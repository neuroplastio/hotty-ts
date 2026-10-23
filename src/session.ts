/**
 * A full-screen program's side of hotty, for a UI framework's adapter
 * (SDK.md §4.3): it finds out whether the terminal is a host, keeps the
 * program's surfaces on screen as its frame changes, and turns what the host
 * sends into messages. It assumes nothing of the framework: it never writes
 * the frame, and it owns no stream.
 *
 * - **Input.** It reads what its {@link Link} is handed: a byte stream (a
 *   {@link Terminal}) or the sequences a framework's input parser pushes.
 * - **Frames.** With each frame, the program says which surfaces it wants
 *   where ({@link Session.layout}); {@link Session.flush} returns the
 *   commands that changed, for the adapter to write with that frame, in the
 *   same stream, so that a placement lands with the cells around it. Where
 *   the framework brackets its frames in synchronized output, they go
 *   inside its brackets; the Session adds none.
 * - **Relayout.** A framework's renderer erases, scrolls and switches
 *   screens on its own, and a host drops placements with them (SPEC §5.4).
 *   The adapter hands the Session what the framework writes
 *   ({@link Session.watch}), or says when it redrew
 *   ({@link Session.relayout}), and the Session asks for a new layout.
 * - **Messages.** What the host sends comes back through onMessage: ready
 *   (the mode is known), an event, an error (a command refused), an ack (the
 *   ok of a numbered command), relayout (with lost when the host lost
 *   documents, so that the program sends their resources again), and pong.
 *   Other input comes back as it was.
 *
 * In a terminal that is not a host the mode is text, and the Session sends
 * nothing: the program draws everything in cells.
 *
 * @module
 */

import { del, detach, doc, hide, placeAt, type Window } from "./commands.ts";
import type { Link } from "./link.ts";
import type { Caps, Event, Reply } from "./messages.ts";

export type { Clock, Input, Known } from "./link.ts";

/** What the terminal turned out to be: not known yet, a host, or a terminal that is not one. */
export type Mode = "detecting" | "native" | "text";

/** A rectangle of cells, from the screen's top-left corner (0, 0). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The part of r inside o; w or h is 0 or less if none is. */
export function intersect(r: Rect, o: Rect): Rect {
  const x0 = Math.max(r.x, o.x);
  const y0 = Math.max(r.y, o.y);
  const x1 = Math.min(r.x + r.w, o.x + o.w);
  const y1 = Math.min(r.y + r.h, o.y + o.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A surface the program wants on screen. */
export interface Want {
  /** The surface's name: unique, and valid. */
  name: string;
  /** The whole surface, in screen cells. With clip it may reach past the screen's edges. */
  rect: Rect;
  /**
   * The part of the screen the surface shows in, such as a scrolling
   * region: the window of it inside is placed (SPEC §5.2). A surface with
   * nothing inside is as good as not wanted.
   */
  clip?: Rect;
  /**
   * When the program stops wanting it, hide it instead of deleting it, so it
   * shows again without its document being sent (SPEC §5.4).
   */
  keep?: boolean;
  /** Above (greater) or below the surfaces it overlaps (SPEC §5.2). */
  z?: number;
  /**
   * What the program wants of the surface now: press wherever the user
   * presses in it (SPEC §9), fit whenever the rows its document needs at
   * its width change (SPEC §5.2), and hover each time the element under
   * the pointer changes, and when it leaves (SPEC §9.4). They belong to the
   * surface on the host (SPEC §5.2), so the Session sends each only when it
   * differs from what the surface last had: on when it turns on, off when
   * it turns off, nothing when it is as it was. A surface the host lost, or
   * the Session deleted, starts again from none.
   */
  press?: boolean;
  fit?: boolean;
  hover?: boolean;
  /**
   * The axes the host scrolls the document along itself (SPEC §5.3): a
   * bitmask of SCROLL_VERTICAL and SCROLL_HORIZONTAL; 0, the default, does
   * not scroll. The wheel, a touchpad, touch and the scrolling keys move
   * it, and the program hears nothing of it; rect is the box it scrolls in.
   * It goes out with the document, so a change sends the document again,
   * which starts at the top.
   */
  scroll?: number;
  /**
   * Returns the document. Called only when the document must be sent: the
   * first time, again after the surface was deleted or the host lost it,
   * and when its scroll changed.
   */
  doc: () => string;
}

/** What the Session tells the program. */
export type SessionMessage =
  /** Detection decided, once; again, native, when a late answer comes (SessionOptions.late). */
  | { kind: "ready"; mode: "native" | "text"; caps?: Caps }
  /** Something the user did in a surface (SPEC §9). */
  | { kind: "event"; event: Event }
  /** A command the host refused that the Session does not handle itself. */
  | { kind: "error"; reply: Reply }
  /**
   * The host's ok for a command the program numbered: it has carried it
   * out. A reply reaches the program the way the user's keys do, in order
   * (SPEC §3.6), so every key typed before the host carried it out came
   * before its ack.
   */
  | { kind: "ack"; reply: Reply }
  /** Lay the surfaces out again: the screen was erased or scrolled under them, or a document went missing. */
  | {
      kind: "relayout";
      /**
       * The host lost a document, which layout sends again, and it may have
       * lost the resources (res) the document refers to as well, since a
       * full reset ends the session that stored them (SPEC §2, §7.1). Send
       * them again before layout, so that they reach the host ahead of the
       * document; sending one again replaces it. A host loses its documents
       * together (a full reset, a restart behind a relay), so layout sends
       * every one again, and one loss is reported once however many it
       * took: an ENOENT for a placement sent before the documents went again
       * is the same loss's, and gives nothing. A full reset the Session
       * watched go out is a loss of its own.
       */
      lost: boolean;
    }
  /** A ping's answer: the terminal took what was written before it, took milliseconds after. */
  | { kind: "pong"; took: number }
  /** Bytes of a byte stream that are not hotty's: keys, the mouse, other answers, as they were. */
  | { kind: "input"; data: Uint8Array };

/** What layout has sent so far, and the relayouts after the screen was erased or scrolled. */
export interface Counts {
  docs: number;
  places: number;
  hides: number;
  deletes: number;
  relayouts: number;
}

/**
 * How many surfaces a Session keeps at most, shown and hidden, unless its
 * limit or the host says fewer: a hidden surface keeps its memory in the
 * terminal.
 */
export const DEFAULT_LIMIT = 48;

/** How long a ping waits for a frame to go with before it goes on its own. */
export const PING_WAIT = 100;

// Numbers a loss's marks (the Session's marking) above any number a program
// picks for its own commands, and well under 2^53.
const MARK_BASE = 2 ** 40;

// How long a mark's answer may take, in ms: past it, the answer is taken as
// lost with the host that would have sent it, and an ENOENT is a loss again.
const MARK_TIMEOUT = 3000;

/** Options of a {@link Session}. */
export interface SessionOptions {
  /** The link to the host: a Terminal, or a Link the adapter feeds. */
  link: Link;
  /** Where the Session's messages go. */
  onMessage: (m: SessionMessage) => void;
  /**
   * The most surfaces to keep, shown and hidden; DEFAULT_LIMIT by default.
   * The host's limits.surfaces, and one an EQUOTA taught, lower it further,
   * and those are hard: a surface beyond them waits for room.
   */
  limit?: number;
  /**
   * Ask for a late answer (SPEC §4): if one comes while the mode is text,
   * the mode becomes native, ready comes again, and then relayout. A
   * program that asks for it draws either rendition whenever the mode
   * says. Until it comes, close withdraws the query.
   */
  late?: boolean;
}

// A surface's p, f and v as the host has them (SPEC §5.2).
interface Flags {
  press: boolean;
  fit: boolean;
  hover: boolean;
}

// The flag that takes a surface's p, f or v from was to now: undefined,
// which a placement does not send, when it is as it was.
const changed = (was: boolean, now: boolean): boolean | undefined => (was === now ? undefined : now);

// What the Session last sent for a surface on screen.
interface Placed {
  at: Rect; // the window's cells
  cols: number;
  rows: number; // the whole surface
  win: Window;
  z: number;
  press: boolean;
  fit: boolean;
  hover: boolean;
}

const samePlaced = (a: Placed, b: Placed) =>
  a.at.x === b.at.x &&
  a.at.y === b.at.y &&
  a.at.w === b.at.w &&
  a.at.h === b.at.h &&
  a.cols === b.cols &&
  a.rows === b.rows &&
  a.win.x === b.win.x &&
  a.win.y === b.win.y &&
  a.win.w === b.win.w &&
  a.win.h === b.win.h &&
  a.z === b.z &&
  a.press === b.press &&
  a.fit === b.fit &&
  a.hover === b.hover;

/** A full-screen program's side of hotty (SDK.md §4.3). */
export class Session {
  /** The link to the host. */
  readonly link: Link;
  /** What detection found. */
  mode: Mode = "detecting";
  /**
   * The host's capabilities, when native, kept current by the caps events
   * it has sent since ({@link Caps.merge}); the events still reach the
   * program.
   */
  caps: Caps | undefined;
  /** The most surfaces to keep; see SessionOptions.limit. */
  limit: number;
  /** The bytes of hotty commands flush has returned. */
  sent = 0;
  /** What layout has sent. */
  readonly counts: Counts = { docs: 0, places: 0, hides: 0, deletes: 0, relayouts: 0 };

  readonly #onMessage: (m: SessionMessage) => void;
  readonly #late: boolean;
  #placed = new Map<string, Placed>(); // on screen
  #flags = new Map<string, Flags>(); // the host's p, f and v for each surface sent
  #hasDoc = new Set<string>(); // sent: on screen or hidden
  #scroll = new Map<string, number>(); // the axes each document went out with
  #keep = new Map<string, boolean>();
  #seen = new Map<string, number>(); // the last layout that wanted a surface
  #refused = new Set<string>(); // documents refused with EQUOTA, whose placement fails too
  // marking is a loss reported (relayout's lost) whose late answers may still
  // come. The first document layout sends again after it is numbered, markN
  // (0 until it goes), on markDoc at markAt: the host answers in order, so an
  // ENOENT read before that document's answer is for a placement sent before
  // it (SDK.md §4.3).
  #marking = false;
  #markN = 0;
  #markDoc = "";
  #markAt = 0;
  #marks = 0;
  #layouts = 0;
  #learned = 0; // a limit an EQUOTA taught
  #closed = false;
  #out: string[] = [];
  #ping = false; // a ping waits for the next flush
  #pingTimer: unknown;
  #watch = new Watcher();
  #relayoutDue = false;
  #reset = false; // a full reset went out: the host has no documents

  constructor(options: SessionOptions) {
    this.link = options.link;
    this.#onMessage = options.onMessage;
    this.limit = options.limit ?? 0;
    this.#late = options.late ?? false;
    this.link.listen((i) => {
      if (i.kind === "data") {
        this.#onMessage({ kind: "input", data: i.data });
        return;
      }
      if (i.kind === "host") {
        this.#lateAnswer(i.caps);
        return;
      }
      const r = i.message.reply();
      if (r) {
        this.#reply(r);
        return;
      }
      const ev = i.message.event();
      if (ev) {
        const ch = ev.kind === "caps" && this.mode === "native" ? ev.changed() : undefined;
        if (ch && this.caps) this.caps = this.caps.merge(ch); // kept current (SPEC §4)
        this.#onMessage({ kind: "event", event: ev });
      }
    });
  }

  /**
   * Asks the terminal whether it is a host (SPEC §4), through the link: call
   * it once the program starts. ready comes once it is decided: when the
   * terminal replies to the query (native for a host of this SDK's version,
   * text for an error or another version), when it answers the fence
   * without a reply, or after 1.5 s of silence.
   */
  detect(): void {
    void this.link.detect({ decided: true, late: this.#late }).then((native) => {
      if (this.mode !== "detecting") return;
      this.mode = native ? "native" : "text";
      this.caps = native ? this.link.caps : undefined;
      this.#onMessage(native ? { kind: "ready", mode: "native", caps: this.caps } : { kind: "ready", mode: "text" });
    });
  }

  // A late answer (SPEC §4): a host attached after the Session fell back to
  // text. ready again, and a layout. It may come before ready text does: a
  // reply to the query that made it text (an error, another version), then
  // the host's, in one read.
  #lateAnswer(caps: Caps | undefined) {
    if (this.mode === "native" || this.#closed) return;
    this.mode = "native";
    this.caps = caps;
    this.#onMessage({ kind: "ready", mode: "native", caps });
    this.#onMessage({ kind: "relayout", lost: false });
  }

  #reply(r: Reply) {
    if (r.n !== undefined && r.n >= MARK_BASE && r.re === "doc") {
      // A loss's mark: this one, or an older one answered after it timed
      // out. Either way the Session's, never an ack the program waits for.
      if (this.#marking && r.n === this.#markN && r.surface === this.#markDoc) this.#marking = false; // the loss's late answers have all come
      if (r.ok) return;
    }
    if (r.ok) {
      // A command the program numbered; queries are the link's.
      if (r.n !== undefined && r.re !== "q") this.#onMessage({ kind: "ack", reply: r });
      return;
    }
    const s = r.surface ?? "";
    if (r.re === "doc" && r.code === "EQUOTA" && this.#hasDoc.has(s)) {
      // Over the host's limit: it holds fewer surfaces than the Session has
      // sent. Keep below that from now on, and lay out again. The placement
      // sent with the document fails too.
      const n = Math.max(1, this.#hasDoc.size - 1);
      if (this.#learned === 0 || n < this.#learned) this.#learned = n;
      this.#hasDoc.delete(s);
      this.#placed.delete(s);
      this.#flags.delete(s);
      this.#refused.add(s);
      this.#onMessage({ kind: "relayout", lost: false });
      return;
    }
    if (r.re === "place" && r.code === "ENOENT" && this.#refused.has(s)) {
      this.#refused.delete(s);
      return;
    }
    if (r.re === "place" && r.code === "ENOENT" && this.#marking && (this.#markN === 0 || this.link.clock.now() - this.#markAt < MARK_TIMEOUT)) {
      // For a placement sent before the documents went again: this loss's,
      // and its document goes with the rest.
      return;
    }
    if (r.re === "place" && r.code === "ENOENT" && this.#hasDoc.has(s)) {
      // The host dropped the document with its placement, and with it the
      // others (a reset, a host restarting behind a relay): send them all
      // again with the next layout, and have the program send the resources
      // again.
      this.#marking = true;
      this.#markN = 0;
      this.#hasDoc.clear();
      this.#placed.clear();
      this.#flags.clear();
      this.#onMessage({ kind: "relayout", lost: true });
      return;
    }
    this.#onMessage({ kind: "error", reply: r });
  }

  /**
   * Makes the surfaces on screen match want: a new surface gets its document
   * (attached, q=1, with its scroll) and a placement; one whose scroll
   * changed gets its document again, and keeps its placement; a moved or
   * scrolled one is placed again (only the window inside its clip); one no
   * longer wanted is hidden if it is kept, or else deleted. What it sends leaves with the next flush. It
   * does nothing until the mode is native, and after close.
   */
  layout(want: Want[]): void {
    if (this.mode !== "native" || this.#closed) return;
    this.#layouts++;
    const on: { s: Want; at: Rect }[] = [];
    const wanted = new Set<string>();
    for (const s of want) {
      const at = s.clip ? intersect(s.rect, s.clip) : s.rect;
      if (at.w <= 0 || at.h <= 0) continue; // nothing in view
      wanted.add(s.name);
      this.#keep.set(s.name, s.keep ?? false);
      this.#seen.set(s.name, this.#layouts);
      on.push({ s, at });
    }
    for (const { s, at } of on) {
      const has = this.#hasDoc.has(s.name);
      const scroll = s.scroll ?? 0;
      if (!has || this.#scroll.get(s.name) !== scroll) {
        if (!has && !this.#makeRoom(wanted)) continue; // the host holds no more: not until one goes
        let n: number | undefined;
        if (this.#marking && this.#markN === 0) {
          // The loss's mark: a numbered command is answered whatever comes
          // of it (SPEC §3.5).
          this.#markN = n = MARK_BASE + ++this.#marks;
          this.#markDoc = s.name;
          this.#markAt = this.link.clock.now();
        }
        this.send(doc(s.name, s.doc(), { scroll, n }));
        this.counts.docs++;
        this.#hasDoc.add(s.name);
        this.#scroll.set(s.name, scroll);
        this.#refused.delete(s.name);
        // A replaced document keeps its placement (SPEC §5.1).
        if (!has) {
          this.#placed.delete(s.name);
          this.#flags.delete(s.name); // a new surface starts from none
        }
      }
      const p: Placed = {
        at,
        cols: s.rect.w,
        rows: s.rect.h,
        win: { x: at.x - s.rect.x, y: at.y - s.rect.y, w: at.w, h: at.h },
        z: s.z ?? 0,
        press: s.press ?? false,
        fit: s.fit ?? false,
        hover: s.hover ?? false,
      };
      const old = this.#placed.get(s.name);
      if (!old || !samePlaced(old, p)) {
        const have = this.#flags.get(s.name) ?? { press: false, fit: false, hover: false };
        this.send(
          placeAt(s.name, at.x, at.y, {
            cols: p.cols,
            rows: p.rows,
            window: p.win,
            z: p.z,
            press: changed(have.press, p.press),
            fit: changed(have.fit, p.fit),
            hover: changed(have.hover, p.hover),
          }),
        );
        this.counts.places++;
        this.#placed.set(s.name, p);
        this.#flags.set(s.name, { press: p.press, fit: p.fit, hover: p.hover });
      }
    }
    for (const name of this.#names()) {
      if (wanted.has(name)) continue;
      if (this.#keep.get(name)) {
        if (this.#placed.has(name)) {
          this.send(hide(name));
          this.counts.hides++;
          this.#placed.delete(name);
        }
      } else {
        this.delete(name);
      }
    }
  }

  // The surfaces sent, shown or hidden, in order, so that what layout sends
  // is the same every run.
  #names(): string[] {
    return [...this.#hasDoc].sort();
  }

  // The most surfaces to have at once, and whether it is the host's.
  #limit(): [number, boolean] {
    let n = this.limit > 0 ? this.limit : DEFAULT_LIMIT;
    let hard = false;
    const l = this.caps?.limits.surfaces ?? 0;
    if (l > 0 && l <= n) [n, hard] = [l, true];
    if (this.#learned > 0 && this.#learned <= n) [n, hard] = [this.#learned, true];
    return [n, hard];
  }

  // Deletes surfaces the program no longer wants, the ones seen longest ago
  // first, until one more fits the limit. A surface wanted now is never
  // taken. Returns whether one more may be sent: only the host's own limit
  // refuses one.
  #makeRoom(wanted: Set<string>): boolean {
    const [n, hard] = this.#limit();
    while (this.#hasDoc.size >= n) {
      let oldest = "";
      let at = this.#layouts + 1;
      for (const name of this.#names()) {
        if (wanted.has(name)) continue;
        const s = this.#seen.get(name) ?? 0;
        if (s < at) [oldest, at] = [name, s];
      }
      if (oldest === "") return !hard; // everything is on screen
      this.delete(oldest);
    }
    return true;
  }

  /** Deletes a surface, kept or not: one that will not come back. It leaves with the next flush. */
  delete(name: string): void {
    if (this.#hasDoc.has(name)) {
      this.send(del(name));
      this.counts.deletes++;
    }
    this.#hasDoc.delete(name);
    this.#scroll.delete(name);
    this.#placed.delete(name);
    this.#flags.delete(name);
    this.#keep.delete(name);
    this.#seen.delete(name);
  }

  /** Whether the host has a surface's document, on screen or hidden, so that deltas to it make sense. */
  has(name: string): boolean {
    return this.#hasDoc.has(name);
  }

  /** Whether a surface is on screen: placed by the last layout, and not hidden since. */
  placed(name: string): boolean {
    return this.#placed.has(name);
  }

  /** Queues commands (deltas, focus) for the next flush. Nothing when the terminal is not a host, or after close. */
  send(...commands: string[]): void {
    if (this.mode !== "native" || this.#closed) return;
    this.#out.push(...commands);
  }

  /**
   * What is queued, to write with the frame: "" when nothing is. A ping
   * waiting goes at its end, so that its pong says the terminal took the
   * frame written before it.
   */
  flush(): string {
    let s = this.#out.join("");
    this.#out = [];
    this.sent += s.length;
    if (this.#ping) s += this.#pingNow();
    return s;
  }

  /**
   * Asks the terminal to answer (DA1) with the next flush: its pong says it
   * has taken what was written before it, so a program can measure what a
   * frame costs. One at a time. Without a flush within 100 ms, the ping
   * goes on its own.
   */
  ping(): void {
    if (this.#ping || this.#closed) return;
    this.#ping = true;
    this.#pingTimer = this.link.clock.setTimeout(() => {
      if (this.#ping) this.link.send(this.#pingNow());
    }, PING_WAIT);
  }

  // The ping's DA1, now: what it writes, and the wait for its answer.
  #pingNow(): string {
    this.#ping = false;
    const clock = this.link.clock;
    clock.clearTimeout(this.#pingTimer);
    const t0 = clock.now();
    this.link.awaitDa1().then(
      () => this.#onMessage({ kind: "pong", took: clock.now() - t0 }),
      () => {},
    );
    return "\x1b[c";
  }

  /**
   * Reads what the framework writes on its way out, a piece at a time, as
   * it goes, and asks for a new layout (relayout) after erase in display
   * (2 or 3), scroll up or down, insert or delete lines, a new scrolling
   * region, reverse index, leaving the alternate screen, or a full reset.
   * A full reset deletes every surface, so after one the next layout sends
   * the documents again, and the relayout says the host lost them (lost).
   */
  watch(output: string | Uint8Array): void {
    const seen = this.#watch.scan(output);
    if (seen === "reset") this.#reset = true;
    if (seen) this.#due();
  }

  /** The bytes watch has read. */
  get watched(): number {
    return this.#watch.written;
  }

  /**
   * The environment redrew, so the host may have dropped placements: an
   * environment that knows its own redraws (an editor) says so here instead
   * of handing over its output.
   */
  relayout(): void {
    this.#due();
  }

  // A relayout, once, after what is being written now: never from inside the
  // framework's write.
  #due() {
    if (this.#relayoutDue) return;
    this.#relayoutDue = true;
    queueMicrotask(() => {
      this.#relayoutDue = false;
      const reset = this.#reset;
      this.#reset = false;
      if (this.mode !== "native" || this.#closed) return;
      // A full reset deletes every surface (SPEC §5.4), hidden ones too, and
      // ends the session, with the resources it stored (SPEC §2, §7.1): the
      // next layout sends the documents again, and the program its
      // resources first. No ENOENT will tell it: the placements go with
      // their documents.
      const lost = reset && this.#hasDoc.size > 0;
      if (reset) {
        this.#hasDoc.clear();
        this.#flags.clear();
        this.#refused.clear();
      }
      if (this.#placed.size === 0 && !lost) return;
      if (lost) {
        // Marked like a loss an ENOENT reports, so that the two behave the
        // same: a placement written behind the reset finds its document
        // gone, and its ENOENT is this loss's.
        this.#marking = true;
        this.#markN = 0;
      }
      this.#placed.clear();
      this.counts.relayouts++;
      this.#onMessage({ kind: "relayout", lost });
    });
  }

  /**
   * Ends the Session on the program's way out: it deletes every surface it
   * sent, and none of anyone else's, and returns what writes the deletes,
   * and the withdrawal of a late query no answer came to (SPEC §4).
   * After it, layout and send do nothing, so that a frame drawn before the
   * program quits does not send a document again.
   */
  close(): string {
    for (const name of this.#names()) this.delete(name);
    const out = this.flush() + this.link.withdrawLate();
    this.#closed = true;
    return out;
  }

  /**
   * Detaches every surface the Session has sent (SPEC §5.5), for a program
   * that leaves them on the screen when it quits, rather than close. They
   * stop reporting to whatever reads the terminal after the program. It
   * leaves with the next flush.
   */
  detachAll(): void {
    this.send(...this.#names().map((n) => detach(n)));
  }
}

// Scans output for what can take placements with it, keeping its parser
// state across writes, since a sequence can be split between two. A full
// reset takes the documents too.
class Watcher {
  written = 0;
  #state = 0; // 0 ground, 'e' after ESC, '[' in a CSI, ']' in a string
  #private = "";
  #param = "";
  #strEsc = false;

  scan(p: string | Uint8Array): "" | "relayout" | "reset" {
    let hit = false;
    let reset = false;
    const n = p.length;
    this.written += typeof p === "string" ? new TextEncoder().encode(p).length : n;
    for (let i = 0; i < n; i++) {
      const c = typeof p === "string" ? p.charCodeAt(i) : p[i]!;
      switch (this.#state) {
        case 0:
          if (c === 0x1b) this.#state = 0x65;
          break;
        case 0x65: // after ESC
          if (c === 0x5b) {
            this.#state = 0x5b;
            this.#private = "";
            this.#param = "";
          } else if (c === 0x5d || c === 0x50 || c === 0x5f || c === 0x5e || c === 0x58) {
            this.#state = 0x5d; // OSC, DCS, APC, PM, SOS: skip to ST
            this.#strEsc = false;
          } else {
            // RI scrolls at the top margin; RIS resets everything.
            if (c === 0x4d) hit = true;
            else if (c === 0x63) reset = true;
            this.#state = 0;
          }
          break;
        case 0x5b: // CSI
          if (c >= 0x40 && c <= 0x7e) {
            const f = String.fromCharCode(c);
            if (this.#private === "") {
              if (f === "J") hit ||= this.#param === "2" || this.#param === "3";
              else if ("STLMr".includes(f)) hit = true;
            } else if (this.#private === "?" && f === "l") {
              // Leaving the alternate screen.
              hit ||= this.#param.split(";").some((m) => m === "1049" || m === "1047" || m === "47");
            }
            this.#state = 0;
          } else if (c === 0x3f || c === 0x3e || c === 0x3d || c === 0x3c) {
            this.#private = String.fromCharCode(c);
          } else if (this.#param.length < 32) {
            this.#param += String.fromCharCode(c);
          }
          break;
        case 0x5d:
          if (c === 0x07 || (this.#strEsc && c === 0x5c)) this.#state = 0;
          else this.#strEsc = c === 0x1b;
          break;
      }
    }
    return reset ? "reset" : hit ? "relayout" : "";
  }
}
