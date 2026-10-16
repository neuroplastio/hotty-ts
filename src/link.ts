/**
 * The program's link to a host, in any environment (SDK.md §4.1, §4.2): it
 * writes through the environment's output, and is handed what the
 * environment reads, either as a byte stream (a terminal's input) or as
 * complete sequences (a framework's or an editor's input parser). On it run
 * detection, numbered requests, fences, and one stream of whatever no call
 * waits for.
 *
 * {@link Terminal} is a Link on a process's terminal; {@link Session} is a
 * framework's adapter on one. An environment that does its own I/O makes
 * its own:
 *
 * ```ts
 * const link = new Link({ write: (s) => out.write(s), name: "tool-42" });
 * input.onOsc((seq) => link.osc(seq)); // complete sequences, terminated or not
 * input.onDa1(() => link.da1());       // whether it was the link's to swallow
 * if (await link.detect()) …
 * ```
 *
 * @module
 */

import type { ReplyOptions } from "./commands.ts";
import { detach, withdrawLate } from "./commands.ts";
import { Decoder } from "./decoder.ts";
import { Detector } from "./detector.ts";
import type { Caps, Message, Reply } from "./messages.ts";
import { surfaceName } from "./names.ts";
import { Scanner, type Segment } from "./scanner.ts";

/** How long a request waits for its reply: a terminal that is not a host never replies. */
export const REPLY_TIMEOUT = 3000;
/** How long a fence, a ping or the cursor's position waits: every terminal answers at once, or never. */
export const FENCE_TIMEOUT = 1000;
/** The query's number: a reply that does not echo it answers someone else's. */
export const QUERY_N = 1;
/**
 * How long a lone ESC at the end of a read waits for what may follow it
 * before it goes out as the Escape key: a HOTTY sequence cut right after
 * its ESC still arrives whole.
 */
export const ESCAPE_DELAY = 25;

/** The time, and timers: the environment's, or a test's. */
export interface Clock {
  /** Milliseconds, from any origin. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The runtime's clock. */
export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** What a terminal is known to be without asking it, such as one in a page that always has the HOTTY addon. */
export interface Known {
  native: boolean;
  caps?: Caps;
}

/**
 * What arrives that no call waits for, in the order it arrived: a HOTTY
 * message (a reply or an event), other bytes of a byte stream (keys, the
 * mouse, pastes, other answers), unchanged, or a late answer to the query
 * (SPEC §4): the terminal is a host from now on, with these capabilities.
 */
export type Input =
  | { kind: "message"; message: Message }
  | { kind: "data"; data: Uint8Array }
  | { kind: "host"; caps: Caps | undefined };

/** A call waited for the terminal in vain: it did not answer in time, or its input ended. */
export class NoAnswerError extends Error {
  /** A fence's replies that came before it gave up. */
  readonly replies: Reply[];
  constructor(what: string, replies: Reply[] = []) {
    super(`hotty: the terminal did not answer ${what}`);
    this.name = "NoAnswerError";
    this.replies = replies;
  }
}

/** Options of a {@link Link}. */
export interface LinkOptions {
  /** Writes to the terminal: the environment's output. */
  write: (data: string) => void;
  /**
   * Prefixes the surface names {@link Link.surface} makes: the program's
   * name and a number unique on the terminal, such as its process id, or
   * what the environment provides. Default "hotty".
   */
  name?: string;
  /** What detect answers without asking. */
  known?: Known;
  /**
   * Ask for a late answer (SPEC §4), for a program that can start using
   * HOTTY after it fell back: what passes HOTTY through with no host yet,
   * such as a multiplexer's pane with no terminal attached, may answer once
   * a terminal that is a host attaches. The answer comes to the input
   * stream as `host`, and detect answers true from then on. Until it comes,
   * close withdraws the query.
   */
  late?: boolean;
  /** The time and timers; the runtime's by default. */
  clock?: Clock;
  /** How long a lone ESC at the end of a read waits before it is the Escape key; ESCAPE_DELAY by default, 0 for at once. */
  escapeDelay?: number;
}

/** Options of {@link Link.detect}. */
export interface DetectOptions {
  /**
   * Resolve once it is decided rather than done: for a program that must
   * not wait, such as a framework's adapter. A terminal that answers the
   * query is decided when its reply arrives (a host, or with an error or
   * another version none this SDK can use), and done when the DA1 behind it
   * does, or 300 ms later.
   */
  decided?: boolean;
  /** Ask for a late answer, as LinkOptions.late; the first call's counts. */
  late?: boolean;
}

// What takes the inputs a call waits for. Each returns whether it took it;
// data returns what it left of the bytes.
interface Tap {
  message?: (m: Message) => boolean;
  da1?: () => boolean;
  data?: (b: Uint8Array) => Uint8Array;
}

const ESC_ONLY = (b: Uint8Array) => b.length === 1 && b[0] === 0x1b;

/**
 * The program's link to a host (SDK.md §4.1, §4.2). Input reaches it as a
 * byte stream ({@link bytes}) or as complete sequences ({@link osc},
 * {@link da1}); what a call waits for goes to that call, and everything else
 * to the input stream ({@link listen}, {@link events}).
 */
export class Link {
  readonly #write: (data: string) => void;
  /** The prefix of the surface names {@link surface} makes. */
  readonly name: string;
  /** The time and timers the link waits with. */
  readonly clock: Clock;
  readonly #known: Known | undefined;
  readonly #late: boolean;
  readonly #dec = new Decoder();
  readonly #scanner = new Scanner({ da1: true });
  readonly #escapeDelay: number;
  #escTimer: unknown;

  #taps: Tap[] = [];
  #queue: Input[] = [];
  #listener: ((input: Input) => void) | undefined;
  #names: string[] = [];
  #nextN = QUERY_N;
  #ended = false;
  #closed = false;
  #onEnd: (() => void)[] = [];

  // Detection: run once.
  #detector: Detector | undefined;
  #timer: unknown;
  #decided: Promise<boolean> | undefined;
  #done: Promise<boolean> | undefined;
  #resolveDecided: ((native: boolean) => void) | undefined;
  #resolveDone: ((native: boolean) => void) | undefined;
  #native = false;
  #caps: Caps | undefined;
  #withdrawn = false; // a late query withdrawn

  constructor(options: LinkOptions) {
    this.#write = options.write;
    this.name = surfaceName(options.name ?? "hotty");
    this.clock = options.clock ?? systemClock;
    this.#known = options.known;
    this.#late = options.late ?? false;
    this.#escapeDelay = options.escapeDelay ?? ESCAPE_DELAY;
  }

  // --- what a subclass provides ------------------------------------------------

  /** Called when something needs the input read: a Terminal starts reading it. */
  protected read(): void {}

  /**
   * Called when a call starts waiting for the terminal; returns what to do
   * when it is done waiting. A Terminal reads, and puts the terminal in raw
   * mode for as long as the call waits.
   */
  protected hold(): () => void {
    this.read();
    return () => {};
  }

  // --- output -----------------------------------------------------------------

  /** Writes commands to the terminal, in one write, so that nothing the program prints lands between them. */
  send(...commands: string[]): void {
    const s = commands.join("");
    if (s !== "" && !this.#closed) this.#write(s);
  }

  // --- input ------------------------------------------------------------------

  /**
   * Takes the next bytes of the terminal's input, however its reads split
   * it: HOTTY's sequences and DA1 answers are cut out of them (a Scanner).
   * A lone ESC at the end of a read is the Escape key, once nothing follows
   * it within escapeDelay.
   */
  bytes(chunk: Uint8Array | string): void {
    if (this.#closed) return;
    this.clock.clearTimeout(this.#escTimer);
    this.#escTimer = undefined;
    this.#segments(this.#scanner.feed(chunk));
    if (!ESC_ONLY(this.#scanner.holding)) return;
    if (this.#escapeDelay <= 0) this.#segments(this.#scanner.flush());
    else
      this.#escTimer = this.clock.setTimeout(() => {
        this.#escTimer = undefined;
        if (ESC_ONLY(this.#scanner.holding)) this.#segments(this.#scanner.flush());
      }, this.#escapeDelay);
  }

  #segments(segs: Segment[]) {
    for (const s of segs) {
      if (s.kind === "osc") this.osc(s.data);
      else if (s.kind === "da1") {
        if (!this.da1()) this.#data(s.data);
      } else this.#data(s.data);
    }
  }

  /**
   * Takes one complete OSC sequence, with or without its terminator, as an
   * environment's input parser hands it over. Returns whether it was
   * HOTTY's: a sequence that is not goes back to the environment.
   */
  osc(seq: string | Uint8Array): boolean {
    if (this.#closed) return false;
    const f = this.#dec.feed(seq);
    if (f.result === "not_hotty") return false;
    if (f.result === "complete") this.#message(f.message);
    return true;
  }

  /**
   * A DA1 answer arrived. Returns whether it was this link's: detection's,
   * a fence's or a ping's, for the environment to swallow. One it does not
   * take answers someone else's question.
   */
  da1(): boolean {
    if (this.#closed) return false;
    const d = this.#detector;
    if (d && !d.done) {
      const took = d.da1(this.clock.now());
      this.#detected();
      if (took) return true;
    }
    for (const t of [...this.#taps]) if (t.da1?.()) return true;
    return false;
  }

  /** The input ended: calls that wait give up, and the input stream ends once it is read. */
  end(): void {
    if (this.#ended) return;
    this.clock.clearTimeout(this.#escTimer);
    const held = this.#scanner.flush();
    for (const s of held) this.#data(s.data);
    this.#ended = true;
    const d = this.#detector;
    if (d && !d.done) {
      d.end(this.clock.now());
      this.#detected();
    }
    for (const f of this.#onEnd.splice(0)) f();
    this.#deliver();
  }

  #message(m: Message) {
    const r = m.reply();
    const d = this.#detector;
    if (r && d) {
      // Text: no host answered, or the one that did is not one this SDK
      // can use, and a reply to the query that makes it one is a late answer.
      const fellBack = d.state === "text";
      // A withdrawn query's late answer reaches nothing.
      if (fellBack && this.#withdrawn && r.re === "q" && r.n === d.n) return;
      // Detection's, ok or an error, whenever it arrives: swallowed.
      if (d.reply(r, this.clock.now())) {
        if (fellBack && d.state === "native") this.#lateAnswer(d.caps);
        else this.#detected();
        return;
      }
    }
    this.#mergeCaps(m);
    for (const t of [...this.#taps]) if (t.message?.(m)) return;
    this.#push({ kind: "message", message: m });
  }

  // A caps event folds into the capabilities (SPEC §4); it still reaches the
  // program, which may act on the change.
  #mergeCaps(m: Message) {
    const ev = m.event();
    const changed = ev?.kind === "caps" ? ev.changed() : undefined;
    if (changed && this.#caps) this.#caps = this.#caps.merge(changed);
  }

  #data(b: Uint8Array) {
    for (const t of [...this.#taps]) {
      if (!t.data) continue;
      b = t.data(b);
      if (b.length === 0) return;
    }
    this.#push({ kind: "data", data: b });
  }

  #push(input: Input) {
    this.#queue.push(input);
    this.#deliver();
  }

  #deliver() {
    while (this.#listener && this.#queue.length > 0) this.#listener(this.#queue.shift()!);
  }

  /**
   * Hands what no call waits for to fn, in order: what is queued at once,
   * then each input as it arrives. One listener at a time; the function it
   * returns removes it, and inputs queue again until the next.
   */
  listen(fn: (input: Input) => void): () => void {
    this.#listener = fn;
    this.read();
    this.#deliver();
    return () => {
      if (this.#listener === fn) this.#listener = undefined;
    };
  }

  /** What no call waits for, as an async iterable that ends when the input ends or the link closes. */
  async *events(): AsyncGenerator<Input> {
    const buf: Input[] = [];
    let wake: (() => void) | undefined;
    const stop = this.listen((i) => {
      buf.push(i);
      wake?.();
    });
    const ended = () => wake?.();
    this.#onEnd.push(ended);
    try {
      for (;;) {
        if (buf.length > 0) {
          yield buf.shift()!;
          continue;
        }
        if (this.#ended || this.#closed) return;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    } finally {
      stop();
      this.#onEnd = this.#onEnd.filter((f) => f !== ended);
    }
  }

  // Adds a tap until the function it returns removes it.
  #tap(t: Tap): () => void {
    this.#taps.push(t);
    return () => {
      this.#taps = this.#taps.filter((x) => x !== t);
    };
  }

  // Waits for done(resolve) to settle it, ms at most, or until the input
  // ends; then cleans up.
  #wait<T>(
    ms: number,
    what: string,
    start: (resolve: (v: T) => void, fail: (e: Error) => void) => () => void,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const release = this.hold();
      let cleanup = () => {};
      let settled = false;
      const finish = () => {
        settled = true;
        this.clock.clearTimeout(timer);
        this.#onEnd = this.#onEnd.filter((f) => f !== onEnd);
        cleanup();
        release();
      };
      const ok = (v: T) => {
        if (settled) return;
        finish();
        resolve(v);
      };
      const fail = (e: Error) => {
        if (settled) return;
        finish();
        reject(e);
      };
      const onEnd = () => fail(new NoAnswerError(what));
      const timer = this.clock.setTimeout(() => fail(new NoAnswerError(what)), ms);
      this.#onEnd.push(onEnd);
      cleanup = start(ok, fail);
      if (this.#ended || this.#closed) onEnd();
      signal?.addEventListener("abort", () => fail(signal.reason as Error), { once: true });
      if (signal?.aborted) fail(signal.reason as Error);
    });
  }

  // --- detection ---------------------------------------------------------------

  /**
   * Asks the terminal whether it is a HOTTY host that speaks this SDK's
   * version (SPEC §4), once: later calls answer what the first found, or
   * true once a late answer came. It resolves when the detection is done,
   * so that nothing of it is left for whatever reads the terminal next, or
   * with `decided`, as soon as it is known. A terminal that answers the
   * query with an error (EVERSION) or with capabilities of another version,
   * or answers neither the query nor DA1 within 1.5 s, is not a host; a
   * link made with `known` answers at once.
   */
  detect(options: DetectOptions = {}): Promise<boolean> {
    if (!this.#done) this.#startDetection(options.late ?? false);
    return options.decided ? this.#decided! : this.#done!;
  }

  // A late answer (SPEC §4): the terminal is a host from now on.
  #lateAnswer(caps: Caps | undefined) {
    this.#native = true;
    this.#caps = caps;
    this.#decided = this.#done = Promise.resolve(true);
    this.#push({ kind: "host", caps });
  }

  /**
   * Withdraws the query, when it asked for a late answer and none has come
   * (SPEC §4): returns the command to write, or "" when there is nothing to
   * withdraw. close writes it itself; an adapter that writes with its
   * frames, as a Session does, writes what this returns.
   */
  withdrawLate(): string {
    const d = this.#detector;
    if (!d?.late || d.state === "native" || this.#withdrawn) return "";
    this.#withdrawn = true;
    return withdrawLate();
  }

  #startDetection(late: boolean) {
    this.#decided = new Promise((r) => (this.#resolveDecided = r));
    this.#done = new Promise((r) => (this.#resolveDone = r));
    if (this.#known) {
      this.#native = this.#known.native;
      this.#caps = this.#known.caps;
      this.#resolveDecided!(this.#native);
      this.#resolveDone!(this.#native);
      return;
    }
    const d = new Detector({ n: QUERY_N, late: this.#late || late });
    this.#detector = d;
    const release = this.hold();
    void this.#done.then(release);
    this.send(d.start(this.clock.now()));
    if (this.#ended || this.#closed) d.end(this.clock.now());
    this.#detected();
  }

  // Acts on what the Detector decided, and sets the timer for its deadline.
  #detected() {
    const d = this.#detector!;
    if (d.decided && this.#resolveDecided) {
      this.#native = d.state === "native";
      this.#caps = d.caps;
      this.#resolveDecided(this.#native);
      this.#resolveDecided = undefined;
    }
    this.clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (d.done) {
      this.#resolveDone?.(this.#native);
      this.#resolveDone = undefined;
      return;
    }
    const at = d.deadline;
    if (at !== undefined) {
      this.#timer = this.clock.setTimeout(
        () => {
          d.tick(this.clock.now());
          this.#detected();
        },
        Math.max(0, at - this.clock.now()),
      );
    }
  }

  /** What detection found: true for a HOTTY host. False until it is decided. */
  get native(): boolean {
    return this.#native;
  }

  /** The host's capabilities, when native, kept current by the caps events it has sent since (SPEC §4, {@link Caps.merge}). */
  get caps(): Caps | undefined {
    return this.#caps;
  }

  // --- requests and fences ---------------------------------------------------------

  /**
   * Sends one command and waits for its reply, 3 s at most: build makes the
   * command with the options it is given, which number it and ask for the
   * reply. An error reply is a reply, not an error; no reply in time
   * rejects with NoAnswerError.
   *
   * ```ts
   * const r = await link.request((o) => place(name, { cols: 40 }, o));
   * r.rows; // the rows the host chose
   * ```
   */
  request(build: (options: ReplyOptions) => string, options: { timeout?: number } = {}): Promise<Reply> {
    const n = ++this.#nextN; // never the query's
    return this.#wait<Reply>(options.timeout ?? REPLY_TIMEOUT, `request ${n}`, (resolve) => {
      const remove = this.#tap({
        message: (m) => {
          const r = m.reply();
          if (!r || r.n !== n) return false;
          resolve(r);
          return true;
        },
      });
      this.send(build({ n }));
      return remove;
    });
  }

  /**
   * Waits for the next DA1 answer that detection does not take, and nothing
   * before it takes, ms at most: a building block for fences and pings,
   * whose caller writes the DA1 request itself.
   */
  awaitDa1(timeout: number = FENCE_TIMEOUT, signal?: AbortSignal): Promise<void> {
    return this.#wait<void>(
      timeout,
      "DA1",
      (resolve) => {
        let done = false;
        return this.#tap({
          da1: () => {
            if (done) return false;
            done = true;
            resolve();
            return true;
          },
        });
      },
      signal,
    );
  }

  /**
   * Waits until the terminal has taken everything written before it (it
   * sends DA1, which terminals answer in order), 1 s at most, and returns
   * the replies nothing read: the errors of commands sent with q=1, mostly.
   * Replies to numbered commands go to their request, or to the input
   * stream. Call it before exiting, after the last command that may be
   * answered, so that no reply is left for the shell to read as typing. No
   * answer in time rejects with NoAnswerError, which carries the replies.
   */
  async fence(options: { timeout?: number } = {}): Promise<Reply[]> {
    const replies: Reply[] = [];
    const unnumbered = (m: Message) => {
      const r = m.reply();
      return r && r.n === undefined ? r : undefined;
    };
    // Replies that came before the fence, and that the input stream has not
    // delivered, are the fence's too.
    this.#queue = this.#queue.filter((i) => {
      const r = i.kind === "message" ? unnumbered(i.message) : undefined;
      if (r) replies.push(r);
      return !r;
    });
    const remove = this.#tap({
      message: (m) => {
        const r = unnumbered(m);
        if (r) replies.push(r);
        return !!r;
      },
    });
    try {
      const answered = this.awaitDa1(options.timeout ?? FENCE_TIMEOUT);
      this.send("\x1b[c");
      await answered;
    } catch (e) {
      throw e instanceof NoAnswerError ? new NoAnswerError("the fence", replies) : e;
    } finally {
      remove();
    }
    return replies;
  }

  /** Writes DA1 and resolves with how long the terminal took to answer it, in milliseconds. */
  async ping(options: { timeout?: number } = {}): Promise<number> {
    const t0 = this.clock.now();
    const answered = this.awaitDa1(options.timeout);
    this.send("\x1b[c");
    await answered;
    return this.clock.now() - t0;
  }

  /**
   * Waits for an answer cut out of the input's other bytes: match finds a
   * complete one in the bytes (as text, one character a byte) and returns
   * its start and end, and partial says whether the bytes end with what may
   * still become one, which is held for the next read. For the terminal's
   * own answers: the cursor's position, the kitty graphics query.
   */
  protected awaitAnswer<T>(
    timeout: number,
    what: string,
    match: (s: string) => { start: number; end: number; value: T } | undefined,
    partial: RegExp,
    signal?: AbortSignal,
  ): Promise<T> {
    let carry = new Uint8Array(0);
    const release = () => {
      if (carry.length > 0) {
        const b = carry;
        carry = new Uint8Array(0);
        this.#push({ kind: "data", data: b });
      }
    };
    return this.#wait<T>(timeout, what, (resolve) => {
      let done = false;
      const remove = this.#tap({
        data: (b) => {
          if (done) return b;
          const all = new Uint8Array(carry.length + b.length);
          all.set(carry);
          all.set(b, carry.length);
          carry = new Uint8Array(0);
          const s = String.fromCharCode(...all);
          const m = match(s);
          if (m) {
            done = true;
            resolve(m.value);
            const rest = new Uint8Array(all.length - (m.end - m.start));
            rest.set(all.subarray(0, m.start));
            rest.set(all.subarray(m.end), m.start);
            return rest;
          }
          const p = partial.exec(s);
          if (p) {
            carry = all.slice(p.index);
            return all.subarray(0, p.index);
          }
          return all;
        },
      });
      return () => {
        remove();
        release();
      };
    }, signal);
  }

  // --- names --------------------------------------------------------------------

  /**
   * A surface name of this program's own: the link's name, a dash, and
   * name, made a valid surface name, so that two runs never share a
   * surface. Every name it returns is remembered ({@link surfaces}).
   */
  surface(name: string): string {
    const s = surfaceName(this.name + "-" + name);
    if (!this.#names.includes(s)) this.#names.push(s);
    return s;
  }

  /** The names {@link surface} has returned: what this program may have left on the terminal. */
  surfaces(): string[] {
    return [...this.#names];
  }

  /**
   * Detaches every surface {@link surface} has named (SPEC §5.5), so that
   * none reports to whatever reads the terminal after this program.
   * Detaching a detached or deleted surface does nothing.
   */
  detachAll(): void {
    this.send(...this.#names.map((s) => detach(s)));
  }

  // --- closing ------------------------------------------------------------------

  /** Whether the link is closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Closes the link: calls that wait give up, and the input stream ends.
   * It sends nothing but the withdrawal of a late query no answer came to
   * ({@link withdrawLate}): what is left on the screen, and the replies not
   * read, are the program's to settle first (SDK.md §2.6).
   */
  close(): void {
    if (this.#closed) return;
    this.send(this.withdrawLate());
    this.#closed = true;
    this.clock.clearTimeout(this.#timer);
    this.clock.clearTimeout(this.#escTimer);
    const d = this.#detector;
    if (d && !d.done) {
      d.end(this.clock.now());
      this.#detected();
    }
    this.#resolveDecided?.(this.#native);
    this.#resolveDone?.(this.#native);
    for (const f of this.#onEnd.splice(0)) f();
  }
}
