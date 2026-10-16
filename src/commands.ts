// A builder for each action (SDK.md §3.4). Each returns the command's
// sequences, ready to write.

import { NO_REPLY, OPS, type OpName, type Quiet, REPLY_ALWAYS, REPLY_ON_ERROR, VERSION } from "./constants.ts";
import { Control } from "./control.ts";
import { encode } from "./encode.ts";
import { HottyError, type Message } from "./messages.ts";
import { readKey, type Platform } from "./keys.ts";
import { pack, unpack } from "./msgpack.ts";

/**
 * The reply a command asks for (SPEC §3.5). Every builder but
 * {@link query} and {@link sync} takes them.
 */
export interface ReplyOptions {
  /**
   * Numbers the command and asks for its reply (`n`, and quiet level 0
   * unless `q` is given): the reply echoes n, so the program can tell
   * which command it answers.
   */
  n?: number;
  /**
   * The quiet level: 0 replies always, 1 only on error, 2 never. It wins
   * over the level `n` implies. It goes out only where the wire does not
   * imply it: 0 with `n`, else 1 (SPEC §3.5).
   */
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
   * other value goes out as given, for the host to judge.
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
  /**
   * Asks for a press event wherever the user presses in the placement
   * (`p=1`), or stops them (`p=0`). Press, fit and hover belong to the
   * surface (SPEC §5.2): `true` is on, `false` off, and absent leaves them
   * as they were.
   */
  press?: boolean;
  /**
   * Asks for a fit event whenever the rows the document needs at this
   * width change from the rows last heard (`f=1`), or stops them (`f=0`).
   * The placement keeps its size; placing it again is the program's to do.
   */
  fit?: boolean;
  /**
   * Asks for a hover event each time the element with an id under the
   * pointer changes, and when the pointer leaves the window (`v=1`), or
   * stops them (`v=0`).
   */
  hover?: boolean;
  /** Leaves the cursor where it was (`C=1`); otherwise it goes to the start of the line below. */
  keepCursor?: boolean;
}

// command encodes a command with its default quiet level and the options:
// n numbers it and asks for its reply, and a q given wins whatever the
// order. q goes out only where the wire does not imply it: 0 with n, else 1
// (SPEC §3.5).
function command(ctl: Control, payload: Uint8Array | string | undefined, def: Quiet, opts: ReplyOptions | undefined): string {
  const numbered = opts?.n !== undefined;
  let q: Quiet = numbered ? REPLY_ALWAYS : def;
  if (opts?.q !== undefined) q = opts.q;
  if (numbered) ctl = ctl.with("n", opts.n!);
  if (q !== (numbered ? REPLY_ALWAYS : REPLY_ON_ERROR)) ctl = ctl.with("q", q);
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
 * Asks whether the terminal is a HOTTY host that speaks {@link VERSION},
 * fenced by Primary Device Attributes (SPEC §4): `a=q:n=<n>:v=0.3`. A host
 * replies to the query, numbered n, before the DA1 answer every terminal
 * sends: its capabilities, or EVERSION when it speaks no version the query
 * lists.
 */
export function query(n = 1, opts?: QueryOptions): string {
  const ctl: [string, string | number][] = [["a", "q"], ["n", n], ["v", VERSION]];
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
  for (const [k, f] of [["p", p.press], ["f", p.fit], ["v", p.hover]] as const) if (f !== undefined) pairs.push([k, f ? 1 : 0]);
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
 * One change of a delta (SPEC §6.1): what to do, to which element, with
 * which name and which value. The builders {@link morph}, {@link attr} and
 * the rest make them.
 */
export interface Op {
  /** What it does: one of {@link OPS}. */
  op: OpName | (string & {});
  /** The id of the element, as the document has it; empty or absent for a morph of the whole tree, and sent only when not. */
  target?: string;
  /** The name of the attribute or the custom property, for attr, unattr and var. */
  key?: string;
  /** The HTML, the text or the value; absent for an op that takes none, and sent, even empty, for one that does (SDK.md §3.4.3). */
  value?: string;
}

const valued = (op: OpName, target: string, key: string, value: string): Op => ({ op, target, key, value });

/** Morphs an element into html, or with no target (""), each top-level element of html into the document's element with its id (SPEC §6.2). */
export const morph = (target: string, html: string): Op => valued("morph", target, "", html);
/** Morphs the children of an element into the nodes of html. */
export const inner = (target: string, html: string): Op => valued("inner", target, "", html);
/** Replaces an element with the nodes of html, without morphing. */
export const replace = (target: string, html: string): Op => valued("replace", target, "", html);
/** Adds the nodes of html as an element's last children. */
export const append = (target: string, html: string): Op => valued("append", target, "", html);
/** Adds the nodes of html as an element's first children. */
export const prepend = (target: string, html: string): Op => valued("prepend", target, "", html);
/** Inserts the nodes of html before an element. */
export const before = (target: string, html: string): Op => valued("before", target, "", html);
/** Inserts the nodes of html after an element. */
export const after = (target: string, html: string): Op => valued("after", target, "", html);
/** Removes an element. It has no value. */
export const remove = (target: string): Op => ({ op: "remove", target });
/** Sets an attribute on an element. */
export const attr = (target: string, name: string, value: string | number): Op => valued("attr", target, name, String(value));
/** Removes an attribute from an element. It has no value. */
export const unattr = (target: string, name: string): Op => ({ op: "unattr", target, key: name });
/** Replaces an element's children with one text node: a clock, a count. Hosts make it cheap (SPEC §6.1). */
export const text = (target: string, text: string): Op => valued("text", target, "", text);
/** Sets the custom property `--name` on an element: the cheap way to move a bar every frame, with CSS that reads it. */
export const varOp = (target: string, name: string, value: string | number): Op => valued("var", target, name, String(value));
/**
 * Scrolls an element into view (SPEC §6.1), in each box that holds it, the
 * innermost first: with "start" its top to the top, with "end" its bottom
 * to the bottom, and with "" by as little as brings it into view, which
 * sends it no value. It moves no focus.
 */
export const revealOp = (target: string, where: "start" | "end" | "" = ""): Op =>
  where === "" ? { op: "reveal", target } : valued("reveal", target, "", where);

/**
 * Changes one surface's document (SPEC §6.1): the ops, in the order they
 * apply, which the host shows as one. A program that changes a surface in
 * one frame sends one delta (SDK.md §2.9). A delta of no ops is sent, and
 * the host refuses it (EINVAL). Never answered unless asked; a reply to an
 * op that failed names it by its index ({@link Reply.op}).
 *
 * The body is one msgpack map, `{"ops": [...]}`; targets and values are
 * not cleaned, they travel as the document has them (SDK.md §3.4.3).
 */
export function delta(surface: string, ops: readonly Op[], opts?: ReplyOptions): string {
  const body = {
    ops: ops.map((o) => ({
      op: o.op,
      t: o.target ? o.target : undefined,
      k: o.key ? o.key : undefined,
      v: o.value,
    })),
  };
  return command(new Control([["a", "delta"], ["s", surface]]), pack(body), NO_REPLY, opts);
}

/** Replaces an element's children with one text node: a clock, a count. Hosts make it cheap. */
export function setText(surface: string, target: string, value: string, opts?: ReplyOptions): string {
  return delta(surface, [text(target, value)], opts);
}

/** Sets the custom property `--name` on an element: the cheap way to move a bar every frame. */
export function setVar(surface: string, target: string, name: string, value: string | number, opts?: ReplyOptions): string {
  return delta(surface, [varOp(target, name, value)], opts);
}

/** Sets an attribute on an element. */
export function setAttr(surface: string, target: string, name: string, value: string | number, opts?: ReplyOptions): string {
  return delta(surface, [attr(target, name, value)], opts);
}

/** Removes an attribute from an element. */
export function removeAttr(surface: string, target: string, name: string, opts?: ReplyOptions): string {
  return delta(surface, [unattr(target, name)], opts);
}

/**
 * Morphs an element into html, or with no target (""), each top-level
 * element of html into the document's element with its id. Morphing keeps
 * what the user is doing in what stays (SPEC §6.2).
 */
export function morphTo(surface: string, target: string, html: string, opts?: ReplyOptions): string {
  return delta(surface, [morph(target, html)], opts);
}

/**
 * Scrolls an element into view, in each box that holds it, the innermost
 * first (SPEC §6.1): with "start" its top to the top, with "end" its bottom
 * to the bottom, and with "" by as little as brings it into view. It moves
 * no focus and sends no event of its own, and in a document that asked for
 * no scrolling it moves nothing.
 */
export function reveal(surface: string, target: string, where: "start" | "end" | "" = "", opts?: ReplyOptions): string {
  return delta(surface, [revealOp(target, where)], opts);
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

/**
 * Takes the edit commands named (SPEC §10.6): `select-all`, `copy`, `cut`,
 * `paste`, `undo`, `redo`. Their keys, the host's edit shortcuts
 * (the capabilities' `edit`), then reach the program as `command` events in place
 * of their bytes. Each replaces the last; none takes nothing. It holds for
 * the screen it is sent on.
 */
export function edit(names: readonly string[], opts?: ReplyOptions): string {
  return command(new Control([["a", "edit"], ["take", names.join(",")]]), undefined, NO_REPLY, opts);
}

/** An action of a program's menu, or a group of them (SPEC §10.7). Items nest at most {@link MENU_DEPTH} deep. */
export interface MenuItem {
  /** The key that reaches it after its group's, named as SPEC §10.4 names it; empty or absent for an item no key reaches. */
  key?: string;
  /** What it does. */
  label?: string;
  /** The command a pick sends; empty or absent for an item only its keys reach. */
  name?: string;
  /** Whether it does anything now; true when absent. */
  enabled?: boolean;
  /** The items after it, which make it a group; none or an empty list make it an action. */
  items?: readonly MenuItem[];
}

/** What a program can do (SPEC §10.7): a tree of actions with the keys that reach them and the names a pick sends. */
export interface MenuTree {
  /** What the menu is for: "Files". Empty or absent leaves it to the host. */
  label?: string;
  /** The menu's top level, in the order to show them. */
  items: readonly MenuItem[];
}

/** How deep a menu's items nest, the top level's being one deep (SPEC §10.7). */
export const MENU_DEPTH = 8;

// A menu's items for the wire: each in the smallest form (SDK.md §3.4), the
// top level's array always there, and a group's only when it has items.
function menuItems(items: readonly MenuItem[]): unknown[] {
  return items.map((i) => ({
    key: i.key ? i.key : undefined,
    label: i.label ? i.label : undefined,
    name: i.name ? i.name : undefined,
    enabled: i.enabled !== false,
    items: i.items && i.items.length > 0 ? menuItems(i.items) : undefined,
  }));
}

/**
 * Tells the host what the program can do now (SPEC §10.7): its menu, kept
 * until the program sends another; with none, the program has none. A host
 * shows it and lets the user pick from it when its capabilities have the
 * feature `menu` (`caps.has("menu")`); on one that does not, the program
 * shows its menu itself. Keep the tree within {@link MENU_DEPTH} levels.
 */
export function menu(tree?: MenuTree, opts?: ReplyOptions): string {
  if (tree === undefined) return command(new Control([["a", "menu"]]), undefined, NO_REPLY, opts);
  const body = { label: tree.label ? tree.label : undefined, items: menuItems(tree.items) };
  return command(new Control([["a", "menu"]]), pack(body), NO_REPLY, opts);
}

/**
 * Shows the level of the program's menu that the keys typed reach (SPEC
 * §10.7): `keys` names them as SPEC §10.4 does, "Space" and "f" for a leader
 * and a group; with none, the top level. A level shows until the program
 * shows another, or {@link menuHide}s it.
 */
export function menuShow(keys: readonly string[] = [], opts?: ReplyOptions): string {
  const body = keys.length > 0 ? pack({ seq: [...keys] }) : undefined;
  return command(new Control([["a", "menu"], ["show", 1]]), body, NO_REPLY, opts);
}

/** Hides the level shown (SPEC §10.7). The menu stays. */
export function menuHide(opts?: ReplyOptions): string {
  return command(new Control([["a", "menu"], ["show", 0]]), undefined, NO_REPLY, opts);
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

// --- for hosts and relays: reading what a program sends ----------------------

type Body = Record<string, unknown>;
const isMap = (v: unknown): v is Body => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;
const isStr = (v: unknown): v is string => typeof v === "string";

// The EINVAL a host answers a command with, from the command m.
function invalid(m: Message, detail: string, op?: number): HottyError {
  return new HottyError("EINVAL", detail, m.get("a"), m.get("s"), op);
}

// A message's body as one msgpack map, or undefined when it is not one.
function mapOf(m: Message): Body | undefined {
  try {
    const v = unpack(m.payload);
    return isMap(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const OP_NEEDS_TARGET = new Set<string>(OPS.filter((o) => o !== "morph"));

/**
 * Reads a delta command's ops (SPEC §6.1), as a host or a relay does,
 * checking the whole body first. It throws a {@link HottyError} with code
 * EINVAL, and with {@link HottyError.op} the index of the first op at
 * fault, when the body does not decode (SPEC §3.3) or has no ops, an op is
 * not a map, holds `op`, `t`, `k` or `v` as anything but a str, or names
 * an op there is none of, an op lacks the `t` or `k` it needs (an empty
 * one is none), or a reveal has a value other than `start` or `end`. A
 * value an op does not take is ignored, and so is a key this SDK does not
 * know.
 */
export function deltaOf(m: Message): Op[] {
  if (m.get("a") !== "delta") throw invalid(m, "not a delta command");
  const body = mapOf(m);
  if (body === undefined) throw invalid(m, "body does not decode");
  const ops = body.ops;
  if (ops === undefined) throw invalid(m, "no ops");
  if (!Array.isArray(ops)) throw invalid(m, "body does not decode");
  ops.forEach((o, i) => {
    if (!isMap(o) || ["op", "t", "k", "v"].some((k) => o[k] !== undefined && !isStr(o[k]))) throw invalid(m, "op is not a map of strs", i);
  });
  if (ops.length === 0) throw invalid(m, "no ops");
  return (ops as Body[]).map((o, i) => {
    const name = o.op;
    const t = (o.t as string | undefined) ?? "";
    const k = (o.k as string | undefined) ?? "";
    const v = o.v as string | undefined;
    if (name === undefined || !(OPS as readonly string[]).includes(name as string)) throw invalid(m, "unknown op " + String(name), i);
    if (t === "" && OP_NEEDS_TARGET.has(name as string)) throw invalid(m, "missing t", i);
    if (k === "" && (name === "attr" || name === "unattr" || name === "var")) throw invalid(m, "missing k", i);
    if (name === "reveal" && v !== undefined && v !== "start" && v !== "end") throw invalid(m, "reveal " + v, i);
    const op: Op = { op: name as OpName };
    if (t !== "") op.target = t;
    if (k !== "") op.key = k;
    if (v !== undefined) op.value = v;
    return op;
  });
}

// A menu's items as the wire has them, each in full; undefined when the
// body is not a menu's.
function readItems(v: unknown, depth: number): MenuItem[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: MenuItem[] = [];
  for (const it of v) {
    if (!isMap(it)) return undefined;
    for (const k of ["key", "label", "name"]) if (it[k] !== undefined && !isStr(it[k])) return undefined;
    if (it.enabled !== undefined && typeof it.enabled !== "boolean") return undefined;
    let items: MenuItem[] = [];
    if (it.items !== undefined) {
      if (depth + 1 > MENU_DEPTH && Array.isArray(it.items) && it.items.length > 0) throw new RangeError("deep");
      const sub = readItems(it.items, depth + 1);
      if (sub === undefined) return undefined;
      items = sub;
    }
    out.push({
      key: (it.key as string | undefined) ?? "",
      label: (it.label as string | undefined) ?? "",
      name: (it.name as string | undefined) ?? "",
      enabled: it.enabled === true,
      items,
    });
  }
  return out;
}

/**
 * Reads an `a=menu` command's menu (SPEC §10.7), as a host or a relay
 * does: undefined for a command with no body, which leaves the program no
 * menu. Every field of the tree is filled: empty strings, `enabled` false
 * where the body has none, and an empty `items` for an action. A body that
 * is no menu, holds a field of another type, or nests its items deeper than
 * {@link MENU_DEPTH} throws a {@link HottyError} with code EINVAL. A command
 * with `show` is not a menu: {@link menuShowOf} reads it.
 */
export function menuOf(m: Message): Required<MenuTree> | undefined {
  if (m.get("a") !== "menu") throw invalid(m, "not a menu command");
  if (m.payload.length === 0) return undefined;
  const body = mapOf(m);
  if (body === undefined || (body.label !== undefined && !isStr(body.label))) throw invalid(m, "body does not decode");
  let items: MenuItem[] | undefined = [];
  if (body.items !== undefined) {
    try {
      items = readItems(body.items, 1);
    } catch {
      throw invalid(m, "items nest deeper than eight");
    }
  }
  if (items === undefined) throw invalid(m, "body does not decode");
  return { label: (body.label as string | undefined) ?? "", items };
}

/**
 * Reads an `a=menu` command's show body (SPEC §10.7), as a host or a relay
 * does: the keys typed, as the program names them, whose level to show. No
 * body, or none in it, is the top level: an empty list. A body that is no
 * map, or whose `seq` is not an array of str, throws a {@link HottyError}
 * with code EINVAL.
 */
export function menuShowOf(m: Message): string[] {
  if (m.get("a") !== "menu") throw invalid(m, "not a menu command");
  if (m.payload.length === 0) return [];
  const body = mapOf(m);
  const seq = body?.seq;
  if (body === undefined || (seq !== undefined && (!Array.isArray(seq) || !seq.every(isStr)))) throw invalid(m, "seq is not an array of str");
  return [...((seq as string[] | undefined) ?? [])];
}

/**
 * The level of a menu that the keys reach (SPEC §10.7): its items, a
 * group's, for a host to show those that have a key. From the top level,
 * each key enters the first group (an item with items) at the level whose
 * key is that key, compared as {@link readKey} compares: with `Mod` read as
 * the platform's. With no keys it is the top level. Undefined when the keys
 * reach no group, or there is no tree.
 */
export function menuLevelOf(tree: MenuTree | undefined, platform: Platform, keys: readonly string[]): readonly MenuItem[] | undefined {
  if (tree === undefined) return undefined;
  let items: readonly MenuItem[] = tree.items;
  for (const key of keys) {
    const typed = readKey(platform, key);
    if (typed === undefined) return undefined;
    const group = items.find((it) => (it.items?.length ?? 0) > 0 && readKey(platform, it.key ?? "") === typed);
    if (group === undefined) return undefined;
    items = group.items!;
  }
  return items;
}

/**
 * The first item of a menu with the name, depth first (SPEC §10.7), or
 * undefined: a pick of that name is for it. An item with no name, as the
 * name "" asks for, is never found.
 */
export function menuFind(tree: MenuTree | undefined, name: string): MenuItem | undefined {
  if (tree === undefined || name === "") return undefined;
  const find = (items: readonly MenuItem[]): MenuItem | undefined => {
    for (const it of items) {
      if (it.name === name) return it;
      const sub = find(it.items ?? []);
      if (sub) return sub;
    }
    return undefined;
  };
  return find(tree.items);
}
