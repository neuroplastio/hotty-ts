// What the host sends: replies, events and capabilities (SDK.md §3.9).

import type { ErrorCode, EventKind, Op } from "./constants.ts";

const decoder = new TextDecoder();

/** A JSON object, as a detail or capabilities may be. */
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** A control value as a number: undefined when it is not an integer. */
function int(s: string | undefined): number | undefined {
  return s !== undefined && /^-?[0-9]+$/.test(s) ? Number(s) : undefined;
}

/**
 * One HOTTY message, decoded: a reply or an event from the host, or a
 * command from a program (what a host, or a test, decodes). Its control
 * has no `m` or `o`.
 */
export class Message {
  readonly control: ReadonlyMap<string, string>;
  readonly payload: Uint8Array;

  constructor(control: ReadonlyMap<string, string>, payload: Uint8Array) {
    this.control = control;
    this.payload = payload;
  }

  /** A control key's value, or undefined when the message lacks it. */
  get(key: string): string | undefined {
    return this.control.get(key);
  }

  /** The payload as UTF-8 text. */
  text(): string {
    return decoder.decode(this.payload);
  }

  /** The payload as JSON, or undefined when there is none or it is not JSON. */
  json(): unknown {
    if (this.payload.length === 0) return undefined;
    try {
      return JSON.parse(this.text());
    } catch {
      return undefined;
    }
  }

  /** The message as a reply (`a=ok` or `a=err`), or undefined when it is not one. */
  reply(): Reply | undefined {
    const a = this.get("a");
    return a === "ok" || a === "err" ? new Reply(this) : undefined;
  }

  /** The message as an event (`a=ev`), or undefined when it is not one. */
  event(): Event | undefined {
    return this.get("a") === "ev" ? new Event(this) : undefined;
  }
}

/**
 * An error reply (SPEC §3.6), as an Error: what was refused and why,
 * `hotty: delta card: ENOTARGET (go)`.
 */
export class HottyError extends Error {
  /** EINVAL, ENOENT, …; "" when the host gave none. */
  readonly code: ErrorCode | (string & {});
  readonly detail: string | undefined;
  /** The action answered. */
  readonly re: string | undefined;
  readonly surface: string | undefined;

  constructor(code: string, detail?: string, re?: string, surface?: string) {
    let msg = "hotty: " + (re ?? "?");
    if (surface) msg += " " + surface;
    msg += ": " + (code || "error");
    if (detail) msg += " (" + detail + ")";
    super(msg);
    this.name = "HottyError";
    this.code = code;
    this.detail = detail;
    this.re = re;
    this.surface = surface;
  }
}

/** The host's answer to a command (SPEC §3.6). */
export class Reply {
  /** `a=ok`. */
  readonly ok: boolean;
  /** The action answered: "doc", "place", "q", …. */
  readonly re: string | undefined;
  /** The request number, when the command had one. */
  readonly n: number | undefined;
  /** The surface the command named, when it named one. */
  readonly surface: string | undefined;
  /** A placement's size, in a reply to place: with auto rows, the rows the host chose. */
  readonly cols: number | undefined;
  readonly rows: number | undefined;
  /** What went wrong, when not ok. */
  readonly code: ErrorCode | (string & {}) | undefined;
  readonly detail: string | undefined;
  /** The reply as it came. */
  readonly message: Message;

  constructor(m: Message) {
    this.message = m;
    this.ok = m.get("a") === "ok";
    this.re = m.get("re");
    this.n = int(m.get("n"));
    this.surface = m.get("s");
    this.cols = int(m.get("c"));
    this.rows = int(m.get("r"));
    if (!this.ok) {
      const body = m.json();
      if (isObj(body)) {
        if (isStr(body.code)) this.code = body.code;
        if (isStr(body.detail)) this.detail = body.detail;
      }
    }
  }

  /** The capabilities an ok reply to a query carries, or undefined. */
  caps(): Caps | undefined {
    if (!this.ok || this.re !== "q") return undefined;
    const body = this.message.json();
    return new Caps(isObj(body) ? body : {});
  }

  /** The reply as an error, or undefined when ok. */
  err(): HottyError | undefined {
    return this.ok ? undefined : new HottyError(this.code ?? "", this.detail, this.re, this.surface);
  }
}

/** Where a drag's pointer is, and the modifier keys held (SPEC §9.1). */
export interface Drag {
  /** The surface's column and row under the pointer, from 0 at its top left (not its window's); they go on past its edges. */
  c: number;
  r: number;
  /** The modifier keys held: "shift", "ctrl", "alt" and "meta", in that order. */
  keys: string[];
  /**
   * Where in the dragged element the pointer is, for an element with
   * data-steps (SPEC §9.1): a step from 0 to its count, along its width (x)
   * and down its height (y), measured against the element the drag started
   * on wherever the pointer is. Absent along an axis the element does not
   * count; 0 is a step like any other.
   */
  x?: number;
  y?: number;
}

/** Where a hover event says the pointer is (SPEC §9.4). */
export interface Hover {
  /** The surface's cell under the pointer when the element changed; absent when out. */
  c?: number;
  r?: number;
  /** The pointer left the window. */
  out: boolean;
}

/**
 * The cells an element covers, as a click or a press reports them (SPEC §9):
 * from 0 at the surface's top left cell, as a drag's are. An element partly
 * clipped or scrolled away reports its whole area, so c and r may be
 * negative or past the surface.
 */
export interface Area {
  c: number;
  r: number;
  w: number;
  h: number;
}

/** A clicked link (SPEC §9). */
export interface Link {
  /** The href, as the document has it. */
  href: string;
  /** The href resolved against the document's base URL; absent when it resolves to nothing outside the document. */
  url?: string;
}

/** What the user did in a surface (SPEC §9). */
export class Event {
  readonly surface: string;
  /** One of {@link EventKind}, or a kind this SDK does not know, as it came. */
  readonly kind: EventKind | (string & {});
  /** The id of the element that reported; empty when there is none. */
  readonly target: string;
  /** The event as it came. */
  readonly message: Message;
  readonly #d: Obj;

  constructor(m: Message) {
    this.message = m;
    this.surface = m.get("s") ?? "";
    this.kind = m.get("e") ?? "";
    this.target = m.get("t") ?? "";
    const d = m.json();
    this.#d = isObj(d) ? d : {};
  }

  /** The detail, as JSON; undefined when the event carries none. */
  get detail(): unknown {
    return this.message.json();
  }

  /** The detail's value: a control's, or the value attribute of what was clicked. */
  value(): string | undefined {
    const v = this.#d.value;
    return isStr(v) ? v : undefined;
  }

  /** A checkbox's or radio button's state, in a change event. */
  checked(): boolean | undefined {
    const v = this.#d.checked;
    return typeof v === "boolean" ? v : undefined;
  }

  /** A submit's fields by name: a value that is not a string as its JSON, a null left out. */
  fields(): Record<string, string> | undefined {
    if (this.kind !== "submit") return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.#d)) {
      if (v === null) continue;
      out[k] = isStr(v) ? v : JSON.stringify(v);
    }
    return out;
  }

  /** A clicked link: its href, and its url when there is one. */
  link(): Link | undefined {
    const { href, url } = this.#d;
    if (this.kind !== "click" || !isStr(href)) return undefined;
    return isStr(url) ? { href, url } : { href };
  }

  /** A resize's new size, in CSS pixels. */
  size(): { w: number; h: number } | undefined {
    const { w, h } = this.#d;
    if (this.kind !== "resize" || !isNum(w) || !isNum(h)) return undefined;
    return { w, h };
  }

  /** The rows a fit event says the document needs now. */
  fitRows(): number | undefined {
    const r = this.#d.r;
    return this.kind === "fit" && isInt(r) && r >= 1 ? r : undefined;
  }

  /** A dragstart's, drag's or dragend's cell and keys, and its steps. */
  drag(): Drag | undefined {
    if (this.kind !== "dragstart" && this.kind !== "drag" && this.kind !== "dragend") return undefined;
    const { c, r, keys, x, y } = this.#d;
    if (!isInt(c) || !isInt(r)) return undefined;
    const drag: Drag = { c, r, keys: Array.isArray(keys) ? keys.filter(isStr) : [] };
    // A step that is not a whole number is absent, and the rest stands.
    if (isInt(x)) drag.x = x;
    if (isInt(y)) drag.y = y;
    return drag;
  }

  /**
   * A click's or a press's element's cells: where the program places what
   * belongs next to it, such as a select's list. Absent unless c, r, w and
   * h are all whole numbers.
   */
  area(): Area | undefined {
    if (this.kind !== "click" && this.kind !== "press") return undefined;
    const a = this.#d.area;
    if (!isObj(a)) return undefined;
    const { c, r, w, h } = a;
    return isInt(c) && isInt(r) && isInt(w) && isInt(h) ? { c, r, w, h } : undefined;
  }

  /** A hover's cell, or out. The element is the event's target. */
  hover(): Hover | undefined {
    if (this.kind !== "hover") return undefined;
    if (this.#d.out === true) return { out: true };
    const { c, r } = this.#d;
    if (!isInt(c) || !isInt(r)) return undefined;
    return { c, r, out: false };
  }
}

/**
 * What a host says about itself in its reply to a query (SPEC §4). Each
 * field is read on its own: one of an unexpected type is ignored, as one
 * the SDK does not know is (SDK.md §2.7).
 */
export class Caps {
  /** The protocol version the host implements: "0.1". */
  readonly v: string | undefined;
  /** The delta ops it supports; empty when it lists none. */
  readonly ops: string[];
  /** The event kinds it sends; empty when it lists none. */
  readonly events: string[];
  /** A cell's size in device pixels. */
  readonly cell: { w: number; h: number } | undefined;
  /** Device pixels per CSS pixel. */
  readonly scale: number | undefined;
  /** The terminal's colour scheme: "dark" or "light". */
  readonly scheme: string | undefined;
  /** The host's limits, such as surfaces (a count) and resources (bytes) (SPEC §13). */
  readonly limits: Record<string, number>;
  /** The host's network policy, from directive to the sources it allows (SPEC §7.2): empty when it fetches nothing. */
  readonly net: Record<string, string[]>;
  /** Whether the pointer passes through the parts of a surface that take none (SPEC §9.3). */
  readonly passthrough: boolean;
  /** Whether a document can ask to scroll (SPEC §5.1, §5.3); a host that does not say clips. */
  readonly scroll: boolean;
  /** Whether a drag of an element with data-steps says where in it the pointer is (SPEC §9.1). */
  readonly steps: boolean;
  /** A name for the implementation, when it gives one. */
  readonly host: string | undefined;
  /** The implementation's version, with host. */
  readonly version: string | undefined;
  /** The capabilities object as it came. */
  readonly raw: Readonly<Record<string, unknown>>;

  constructor(raw: Record<string, unknown> = {}) {
    this.raw = raw;
    this.v = isStr(raw.v) ? raw.v : undefined;
    this.ops = Array.isArray(raw.ops) ? raw.ops.filter(isStr) : [];
    this.events = Array.isArray(raw.events) ? raw.events.filter(isStr) : [];
    const cell = raw.cell;
    this.cell = isObj(cell) && isNum(cell.w) && isNum(cell.h) ? { w: cell.w, h: cell.h } : undefined;
    this.scale = isNum(raw.scale) ? raw.scale : undefined;
    this.scheme = isStr(raw.scheme) ? raw.scheme : undefined;
    this.limits = {};
    if (isObj(raw.limits)) for (const [k, v] of Object.entries(raw.limits)) if (isInt(v)) this.limits[k] = v;
    this.net = {};
    if (isObj(raw.net)) for (const [k, v] of Object.entries(raw.net)) if (Array.isArray(v)) this.net[k] = v.filter(isStr);
    this.passthrough = raw.passthrough === true;
    this.scroll = raw.scroll === true;
    this.steps = raw.steps === true;
    this.host = isStr(raw.host) ? raw.host : undefined;
    this.version = isStr(raw.version) ? raw.version : undefined;
  }

  /** Whether the host supports a delta op. A host that lists no ops is taken to support them all. */
  supports(op: Op | (string & {})): boolean {
    return this.ops.length === 0 || this.ops.includes(op);
  }

  /**
   * Whether the host sends an event kind; `drag` stands for the three drag
   * kinds. A host that lists no kinds is taken to send them all.
   */
  sends(kind: EventKind | (string & {})): boolean {
    if (kind === "dragstart" || kind === "dragend") kind = "drag";
    return this.events.length === 0 || this.events.includes(kind);
  }

  /**
   * Whether the host sends drags (SPEC §9.1). Unlike sends, a host that
   * lists no kinds is taken not to: drags came after the first hosts, so a
   * program offers another way to do what its drags do.
   */
  drags(): boolean {
    return this.events.includes("drag");
  }

  /** Whether the host sends hover (SPEC §9.4); like drags, not when it lists no kinds. */
  hovers(): boolean {
    return this.events.includes("hover");
  }

  /** Whether the terminal's colour scheme is light. */
  light(): boolean {
    return this.scheme === "light";
  }

  /** A cell's size in CSS pixels: cell divided by scale, and a usual 9 × 18 when the host gave no cell. */
  cellCss(): { w: number; h: number } {
    const s = this.scale !== undefined && this.scale > 0 ? this.scale : 1;
    const c = this.cell;
    if (!c || c.w <= 0 || c.h <= 0) return { w: 9, h: 18 };
    return { w: c.w / s, h: c.h / s };
  }
}
