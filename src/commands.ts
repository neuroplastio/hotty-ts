// A builder for each action (SDK.md §3.4). Each returns the command's
// sequences, ready to write.

import { NO_REPLY, type Op, type Quiet, REPLY_ALWAYS, REPLY_ON_ERROR } from "./constants.ts";
import { Control } from "./control.ts";
import { encode } from "./encode.ts";

/**
 * The reply a command asks for (SPEC §3.5). Every builder but
 * {@link query} and {@link sync} takes them.
 */
export interface ReplyOptions {
  /**
   * Numbers the command and asks for its reply (`n`, and `q=0` unless
   * `q` is given): the reply echoes n, so the program can tell which
   * command it answers.
   */
  n?: number;
  /** The quiet level: 0 replies always, 1 only on error, 2 never. It wins over the level `n` implies. */
  q?: Quiet;
}

/** The options of {@link doc}. */
export interface DocOptions extends ReplyOptions {
  /**
   * Sends a document the program only shows (`d=1`, SPEC §5.5): the
   * surface is created detached, or its document replaced and the surface
   * detached, in the one command. It reports nothing, never takes the
   * keyboard, and its controls act disabled. It is what a command prints
   * among its output, which outlives it.
   */
  detached?: boolean;
  /**
   * The axes along which the document scrolls, as a page does (`scroll`,
   * SPEC §5.1, §5.3): a bitmask of SCROLL_VERTICAL and SCROLL_HORIZONTAL.
   * 0, the default, sends no key, and the document does not scroll; any
   * other value goes out as given, for the host to judge. A host without
   * `scroll` in its capabilities ignores it and clips.
   */
  scroll?: number;
}

/** The part of a surface a placement shows, in cells from its top-left corner (SPEC §5.2). */
export interface Window {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where and how a surface is shown (SPEC §5.2). */
export interface Placement {
  /** The surface's width in cells, 1 to 1000. */
  cols: number;
  /**
   * Its height in cells, 1 to 1000; 0 or absent is auto: the host lays
   * the document out `cols` wide, takes the rows its content needs, and
   * says how many in the reply.
   */
  rows?: number;
  /**
   * The part of the surface shown: a full-screen program scrolling a
   * surface out of view shows what is still in it. Absent, or all zero,
   * shows all of it.
   */
  window?: Window;
  /** Stacks overlapping placements, from -1000 to 1000: greater is above, 0 the usual. */
  z?: number;
  /** Asks for a press event wherever the user presses in the placement (`p=1`). */
  press?: boolean;
  /**
   * Asks for a fit event whenever the rows the document needs at this
   * width change from the rows last heard (`f=1`). The placement keeps its
   * size; placing it again is the program's to do.
   */
  fit?: boolean;
  /**
   * Asks for a hover event each time the element with an id under the
   * pointer changes, and when the pointer leaves the window (`v=1`).
   */
  hover?: boolean;
  /** Leaves the cursor where it was (`C=1`); otherwise it goes to the start of the line below. */
  keepCursor?: boolean;
}

// command encodes a command with its default quiet level and the options:
// n numbers it and asks for its reply, and a q given wins whatever the order.
function command(ctl: Control, payload: Uint8Array | string | undefined, def: Quiet, opts: ReplyOptions | undefined): string {
  ctl = ctl.with("q", def);
  if (opts?.n !== undefined) ctl = ctl.with("n", opts.n).with("q", REPLY_ALWAYS);
  if (opts?.q !== undefined) ctl = ctl.with("q", opts.q);
  return encode(ctl, payload);
}

/** Options of {@link query}. */
export interface QueryOptions {
  /**
   * Ask for a late answer (`late=1`, SPEC §4): what passes HOTTY through
   * and has no host yet, such as a multiplexer's pane with no terminal
   * attached, may answer once there is one. {@link withdrawLate} takes it
   * back.
   */
  late?: boolean;
}

/**
 * Asks whether the terminal is a HOTTY host, fenced by Primary Device
 * Attributes (SPEC §4): a host replies to the query, numbered n, before the
 * DA1 answer every terminal sends.
 */
export function query(n = 1, opts?: QueryOptions): string {
  const ctl: [string, string | number][] = [["a", "q"], ["n", n]];
  if (opts?.late) ctl.push(["late", 1]);
  return encode(ctl) + "\x1b[c";
}

/**
 * Withdraws a query that asked for a late answer (SPEC §4): `a=q:q=2`, a
 * query that wants no answer and takes the held one's place, so that no
 * answer reaches whatever reads the terminal next. It has no fence.
 */
export function withdrawLate(): string {
  return encode([["a", "q"], ["q", NO_REPLY]]);
}

/**
 * Creates a surface, or replaces its document (SPEC §5.1). The surface is
 * the program's, even one it had detached, unless the document is sent
 * detached. Answered on error (`q=1`): EQUOTA when the host holds no more.
 */
export function doc(surface: string, html: string, opts?: DocOptions): string {
  let ctl = new Control([["a", "doc"], ["s", surface]]);
  if (opts?.detached) ctl = ctl.with("d", 1);
  if (opts?.scroll) ctl = ctl.with("scroll", opts.scroll);
  return command(ctl, html, REPLY_ON_ERROR, opts);
}

function placementControl(surface: string, p: Placement): Control {
  const rows = p.rows ?? 0;
  const pairs: [string, string | number][] = [
    ["a", "place"],
    ["s", surface],
    ["c", p.cols],
    ["r", rows > 0 ? rows : "auto"],
  ];
  const w = p.window;
  if (w && (w.x !== 0 || w.y !== 0 || w.w !== 0 || w.h !== 0)) {
    const whole = rows > 0 && w.x === 0 && w.y === 0 && w.w === p.cols && w.h === rows;
    if (!whole) pairs.push(["x", w.x], ["y", w.y], ["w", w.w], ["h", w.h]);
  }
  if (p.z) pairs.push(["z", p.z]);
  if (p.press) pairs.push(["p", 1]);
  if (p.fit) pairs.push(["f", 1]);
  if (p.hover) pairs.push(["v", 1]);
  if (p.keepCursor) pairs.push(["C", 1]);
  return new Control(pairs);
}

/**
 * Places a surface at the cursor (SPEC §5.2); placing a placed surface
 * moves it. Answered on error (`q=1`): ENOENT when the host has no such
 * surface (it may have dropped it), EINVAL for a size or window out of
 * range. A reply to a placement with auto rows carries the rows chosen.
 */
export function place(surface: string, placement: Placement, opts?: ReplyOptions): string {
  return command(placementControl(surface, placement), undefined, REPLY_ON_ERROR, opts);
}

/**
 * Places a surface with its window's top-left corner at screen cell (x, y),
 * counted from 0, and leaves the cursor where it was: the way a full-screen
 * program lays surfaces out where it draws them. It saves the cursor, moves
 * it, places with `C=1`, and restores it.
 */
export function placeAt(surface: string, x: number, y: number, placement: Placement, opts?: ReplyOptions): string {
  return `\x1b7\x1b[${y + 1};${x + 1}H` + place(surface, { ...placement, keepCursor: true }, opts) + "\x1b8";
}

/**
 * Removes a surface's placement and keeps its document, to place it again
 * without sending it (SPEC §5.4). Deltas still apply to it.
 */
export function hide(surface: string, opts?: ReplyOptions): string {
  return command(new Control([["a", "hide"], ["s", surface]]), undefined, NO_REPLY, opts);
}

/**
 * Changes one surface's document (SPEC §6). target is an element id, ""
 * for a morph by top-level ids; key names the attribute or the custom
 * property, "" when the op takes none. Never answered unless asked.
 */
export function delta(
  surface: string,
  op: Op,
  target: string,
  key: string,
  payload?: Uint8Array | string,
  opts?: ReplyOptions,
): string {
  let ctl = new Control([["a", "delta"], ["s", surface], ["op", op]]);
  if (target !== "") ctl = ctl.with("t", target);
  if (key !== "") ctl = ctl.with("k", key);
  return command(ctl, payload, NO_REPLY, opts);
}

/** Replaces an element's children with one text node: a clock, a count. Hosts make it cheap. */
export function setText(surface: string, target: string, text: string, opts?: ReplyOptions): string {
  return delta(surface, "text", target, "", text, opts);
}

/** Sets the custom property `--name` on an element: the cheap way to move a bar every frame. */
export function setVar(surface: string, target: string, name: string, value: string | number, opts?: ReplyOptions): string {
  return delta(surface, "var", target, name, String(value), opts);
}

/** Sets an attribute on an element. */
export function setAttr(surface: string, target: string, name: string, value: string | number, opts?: ReplyOptions): string {
  return delta(surface, "attr", target, name, String(value), opts);
}

/** Removes an attribute from an element. */
export function removeAttr(surface: string, target: string, name: string, opts?: ReplyOptions): string {
  return delta(surface, "unattr", target, name, undefined, opts);
}

/**
 * Morphs an element into html, or with no target (""), each top-level
 * element of html into the document's element with its id. Morphing keeps
 * what the user is doing in what stays (SPEC §6.2).
 */
export function morphTo(surface: string, target: string, html: string, opts?: ReplyOptions): string {
  return delta(surface, "morph", target, "", html, opts);
}

/**
 * Stores a resource that documents refer to as `cid:<id>` (SPEC §7.1).
 * Sending it again replaces it, and redraws every surface that refers to it.
 */
export function res(id: string, mime: string, data: Uint8Array | string, opts?: ReplyOptions): string {
  return command(new Control([["a", "res"], ["id", id], ["type", mime]]), data, NO_REPLY, opts);
}

/** Deletes a resource. */
export function delRes(id: string, opts?: ReplyOptions): string {
  return command(new Control([["a", "del"], ["id", id]]), undefined, NO_REPLY, opts);
}

/** Deletes a surface and its placement (SPEC §5.4). */
export function del(surface: string, opts?: ReplyOptions): string {
  return command(new Control([["a", "del"], ["s", surface]]), undefined, NO_REPLY, opts);
}

/** Deletes every surface. */
export function delAll(opts?: ReplyOptions): string {
  return command(new Control([["a", "del"]]), undefined, NO_REPLY, opts);
}

/**
 * Gives a surface up (SPEC §5.5): it stays on the screen as text does, but
 * sends no more events and never has the keyboard. A program that leaves
 * surfaces on the screen when it exits detaches them first, unless it sent
 * them detached.
 */
export function detach(surface: string, opts?: ReplyOptions): string {
  return command(new Control([["a", "detach"], ["s", surface]]), undefined, NO_REPLY, opts);
}

/**
 * Gives a surface the keyboard (SPEC §10.1), at an element if target is
 * not empty; else its focused element keeps focus, or its first focusable
 * element takes it.
 */
export function focus(surface: string, target = "", opts?: ReplyOptions): string {
  let ctl = new Control([["a", "focus"], ["s", surface]]);
  if (target !== "") ctl = ctl.with("t", target);
  return command(ctl, undefined, NO_REPLY, opts);
}

/** Takes the keyboard back from a surface. Its focused control commits first, so a change may come before blur. */
export function blur(surface: string, opts?: ReplyOptions): string {
  return command(new Control([["a", "blur"], ["s", surface]]), undefined, NO_REPLY, opts);
}

/**
 * Brackets commands already built in synchronized output (DEC mode 2026,
 * SPEC §6.3): the host shows the state after all of them, never one in
 * between.
 */
export function sync(...commands: string[]): string {
  return "\x1b[?2026h" + commands.join("") + "\x1b[?2026l";
}
