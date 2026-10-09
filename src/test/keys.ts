// What the test host needs to take a key as SPEC §10.2 has a host take it:
// which elements are text fields, the keymap above an element, and a key as
// a terminal sends it.

import type { DefaultTreeAdapterTypes as T } from "parse5";

import { attr, closest } from "./dom.ts";

type Element = T.Element;

const DATE_TYPES = new Set(["date", "time", "datetime-local", "month", "week"]);
const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number", ...DATE_TYPES]);

/** An input that takes text: a text field, or a date or time input. */
export function textInput(n: Element): boolean {
  return n.tagName === "input" && TEXT_TYPES.has((attr(n, "type") ?? "").toLowerCase());
}

/** An editing host (contenteditable). */
export function editingHost(n: Element): boolean {
  const v = attr(n, "contenteditable");
  return v !== undefined && v.toLowerCase() !== "false";
}

/** An element that edits text with a keymap (SPEC §10.2): a text-like input, a textarea, an editing host. */
export function textField(n: Element): boolean {
  if (n.tagName === "textarea" || editingHost(n)) return true;
  return textInput(n) && !DATE_TYPES.has((attr(n, "type") ?? "").toLowerCase());
}

/** The `data-keys` values of the elements from the root down to el, el's last: its keymap, as SPEC §10.2 reads it. */
export function keymaps(el: Element): string[] {
  const values: string[] = [];
  closest(el, (n) => {
    const v = attr(n, "data-keys");
    if (v !== undefined) values.unshift(v);
    return false;
  });
  return values;
}

/** A key's modifiers and its key value; " " may be written "Space". */
export function splitName(key: string): [string[], string] {
  let parts = key.split("+");
  if (key === "+") parts = ["+"];
  else if (key.endsWith("++")) parts = [...key.slice(0, -2).split("+"), "+"];
  const name = parts.pop()!;
  return [parts, name === "Space" ? " " : name];
}

/** The text a key types: its character, without its modifiers. */
export function keyText(canonical: string): string {
  if (canonical === "+" || canonical.endsWith("++")) return "+";
  if (canonical === "Space" || canonical.endsWith("+Space")) return " ";
  return canonical.slice(canonical.lastIndexOf("+") + 1);
}

const SEQUENCES: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
  Backspace: "\x7f",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
};

/** A key as a terminal sends it, in the legacy encoding; "" when it has none here. */
export function keySequence(key: string): string {
  const [mods, name] = splitName(key);
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (const m of mods) {
    if (m === "Control") ctrl = true;
    else if (m === "Alt") alt = true;
    else if (m === "Shift") shift = true;
    else return "";
  }
  let seq = SEQUENCES[name] ?? "";
  if (name === "Tab" && shift) seq = "\x1b[Z";
  else if (seq !== "") {
    // a named key
  } else if ([...name].length !== 1) return "";
  else if (ctrl) {
    const c = name.toLowerCase().charCodeAt(0);
    if (c < 0x40 || c > 0x7e) return "";
    seq = String.fromCharCode(c & 0x1f);
  } else seq = name;
  return alt ? "\x1b" + seq : seq;
}
