// A HOTTY host that runs inside a test (SDK.md §4.4).

import { CAPS, DETAIL, ERROR } from "../bodies.ts";
import { MAX_SIZE, OPS, VERSION } from "../constants.ts";
import { DEFAULT_MAX, Decoder } from "../decoder.ts";
import { encode } from "../encode.ts";
import { Field } from "../field.ts";
import { INSERT, parseKey, parseKeymap, resolve as resolveKeymap } from "../keys.ts";
import { type Area, Caps, type CapsBody, type Event, type Message } from "../messages.ts";
import { pack } from "../msgpack.ts";
import { validName } from "../names.ts";
import {
  attr,
  box,
  closest,
  control,
  find,
  focusable,
  hyperlink,
  isElement,
  listens,
  reportsClick,
  Surface,
  submits,
  textOf,
  walk,
} from "./dom.ts";
import { editingHost, keymaps, keySequence, keyText, splitName, textField, textInput } from "./keys.ts";
import { Screen } from "./screen.ts";

type El = NonNullable<ReturnType<Surface["byId"]>>;
type AnyNode = Parameters<typeof walk>[0];

/** Why a user's action could not be done, or the program broke the protocol. */
export type HostErrorCode =
  | "protocol" // the program broke the protocol (a strict host)
  | "not-host" // the terminal is not a HOTTY host
  | "no-surface"
  | "no-element"
  | "detached" // the surface is detached, and reports nothing
  | "not-placed"
  | "no-press" // the placement did not ask for presses
  | "not-control" // the element is not a control that takes this
  | "no-report" // nothing with an id reports this click
  | "no-drag" // no drag is in progress
  | "dragging"; // a drag is already in progress

/** An error of the test host: a user's action it could not do, or the program's protocol error. */
export class HostError extends Error {
  readonly code: HostErrorCode;
  constructor(code: HostErrorCode, message: string) {
    super("hotty test host: " + message);
    this.name = "HostError";
    this.code = code;
  }
}

/** The capabilities a Host reports unless its options say otherwise. */
export function defaultCaps(): CapsBody {
  return {
    v: VERSION,
    ops: [...OPS],
    events: ["click", "change", "input", "submit", "press", "focus", "blur", "resize", "drag", "fit", "hover"],
    cell: { w: 9, h: 18 },
    scale: 1,
    scheme: "dark",
    limits: { surfaces: 64, message: DEFAULT_MAX },
    scroll: true,
    count: true,
    host: "hotty-ts-test",
  };
}

/** Options of a {@link Host}. */
export interface HostOptions {
  /**
   * Capability fields to report instead of the defaults' ({@link defaultCaps}),
   * each sent as its type (SPEC §4): scale as a float, whole or not. The
   * host speaks VERSION whatever v they give: a query that does not list it
   * gets EVERSION.
   */
  caps?: CapsBody;
  /**
   * A terminal that is not a HOTTY host: it answers DA1 and the cursor's
   * position, and ignores HOTTY, until becomeHost.
   */
  text?: boolean;
  /**
   * Record protocol errors (errors()) instead of throwing them from write: a
   * malformed message, one the host refuses as EINVAL, or a HOTTY command
   * other than the query sent to a terminal that is not a host.
   */
  lenient?: boolean;
  /** Answer the kitty graphics query, as a terminal that shows images does. */
  kittyGraphics?: boolean;
  /** The terminal's size in cells; 80 × 24 by default. */
  cols?: number;
  rows?: number;
  /**
   * How many rows a placement with auto rows gets, for its surface laid out
   * cols wide. The default counts the body's lines of text.
   */
  autoRows?: (s: Surface, cols: number) => number;
}

// A drag in progress: the pointer is its surface's until the release.
interface Drag {
  s: Surface;
  start: El; // the element that opted in, where it began
  id: string; // its id
  t: string; // the element under the pointer, as last reported
  c: number;
  r: number; // the cell under the pointer, as last reported
  n: [number, number]; // the element's data-steps when the drag began: none is 0
  x: number;
  y: number; // the step as last reported, along each counted axis
  tn: [number, number]; // t's data-steps as last reported: none is 0
  tx: number;
  ty: number; // the step in t as last reported, along each counted axis
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

// The rows a placement with auto rows gets by default: a row for each line
// of the body's text, wrapped at cols.
function estimateRows(s: Surface, cols: number): number {
  const body = s.body();
  if (!body) return 1;
  let rows = 0;
  for (const line of textOf(body).trim().split("\n")) {
    const n = [...line.trim()].length;
    rows += Math.max(1, Math.ceil(n / Math.max(1, cols)));
  }
  return Math.max(1, rows);
}

/**
 * A HOTTY host for a test: a terminal the program writes to ({@link write})
 * and reads from (it is an async iterable of what the terminal sends). The
 * test then looks at what the program showed, and plays the user.
 *
 * It keeps every surface's document as the program's commands leave it,
 * with the delta operations and the morph of SPEC §6, and answers each
 * command as SPEC §3.6 has hosts do. It lays nothing out and draws no
 * pixels: a placement with auto rows gets an estimate (autoRows), a click
 * or a press reports the area the test gave its element (setArea), a
 * document that asks to scroll records its axes (Surface.scroll), and
 * reveal scrolls nothing. It does not list view: what is in view is a
 * test's to emit.
 *
 * It also answers what terminals answer: Primary Device Attributes, the
 * cursor's position, the background colour, and, when asked to, the kitty
 * graphics query. It keeps the cells the program printed (screen, lines)
 * and where it left the cursor. A placement made on the alternate screen
 * goes with it, and so does its surface; a full reset deletes every
 * surface (SPEC §5.4).
 */
export class Host implements AsyncIterable<Uint8Array> {
  readonly cols: number;
  readonly rows: number;
  readonly #caps: CapsBody;
  #text: boolean;
  #late: Message | undefined; // a query asking for a late answer, held while not a host
  readonly #lenient: boolean;
  readonly #kitty: boolean;
  readonly #autoRows: (s: Surface, cols: number) => number;

  // What the program writes, parsed as it comes.
  #state = 0; // 0 text, 'e' after ESC, '[' CSI, ']' OSC, 'P' another string
  #seq: number[] = [];
  #partial: number[] = []; // the start of a UTF-8 character split between writes
  #dec = new Decoder();
  #invalid = 0;
  #output: Uint8Array[] = [];
  #scr: Screen;
  #main: Screen | undefined; // the main screen, while the alternate one is on
  #hidden = false; // the cursor is not on show (DECTCEM)

  #surfaces = new Map<string, Surface>();
  #created = 0;
  #res = new Map<string, { mime: string; data: Uint8Array }>();
  #keyboard: Surface | undefined; // the surface that has the keyboard
  #drag: Drag | undefined; // the drag in progress (SPEC §9.1)
  #hovered: Surface | undefined; // the surface the pointer is on
  #alt = false;
  #commands: Message[] = [];
  #replies: Message[] = [];
  #events: Event[] = [];
  #opened: string[] = [];
  #errs: string[] = [];
  #newErrs: string[] = [];

  // The program's input: what the host sent, not read yet.
  #in: Uint8Array[] = [];
  #closed = false;
  #wake: (() => void) | undefined;

  constructor(options: HostOptions = {}) {
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    this.#caps = { ...defaultCaps(), ...options.caps };
    // What the program sends is decoded with at most the limit the host
    // reports as limits.message (SPEC §13), DEFAULT_MAX when the caps name
    // none.
    const message = this.#caps.limits?.message ?? 0;
    this.#dec.max = message > 0 ? message : DEFAULT_MAX;
    if (!(message > 0)) this.#caps.limits = { ...this.#caps.limits, message: DEFAULT_MAX };
    this.#text = options.text ?? false;
    this.#lenient = options.lenient ?? false;
    this.#kitty = options.kittyGraphics ?? false;
    this.#autoRows = options.autoRows ?? estimateRows;
    this.#scr = new Screen(this.cols, this.rows);
  }

  /** The capabilities the host reports. */
  get caps(): Caps {
    return new Caps(this.#caps);
  }

  /** Whether the terminal is a HOTTY host: false when made with text, until becomeHost. */
  get host(): boolean {
    return !this.#text;
  }

  /**
   * Makes a terminal made with text a host from now on, as a terminal
   * attaching to a multiplexer's pane does (SDK.md §4.4): it answers the
   * query that asked for a late answer and was not answered, if one was
   * sent and not withdrawn (SPEC §4), and every command after.
   */
  becomeHost(): void {
    if (!this.#text) return;
    this.#text = false;
    const q = this.#late;
    this.#late = undefined;
    if (q) this.#command(q);
  }

  // --- the terminal's two sides ------------------------------------------------

  #send(s: string) {
    if (this.#closed) return;
    this.#in.push(utf8.encode(s));
    this.#wake?.();
  }

  /**
   * What the host has sent the program and nothing has read, taken now: for
   * a test that hands a program its input itself.
   */
  take(): Uint8Array {
    const out = new Uint8Array(this.buffered);
    let o = 0;
    for (const b of this.#in) {
      out.set(b, o);
      o += b.length;
    }
    this.#in = [];
    return out;
  }

  /** How many bytes the host has sent that the program has not read. */
  get buffered(): number {
    return this.#in.reduce((n, b) => n + b.length, 0);
  }

  /** The program's input: answers, events and keys, as a terminal sends them, until close. */
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      if (this.#in.length > 0) {
        yield this.take();
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }

  /** Ends the program's input, once it has read what was sent. */
  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  /** Sends text to the program as keys typed: "q", "\r" for Enter, "\x03" for Ctrl-C, "\x1b" for Escape. */
  type(keys: string): void {
    this.#send(keys);
  }

  /**
   * The program's output. It is parsed as it comes: HOTTY commands are
   * carried out and answered, the terminal's queries answered, and the rest
   * kept as cells. A strict host throws a HostError, once the whole write
   * is taken, for a protocol error in it.
   */
  write(data: string | Uint8Array): boolean {
    const b = typeof data === "string" ? utf8.encode(data) : data;
    this.#output.push(b.slice());
    for (const c of b) this.#byte(c);
    const errs = this.#newErrs;
    this.#newErrs = [];
    if (errs.length > 0 && !this.#lenient) throw new HostError("protocol", errs.join("; "));
    return true;
  }

  #byte(c: number) {
    switch (this.#state) {
      case 0:
        if (c === 0x1b) this.#state = 0x65; // 'e'
        else if (c < 0x20 || c === 0x7f) this.#scr.control(c);
        else this.#printable(c);
        return;
      case 0x65: // after ESC
        this.#state = 0;
        switch (c) {
          case 0x5b: // [
            this.#state = 0x5b;
            this.#seq = [];
            return;
          case 0x5d: // ]
            this.#state = 0x5d;
            this.#seq = [0x1b, 0x5d];
            return;
          case 0x50: // P, _, ^, X: strings
          case 0x5f:
          case 0x5e:
          case 0x58:
            this.#state = 0x50;
            this.#seq = [0x1b, c];
            return;
          case 0x37: // 7
            this.#scr.save();
            return;
          case 0x38: // 8
            this.#scr.restore();
            return;
          case 0x44: // D
            this.#scr.index();
            return;
          case 0x45: // E
            this.#scr.index();
            this.#scr.col = 0;
            return;
          case 0x4d: // M
            this.#scr.reverseIndex();
            return;
          case 0x63: // c
            this.#reset();
            return;
        }
        return;
      case 0x5b: // CSI
        if (c >= 0x40 && c <= 0x7e) {
          this.#state = 0;
          this.#csi(String.fromCharCode(...this.#seq), String.fromCharCode(c));
          return;
        }
        this.#seq.push(c);
        return;
      case 0x5d: // OSC
      case 0x50: {
        const seq = this.#seq;
        seq.push(c);
        const n = seq.length;
        if ((this.#state === 0x5d && c === 0x07) || (n >= 2 && seq[n - 2] === 0x1b && c === 0x5c)) {
          const kind = this.#state;
          this.#state = 0;
          const s = binary(seq);
          if (kind === 0x5d) this.#osc(s);
          else this.#str(s);
        }
        return;
      }
    }
  }

  #printable(c: number) {
    const p = this.#partial;
    p.push(c);
    const want = p[0]! < 0x80 ? 1 : p[0]! >= 0xf0 ? 4 : p[0]! >= 0xe0 ? 3 : 2;
    if (p.length < want) return;
    this.#partial = [];
    this.#scr.put(fromUtf8.decode(new Uint8Array(p)));
  }

  // Enters or leaves the alternate screen. A placement made there belongs
  // to it: leaving deletes its surface (SPEC §5.4, SHOULD).
  #altScreen(on: boolean) {
    if (!on && this.#alt) {
      for (const [name, s] of this.#surfaces) {
        if (s.placed && s.alt) {
          if (this.#keyboard === s) this.#keyboard = undefined;
          this.#surfaces.delete(name);
        }
      }
    }
    if (on && !this.#alt) {
      this.#main = this.#scr;
      this.#scr = new Screen(this.cols, this.rows, true);
    } else if (!on && this.#alt) {
      this.#scr = this.#main!;
    }
    this.#alt = on;
  }

  // RIS: a full reset deletes every surface (SPEC §5.4), and forgets a
  // held late query (§4).
  #reset() {
    this.#late = undefined;
    this.#surfaces.clear();
    this.#keyboard = undefined;
    this.#scr = new Screen(this.cols, this.rows);
    this.#alt = false;
    this.#hidden = false;
  }

  #cursorReport(): string {
    return `${this.#scr.row - this.#scr.top + 1};${Math.min(this.#scr.col, this.cols - 1) + 1}`;
  }

  #csi(params: string, final: string) {
    if (final === "c" && (params === "" || params === "0")) this.#send("\x1b[?62;22c");
    else if (final === "n" && params === "6") this.#send(`\x1b[${this.#cursorReport()}R`);
    else if (final === "n" && params === "?6") this.#send(`\x1b[?${this.#cursorReport()}R`);
    else if ((final === "h" || final === "l") && ["?1049", "?1047", "?47"].includes(params)) this.#altScreen(final === "h");
    else if ((final === "h" || final === "l") && params === "?25") this.#hidden = final === "l";
    else this.#scr.csi(params, final);
  }

  // The kitty graphics query: a=q on an image id.
  #str(seq: string) {
    if (!this.#kitty || !seq.startsWith("\x1b_G")) return;
    const ctl = seq.slice(3).replace(/\x1b\\$/, "").split(";")[0]!;
    let id = "";
    let query = false;
    for (const kv of ctl.split(",")) {
      const [k, v = ""] = kv.split("=");
      if (k === "i") id = v;
      if (k === "a") query = v === "q";
    }
    if (query && id) this.#send(`\x1b_Gi=${id};OK\x1b\\`);
  }

  #osc(seq: string) {
    if (seq.startsWith("\x1b]11;?")) {
      this.#send("\x1b]11;" + (this.caps.light() ? "rgb:ffff/ffff/ffff" : "rgb:1212/1212/1a1a") + "\x1b\\");
      return;
    }
    const before = this.#dec.invalid;
    const f = this.#dec.feed(seq);
    if (this.#dec.invalid > before) {
      this.#invalid += this.#dec.invalid - before;
      this.#protocol(`a malformed HOTTY message (SPEC §3.7): ${JSON.stringify(seq.slice(0, 80))}`);
    }
    if (f.result !== "complete") return;
    const m = f.message;
    this.#commands.push(m);
    if (this.#text) {
      if (m.get("a") !== "q") this.#protocol(`a HOTTY command to a terminal that is not a host (SPEC §14): ${ctlString(m)}`);
      // One query held at a time: any other takes its place (SPEC §4).
      else this.#late = m.get("late") === "1" && m.get("q") !== "2" ? m : undefined;
      return;
    }
    this.#command(m);
  }

  #protocol(msg: string) {
    this.#errs.push(msg);
    this.#newErrs.push(msg);
  }

  // --- commands ---------------------------------------------------------------

  // Carries out one command and answers it (SPEC §3.6).
  #command(m: Message) {
    const a = m.get("a") ?? "";
    const { code, detail, extra } = this.#do(a, m);
    if (code === "EINVAL") this.#protocol(`${a} refused: EINVAL (${detail}): ${ctlString(m)}`);
    const q = m.get("q");
    if (!(q === "2" || (q === "1" && !code))) {
      const ctl: [string, string][] = [["a", code ? "err" : "ok"]];
      const n = m.get("n");
      if (n !== undefined) ctl.push(["n", n]);
      const s = m.get("s");
      if (s !== undefined) ctl.push(["s", s]);
      ctl.push(["re", a], ...extra);
      let payload: Uint8Array | undefined;
      if (code) payload = pack({ code, detail }, ERROR);
      else if (a === "q") payload = pack(this.#caps, CAPS);
      this.#reply(encode(ctl, payload));
    }
    // After the reply: the host lays the document out on its next frame,
    // and fit comes from that layout.
    if (!code) this.#refit(a, m);
  }

  #reply(enc: string) {
    const f = new Decoder().feed(enc);
    if (f.result === "complete") {
      if (f.message.reply()) this.#replies.push(f.message);
      const ev = f.message.event();
      if (ev) this.#events.push(ev);
    }
    this.#send(enc);
  }

  #do(a: string, m: Message): { code?: string; detail?: string; extra: [string, string][] } {
    const ok = { extra: [] as [string, string][] };
    const err = (code: string, detail: string) => ({ code, detail, extra: [] as [string, string][] });
    // This host speaks VERSION only (SPEC §4): it answers a query that lists
    // it, in whatever order and among whatever others, and any other with
    // EVERSION and the version it speaks.
    if (a === "q") return (m.get("v") ?? "").split(",").includes(VERSION) ? ok : err("EVERSION", VERSION);
    if (a === "res") {
      const id = m.get("id");
      if (!id) return err("EINVAL", "missing id");
      const old = this.#res.get(id);
      const limit = this.#caps.limits?.resources ?? 0;
      if (limit > 0 && this.#resBytes() - (old?.data.length ?? 0) + m.payload.length > limit) return err("EQUOTA", "resources");
      this.#res.set(id, { mime: m.get("type") ?? "", data: m.payload });
      return ok;
    }
    if (a === "del") {
      const id = m.get("id");
      if (id !== undefined && !m.get("s")) {
        this.#res.delete(id);
        return ok;
      }
      if (m.get("s") === undefined) {
        this.#surfaces.clear();
        this.#keyboard = undefined;
        return ok;
      }
    }
    if (!["doc", "place", "hide", "delta", "del", "detach", "focus", "blur"].includes(a)) return err("EINVAL", "unknown action " + a);
    const name = m.get("s");
    if (name === undefined || !validName(name)) return err("EINVAL", "bad surface name");
    let s = this.#surfaces.get(name);
    if (a === "doc") {
      const markup = m.text();
      if (!s) {
        const limit = this.#caps.limits?.surfaces ?? 0;
        if (limit > 0 && this.#surfaces.size >= limit) return err("EQUOTA", "surfaces");
        s = new Surface(name, markup, ++this.#created);
        this.#surfaces.set(name, s);
      } else {
        if (this.#keyboard === s) this.#keyboard = undefined;
        if (this.#drag?.s === s) {
          if (m.get("d") === "1") this.#drag = undefined; // detached: it reports nothing more
          else this.#cutDrag(); // a new document ends it
        }
        s.setDoc(markup);
      }
      s.detached = m.get("d") === "1";
      // Like d, scroll belongs to the document; a host without it ignores it.
      const axes = m.get("scroll");
      s.scroll = this.#caps.scroll === true && (axes === "1" || axes === "2" || axes === "3") ? Number(axes) : 0;
      return ok;
    }
    if (!s) return err("ENOENT", "no surface " + name);
    switch (a) {
      case "place":
        return this.#place(s, m);
      case "hide":
        if (this.#drag?.s === s) this.#cutDrag();
        if (s.placed && this.#keyboard === s) this.#blur(s);
        s.placed = false;
        s.heard = undefined;
        return ok;
      case "delta": {
        const op = m.get("op") || "morph";
        if (!(OPS as readonly string[]).includes(op)) return err("EINVAL", "unknown op " + op);
        const t = m.get("t") ?? "";
        const k = m.get("k") ?? "";
        if (t === "" && op !== "morph") return err("EINVAL", "missing t");
        if (k === "" && (op === "attr" || op === "unattr" || op === "var")) return err("EINVAL", "missing k");
        const out = s.delta(op, t, k, m.text());
        if (this.#keyboard === s && !s.keyb) this.#keyboard = undefined; // the focused element went
        return out ? err(out.code, out.detail) : ok;
      }
      case "del":
        if (this.#keyboard === s) this.#keyboard = undefined;
        if (this.#drag?.s === s) this.#drag = undefined; // it reports nothing more
        this.#surfaces.delete(name);
        return ok;
      case "detach":
        if (this.#keyboard === s) this.#keyboard = undefined; // back to the terminal, with no blur
        if (this.#drag?.s === s) this.#drag = undefined;
        s.detached = true;
        s.keyb = false;
        return ok;
      case "focus": {
        if (s.detached) return err("EDETACHED", name);
        let el: El | undefined;
        const t = m.get("t");
        if (t) {
          el = s.byId(t);
          if (!el) return err("ENOTARGET", t);
        } else if (s.focusedNode) {
          el = s.focusedNode;
        } else {
          const f = find(s.doc, (n) => isElement(n) && focusable(n));
          el = isElement(f) ? f : undefined;
        }
        // No focus event for focus the program gave (SPEC §10.1).
        this.#takeKeyboard(s, el, false);
        return ok;
      }
      case "blur":
        if (!s.detached && this.#keyboard === s) this.#blur(s);
        return ok;
    }
    return ok;
  }

  #resBytes(): number {
    let n = 0;
    for (const r of this.#res.values()) n += r.data.length;
    return n;
  }

  #place(s: Surface, m: Message): { code?: string; detail?: string; extra: [string, string][] } {
    const err = (detail: string) => ({ code: "EINVAL", detail, extra: [] as [string, string][] });
    const num = (k: string, def: number, lo: number, hi: number): number | undefined => {
      const v = m.get(k);
      if (v === undefined) return def;
      if (!/^-?\d+$/.test(v)) return undefined;
      const n = Number(v);
      return n >= lo && n <= hi ? n : undefined;
    };
    if (m.get("c") === undefined) return err("missing c");
    const c = num("c", 0, 1, MAX_SIZE);
    if (c === undefined) return err("c out of range");
    let r = 0;
    const rv = m.get("r");
    if (rv !== undefined && rv !== "" && rv !== "auto") {
      const n = num("r", 0, 1, MAX_SIZE);
      if (n === undefined) return err("r out of range");
      r = n;
    }
    if (r === 0) r = Math.max(1, Math.min(MAX_SIZE, this.#autoRows(s, c)));
    const x = num("x", 0, 0, MAX_SIZE);
    const y = num("y", 0, 0, MAX_SIZE);
    const w = x === undefined ? undefined : num("w", c - x, 1, MAX_SIZE);
    const h = y === undefined ? undefined : num("h", r - y, 1, MAX_SIZE);
    if (x === undefined || y === undefined || w === undefined || h === undefined || x + w > c || y + h > r || w < 1 || h < 1) {
      return err("window out of the surface");
    }
    const z = num("z", 0, -1000, 1000);
    if (z === undefined) return err("z out of range");
    s.placed = true;
    s.placement = {
      cols: c,
      rows: r,
      z,
      press: m.get("p") === "1",
      fit: m.get("f") === "1",
      hover: m.get("v") === "1",
      keepCursor: m.get("C") === "1",
    };
    if (!s.placement.hover) s.heard = undefined; // v=1 again starts from out (SPEC §9.4)
    s.fitRows = r;
    if (["x", "y", "w", "h"].some((k) => m.get(k) !== undefined)) s.placement.window = { x, y, w, h };
    s.col = this.#scr.col;
    s.row = this.#scr.row;
    s.alt = this.#alt;
    if (!s.placement.keepCursor) {
      // As if by h times IND, then CR.
      for (let i = 0; i < h; i++) this.#scr.index();
      this.#scr.col = 0;
    }
    return { extra: [["c", String(c)], ["r", String(r)]] };
  }

  // --- events -------------------------------------------------------------------

  // Sends fit to each surface a command may have changed the height of whose
  // placement asked for it (SPEC §5.2): the rows its document needs now,
  // when they differ from the rows it last heard. A resource can change any
  // document that refers to it, so it checks all.
  #refit(a: string, m: Message) {
    let check: Surface[] = [];
    if (a === "res") check = [...this.#surfaces.keys()].sort().map((k) => this.#surfaces.get(k)!);
    else if (a === "doc" || a === "delta" || a === "place") {
      const s = this.#surfaces.get(m.get("s") ?? "");
      if (s) check = [s];
    }
    for (const s of check) {
      if (!s.placed || !s.placement.fit || s.detached) continue;
      const n = Math.max(1, Math.min(MAX_SIZE, this.#autoRows(s, s.placement.cols)));
      if (n !== s.fitRows) {
        s.fitRows = n;
        this.#event(s, "fit", "", { r: n });
      }
    }
  }

  // Sends an event, its detail written as its kind's type: resize's w and
  // h go out as floats, whole or not.
  #event(s: Surface, kind: string, target: string, detail?: unknown) {
    const ctl: [string, string][] = [["a", "ev"], ["s", s.name], ["e", kind], ["t", target]];
    this.#reply(encode(ctl, detail === undefined ? undefined : pack(detail, DETAIL.get(kind))));
  }

  // Gives a surface the keyboard at el, taking it from another (which sends
  // blur), and committing the control that loses focus. Focus the user
  // moves (report) is reported each time it lands on another element, named
  // by the nearest id from el outward (SPEC §10.1); the program's is not.
  #takeKeyboard(s: Surface, el: El | undefined, report: boolean) {
    if (this.#keyboard && this.#keyboard !== s) this.#blur(this.#keyboard);
    if (s.keyb && s.focusedNode !== el) this.#commit(s);
    const had = s.keyb;
    const was = s.focusedNode;
    s.focusedNode = el;
    s.keyb = true;
    this.#keyboard = s;
    if (report && (!had || was !== el)) {
      const n = closest(el, (n) => (attr(n, "id") ?? "") !== "");
      this.#event(s, "focus", n ? attr(n, "id")! : "");
    }
  }

  // Sends change for the focused text control, if the user edited it since
  // its last commit.
  #commit(s: Surface) {
    const el = s.focusedNode;
    if (!el || !s.edited.has(el)) return;
    s.edited.delete(el);
    const id = attr(el, "id");
    if (id !== undefined && !s.detached) this.#event(s, "change", id, { value: s.valueOf(el) });
  }

  #blur(s: Surface) {
    if (s.keyb) this.#commit(s);
    s.keyb = false;
    if (this.#keyboard === s) this.#keyboard = undefined;
    this.#event(s, "blur", "");
  }

  // A surface the user can act in.
  #target(surface: string): Surface {
    if (this.#text) throw new HostError("not-host", "the terminal is not a HOTTY host");
    const s = this.#surfaces.get(surface);
    if (!s) throw new HostError("no-surface", `no surface ${surface}`);
    if (!s.placed) throw new HostError("not-placed", `${surface} is not placed`);
    return s;
  }

  #element(s: Surface, id: string): El {
    const n = s.byId(id);
    if (!n) throw new HostError("no-element", `no #${id} in ${s.name}`);
    return n;
  }

  #detachedError(s: Surface): HostError {
    return new HostError("detached", `${s.name} is detached, and reports nothing`);
  }

  // --- the user ----------------------------------------------------------------

  /**
   * Clicks the element with an id, as the user does (SPEC §9): a press
   * first, if the placement asks for presses; the keyboard, if the element
   * takes focus, or else back to the terminal (blur, SPEC §10.1); then
   * click, reported by the nearest element from it outward that reports
   * clicks, if that has an id. A link reports its href; a hyperlink
   * (target=_blank) is opened by the terminal and reports nothing (opened).
   * A submit button then submits its form. On a detached surface it does
   * what is local and throws "detached".
   */
  click(surface: string, id: string): void {
    const s = this.#target(surface);
    this.#click(s, this.#element(s, id));
  }

  /**
   * Clicks the element with an id twice, as a double click does: click,
   * then a click that says it is the second of its run (count 2, SPEC §9).
   */
  doubleClick(surface: string, id: string): void {
    const s = this.#target(surface);
    const el = this.#element(s, id);
    this.#click(s, el);
    this.#click(s, el, true, 2);
  }

  /** Clicks the first link in a surface whose href is href, as written: for links with no id. */
  clickLink(surface: string, href: string): void {
    const s = this.#target(surface);
    const el = find(s.doc, (n) => isElement(n) && n.tagName === "a" && attr(n, "href") === href);
    if (!isElement(el)) throw new HostError("no-element", `no link to ${href} in ${s.name}`);
    this.#click(s, el);
  }

  // A click on el: by the pointer, which presses first, or by the keyboard
  // (key), which does not. count is its place in its run of clicks, which
  // its detail carries from 2 on (SPEC §9).
  #click(s: Surface, el: El, pointer = true, count = 1) {
    const n = count > 1 ? { count } : {};
    const a = closest(el, (n) => n.tagName === "a");
    if (a && attr(a, "href") !== undefined && hyperlink(a)) {
      const u = resolve(s, a);
      if (u) this.#opened.push(u);
      return;
    }
    if (s.detached) throw this.#detachedError(s);
    if (pointer && s.placement.press) this.#pressAt(s, el);
    const f = closest(el, focusable);
    if (f) this.#takeKeyboard(s, f, true);
    else if (this.#keyboard) this.#blur(this.#keyboard); // a click on what takes no focus (SPEC §10.1)
    const rep = closest(el, reportsClick);
    if (!rep) throw new HostError("no-report", "nothing with an id reports this click");
    const href = rep.tagName === "a" ? attr(rep, "href") : undefined;
    if (href !== undefined) {
      // The href is the handle, and the id too when there is one.
      const u = resolve(s, rep);
      const id = attr(rep, "id") ?? "";
      this.#event(s, "click", id, { href, ...(u ? { url: u } : {}), ...areaOf(s, id), ...n });
      return;
    }
    const rid = attr(rep, "id");
    if (rid === undefined) throw new HostError("no-report", "nothing with an id reports this click");
    const v = attr(rep, "value");
    const detail = { ...(v === undefined ? {} : { value: v }), ...areaOf(s, rid), ...n };
    this.#event(s, "click", rid, Object.keys(detail).length > 0 ? detail : undefined);
    if (submits(rep)) {
      const form = closest(rep, (n) => n.tagName === "form");
      if (form) this.#submit(s, form, rep);
    }
  }

  /**
   * Presses the element with an id, or empty space (""), with the primary
   * button (SPEC §9): reported only on a placement made with press, as the
   * id of the nearest element with one.
   */
  press(surface: string, id: string): void {
    const s = this.#target(surface);
    const el = id === "" ? undefined : this.#element(s, id);
    if (s.detached) throw this.#detachedError(s);
    if (!s.placement.press) throw new HostError("no-press", "the placement did not ask for presses");
    this.#pressAt(s, el);
  }

  #pressAt(s: Surface, el: El | undefined) {
    const n = closest(el, (n) => attr(n, "id") !== undefined);
    const id = n ? attr(n, "id")! : "";
    const area = areaOf(s, id);
    this.#event(s, "press", id, area.area ? area : undefined);
  }

  /**
   * Says where an element is, in the surface's cells, for the area a click
   * or a press on it reports (SPEC §9): the host lays nothing out, so it
   * knows only what the test tells it. undefined forgets it. An element with
   * none reports no area.
   */
  setArea(surface: string, id: string, area: Area | undefined): void {
    const s = this.#target(surface);
    if (area) s.areas.set(id, { ...area });
    else s.areas.delete(id);
  }

  /**
   * Types text into a text control, as the user does: the surface takes the
   * keyboard there (focus, if it did not have it), the control's value
   * becomes text (input, with data-on~=input), with the caret at its end and
   * nothing selected, and the change is committed when focus leaves it
   * (blur, another control, submit).
   */
  fill(surface: string, id: string, text: string): void {
    const s = this.#target(surface);
    const el = this.#element(s, id);
    if (s.detached) throw this.#detachedError(s);
    if (!control(el) || box(el) || !focusable(el)) throw new HostError("not-control", `#${id} is not a text control`);
    this.#takeKeyboard(s, el, true);
    s.fields.delete(el); // the caret starts at the end of the text again
    s.values.set(el, text);
    s.edited.add(el);
    if (listens("input")(el)) this.#event(s, "input", id, { value: text });
  }

  /** Sets a checkbox, or chooses a radio button (on must then be true): change comes at once. */
  check(surface: string, id: string, on: boolean): void {
    const s = this.#target(surface);
    const el = this.#element(s, id);
    if (s.detached) throw this.#detachedError(s);
    if (!box(el) || !focusable(el)) throw new HostError("not-control", `#${id} is not a checkbox or a radio button`);
    const radio = (attr(el, "type") ?? "").toLowerCase() === "radio";
    if (radio && !on) throw new HostError("not-control", "a radio button is unchosen by choosing another");
    this.#takeKeyboard(s, el, true);
    if (radio) {
      const name = attr(el, "name") ?? "";
      const scope: AnyNode = closest(el, (n) => n.tagName === "form") ?? s.doc;
      walk(scope, (n) => {
        if (n === el || !isElement(n) || !box(n)) return;
        if ((attr(n, "type") ?? "").toLowerCase() === "radio" && name !== "" && attr(n, "name") === name) s.checked.set(n, false);
      });
    }
    if (s.isChecked(el) === on) return;
    s.checked.set(el, on);
    this.#event(s, "change", id, { checked: on, value: s.valueOf(el) });
  }

  /** Picks an option of a select by its value, as from its list: input (with data-on~=input) and change come at once. */
  choose(surface: string, id: string, value: string): void {
    const s = this.#target(surface);
    const el = this.#element(s, id);
    if (s.detached) throw this.#detachedError(s);
    if (el.tagName !== "select") throw new HostError("not-control", `#${id} is not a select`);
    let found = false;
    walk(el, (o) => {
      if (isElement(o) && o.tagName === "option") found ||= (attr(o, "value") ?? textOf(o)) === value;
    });
    if (!found) throw new HostError("not-control", `no option ${JSON.stringify(value)}`);
    this.#takeKeyboard(s, el, true);
    this.#pick(s, el, value);
  }

  /**
   * Submits a form, as Enter in one of its fields does: id is the form's,
   * or a control's in it. The control being edited commits first. A form
   * without an id reports nothing.
   */
  submit(surface: string, id: string): void {
    const s = this.#target(surface);
    const el = this.#element(s, id);
    if (s.detached) throw this.#detachedError(s);
    const form = closest(el, (n) => n.tagName === "form");
    if (!form) throw new HostError("not-control", `#${id} is in no form`);
    if (s.keyb) this.#commit(s);
    this.#submit(s, form, undefined);
  }

  // Sends the form's fields as FormData has them: named controls that are
  // not disabled, boxes only when checked, and the submitter's own.
  #submit(s: Surface, form: El, submitter: El | undefined) {
    const fid = attr(form, "id");
    if (fid === undefined) return;
    const fields: Record<string, string> = {};
    walk(form, (n) => {
      if (!isElement(n)) return;
      const name = attr(n, "name");
      if (!name || attr(n, "disabled") !== undefined) return;
      if (n.tagName === "button" || (n.tagName === "input" && reportsClick(n))) {
        if (n === submitter) fields[name] = attr(n, "value") ?? "";
      } else if (box(n)) {
        if (s.isChecked(n)) fields[name] = s.valueOf(n);
      } else if (control(n)) {
        fields[name] = s.valueOf(n);
      }
    });
    this.#event(s, "submit", fid, fields);
  }

  /** Takes the keyboard from a surface, as a click elsewhere does: the control being edited commits, then blur. */
  blur(surface: string): void {
    const s = this.#target(surface);
    if (s.detached) throw this.#detachedError(s);
    if (s.keyb) this.#blur(s);
  }

  // --- keys (SPEC §10.2) ---------------------------------------------------------

  /**
   * Types a key as the user does, and does with it what SPEC §10.2 has a
   * host do while a surface has the keyboard. The key is named as SPEC §10.4
   * names it: a W3C UI Events key value after its modifiers, joined by "+":
   * "a", "A", "Space", "Enter", "Tab", "Shift+Tab", "Backspace",
   * "ArrowDown", "Escape", "Control+s". Returns whether a surface used it.
   *
   * Tab and Shift+Tab move focus among the surface's focusable elements in
   * tree order, those with a negative tabindex and those in an inert subtree
   * left out; past the last, or before the first, the surface loses the
   * keyboard (blur). A text field (a text-like input, a textarea, an editing
   * host) does what its keymap says (resolve, with the `data-keys` of the
   * elements from the root to it): it edits its value at a caret and a
   * selection this host keeps, as a Field does, with input for each edit
   * (data-on~=input); Shift with a move selects (Keymap.selects), and
   * select-all selects the value; submit commits it and submits its form;
   * characters type, in place of the selection.
   *
   * Any other element has a keymap too, read the same way but with no
   * default keymap (Keymap.program): a key it binds to `program` reaches the
   * program, and its other bindings do nothing. The element takes the other
   * keys of its row of the table, unmodified or with Shift only:
   * - a button, a link, a summary: Space and Enter click it;
   * - a checkbox or a radio button: Space checks it, Enter submits its form;
   * - a date or time input: the keys a text input's default keymap binds,
   *   and characters; the arrows up and down and the page keys are used;
   * - a select: the arrows, Home and End pick an option, the page keys as far
   *   as Home and End, a character the next option its label starts, past
   *   disabled ones; a pick sends input (with data-on~=input) and change at
   *   once. Space and Enter do nothing: this host shows no list.
   *
   * With no element focused there is no keymap: the document's `data-keys`
   * are not read, and every key but Tab is the program's.
   *
   * Every other key reaches the program, as typed (type) when it has a
   * terminal encoding here: characters, Enter, Tab, Escape, Backspace, the
   * arrows and the editing keys, and Control or Alt with a character. So
   * does every key while no surface has the keyboard. The host lays nothing
   * out and does not report scroll, so no key scrolls: a key bound to a
   * scroll action goes on as if its keymap did not bind it (SPEC §10.2), and
   * a field's keymap leaves those bindings out.
   */
  key(key: string): boolean {
    const s = this.#keyboard;
    if (s && !s.detached && this.#useKey(s, key)) return true;
    const seq = keySequence(key);
    if (seq !== "") this.#send(seq);
    return false;
  }

  #useKey(s: Surface, key: string): boolean {
    const [mods, name] = splitName(key);
    const shiftOnly = mods.every((m) => m === "Shift");
    if (name === "Tab" && shiftOnly) {
      this.#tab(s, mods.length > 0);
      return true;
    }
    const el = s.focusedNode;
    if (!el) return false; // no element focused, no keymap (SPEC §10.2)
    if (textField(el)) return this.#fieldKey(s, el, key);
    // Any other element's keymap gives keys to the program; its scroll
    // actions do nothing here, where nothing scrolls, and a nearer one takes
    // a key back from a farther program.
    if (parseKeymap(keymaps(el).join(" ")).program(key)) return false;
    if (!shiftOnly) return false;
    if (textInput(el)) {
      // A date or time input.
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(name)) return true;
      return this.#fieldKey(s, el, key);
    }
    if (el.tagName === "select") return this.#selectKey(s, el, name);
    if (box(el)) {
      if (name === " ") this.#toggle(s, el);
      else if (name === "Enter") {
        const form = closest(el, (n) => n.tagName === "form");
        if (form) this.#submit(s, form, undefined);
      } else return false;
      return true;
    }
    if (reportsClick(el) && (el.tagName !== "a" || !hyperlink(el))) {
      if (name !== " " && name !== "Enter") return false;
      try {
        this.#click(s, el, false);
      } catch (e) {
        if (!(e instanceof HostError)) throw e; // nothing with an id reports it
      }
      return true;
    }
    return false;
  }

  // Gives a key to a text field, which does what its keymap says (SPEC
  // §10.2). A date or time input has the default keymap only.
  #fieldKey(s: Surface, el: El, key: string): boolean {
    const multi = el.tagName === "textarea" || editingHost(el);
    let f = s.fields.get(el);
    if (!f) {
      // The caret starts at the end of the value.
      const password = (attr(el, "type") ?? "").toLowerCase() === "password";
      f = new Field({ value: s.valueOf(el), multiline: multi, password });
      s.fields.set(el, f);
    }
    f.value = s.valueOf(el);
    const keys = resolveKeymap(multi, ...(textField(el) ? keymaps(el) : []));
    const a = keys.lookup(key);
    if (a === undefined) return false;
    if (a === "submit") {
      const form = closest(el, (n) => n.tagName === "form");
      if (form) {
        this.#commit(s);
        this.#submit(s, form, undefined);
      }
      return true;
    }
    // No cut with nothing selected, nor in a password field: the key is the
    // program's (SPEC §10.2). This host keeps no clipboard, so a cut only
    // deletes, and a paste is the program's.
    if (a === "cut") {
      const [lo, hi] = f.selection();
      if (lo === hi || f.password) return false;
      if (f.do("delete-char-backward")) this.#typeInto(s, el, f.value);
      return true;
    }
    if (a === "paste") return false;
    const changed = a === INSERT ? f.type(keyText(parseKey(key)!)) : keys.selects(key) ? f.extend(a) : f.do(a);
    if (changed) this.#typeInto(s, el, f.value);
    return true;
  }

  // Moves focus to the next focusable element, or the previous one.
  #tab(s: Surface, back: boolean) {
    const order: El[] = [];
    walk(s.doc, (n) => {
      if (!isElement(n) || !focusable(n) || closest(n, (p) => attr(p, "inert") !== undefined)) return;
      const t = attr(n, "tabindex");
      if (t !== undefined && /^-?\d+$/.test(t) && Number(t) < 0) return;
      order.push(n);
    });
    let i = s.focusedNode ? order.indexOf(s.focusedNode) : -1;
    if (i < 0) i = back ? order.length - 1 : 0;
    else i += back ? -1 : 1;
    if (i < 0 || i >= order.length) this.#blur(s);
    else this.#takeKeyboard(s, order[i]!, true);
  }

  // Sets a text control's value as typing does.
  #typeInto(s: Surface, el: El, v: string) {
    s.values.set(el, v);
    s.edited.add(el);
    const id = attr(el, "id");
    if (id !== undefined && listens("input")(el)) this.#event(s, "input", id, { value: v });
  }

  // Space on a box: a checkbox flips, a radio button is chosen.
  #toggle(s: Surface, el: El) {
    const on = !s.isChecked(el);
    if ((attr(el, "type") ?? "").toLowerCase() === "radio") {
      if (!on) return;
      const name = attr(el, "name") ?? "";
      const scope: AnyNode = closest(el, (n) => n.tagName === "form") ?? s.doc;
      walk(scope, (n) => {
        if (n === el || !isElement(n) || !box(n)) return;
        if ((attr(n, "type") ?? "").toLowerCase() === "radio" && name !== "" && attr(n, "name") === name) s.checked.set(n, false);
      });
    }
    s.checked.set(el, on);
    const id = attr(el, "id");
    if (id !== undefined) this.#event(s, "change", id, { checked: on, value: s.valueOf(el) });
  }

  // A key on a select.
  #selectKey(s: Surface, el: El, name: string): boolean {
    const vals: string[] = [];
    const labels: string[] = [];
    walk(el, (o) => {
      if (!isElement(o) || o.tagName !== "option" || attr(o, "disabled") !== undefined) return;
      vals.push(attr(o, "value") ?? textOf(o));
      labels.push(attr(o, "label") ?? textOf(o));
    });
    const i = vals.indexOf(s.valueOf(el));
    let pick = -1;
    if ([...name].length === 1 && name !== " ") {
      for (let k = 1; k <= vals.length; k++) {
        const j = (i + k) % vals.length;
        if (labels[j]!.toLowerCase().startsWith(name.toLowerCase())) {
          pick = j;
          break;
        }
      }
    } else if (name === "ArrowDown") pick = Math.min(i + 1, vals.length - 1);
    else if (name === "ArrowUp") pick = Math.max(i - 1, 0);
    else if (name === "Home" || name === "PageUp") pick = 0;
    else if (name === "End" || name === "PageDown") pick = vals.length - 1;
    else if (name !== " " && name !== "Enter") return false;
    if (pick >= 0 && pick < vals.length && pick !== i) this.#pick(s, el, vals[pick]!);
    return true;
  }

  // Picks a select's option by its value: input, with data-on~=input, and
  // change come at once, as a browser's select sends them (SPEC §10.2).
  #pick(s: Surface, el: El, v: string) {
    s.values.set(el, v);
    const id = attr(el, "id");
    if (id === undefined) return;
    if (listens("input")(el)) this.#event(s, "input", id, { value: v });
    this.#event(s, "change", id, { value: v });
  }

  /**
   * Presses a mouse's primary button on the element with an id and starts a
   * drag (SPEC §9.1), at the surface's cell c, r, with the modifier keys
   * held. press first, if the placement asks; then dragstart, from the
   * nearest element from it outward with drag in its data-on; then the
   * keyboard, as a click moves it. Throws "no-report", with no drag, if no
   * element with an id opts in. The host lays nothing out, so a test names
   * what is under the pointer: dragMove for each element or cell crossed,
   * then dragEnd.
   */
  dragStart(surface: string, id: string, c: number, r: number, keys: string[] = []): void {
    this.#dragStart(surface, id, c, r, 0, 0, keys);
  }

  /**
   * dragStart on an element with data-steps (SPEC §9.1), with the pointer
   * at step x, y of it. The host lays nothing out, so the test says where in
   * the element the pointer is: a step past the element's count is clamped
   * to it, and one along an axis it does not count is ignored. The host
   * reports steps only when its caps say steps.
   */
  dragStartStep(surface: string, id: string, c: number, r: number, x: number, y: number, keys: string[] = []): void {
    this.#dragStart(surface, id, c, r, x, y, keys);
  }

  #dragStart(surface: string, id: string, c: number, r: number, x: number, y: number, keys: string[]): void {
    const s = this.#target(surface);
    const el = this.#element(s, id);
    if (s.detached) throw this.#detachedError(s);
    if (this.#drag) throw new HostError("dragging", "a drag is already in progress");
    if (s.placement.press) this.#pressAt(s, el);
    const on = closest(el, listens("drag"));
    const rid = attr(on, "id");
    if (on && rid !== undefined) {
      const n: [number, number] = this.#caps.steps === true ? steps(on) : [0, 0];
      const d: Drag = { s, start: on, id: rid, t: rid, c, r, n, x: 0, y: 0, tn: [0, 0], tx: 0, ty: 0 };
      [d.x, d.y] = clampSteps(d.n, x, y);
      this.#drag = d;
      this.#event(s, "dragstart", rid, dragDetail(d, c, r, keys));
    }
    const f = closest(el, focusable);
    if (f) this.#takeKeyboard(s, f, true);
    else if (this.#keyboard) this.#blur(this.#keyboard);
    if (!this.#drag) throw new HostError("no-report", "no element with an id opts in to drags");
  }

  /**
   * Moves the pointer of the drag in progress onto the element with an id in
   * its surface, or onto none (""), at the surface's cell c, r: drag when t,
   * the element under the pointer, changes, and while that is none, when the
   * cell does. t is the nearest element with an id and drag in its data-on,
   * or drop when the caps say drop. In a t with data-steps the pointer stays
   * at the step it was at in t, or 0 in a new one (dragOver).
   */
  dragMove(id: string, c: number, r: number, keys: string[] = []): void {
    const d = this.#current();
    this.#dragMove(id, c, r, d.x, d.y, d.tx, d.ty, keys);
  }

  /**
   * dragMove with the pointer at step x, y of the element the drag began on,
   * wherever the pointer is (dragStartStep): drag also when the step changes.
   */
  dragMoveStep(id: string, c: number, r: number, x: number, y: number, keys: string[] = []): void {
    const d = this.#current();
    this.#dragMove(id, c, r, x, y, d.tx, d.ty, keys);
  }

  /**
   * dragMove with the pointer at step tx, ty of t, for a t with drop in its
   * data-on and data-steps (SPEC §9.1): a row with "0 1" is split in halves, a folder with "0 2"
   * into before, into and after. The host lays nothing out, so the test says
   * where in t the pointer is: a step past t's count is clamped to it, and
   * one along an axis t does not count is ignored. drag also when that step
   * changes. The host reports it only when its caps say drop.
   */
  dragOver(id: string, c: number, r: number, tx: number, ty: number, keys: string[] = []): void {
    const d = this.#current();
    this.#dragMove(id, c, r, d.x, d.y, tx, ty, keys);
  }

  #dragMove(id: string, c: number, r: number, x: number, y: number, tx: number, ty: number, keys: string[]): void {
    const [d, t] = this.#over(id);
    [x, y] = clampSteps(d.n, x, y);
    const tn = this.#targetSteps(d, t);
    [tx, ty] = clampSteps(tn, tx, ty);
    if (t === d.t && (t !== "" || (c === d.c && r === d.r)) && x === d.x && y === d.y && tx === d.tx && ty === d.ty) return;
    Object.assign(d, { t, c, r, x, y, tn, tx, ty });
    this.#event(d.s, "drag", t, dragDetail(d, c, r, keys));
  }

  /**
   * Releases the button of the drag in progress over the element with an id,
   * or none (""): dragend, and the click of the element it began on, if it
   * ends there and reports clicks: the nearest element with an id and drag
   * in its data-on, from the one named outward, is the one it began on,
   * whatever t is.
   */
  dragEnd(id: string, c: number, r: number, keys: string[] = []): void {
    const d = this.#current();
    this.#dragEnd(id, c, r, d.x, d.y, d.tx, d.ty, keys);
  }

  /** dragEnd with the pointer at step x, y of the element the drag began on (dragStartStep). */
  dragEndStep(id: string, c: number, r: number, x: number, y: number, keys: string[] = []): void {
    const d = this.#current();
    this.#dragEnd(id, c, r, x, y, d.tx, d.ty, keys);
  }

  /** dragEnd with the pointer at step tx, ty of t (dragOver). */
  dragEndOver(id: string, c: number, r: number, tx: number, ty: number, keys: string[] = []): void {
    const d = this.#current();
    this.#dragEnd(id, c, r, d.x, d.y, tx, ty, keys);
  }

  #dragEnd(id: string, c: number, r: number, x: number, y: number, tx: number, ty: number, keys: string[]): void {
    const [d, t, own] = this.#over(id);
    [d.x, d.y] = clampSteps(d.n, x, y);
    d.tn = this.#targetSteps(d, t);
    [d.tx, d.ty] = clampSteps(d.tn, tx, ty);
    this.#drag = undefined;
    this.#event(d.s, "dragend", t, dragDetail(d, c, r, keys));
    if (own === d.id && reportsClick(d.start)) {
      const v = attr(d.start, "value");
      this.#event(d.s, "click", d.id, v === undefined ? undefined : { value: v });
    }
  }

  /** Whether a drag is in progress. */
  get dragging(): boolean {
    return this.#drag !== undefined;
  }

  #current(): Drag {
    const d = this.#drag;
    if (!d) throw new HostError("no-drag", "no drag is in progress");
    return d;
  }

  // What is under the pointer of the drag in progress, from the element named
  // outward: t, the nearest element with an id and drag in its data-on, or
  // drop when the caps say drop; and own, the nearest with an id and drag,
  // for whether the release is a click.
  #over(id: string): [Drag, string, string] {
    const d = this.#current();
    if (id === "") return [d, "", ""];
    const el = d.s.byId(id);
    if (!el) throw new HostError("no-element", `no #${id} in ${d.s.name}`);
    const withId = (on: (n: El) => boolean) => attr(closest(el, (n) => attr(n, "id") !== undefined && on(n)), "id") ?? "";
    const own = withId(listens("drag"));
    const t = this.#caps.drop === true ? withId((n) => listens("drag")(n) || listens("drop")(n)) : own;
    return [d, t, own];
  }

  // t's data-steps, when t has drop in its data-on and the caps say drop.
  #targetSteps(d: Drag, t: string): [number, number] {
    const el = t === "" || this.#caps.drop !== true ? undefined : d.s.byId(t);
    return el && listens("drop")(el) ? steps(el) : [0, 0];
  }

  // Ends the drag in progress early (SPEC §9.1): dragend, with no target, the
  // last cell the pointer was on, and no step in t.
  #cutDrag() {
    const d = this.#drag!;
    this.#drag = undefined;
    d.tn = [0, 0];
    this.#event(d.s, "dragend", "", dragDetail(d, d.c, d.r, []));
  }

  /**
   * Moves the pointer onto a placed surface, over the element with an id (or
   * "" for nothing with an id), at the surface's cell c, r. The surface the
   * pointer was on is left first. A placement made with hover hears hover
   * when the element differs from what it heard last.
   */
  hover(surface: string, id: string, c: number, r: number): void {
    const s = this.#target(surface);
    if (id !== "") this.#element(s, id);
    if (this.#hovered && this.#hovered !== s) this.#leave(this.#hovered);
    this.#hovered = s;
    if (s.placement.hover && !s.detached && s.heard !== id) {
      s.heard = id;
      this.#event(s, "hover", id, { c, r });
    }
  }

  /** Takes the pointer off the surface it is on; a placement made with hover hears it is out. */
  unhover(): void {
    if (this.#hovered) {
      this.#leave(this.#hovered);
      this.#hovered = undefined;
    }
  }

  #leave(s: Surface) {
    if (s.placed && s.placement.hover && !s.detached && s.heard !== undefined) {
      s.heard = undefined;
      this.#event(s, "hover", "", { out: true });
    }
  }

  /**
   * Sends any event from a surface, for what the other actions do not
   * cover: a resize, a kind from a later version. The detail goes out as a
   * msgpack map: each field of a kind SPEC §9 lists as its type, so that a
   * resize's `{ w: 320, h: 48 }` is floats, and in any other field a whole
   * number as an int, another number or a `Float` as a float.
   */
  emit(surface: string, kind: string, target: string, detail?: unknown): void {
    if (this.#text) throw new HostError("not-host", "the terminal is not a HOTTY host");
    const s = this.#surfaces.get(surface);
    if (!s) throw new HostError("no-surface", `no surface ${surface}`);
    if (s.detached) throw this.#detachedError(s);
    this.#event(s, kind, target, detail);
  }

  // --- inspection ---------------------------------------------------------------

  /** The surface of a name, undefined when there is none. */
  surface(name: string): Surface | undefined {
    return this.#surfaces.get(name);
  }

  /** The surfaces there are, in the order they were created. */
  surfaces(): Surface[] {
    return [...this.#surfaces.values()].sort((a, b) => a.created - b.created);
  }

  /**
   * The cells the program printed, a line a row, without colours: the main
   * screen with its scrollback, or the alternate screen while it is on.
   * Surfaces are not drawn in it.
   */
  screen(): string {
    return this.#scr.toString();
  }

  /** The screen's text as the program wrote its lines: rows it wrapped onto joined. */
  lines(): string[] {
    return this.#scr.logical();
  }

  /** Where the cursor is (row is a line of screen), and whether it is on show. */
  cursor(): { col: number; row: number; shown: boolean } {
    return { col: Math.min(this.#scr.col, this.cols - 1), row: this.#scr.row, shown: !this.#hidden };
  }

  /** Every byte the program wrote, as text. */
  output(): string {
    const d = new TextDecoder();
    return this.#output.map((b) => d.decode(b, { stream: true })).join("") + d.decode();
  }

  /** The HOTTY messages the program sent, in order. */
  commands(): Message[] {
    return [...this.#commands];
  }

  /** The replies the host sent, in order. */
  replies(): Message[] {
    return [...this.#replies];
  }

  /** The events the host sent the program, in order. */
  events(): Event[] {
    return [...this.#events];
  }

  /** A resource the program stored (SPEC §7.1). */
  resource(id: string): { mime: string; data: Uint8Array } | undefined {
    return this.#res.get(id);
  }

  /** The hyperlinks the user opened (target=_blank), which the terminal opens and never reports. */
  opened(): string[] {
    return [...this.#opened];
  }

  /** The protocol errors the program made. */
  errors(): string[] {
    return [...this.#errs];
  }

  /** The malformed messages the program sent. */
  get invalid(): number {
    return this.#invalid;
  }

  /** The surface that has the keyboard, if any. */
  get keyboard(): Surface | undefined {
    return this.#keyboard;
  }
}

// A sequence's bytes as a string of their codes, as the Decoder takes it.
function binary(b: number[]): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.slice(i, i + 8192));
  return s;
}

function ctlString(m: Message): string {
  return [...m.control].map(([k, v]) => `${k}=${v}`).join(":");
}

// A drag event's detail: the cell, the modifier keys in SPEC §9.1's order,
// and the step along each axis the element counts, and t.
function dragDetail(d: Drag, c: number, r: number, keys: string[]) {
  const detail: Record<string, unknown> = { c, r, keys: ["shift", "ctrl", "alt", "meta"].filter((k) => keys.includes(k)) };
  if (d.n[0] > 0) detail.x = d.x;
  if (d.n[1] > 0) detail.y = d.y;
  if (d.tn[0] > 0) detail.tx = d.tx;
  if (d.tn[1] > 0) detail.ty = d.ty;
  return detail;
}

// A step kept within counts n, 0 along an axis n does not count.
function clampSteps(n: [number, number], x: number, y: number): [number, number] {
  return [Math.min(Math.max(x, 0), n[0]), Math.min(Math.max(y, 0), n[1])];
}

// An element's data-steps (SPEC §9.1): "<x>" or "<x> <y>", whole numbers
// from 0 to 2^53 − 1; anything else is none.
function steps(el: El): [number, number] {
  const f = (attr(el, "data-steps") ?? "").split(/[ \t\n\f\r]+/).filter((v) => v !== "");
  if (f.length < 1 || f.length > 2 || !f.every((v) => /^[0-9]+$/.test(v) && Number.isSafeInteger(Number(v)))) return [0, 0];
  return [Number(f[0]), Number(f[1] ?? 0)];
}

// A link's URL against the document's base (SPEC §7.3), "" when it is under
// https://hotty.invalid/.
function resolve(s: Surface, a: El): string {
  const href = attr(a, "href") ?? "";
  let base = "https://hotty.invalid/";
  const b = find(s.doc, (n) => isElement(n) && n.tagName === "base");
  const bh = attr(b, "href");
  if (bh !== undefined) {
    try {
      const u = new URL(bh);
      if (u.protocol === "http:" || u.protocol === "https:") base = u.href;
    } catch {
      // not a URL: the default base
    }
  }
  try {
    const u = new URL(href, base);
    return u.host === "hotty.invalid" ? "" : u.href;
  } catch {
    return "";
  }
}

// The area a click or a press on the element with this id reports, as a
// detail's field: none for an element the test placed nowhere.
function areaOf(s: Surface, id: string): { area?: Area } {
  const a = id === "" ? undefined : s.areas.get(id);
  return a ? { area: { ...a } } : {};
}
