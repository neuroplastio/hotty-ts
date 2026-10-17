// What the host sends: replies, events and capabilities (SDK.md §3.9).
// Their bodies are msgpack maps (SPEC §3.3), each read whole as its type
// (bodies.ts): one that does not decode leaves absent what it would fill,
// and the message stands.

import { CAPS, DETAIL, ERROR } from "./bodies.ts";
import type { ErrorCode, EventKind, Feature } from "./constants.ts";
import { readBody, unpack } from "./msgpack.ts";

const decoder = new TextDecoder();

/** A body: a msgpack map's fields, by name. */
type Body = Record<string, unknown>;

// A map as unpack gives it, not bin, a time or an array.
const isMap = (v: unknown): v is Body => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

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

  /**
   * The body, one msgpack map (SPEC §3.3), as plain values, whatever their
   * types ({@link unpack}); undefined when there is none, or it is not one
   * map that decodes.
   */
  body(): Body | undefined {
    if (this.payload.length === 0) return undefined;
    try {
      const v = unpack(this.payload);
      return isMap(v) ? v : undefined;
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
  /** The index of the op at fault, from 0, in an error answering a delta (SPEC §6.1). */
  readonly op: number | undefined;

  constructor(code: string, detail?: string, re?: string, surface?: string, op?: number) {
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
    this.op = op;
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
  /**
   * The index of the op at fault, from 0, in an error answering a delta
   * (the control key `i`, SPEC §6.1); absent otherwise.
   */
  readonly op: number | undefined;
  /** What went wrong, when not ok: absent when the body has none, or does not decode. */
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
    const i = int(m.get("i"));
    this.op = i !== undefined && i >= 0 ? i : undefined;
    if (!this.ok) {
      const body = readBody(m.payload, ERROR);
      this.code = body?.code as string | undefined;
      this.detail = body?.detail as string | undefined;
    }
  }

  /**
   * The capabilities an ok reply to a query carries; undefined when it
   * carries none, or they do not decode, as a 0.1 host's JSON does not.
   * Whatever version they name: the Detector takes the terminal for a host
   * only when they name the SDK's VERSION.
   */
  caps(): Caps | undefined {
    if (!this.ok || this.re !== "q") return undefined;
    const body = readBody(this.message.payload, CAPS);
    return body && new Caps(body);
  }

  /** The reply as an error, or undefined when ok. */
  err(): HottyError | undefined {
    return this.ok ? undefined : new HottyError(this.code ?? "", this.detail, this.re, this.surface, this.op);
  }
}

/** Where a drag's pointer is (SPEC §9.1); the modifier keys held are the event's {@link Event.mods}. */
export interface Drag {
  /** The surface's column and row under the pointer, from 0 at its top left (not its window's); they go on past its edges. */
  c: number;
  r: number;
  /**
   * Where in the dragged element the pointer is, for an element with
   * data-steps (SPEC §9.1): a step from 0 to its count, along its width (x)
   * and down its height (y), measured against the element the drag started
   * on wherever the pointer is. Absent along an axis the element does not
   * count, which the detail leaves out; 0 is a step like any other.
   */
  x?: number;
  y?: number;
  /**
   * Where in t the pointer is, for a t with drop in its data-on and
   * data-steps (SPEC §9.1), in drag and dragend: measured as x and y are, against t's box. Absent along an
   * axis t does not count.
   */
  tx?: number;
  ty?: number;
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
 * The cells an element covers, as a click, a press or a view reports them
 * (SPEC §9): from 0 at the surface's top left cell, as a drag's are. An
 * element partly clipped or scrolled away reports its whole area, so c and
 * r may be negative or past the surface.
 */
export interface Area {
  c: number;
  r: number;
  w: number;
  h: number;
}

/** Which elements are in view, and whether the document shows its end (SPEC §9.5). */
export interface View {
  /**
   * Each element with data-on~=view and an id that is in view, by its id,
   * with its cells as a click's area has them: the whole element, however
   * little of it is shown.
   */
  areas: Record<string, Area>;
  /** The document's root is scrolled as far down as it goes, as a root that does not scroll down always is. */
  atEnd: boolean;
}

/** A clicked link (SPEC §9). */
/**
 * An edit command (SPEC §10.6): the program decides what it means, and with
 * nothing to do takes it as its key, as a text field does.
 */
export interface Command {
  /** `copy`, `cut`, `paste`, `undo`, `redo` or `select-all`. */
  name: string;
  /** The key that sent it, as SPEC §10.4 names it; empty from the terminal's menu. */
  key: string;
  /** A paste's text; absent when the clipboard holds none or the host cannot read it. */
  text?: string;
}

export interface Link {
  /** The href, as the document has it. */
  href: string;
  /** The href resolved against the document's base URL; absent when it resolves to nothing outside the document. */
  url?: string;
}

/**
 * What the user did in a surface (SPEC §9). Its detail is read by its kind
 * (SDK.md §3.9), and each accessor is undefined where the event does not
 * carry what it reads, or its detail does not decode.
 */
export class Event {
  readonly surface: string;
  /** One of {@link EventKind}, or a kind this SDK does not know, as it came. */
  readonly kind: EventKind | (string & {});
  /** The id of the element that reported; empty where the host sends no `t` (SPEC §9). */
  readonly target: string;
  /** The event as it came. */
  readonly message: Message;
  // The detail read as its kind's type: its fields have their types.
  readonly #d: Body | undefined;

  constructor(m: Message) {
    this.message = m;
    this.surface = m.get("s") ?? "";
    this.kind = m.get("e") ?? "";
    this.target = m.get("t") ?? "";
    const t = DETAIL.get(this.kind);
    this.#d = t && readBody(m.payload, t);
  }

  /**
   * The detail as it came ({@link Message.body}), whatever its fields'
   * types; undefined when the event carries none, or it is not one map.
   */
  get detail(): Body | undefined {
    return this.message.body();
  }

  /** The detail's value: a control's, or the value attribute of what was clicked. */
  value(): string | undefined {
    const k = this.kind;
    return k === "click" || k === "change" || k === "input" ? (this.#d?.value as string | undefined) : undefined;
  }

  /** A checkbox's or radio button's state, in a change event. */
  checked(): boolean | undefined {
    return this.kind === "change" ? (this.#d?.checked as boolean | undefined) : undefined;
  }

  /**
   * A submit's fields in tree order, each a name and a value: two fields of
   * one name are two pairs (SPEC §9). A detail whose pair is not two strs
   * does not decode.
   */
  fields(): [name: string, value: string][] | undefined {
    if (this.kind !== "submit" || !this.#d) return undefined;
    const given = this.#d.fields as string[][] | undefined;
    if (given === undefined || given.some((p) => p.length !== 2)) return undefined;
    return given.map((p) => [p[0]!, p[1]!]);
  }

  /**
   * The modifier keys held, as bits (MOD_SHIFT, MOD_ALT, MOD_CTRL,
   * MOD_SUPER): in a click, a press and a drag's events (SPEC §9). 0 when
   * none is held, and for any other kind.
   */
  mods(): number {
    const k = this.kind;
    const m = k === "click" || k === "press" || k === "dragstart" || k === "drag" || k === "dragend" ? this.#d?.mods : undefined;
    return typeof m === "number" ? m : 0;
  }

  /** A clicked link: its href, and its url when there is one. */
  link(): Link | undefined {
    const href = this.#d?.href as string | undefined;
    if (this.kind !== "click" || href === undefined) return undefined;
    const url = this.#d?.url as string | undefined;
    return url !== undefined ? { href, url } : { href };
  }

  /** The rows a fit event says the document needs now. */
  fitRows(): number | undefined {
    const r = this.#d?.r as number | undefined;
    return this.kind === "fit" && r !== undefined && r >= 1 ? r : undefined;
  }

  /** A dragstart's, drag's or dragend's cell, and its steps. */
  drag(): Drag | undefined {
    if (this.kind !== "dragstart" && this.kind !== "drag" && this.kind !== "dragend") return undefined;
    const { c, r, x, y, tx, ty } = (this.#d ?? {}) as Partial<Drag>;
    if (c === undefined || r === undefined) return undefined;
    const drag: Drag = { c, r };
    if (x !== undefined) drag.x = x;
    if (y !== undefined) drag.y = y;
    if (tx !== undefined) drag.tx = tx;
    if (ty !== undefined) drag.ty = ty;
    return drag;
  }

  /**
   * A click's or a press's element's cells: where the program places what
   * belongs next to it, such as a select's list. Absent unless the detail
   * has all of c, r, w and h.
   */
  area(): Area | undefined {
    if (this.kind !== "click" && this.kind !== "press") return undefined;
    const a = this.#d?.area as Partial<Area> | undefined;
    if (a?.c === undefined || a.r === undefined || a.w === undefined || a.h === undefined) return undefined;
    return { c: a.c, r: a.r, w: a.w, h: a.h };
  }

  /**
   * A click's place in its run of clicks on its element, as the user's
   * platform counts them (SPEC §9): 2 for the second click of a double
   * click, 1 for a single click or the keyboard's. Absent for any other
   * kind.
   */
  count(): number | undefined {
    if (this.kind !== "click") return undefined;
    const n = this.#d?.count;
    return typeof n === "number" && n > 1 ? n : 1;
  }

  /** A hover's cell, or out. The element is the event's target. */
  hover(): Hover | undefined {
    if (this.kind !== "hover") return undefined;
    const { c, r, out } = (this.#d ?? {}) as { c?: number; r?: number; out?: boolean };
    if (out === true) return { out: true };
    if (c === undefined || r === undefined) return undefined;
    return { c, r, out: false };
  }

  /** A command's (SPEC §10.6); undefined for another kind or a detail with no name. */
  command(): Command | undefined {
    if (this.kind !== "command" || typeof this.#d?.name !== "string") return undefined;
    const c: Command = { name: this.#d.name, key: (this.#d.key as string | undefined) ?? "" };
    if (this.#d.text !== undefined) c.text = this.#d.text as string;
    return c;
  }

  /**
   * A caps event's capabilities that changed (SPEC §4): a Caps whose raw
   * has only those fields, for {@link Caps.merge}.
   */
  changed(): Caps | undefined {
    return this.kind === "caps" && this.#d ? new Caps(this.#d as CapsBody) : undefined;
  }

  /**
   * A view's elements in view and whether the document shows its end. It
   * names every element in view, not what changed. An element whose area
   * lacks one of c, r, w and h is left out.
   */
  view(): View | undefined {
    if (this.kind !== "view" || !this.#d) return undefined;
    const given = (this.#d.in ?? {}) as Record<string, Partial<Area>>;
    const areas = Object.fromEntries(
      Object.entries(given).flatMap(([id, a]) =>
        a.c === undefined || a.r === undefined || a.w === undefined || a.h === undefined
          ? []
          : [[id, { c: a.c, r: a.r, w: a.w, h: a.h }] as const],
      ),
    );
    return { areas, atEnd: this.#d.end === true };
  }
}

/**
 * The capabilities, as a host sends them (SPEC §4): each field of its type,
 * and any other a later version adds.
 */
export interface CapsBody {
  v?: string;
  cellcss?: { w?: number; h?: number };
  scale?: number;
  scheme?: string;
  mod?: string;
  features?: string[];
  limits?: Record<string, number>;
  net?: Record<string, string[]>;
  edit?: Record<string, string[]>;
  host?: string;
  version?: string;
  [field: string]: unknown;
}

/** A caps event's field that became absent: an empty map, array or string (SPEC §9). */
const isEmpty = (v: unknown): boolean => {
  if (v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return (proto === Object.prototype || proto === null) && Object.keys(v).length === 0;
};

/**
 * What a host says about itself in its reply to a query (SPEC §4), from a
 * body whose fields have their types ({@link Reply.caps}), and, with only
 * the fields that changed, in a caps event ({@link Event.changed}). A field
 * the SDK does not know is in raw.
 */
export class Caps {
  /** The protocol version the host answers in (SPEC §4): "0.4", for a host this SDK uses. */
  readonly v: string | undefined;
  /** A cell's size in CSS pixels (SPEC §5.3); undefined when the host did not say. */
  readonly cellCss: { w: number; h: number } | undefined;
  /** Device pixels per CSS pixel: a hint for the resolution of images. */
  readonly scale: number | undefined;
  /** The terminal's colour scheme: "dark" or "light". */
  readonly scheme: string | undefined;
  /** The modifier `mod` stands for in bindings, "ctrl" or "super" (SPEC §10.4). */
  readonly mod: string | undefined;
  /** The optional features the host has (SPEC §4): see {@link Caps.has}. */
  readonly features: string[];
  /** The host's limits, such as surfaces (a count), resources and message (bytes) (SPEC §13). */
  readonly limits: Record<string, number>;
  /** The host's network policy, from directive to the sources it allows (SPEC §7.2): empty when it fetches nothing. */
  readonly net: Record<string, string[]>;
  /** The host's edit shortcuts, from each action to its keys (SPEC §10.2); a host that reports them takes edit commands. */
  readonly edit: Record<string, string[]> | undefined;
  /** A name for the implementation, when it gives one. */
  readonly host: string | undefined;
  /** The implementation's version, with host. */
  readonly version: string | undefined;
  /** The capabilities as they came, the fields the SDK does not know among them. */
  readonly raw: Readonly<CapsBody>;

  constructor(body: CapsBody = {}) {
    this.raw = body;
    this.v = body.v;
    const cell = body.cellcss;
    this.cellCss = cell?.w !== undefined && cell.h !== undefined ? { w: cell.w, h: cell.h } : undefined;
    this.scale = body.scale;
    this.scheme = body.scheme;
    this.mod = body.mod;
    this.features = [...(body.features ?? [])];
    this.limits = { ...body.limits };
    this.net = {};
    for (const [k, v] of Object.entries(body.net ?? {})) this.net[k] = [...v];
    this.edit = body.edit && Object.fromEntries(Object.entries(body.edit).map(([a, k]) => [a, [...k]]));
    this.host = body.host;
    this.version = body.version;
  }

  /**
   * Whether the host has an optional feature (SPEC §4): `passthrough`,
   * `hover`, `count` or `menu`. Everything else a 0.4 host does.
   */
  has(feature: Feature | (string & {})): boolean {
    return this.features.includes(feature);
  }

  /**
   * These capabilities with the fields a caps event changed
   * ({@link Event.changed}) in place of their own, and without those it
   * empties: a field that became absent comes as `{}`, `[]` or `""` (SPEC
   * §9). Its raw is this one's with those fields replaced, so a relay
   * announces the capabilities as they are now.
   */
  merge(changed: Caps): Caps {
    const raw: Record<string, unknown> = { ...this.raw, ...changed.raw };
    for (const [k, v] of Object.entries(changed.raw)) if (isEmpty(v)) delete raw[k];
    return new Caps(raw as CapsBody);
  }

  /** Whether the terminal's colour scheme is light. */
  light(): boolean {
    return this.scheme === "light";
  }
}
