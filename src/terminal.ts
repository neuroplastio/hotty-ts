/**
 * HOTTY for a program that is not a full-screen framework's: a command
 * that prints documents and exits, one that asks a question, a chart that
 * streams (SDK.md §4.1). A Terminal is the process's terminal: it finds out
 * whether the terminal is a HOTTY host, names surfaces so that two runs
 * never share one, writes commands, and reads what comes back.
 *
 * ```ts
 * let t: Terminal;
 * try {
 *   t = Terminal.open("mytool");           // no terminal: write plain data instead
 * } catch { … }
 * try {
 *   if (!(await t.detect())) { … }         // not a host: draw in cells
 *   await t.lineStart();                    // surfaces are placed at the cursor
 *   t.print("card", html, { cols: 40 });
 *   const replies = await t.fence();        // the terminal took it all; errors?
 * } finally {
 *   t.close();
 * }
 * ```
 *
 * Everything the terminal sends is read once, by the Terminal: keys, the
 * mouse, pastes, and HOTTY replies and events. What a call waits for goes
 * to that call (detect's answer, a fence's DA1, a request's numbered
 * reply); the rest goes to the input stream ({@link Link.events}), in
 * order. Keys come as the bytes the terminal sent: decoding them is the
 * program's, or its key library's.
 *
 * A command that exits hands the terminal to whatever runs next, usually a
 * shell, which reads what the terminal sends as typing. So before it exits,
 * a program reads every reply its commands caused ({@link Link.fence}), and
 * leaves no surface that still reports events: it sends documents detached
 * ({@link Terminal.print} does), or detaches them ({@link Link.detachAll}).
 * Close gives the terminal back, and in Node and Bun lets the process exit.
 *
 * @module
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isatty, ReadStream, WriteStream } from "node:tty";

import { doc, place, type Placement } from "./commands.ts";
import { DETECT_AFTER_DA1, DETECT_TIMEOUT } from "./detector.ts";
import { type Clock, FENCE_TIMEOUT, type Known, Link, NoAnswerError } from "./link.ts";

export { type Clock, type Input, type Known, NoAnswerError, REPLY_TIMEOUT, FENCE_TIMEOUT, systemClock } from "./link.ts";

/** Terminal.open's error when the process has no terminal. */
export class NoTerminalError extends Error {
  constructor(why: string) {
    super("hotty: no terminal: " + why);
    this.name = "NoTerminalError";
  }
}

/** The terminal's size in cells. */
export interface Size {
  cols: number;
  rows: number;
}

/** Options of a Terminal made from streams. */
export interface TerminalOptions {
  /** What the terminal sends: keys, replies and events, as bytes. It is read once something asks. */
  input: AsyncIterable<Uint8Array | string>;
  /** Goes to the terminal. */
  output: { write(data: string): unknown };
  /** Prefixes every surface this program makes ({@link Link.surface}), made a valid name. */
  name: string;
  /** The terminal's size in cells; undefined, or a size of 0, is 80 × 24. */
  size?: () => Size | undefined;
  /** What detect answers without asking: the terminal is known to be a host, and with what capabilities. */
  known?: Known;
  /** Puts the terminal in raw mode, and returns what restores it; none for a terminal that is always raw. */
  raw?: () => () => void;
  /** What close does besides: gives the terminal's files back. */
  onClose?: () => void;
  /** The time and timers; the runtime's by default. */
  clock?: Clock;
}

// Bun reads a tty.ReadStream with blocking reads on a thread, and one that
// waits when the stream is destroyed keeps the process alive until the
// terminal sends something. Its process.stdin does not. So in Bun the
// Terminal reads stdin when stdin is the terminal, and otherwise polls
// /dev/tty, opened without blocking, every 10 ms while it reads.

// Whether stdin is the same terminal as fd.
function sameTerminal(fd: number): boolean {
  try {
    return isatty(0) && fstatSync(0).rdev === fstatSync(fd).rdev;
  } catch {
    return false;
  }
}

type Stoppable = AsyncIterable<Uint8Array> & { stop(): void };

function stdinTty(): Stoppable {
  const stdin = process.stdin;
  const buf: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const data = (d: Uint8Array) => {
    buf.push(d);
    wake?.();
  };
  const stop = () => {
    if (done) return;
    done = true;
    stdin.off("data", data);
    stdin.off("end", stop);
    stdin.pause();
    wake?.();
  };
  return {
    stop,
    [Symbol.asyncIterator]: () => {
      stdin.on("data", data);
      stdin.on("end", stop);
      stdin.resume();
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          while (buf.length === 0 && !done) await new Promise<void>((r) => (wake = r));
          wake = undefined;
          return buf.length > 0 ? { done: false, value: buf.shift()! } : { done: true, value: undefined };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          stop();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function pollTty(fd: number): Stoppable {
  let done = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    done = true;
    clearTimeout(timer);
    wake?.();
  };
  const buf = new Uint8Array(4096);
  return {
    stop,
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<Uint8Array>> {
        while (!done) {
          let n: number;
          try {
            n = readSync(fd, buf);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
            await new Promise<void>((r) => {
              wake = r;
              timer = setTimeout(r, 10);
            });
            continue;
          }
          if (n === 0) break;
          return { done: false, value: buf.slice(0, n) };
        }
        return { done: true, value: undefined };
      },
      async return(): Promise<IteratorResult<Uint8Array>> {
        stop();
        return { done: true, value: undefined };
      },
    }),
  };
}

// The kitty graphics query: a 1×1 RGB image with id 31, which a terminal
// that has them answers with ESC _Gi=31;OK ESC \ and draws nothing, then
// DA1, which every terminal answers after it.
const GRAPHICS_QUERY = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\" + "\x1b[c";

/** One process's terminal (SDK.md §4.1). */
export class Terminal extends Link {
  readonly #input: AsyncIterable<Uint8Array | string>;
  readonly #size: (() => Size | undefined) | undefined;
  readonly #raw: (() => () => void) | undefined;
  readonly #onClose: (() => void) | undefined;
  readonly #known: boolean;
  #reading = false;
  #iterator: AsyncIterator<Uint8Array | string> | undefined;
  #rawDepth = 0;
  #restore: (() => void) | undefined;

  /**
   * A terminal from its two streams, for a test or an environment with no
   * file (a terminal in a page).
   */
  constructor(options: TerminalOptions) {
    super({ write: (s) => void options.output.write(s), name: options.name, known: options.known, clock: options.clock });
    this.#input = options.input;
    this.#size = options.size;
    this.#raw = options.raw;
    this.#onClose = options.onClose;
    this.#known = options.known !== undefined;
  }

  /**
   * Opens the process's terminal, /dev/tty, whatever its standard streams
   * are: `x=$(mytool ask)` draws on the terminal and prints to the pipe.
   * name and the process id name its surfaces. Throws NoTerminalError when
   * the process has no terminal (a pipe, a cron job; on Windows, always).
   */
  static open(name: string, options: { clock?: Clock } = {}): Terminal {
    const bun = "Bun" in globalThis;
    let rfd: number;
    let wfd: number;
    try {
      // Bun cannot stop a blocking read: see pollTty.
      rfd = openSync("/dev/tty", bun ? constants.O_RDONLY | constants.O_NONBLOCK : "r");
    } catch (e) {
      throw new NoTerminalError((e as Error).message);
    }
    if (!isatty(rfd)) {
      closeSync(rfd);
      throw new NoTerminalError("/dev/tty is not a terminal");
    }
    try {
      wfd = openSync("/dev/tty", "w");
    } catch (e) {
      closeSync(rfd);
      throw new NoTerminalError((e as Error).message);
    }
    const tty = new ReadStream(rfd); // in Bun, only for its mode: it is never read
    const output = new WriteStream(wfd);
    let input: AsyncIterable<Uint8Array> = tty;
    let stop = (): void => void tty.destroy();
    if (bun) {
      const p = sameTerminal(rfd) ? stdinTty() : pollTty(rfd);
      input = p;
      stop = () => {
        p.stop();
        tty.destroy();
      };
    }
    return new Terminal({
      input,
      output,
      name: `${name}-${process.pid}`,
      size: () => ({ cols: output.columns, rows: output.rows }),
      raw: () => {
        tty.setRawMode(true);
        return () => tty.setRawMode(false);
      },
      onClose: () => {
        if (tty.isRaw) tty.setRawMode(false);
        stop();
        output.end();
      },
      clock: options.clock,
    });
  }

  /** The terminal's size in cells, or 80 × 24 when it cannot be told. */
  get size(): Size {
    const s = this.#size?.();
    return s && s.cols > 0 && s.rows > 0 ? { cols: s.cols, rows: s.rows } : { cols: 80, rows: 24 };
  }

  /**
   * Puts the terminal in raw mode (no echo, no line editing, keys as they
   * are typed) and returns what restores it. Calls that wait for the
   * terminal do this for themselves; a program that reads keys calls it
   * once. In raw mode "\n" does not return the carriage: write "\r\n".
   */
  raw(): () => void {
    if (!this.#raw) return () => {};
    if (this.#rawDepth++ === 0) this.#restore = this.#raw();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.#rawDepth === 0) {
        this.#restore?.();
        this.#restore = undefined;
      }
    };
  }

  protected override read(): void {
    if (this.#reading || this.closed) return;
    this.#reading = true;
    const it = this.#input[Symbol.asyncIterator]();
    this.#iterator = it;
    void (async () => {
      try {
        for (;;) {
          const r = await it.next();
          if (r.done || this.closed) break;
          this.bytes(r.value);
        }
      } catch {
        // a stream that fails has ended
      }
      this.end();
    })();
  }

  protected override hold(): () => void {
    this.read();
    return this.raw();
  }

  /**
   * Moves the cursor to the start of a line, where a surface placed at the
   * cursor belongs: it asks where the cursor is (CPR), and writes CR LF if
   * it is not at column 0. A terminal that does not answer within 1 s is
   * taken to be at one.
   */
  async lineStart(): Promise<void> {
    const col = this.awaitAnswer<number>(
      FENCE_TIMEOUT,
      "the cursor's position",
      (s) => {
        const m = /\x1b\[(\d+);(\d+)R/.exec(s);
        return m ? { start: m.index, end: m.index + m[0].length, value: Number(m[2]) - 1 } : undefined;
      },
      /\x1b(\[(\d+(;\d*)?)?)?$/,
    );
    this.send("\x1b[6n");
    try {
      if ((await col) > 0) this.send("\r\n");
    } catch (e) {
      if (!(e instanceof NoAnswerError)) throw e;
    }
  }

  /**
   * Shows a document at the cursor, to stay in the scrollback among the
   * program's output: the surface named name (made this program's own with
   * {@link Link.surface}) gets html, detached, and is placed, in one write.
   * The host moves the cursor below it, unless keepCursor. Returns the
   * surface's full name, for deltas. Errors the host replies come back on
   * the input: read them with fence.
   */
  print(name: string, html: string, placement: Placement): string {
    const s = this.surface(name);
    this.send(doc(s, html, { detached: true }), place(s, placement));
    return s;
  }

  /**
   * Asks the terminal whether it shows kitty graphics, so that a program on
   * a terminal that is not a host can suggest a polyfill (SPEC §14). Ask
   * after detect, and only when it is false. A terminal made with known is
   * not asked (false), nor is one that answers neither the query nor DA1
   * within 1.5 s.
   */
  async kittyGraphics(): Promise<boolean> {
    if (this.#known) return false;
    const release = this.hold();
    const stop = new AbortController();
    let answer: boolean | undefined;
    const answered = this.awaitAnswer<boolean>(
      DETECT_TIMEOUT,
      "the kitty graphics query",
      (s) => {
        const m = /\x1b_Gi=31;([^\x1b]*)\x1b\\/.exec(s);
        return m ? { start: m.index, end: m.index + m[0].length, value: m[1] === "OK" } : undefined;
      },
      /\x1b(_(G[^\x1b]*(\x1b)?)?)?$/,
      stop.signal,
    ).then(
      (ok) => (answer = ok),
      () => false,
    );
    const da1 = this.awaitDa1(DETECT_TIMEOUT, stop.signal).then(
      () => true,
      () => false,
    );
    this.send(GRAPHICS_QUERY);
    try {
      if ((await Promise.race([answered.then(() => "answer"), da1.then(() => "da1")])) === "answer") {
        // The DA1 behind the answer is this query's: take it too, a moment at most.
        await Promise.race([da1, this.#after(DETECT_AFTER_DA1)]);
      } else if (answer === undefined) {
        // A DA1 first may answer an earlier question: the answer may still come.
        await Promise.race([answered, this.#after(DETECT_AFTER_DA1)]);
      }
      return answer ?? false;
    } finally {
      stop.abort(new Error("done"));
      release();
    }
  }

  #after(ms: number): Promise<void> {
    return new Promise((r) => this.clock.setTimeout(r, ms));
  }

  /**
   * Gives the terminal back as it was (its mode, its files) and stops
   * reading it; the input stream ends. It sends nothing: what is left on
   * the screen, and the replies not read, are the program's to settle
   * first (SDK.md §2.6).
   */
  override close(): void {
    if (this.closed) return;
    super.close();
    if (this.#rawDepth > 0) {
      this.#rawDepth = 0;
      this.#restore?.();
      this.#restore = undefined;
    }
    void this.#iterator?.return?.();
    this.#onClose?.();
  }
}
