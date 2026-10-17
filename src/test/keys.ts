// What the test host needs to take a key as SPEC §10.2 has a host take it:
// which elements are text fields, the keymap above an element, and a key as
// a terminal sends it (SPEC §10.4).

import type { DefaultTreeAdapterTypes as T } from "parse5";

import { keyText, MODIFIERS } from "../keys.ts";
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

/** A canonical key as its modifiers and the rest of its name: `["ctrl", "shift"]` and `"arrow_left"` for `ctrl+shift+arrow_left`. */
export function splitName(key: string): [string[], string] {
  const parts = key.split("+");
  const mods: string[] = [];
  while (parts.length > 1 && (MODIFIERS as readonly string[]).includes(parts[0]!)) mods.push(parts.shift()!);
  return [mods, parts.join("+")];
}

const SEQUENCES: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  backspace: "\x7f",
  arrow_up: "\x1b[A",
  arrow_down: "\x1b[B",
  arrow_right: "\x1b[C",
  arrow_left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  insert: "\x1b[2~",
  delete: "\x1b[3~",
  page_up: "\x1b[5~",
  page_down: "\x1b[6~",
};

/**
 * A canonical key as a terminal sends it, in the legacy encoding; "" when
 * it has none here. A physical key of a character (`key_w`, `digit_1`) is
 * sent as that character.
 */
export function keySequence(key: string): string {
  const [mods, rest] = splitName(key);
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (const m of mods) {
    if (m === "ctrl") ctrl = true;
    else if (m === "alt") alt = true;
    else if (m === "shift") shift = true;
    else return "";
  }
  const name = /^(?:key|digit)_(.)$/.exec(rest)?.[1] ?? rest;
  let seq = SEQUENCES[name] ?? "";
  if (name === "tab" && shift) seq = "\x1b[Z";
  else if (seq !== "") {
    // a named key
  } else if (ctrl && name === "space") seq = "\0";
  else if (ctrl) {
    if ([...name].length !== 1) return "";
    const c = name.toLowerCase().charCodeAt(0);
    if (c < 0x40 || c > 0x7e) return "";
    seq = String.fromCharCode(c & 0x1f);
  } else seq = keyText(shift ? "shift+" + name : name) ?? "";
  return seq !== "" && alt ? "\x1b" + seq : seq;
}
