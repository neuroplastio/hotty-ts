// A surface's document, as the program's commands leave it: parsed with
// the HTML parsing algorithm (parse5), changed by deltas and morphed as
// SPEC §6 has hosts do.

import { type DefaultTreeAdapterTypes as T, parse, parseFragment, serialize } from "parse5";

import type { Placement } from "../commands.ts";
import type { Field } from "../field.ts";
import type { Area } from "../messages.ts";

type Node = T.Node;
type ChildNode = T.ChildNode;
type ParentNode = T.ParentNode;
type Element = T.Element;

// --- nodes ---------------------------------------------------------------

export const isElement = (n: Node | null | undefined): n is Element => !!n && "tagName" in n;
const isText = (n: Node): n is T.TextNode => n.nodeName === "#text";
const isComment = (n: Node): n is T.CommentNode => n.nodeName === "#comment";
const parentOf = (n: Node): ParentNode | null => ("parentNode" in n ? n.parentNode : null);
const kids = (n: Node): ChildNode[] => ("childNodes" in n ? n.childNodes : []);

export function attr(n: Node | null | undefined, name: string): string | undefined {
  if (!isElement(n)) return undefined;
  for (const a of n.attrs) if (!a.namespace && a.name === name) return a.value;
  return undefined;
}

function setAttr(n: Element, name: string, value: string) {
  const a = n.attrs.find((a) => !a.namespace && a.name === name);
  if (a) a.value = value;
  else n.attrs.push({ name, value });
}

function delAttr(n: Element, name: string) {
  n.attrs = n.attrs.filter((a) => a.namespace || a.name !== name);
}

export function walk(n: Node, f: (n: Node) => void) {
  f(n);
  for (const c of kids(n)) walk(c, f);
  if (n.nodeName === "template" && "content" in n) walk((n as T.Template).content, f);
}

export function find(n: Node, f: (n: Node) => boolean): Node | undefined {
  if (f(n)) return n;
  for (const c of kids(n)) {
    const m = find(c, f);
    if (m) return m;
  }
  return undefined;
}

export function closest(n: Node | undefined, f: (n: Element) => boolean): Element | undefined {
  for (let c: Node | null | undefined = n; c; c = parentOf(c)) if (isElement(c) && f(c)) return c;
  return undefined;
}

export function textOf(n: Node): string {
  let out = "";
  walk(n, (c) => {
    if (isText(c)) out += c.value;
  });
  return out;
}

function detachNode(n: ChildNode) {
  const p = n.parentNode;
  if (!p) return;
  const i = p.childNodes.indexOf(n);
  if (i >= 0) p.childNodes.splice(i, 1);
  n.parentNode = null;
}

function insertBefore(parent: ParentNode, n: ChildNode, ref: ChildNode | null) {
  detachNode(n);
  const i = ref ? parent.childNodes.indexOf(ref) : -1;
  if (i < 0) parent.childNodes.push(n);
  else parent.childNodes.splice(i, 0, n);
  n.parentNode = parent;
}

const appendChild = (parent: ParentNode, n: ChildNode) => insertBefore(parent, n, null);

function nextSibling(n: ChildNode): ChildNode | null {
  const p = n.parentNode;
  if (!p) return null;
  return p.childNodes[p.childNodes.indexOf(n) + 1] ?? null;
}

// --- controls --------------------------------------------------------------

const tag = (n: Node | undefined) => (isElement(n) ? n.tagName : "");

export function box(n: Node): boolean {
  if (tag(n) !== "input") return false;
  const t = (attr(n, "type") ?? "").toLowerCase();
  return t === "checkbox" || t === "radio";
}

export const control = (n: Node) => tag(n) === "input" || tag(n) === "textarea" || tag(n) === "select";

export const hyperlink = (n: Node) => tag(n) === "a" && attr(n, "target") === "_blank";

export function focusable(n: Element): boolean {
  if (attr(n, "disabled") !== undefined) return false;
  switch (n.tagName) {
    case "input":
      return (attr(n, "type") ?? "").toLowerCase() !== "hidden";
    case "select":
    case "textarea":
    case "button":
    case "summary":
      return true;
    case "a":
      return attr(n, "href") !== undefined && !hyperlink(n);
  }
  const t = attr(n, "tabindex");
  return t !== undefined && /^-?\d+$/.test(t.trim()) && Number(t) >= 0;
}

export function listens(kind: string): (n: Element) => boolean {
  return (n) => (attr(n, "data-on") ?? "").split(/\s+/).includes(kind);
}

export function reportsClick(n: Element): boolean {
  switch (n.tagName) {
    case "button":
    case "a":
    case "summary":
      return true;
    case "input": {
      const t = (attr(n, "type") ?? "").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset") return true;
    }
  }
  return listens("click")(n);
}

export function submits(n: Element): boolean {
  const t = (attr(n, "type") ?? "").toLowerCase();
  return (n.tagName === "button" && (t === "" || t === "submit")) || (n.tagName === "input" && t === "submit");
}

// --- style ------------------------------------------------------------------

export const varName = (k: string) => (k.startsWith("--") ? k : "--" + k);

// A property from a style attribute.
export function styleProp(style: string, name: string): string | undefined {
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i >= 0 && decl.slice(0, i).trim() === name) return decl.slice(i + 1).trim();
  }
  return undefined;
}

// A style attribute with a property set, the others kept.
function setStyleProp(style: string, name: string, value: string): string {
  const out: string[] = [];
  let found = false;
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    if (decl.slice(0, i).trim() === name) {
      out.push(name + ": " + value);
      found = true;
      continue;
    }
    out.push(decl.trim());
  }
  if (!found) out.push(name + ": " + value);
  return out.join("; ");
}

// --- inspection ---------------------------------------------------------------

/** A child element as a host inspects it: its tag, its id (absent when it has none), and its text. */
export interface Child {
  tag: string;
  id?: string;
  text: string;
}

/**
 * An element as a host inspects it (SPEC §16): its tag, its attributes with
 * the program's values, its text, and its child elements.
 */
export interface Inspected {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: Child[];
}

// The elements a reader sees apart from their neighbours.
const BLOCKS = new Set(
  "address article aside blockquote br button caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr legend li main nav ol option p pre section summary table tbody td tfoot th thead tr ul".split(
    " ",
  ),
);

// --- the surface ----------------------------------------------------------------

/** What a delta answered: an error code and detail, or nothing. */
export type Outcome = { code: string; detail: string } | undefined;

/** One surface the program made: its document, as its commands left it, and its placement. */
export class Surface {
  /** The surface's name. */
  readonly name: string;
  /** The order of creation, for stacking. */
  readonly created: number;
  doc!: T.Document;
  /** Whether the surface is detached (SPEC §5.5). */
  detached = false;
  /** Whether it is placed: on screen, not hidden. */
  placed = false;
  /** Its last placement, as the program sent it; rows are the rows the host chose for auto. */
  placement: Placement = { cols: 0 };
  /** With fit: the rows the program last heard (SPEC §5.2). */
  fitRows = 0;
  /** With hover: the element it last heard the pointer is over; undefined: out (SPEC §9.4). */
  heard: string | undefined;
  /** Where the placement's top-left cell is: a line of the host's screen, the scrollback's included. */
  col = 0;
  row = 0;
  /** Placed on the alternate screen. */
  alt = false;
  /** The axes its document scrolls along (SPEC §5.1): 1 vertically, 2 horizontally, 3 both; 0 when it does not. */
  scroll = 0;
  /**
   * Where elements are, by id, as the test says (Host.setArea): the host
   * lays nothing out, so a click or a press reports these as its area.
   */
  areas: Map<string, Area> = new Map();

  // The controls' state, which the user changes and the program's
  // attributes set (SPEC §6.2): a control's value, a box's checked.
  values: Map<Node, string> = new Map();
  checked: Map<Node, boolean> = new Map();
  edited: Set<Node> = new Set(); // text controls edited since their last commit
  fields: Map<Node, Field> = new Map(); // text fields' carets and selections, once keys edit them
  focusedNode: Element | undefined;
  keyb = false; // the surface has the keyboard

  constructor(name: string, markup: string, created: number) {
    this.name = name;
    this.created = created;
    this.setDoc(markup);
  }

  setDoc(markup: string) {
    this.doc = parse(markup);
    this.values = new Map();
    this.checked = new Map();
    this.edited = new Set();
    this.fields = new Map();
    this.focusedNode = undefined;
    this.keyb = false;
  }

  /** The document as it is now. */
  html(): string {
    return serialize(this.doc);
  }

  body(): Element | undefined {
    const b = find(this.doc, (n) => tag(n) === "body");
    return isElement(b) ? b : undefined;
  }

  /**
   * The text of the document's body as a reader sees it, roughly: block
   * elements apart, runs of whitespace one space, styles and scripts left
   * out.
   */
  text(): string {
    const body = this.body();
    if (!body) return "";
    let out = "";
    const visit = (n: Node) => {
      if (isText(n)) {
        out += n.value;
        return;
      }
      if (["style", "script", "template"].includes(tag(n))) return;
      const apart = BLOCKS.has(tag(n));
      if (apart) out += " ";
      for (const c of kids(n)) visit(c);
      if (apart) out += " ";
    };
    visit(body);
    return out.split(/\s+/).filter(Boolean).join(" ");
  }

  byId(id: string): Element | undefined {
    if (id === "") return undefined;
    const n = find(this.doc, (n) => isElement(n) && attr(n, "id") === id);
    return isElement(n) ? n : undefined;
  }

  /** The element with an id, as a host inspects it; undefined when there is none. */
  element(id: string): Inspected | undefined {
    const n = this.byId(id);
    if (!n) return undefined;
    const attrs: Record<string, string> = {};
    for (const a of n.attrs) attrs[a.name] = a.value;
    const children: Child[] = [];
    for (const c of n.childNodes) {
      if (!isElement(c)) continue;
      const cid = attr(c, "id");
      children.push(cid === undefined ? { tag: c.tagName, text: textOf(c) } : { tag: c.tagName, id: cid, text: textOf(c) });
    }
    return { tag: n.tagName, attrs, text: textOf(n), children };
  }

  /** The text of the element with an id, "" when there is none. */
  textOf(id: string): string {
    const n = this.byId(id);
    return n ? textOf(n) : "";
  }

  /** An attribute of the element with an id. */
  attr(id: string, name: string): string | undefined {
    return attr(this.byId(id), name);
  }

  /** The custom property --name set on the element with an id, by its style attribute or a var delta. */
  var(id: string, name: string): string | undefined {
    const style = this.attr(id, "style");
    return style === undefined ? undefined : styleProp(style, varName(name));
  }

  /** A control's current value: what the program set, or the user typed; for a box, "true" or "false". */
  value(id: string): string | undefined {
    const n = this.byId(id);
    if (!n) return undefined;
    if (box(n)) return this.isChecked(n) ? "true" : "false";
    return this.valueOf(n);
  }

  /** The id of the element that has focus while the surface has the keyboard; "" otherwise. */
  focused(): string {
    if (!this.keyb || !this.focusedNode) return "";
    return attr(this.focusedNode, "id") ?? "";
  }

  valueOf(n: Element): string {
    const v = this.values.get(n);
    if (v !== undefined) return v;
    if (n.tagName === "textarea") return textOf(n);
    if (n.tagName === "select") {
      let first: string | undefined;
      let chosen: string | undefined;
      walk(n, (o) => {
        if (tag(o) !== "option") return;
        const ov = attr(o, "value") ?? textOf(o);
        first ??= ov;
        if (chosen === undefined && attr(o, "selected") !== undefined) chosen = ov;
      });
      return chosen ?? first ?? "";
    }
    if (box(n)) return attr(n, "value") ?? "on";
    return attr(n, "value") ?? "";
  }

  isChecked(n: Element): boolean {
    return this.checked.get(n) ?? attr(n, "checked") !== undefined;
  }

  // Keeps a control's state with the program's attribute, unless the user
  // is editing it (SPEC §6.2, controls whose values the program sets).
  attrChanged(n: Element, key: string) {
    if (n === this.focusedNode && this.keyb) return;
    if (key === "value" && control(n) && !box(n)) {
      this.values.delete(n);
      this.edited.delete(n);
      this.fields.delete(n);
    } else if (key === "checked" && box(n)) {
      this.checked.delete(n);
    } else if (key === "selected" && n.tagName === "option") {
      const sel = closest(n, (p) => p.tagName === "select");
      if (sel) this.values.delete(sel);
    }
  }

  // Forgets the state of a subtree leaving the document.
  drop(n: Node) {
    walk(n, (c) => {
      this.values.delete(c);
      this.checked.delete(c);
      this.edited.delete(c);
      this.fields.delete(c);
      if (c === this.focusedNode) {
        this.focusedNode = undefined;
        this.keyb = false;
      }
    });
  }

  // --- deltas (SPEC §6) ----------------------------------------------------------

  /** Applies a delta, and returns the error code and detail when it cannot. */
  delta(op: string, target: string, key: string, payload: string): Outcome {
    if (op === "morph" && target === "") return this.#morphByIds(payload);
    const t = this.byId(target);
    if (!t) return { code: "ENOTARGET", detail: target };
    switch (op) {
      case "morph": {
        const nodes = this.#fragment(payload, t.parentNode);
        if (nodes.length !== 1 || !isElement(nodes[0])) {
          this.#replaceWith(t, nodes);
          break;
        }
        this.#morph(t, nodes[0]);
        break;
      }
      case "inner":
        this.#morphChildren(t, this.#fragment(payload, t));
        break;
      case "replace":
        this.#replaceWith(t, this.#fragment(payload, t.parentNode));
        break;
      case "append":
      case "prepend": {
        const nodes = this.#fragment(payload, t);
        const first = t.childNodes[0] ?? null;
        for (const n of nodes) {
          const id = attr(n, "id");
          if (id !== undefined) {
            const old = t.childNodes.find((c) => isElement(c) && attr(c, "id") === id);
            if (old) {
              this.#morph(old, n);
              continue;
            }
          }
          insertBefore(t, n, op === "append" ? null : first);
        }
        break;
      }
      case "before":
      case "after": {
        const p = t.parentNode;
        if (!p) return { code: "EINVAL", detail: "no parent" };
        const ref = op === "after" ? nextSibling(t) : t;
        for (const n of this.#fragment(payload, p)) insertBefore(p, n, ref);
        break;
      }
      case "remove":
        this.drop(t);
        detachNode(t);
        break;
      case "attr":
        setAttr(t, key, payload);
        this.attrChanged(t, key);
        break;
      case "unattr":
        delAttr(t, key);
        this.attrChanged(t, key);
        break;
      case "text":
        for (const c of [...t.childNodes]) {
          this.drop(c);
          detachNode(c);
        }
        appendChild(t, { nodeName: "#text", value: payload, parentNode: t });
        if (t.tagName === "textarea") this.attrChanged(t, "value");
        break;
      case "var":
        setAttr(t, "style", setStyleProp(attr(t, "style") ?? "", varName(key), payload));
        break;
      case "reveal":
        // It changes no node, and this host lays nothing out: nothing scrolls.
        if (payload !== "" && payload !== "start" && payload !== "end") {
          return { code: "EINVAL", detail: "reveal takes start, end or none" };
        }
        break;
      default:
        return { code: "EINVAL", detail: "unknown op " + op };
    }
    return undefined;
  }

  // Morphs each top-level element of the payload into the document's
  // element with its id, and reports the ids it could not find (SPEC §6.2,
  // morph without t).
  #morphByIds(payload: string): Outcome {
    const missing: string[] = [];
    for (const n of this.#fragment(payload, this.body() ?? null)) {
      const id = attr(n, "id");
      if (!isElement(n) || id === undefined) continue;
      const old = this.byId(id);
      if (!old) {
        missing.push(id);
        continue;
      }
      this.#morph(old, n);
    }
    return missing.length > 0 ? { code: "ENOTARGET", detail: missing.join(",") } : undefined;
  }

  // Parses a payload in the context of the element it will be a child of,
  // so table rows and list items parse as they would in place.
  #fragment(payload: string, context: ParentNode | null): ChildNode[] {
    const ctx = isElement(context) ? context : this.body();
    const frag = ctx ? parseFragment(ctx, payload, {}) : parseFragment(payload);
    const nodes = [...frag.childNodes];
    for (const n of nodes) n.parentNode = null;
    return nodes;
  }

  #replaceWith(t: ChildNode, nodes: ChildNode[]) {
    const p = t.parentNode;
    if (!p) return;
    for (const n of nodes) insertBefore(p, n, t);
    this.drop(t);
    detachNode(t);
  }

  // Morphs a live node into a parsed one (SPEC §6.2).
  #morph(old: ChildNode, nu: ChildNode) {
    if (isText(old) && isText(nu)) {
      old.value = nu.value;
    } else if (isComment(old) && isComment(nu)) {
      // left as it is
    } else if (isElement(old) && isElement(nu) && matches(old, nu)) {
      this.#syncAttrs(old, nu);
      this.#morphChildren(old, [...nu.childNodes]);
    } else if (old.parentNode) {
      insertBefore(old.parentNode, nu, old);
      this.drop(old);
      detachNode(old);
    }
  }

  #syncAttrs(old: Element, nu: Element) {
    const want = new Map(nu.attrs.filter((a) => !a.namespace).map((a) => [a.name, a.value]));
    for (const a of [...old.attrs]) {
      if (a.namespace) continue;
      if (!want.has(a.name)) {
        delAttr(old, a.name);
        this.attrChanged(old, a.name);
      }
    }
    for (const [k, v] of want) {
      if (attr(old, k) !== v) {
        setAttr(old, k, v);
        this.attrChanged(old, k);
      }
    }
    // Namespaced attributes (xlink:href) come as they are.
    old.attrs = [...old.attrs.filter((a) => !a.namespace), ...nu.attrs.filter((a) => a.namespace)];
  }

  // Morphs parent's children into kids (SPEC §6.2, step 4).
  #morphChildren(parent: ParentNode, nus: ChildNode[]) {
    const olds = [...parent.childNodes];
    const wanted = new Set<string>();
    for (const k of nus) {
      const id = attr(k, "id");
      if (id !== undefined) wanted.add(id);
    }
    const taken = new Set<ChildNode>();
    const match: (ChildNode | undefined)[] = [];
    let last = -1; // the index in olds of the last match
    nus.forEach((k, i) => {
      const id = attr(k, "id");
      if (id !== undefined) {
        const j = olds.findIndex((o) => !taken.has(o) && attr(o, "id") === id);
        if (j >= 0) {
          match[i] = olds[j];
          taken.add(olds[j]!);
          last = j;
        }
        return;
      }
      for (let j = last + 1; j < olds.length; j++) {
        const o = olds[j]!;
        if (taken.has(o)) continue;
        const oid = attr(o, "id");
        if (oid !== undefined && wanted.has(oid)) continue;
        if (sameKind(o, k)) {
          match[i] = o;
          taken.add(o);
          last = j;
          break;
        }
      }
    });
    for (const o of olds) {
      if (!taken.has(o)) this.drop(o);
      detachNode(o);
    }
    // Taken children are morphed and moved into the new order; new children
    // with no match are inserted.
    nus.forEach((k, i) => {
      detachNode(k);
      const o = match[i];
      if (o) {
        appendChild(parent, o);
        this.#morph(o, k);
        return;
      }
      appendChild(parent, k);
    });
  }
}

// Two elements match when their tag and namespace are equal and their ids
// are equal or absent on either side (SPEC §6.2, step 2).
function matches(old: Element, nu: Element): boolean {
  if (old.tagName !== nu.tagName || old.namespaceURI !== nu.namespaceURI) return false;
  const oid = attr(old, "id");
  const nid = attr(nu, "id");
  return oid === undefined || nid === undefined || oid === nid;
}

// An element with the same tag and no id, a text node, or a comment
// (SPEC §6.2, step 4).
function sameKind(old: ChildNode, nu: ChildNode): boolean {
  if (isText(old) || isComment(old)) return old.nodeName === nu.nodeName;
  if (!isElement(old) || !isElement(nu)) return false;
  return old.tagName === nu.tagName && old.namespaceURI === nu.namespaceURI && attr(old, "id") === undefined;
}
