/**
 * A text field's value and caret, edited as SPEC §10.2's actions edit them,
 * for a program that draws its fields in cells (SDK.md §4.6):
 *
 * ```ts
 * const keys = resolve(false, TERMINAL_KEYS); // the keymap its surfaces get in data-keys
 * const f = new Field({ value: "foo bar" });
 * const a = keys.lookup("Control+w");          // "delete-word-backward"
 * if (a === INSERT) f.type(key);
 * else if (a && f.do(a)) report(f.value);     // "foo "
 * ```
 *
 * Rows are lines: a field in cells does not wrap, and the place along a row
 * is a count of characters (grapheme clusters).
 *
 * @module
 */

import { chars, MULTILINE_ACTIONS, type Action } from "./keys.ts";

/** A {@link Field}'s state; what is left out is empty, false, or 1 row. */
export interface FieldOptions {
  value?: string;
  /** In characters from the start; the end when left out. */
  caret?: number;
  multiline?: boolean;
  /** A password field is one word (SPEC §10.2). */
  password?: boolean;
  /** The rows the field shows, for `page-up` and `page-down`. */
  rows?: number;
}

const WHITE_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
// A space: a character whose first code point has White_Space; a line break is one.
const isSpace = (c: string) => WHITE_SPACE.has(c.codePointAt(0)!);
const isBreak = (c: string) => c === "\n" || c === "\r" || c === "\r\n";

const ROW_MOVES = new Set(["line-previous", "line-next", "page-up", "page-down"]);

/** A text field's value and caret (SDK.md §4.6). */
export class Field {
  value: string;
  /** In characters (grapheme clusters) from the start. */
  caret: number;
  multiline: boolean;
  password: boolean;
  rows: number;
  // The place along the row a run of row moves keeps.
  #goal: number | undefined;

  constructor(o: FieldOptions = {}) {
    this.value = o.value ?? "";
    this.caret = o.caret ?? chars(this.value).length;
    this.multiline = o.multiline ?? false;
    this.password = o.password ?? false;
    this.rows = o.rows ?? 1;
  }

  /**
   * Does an action, and returns whether the value changed. `submit` and
   * `program` are the program's, and an action the field does not have (a
   * multi-line one in an input) does nothing.
   */
  do(action: Action | string): boolean {
    const c = chars(this.value);
    const p = Math.min(Math.max(this.caret, 0), c.length);
    if (!ROW_MOVES.has(action)) this.#goal = undefined;
    if (MULTILINE_ACTIONS.has(action as Action) && !this.multiline) return false;
    const [s, e] = this.#lines(c).find(([s, e]) => s <= p && p <= e)!;
    const page = Math.max(this.rows, 1);
    let to: number | undefined;
    switch (action) {
      case "char-backward":
        to = Math.max(p - 1, 0);
        break;
      case "char-forward":
        to = Math.min(p + 1, c.length);
        break;
      case "word-backward":
        to = this.#wordBack(c, p);
        break;
      case "word-forward":
        to = this.#wordForward(c, p);
        break;
      case "line-start":
        to = s;
        break;
      case "line-end":
        to = e;
        break;
      case "line-previous":
        to = this.#row(c, p, -1);
        break;
      case "line-next":
        to = this.#row(c, p, 1);
        break;
      case "page-up":
        to = this.#row(c, p, -page);
        break;
      case "page-down":
        to = this.#row(c, p, page);
        break;
      case "input-start":
        to = 0;
        break;
      case "input-end":
        to = c.length;
        break;
    }
    if (to !== undefined) {
      this.caret = to;
      return false;
    }
    switch (action) {
      case "delete-char-backward":
        return this.#delete(c, p, Math.max(p - 1, 0), p);
      case "delete-char-forward":
        return this.#delete(c, p, p, Math.min(p + 1, c.length));
      case "delete-word-backward":
        return this.#delete(c, p, this.#wordBack(c, p), p);
      case "delete-word-forward":
        return this.#delete(c, p, p, this.#wordForward(c, p));
      case "delete-to-line-start":
        return this.#delete(c, p, s, p);
      case "delete-to-line-end":
        return this.#delete(c, p, p, e);
      case "newline":
        return this.type("\n");
    }
    return false;
  }

  /** Types text at the caret, and returns whether the value changed. */
  type(text: string): boolean {
    this.#goal = undefined;
    if (text === "") return false;
    const c = chars(this.value);
    const p = Math.min(Math.max(this.caret, 0), c.length);
    const before = c.slice(0, p).join("") + text;
    this.value = before + c.slice(p).join("");
    this.caret = chars(before).length;
    return true;
  }

  // The start and the end of each line; an input's value is one.
  #lines(c: string[]): [number, number][] {
    const out: [number, number][] = [];
    let start = 0;
    c.forEach((ch, i) => {
      if (this.multiline && isBreak(ch)) {
        out.push([start, i]);
        start = i + 1;
      }
    });
    out.push([start, c.length]);
    return out;
  }

  #wordBack(c: string[], p: number): number {
    if (this.password) return 0;
    while (p > 0 && isSpace(c[p - 1]!)) p--;
    while (p > 0 && !isSpace(c[p - 1]!)) p--;
    return p;
  }

  #wordForward(c: string[], p: number): number {
    if (this.password) return c.length;
    while (p < c.length && isSpace(c[p]!)) p++;
    while (p < c.length && !isSpace(c[p]!)) p++;
    return p;
  }

  // The caret `by` rows away, at the place along the row the run began at;
  // past the first row the start, past the last the end.
  #row(c: string[], p: number, by: number): number {
    const lines = this.#lines(c);
    const r = lines.findIndex(([s, e]) => s <= p && p <= e);
    this.#goal ??= p - lines[r]![0];
    const t = r + by;
    if (t < 0) return 0;
    if (t >= lines.length) return c.length;
    const [s, e] = lines[t]!;
    return s + Math.min(this.#goal, e - s);
  }

  #delete(c: string[], p: number, a: number, b: number): boolean {
    this.caret = p;
    if (a >= b) return false;
    this.value = [...c.slice(0, a), ...c.slice(b)].join("");
    this.caret = a;
    return true;
  }
}

export { chars };
