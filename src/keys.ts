// What a text field does with a key (SDK.md §3.10; SPEC §10.2, §10.4): key
// names, the keys in what a terminal sends, and keymaps.

/** The modifier keys, in the order a key's name writes them (SPEC §10.4). */
export const MODIFIERS = ["Control", "Alt", "Meta", "Shift"] as const;
/** One of {@link MODIFIERS}. */
export type Modifier = (typeof MODIFIERS)[number];

/** A text field's actions (SPEC §10.2). */
export const ACTIONS = [
  "char-backward",
  "char-forward",
  "word-backward",
  "word-forward",
  "line-start",
  "line-end",
  "delete-char-backward",
  "delete-char-forward",
  "delete-word-backward",
  "delete-word-forward",
  "delete-to-line-start",
  "delete-to-line-end",
  "line-previous",
  "line-next",
  "page-up",
  "page-down",
  "input-start",
  "input-end",
  "newline",
  "submit",
  "program",
] as const;
/** One of {@link ACTIONS}. */
export type Action = (typeof ACTIONS)[number];

/** The actions only a multi-line field has (SPEC §10.2). */
export const MULTILINE_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "line-previous",
  "line-next",
  "page-up",
  "page-down",
  "input-start",
  "input-end",
  "newline",
]);

/** What {@link Keymap.lookup} returns for a character the field types. */
export const INSERT = "insert";

/**
 * The SDK's keymap (SDK.md §3.10), as a `data-keys` value: the keys of
 * Bubble Tea's text input and text area. A program puts it on an element
 * that holds its fields, and edits its fields in cells with
 * `resolve(multiline, TERMINAL_KEYS)`.
 */
export const TERMINAL_KEYS = [
  "ArrowLeft=char-backward Control+b=char-backward ArrowRight=char-forward Control+f=char-forward",
  "Alt+ArrowLeft=word-backward Control+ArrowLeft=word-backward Alt+b=word-backward",
  "Alt+ArrowRight=word-forward Control+ArrowRight=word-forward Alt+f=word-forward",
  "Home=line-start Control+a=line-start End=line-end Control+e=line-end",
  "Backspace=delete-char-backward Control+h=delete-char-backward",
  "Delete=delete-char-forward Control+d=delete-char-forward",
  "Alt+Backspace=delete-word-backward Control+w=delete-word-backward Control+Backspace=delete-word-backward",
  "Alt+Delete=delete-word-forward Alt+d=delete-word-forward Control+Delete=delete-word-forward",
  "Control+u=delete-to-line-start Control+k=delete-to-line-end",
  "ArrowUp=line-previous Control+p=line-previous ArrowDown=line-next Control+n=line-next",
  "PageUp=page-up PageDown=page-down",
  "Alt+<=input-start Control+Home=input-start Alt+>=input-end Control+End=input-end",
  "Control+m=newline",
].join(" ");

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A text's characters: its grapheme clusters (SPEC §10.2), CR LF one. */
export function chars(s: string): string[] {
  return Array.from(segmenter.segment(s), (g) => g.segment);
}

const codePoints = (s: string) => [...s].length;

// One character, not a control.
function isChar(v: string): boolean {
  if (v === "" || chars(v).length !== 1) return false;
  const c = v.codePointAt(0)!;
  return c >= 0x20 && c !== 0x7f;
}

const NAMED = /^[A-Z][A-Za-z0-9]+$/;
const isModifier = (m: string): m is Modifier => (MODIFIERS as readonly string[]).includes(m);

// A key's name as its modifiers and its value, or undefined when it does
// not parse.
function splitKey(name: string): [Modifier[], string] | undefined {
  let head: string;
  let value: string;
  if (name.endsWith("++") && name.length > 2) {
    head = name.slice(0, -2);
    value = "+";
  } else if (name === "+") {
    head = "";
    value = "+";
  } else {
    const i = name.lastIndexOf("+");
    [head, value] = i >= 0 ? [name.slice(0, i), name.slice(i + 1)] : ["", name];
  }
  const mods = head ? head.split("+") : [];
  if (!mods.every(isModifier) || new Set(mods).size !== mods.length) return undefined;
  if (value === "Space") value = " ";
  if (!isChar(value) && !NAMED.test(value)) return undefined;
  return [mods, value];
}

// The canonical name of a key: modifiers in order, Shift shown in a letter
// where it can be, Space for a space.
function keyName(mods: readonly Modifier[], value: string): string {
  let m = new Set(mods);
  if (m.has("Shift") && isChar(value) && codePoints(value) === 1) {
    const up = value.toUpperCase();
    const low = value.toLowerCase();
    if (codePoints(up) === 1 && up !== value) {
      value = up;
      m = new Set([...m].filter((x) => x !== "Shift"));
    } else if (codePoints(low) === 1 && low !== value) {
      m = new Set([...m].filter((x) => x !== "Shift"));
    }
  }
  return [...MODIFIERS.filter((x) => m.has(x)), value === " " ? "Space" : value].join("+");
}

/**
 * A key's name in its canonical form (SDK.md §3.10): `Shift+Control+a` is
 * `Control+A`, `Control+ ` is `Control+Space`. Undefined when the name does
 * not parse: empty, an unknown modifier, a modifier twice, no key.
 */
export function parseKey(name: string): string | undefined {
  const k = splitKey(name);
  return k && keyName(...k);
}

// --- decoding (SPEC §10.4) ---------------------------------------------------

const C0: Record<number, string> = {
  0x00: "Control+Space",
  0x08: "Control+h",
  0x09: "Tab",
  0x0d: "Enter",
  0x1b: "Escape",
  0x7f: "Backspace",
  0x1c: "Control+\\",
  0x1d: "Control+]",
  0x1e: "Control+^",
  0x1f: "Control+_",
};
const CSI_FINAL: Record<string, string> = { A: "ArrowUp", B: "ArrowDown", C: "ArrowRight", D: "ArrowLeft", H: "Home", F: "End" };
const TILDE: Record<number, string> = { 1: "Home", 7: "Home", 4: "End", 8: "End", 2: "Insert", 3: "Delete", 5: "PageUp", 6: "PageDown" };
const CODES: Record<number, string> = { 9: "Tab", 13: "Enter", 27: "Escape", 8: "Backspace", 127: "Backspace" };
// The kitty keyboard protocol's codes from 57344 that name keys.
const KITTY: Record<number, string> = {
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [57399 + i, String(i)])),
  57409: ".",
  57410: "/",
  57411: "*",
  57412: "-",
  57413: "+",
  57414: "Enter",
  57415: "=",
  57417: "ArrowLeft",
  57418: "ArrowRight",
  57419: "ArrowUp",
  57420: "ArrowDown",
  57421: "PageUp",
  57422: "PageDown",
  57423: "Home",
  57424: "End",
  57425: "Insert",
  57426: "Delete",
  57441: "Shift",
  57442: "Control",
  57443: "Alt",
  57444: "Meta",
  57447: "Shift",
  57448: "Control",
  57449: "Alt",
  57450: "Meta",
};

class Malformed extends Error {}

// A CSI parameter as a number; anything but digits is malformed.
function int(s: string): number {
  if (!/^\d+$/.test(s)) throw new Malformed();
  return Number(s);
}

// A key's name with more modifiers.
function withMods(name: string | undefined, add: readonly Modifier[]): string | undefined {
  if (name === undefined) return undefined;
  const [mods, value] = splitKey(name)!;
  return keyName([...mods, ...add.filter((m) => !mods.includes(m))], value);
}

// The modifiers in a CSI parameter `m[:e]`, and whether it is a release.
function modifiers(field: string): [Modifier[], boolean] {
  const parts = field.split(":");
  const m = parts[0] ? int(parts[0]) : 1;
  const e = parts.length > 1 && parts[1] ? int(parts[1]) : 1;
  // Absent, empty or below 2: no modifier.
  const bits = Math.max(m - 1, 0);
  const mods: Modifier[] = [];
  if (bits & 1) mods.push("Shift");
  if (bits & 2) mods.push("Alt");
  if (bits & 4) mods.push("Control");
  if (bits & (8 | 32)) mods.push("Meta");
  return [mods, e === 3];
}

// The key a kitty or modifyOtherKeys code names.
function codeKey(code: number, mods: Modifier[], shifted?: number, text?: string): string | undefined {
  const named = CODES[code];
  if (named !== undefined) return keyName(mods, named);
  if (code >= 57344) {
    const k = KITTY[code];
    return k === undefined ? undefined : keyName(mods, k);
  }
  if (code < 0x20 || code === 0x7f) return undefined;
  const base = String.fromCodePoint(code);
  let value = base;
  if (mods.includes("Shift")) {
    if (shifted) value = String.fromCodePoint(shifted);
    else if (text) value = text;
    else if (codePoints(value.toUpperCase()) === 1) value = value.toUpperCase();
    if (value !== base) mods = mods.filter((m) => m !== "Shift");
  }
  return [...MODIFIERS.filter((m) => mods.includes(m)), value === " " ? "Space" : value].join("+");
}

// The key a CSI sequence names.
function csi(params: string, final: string): string | undefined {
  if (["<", "=", ">", "?"].includes(params.slice(0, 1))) return undefined;
  const fields = params.split(";");
  try {
    const mods = (): [Modifier[], boolean] => (fields.length > 1 ? modifiers(fields[1]!) : [[], false]);
    if (final === "u") {
      const codes = fields[0]!.split(":").map((x) => (x ? int(x) : 0));
      const [m, release] = mods();
      if (release) return undefined;
      const text =
        fields.length > 2
          ? fields[2]!
              .split(":")
              .filter((x) => x)
              .map((x) => String.fromCodePoint(int(x)))
              .join("")
          : undefined;
      return codeKey(codes[0]!, m, codes.length > 1 ? codes[1] : undefined, text);
    }
    if (final === "~") {
      const n = fields[0] ? int(fields[0]) : 0;
      if (n === 27 && fields.length >= 3) {
        const [m, release] = modifiers(fields[1]!);
        return release ? undefined : codeKey(int(fields[2]!), m);
      }
      const named = TILDE[n];
      if (named === undefined) return undefined;
      const [m, release] = mods();
      return release ? undefined : keyName(m, named);
    }
    const named = CSI_FINAL[final];
    if (named !== undefined) {
      const [m, release] = mods();
      return release ? undefined : keyName(m, named);
    }
    if (final === "Z") return "Shift+Tab";
  } catch (e) {
    if (e instanceof Malformed || e instanceof RangeError) return undefined;
    throw e;
  }
  return undefined;
}

const utf8 = new TextEncoder();

// The code point of a UTF-8 sequence at data[i], and its length; undefined
// when the bytes there are not one.
function codePointAt(data: Uint8Array, i: number): [number, number] | undefined {
  const b = data[i]!;
  const n = b < 0x80 ? 1 : b >> 5 === 6 ? 2 : b >> 4 === 14 ? 3 : b >> 3 === 30 ? 4 : 0;
  if (n === 0 || i + n > data.length) return undefined;
  if (n === 1) return [b, 1];
  let c = b & (0xff >> (n + 1));
  for (let k = 1; k < n; k++) {
    const x = data[i + k]!;
    if (x >> 6 !== 2) return undefined;
    c = (c << 6) | (x & 0x3f);
  }
  const min = [0, 0, 0x80, 0x800, 0x10000][n]!;
  if (c < min || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return undefined;
  return [c, n];
}

// The key of a control byte or a character at data[i], and its length.
function one(data: Uint8Array, i: number): [string | undefined, number] {
  const b = data[i]!;
  if (b < 0x20 || b === 0x7f) return [C0[b] ?? "Control+" + String.fromCharCode(b + 0x60), 1];
  // The text from here up to the next control, then its first character.
  let text = "";
  for (let j = i; j < data.length && data[j]! >= 0x20 && data[j] !== 0x7f; ) {
    const cp = codePointAt(data, j);
    if (!cp) break;
    text += String.fromCodePoint(cp[0]);
    j += cp[1];
  }
  if (text === "") return [undefined, 1];
  const c = chars(text)[0]!;
  return [c === " " ? "Space" : c, utf8.encode(c).length];
}

/**
 * The keys in input from the terminal, the bytes a program reads, as SPEC
 * §10.4 names them: a canonical name for each key, or undefined for input
 * that is no key it names (a mouse report, a sequence it does not know).
 * It is pure: an ESC at the end of the input is Escape, so the caller passes
 * each read whole.
 */
export function decodeKeys(input: Uint8Array | string): (string | undefined)[] {
  const data = typeof input === "string" ? utf8.encode(input) : input;
  const out: (string | undefined)[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] !== 0x1b) {
      const [k, n] = one(data, i);
      out.push(k);
      i += n;
      continue;
    }
    if (i + 1 === data.length) {
      out.push("Escape");
      break;
    }
    const next = data[i + 1]!;
    if ((next === 0x5b || next === 0x4f) && i + 2 < data.length) {
      if (next === 0x4f) {
        const f = String.fromCharCode(data[i + 2]!);
        out.push("ABCDHF".includes(f) ? CSI_FINAL[f] : undefined);
        i += 3;
        continue;
      }
      let j = i + 2;
      while (j < data.length && data[j]! >= 0x30 && data[j]! <= 0x3f) j++;
      const params = String.fromCharCode(...data.subarray(i + 2, j));
      while (j < data.length && data[j]! >= 0x20 && data[j]! <= 0x2f) j++;
      if (j === data.length) {
        out.push(undefined);
        break;
      }
      out.push(data[j]! >= 0x40 ? csi(params, String.fromCharCode(data[j]!)) : undefined);
      i = j + 1;
      continue;
    }
    const [k, n] = one(data, i + 1);
    out.push(withMods(k, ["Alt"]));
    i += 1 + n;
  }
  return out;
}

// --- keymaps (SPEC §10.2) ----------------------------------------------------

const isAction = (a: string): a is Action => (ACTIONS as readonly string[]).includes(a);
const UNBINDABLE = new Set(["Tab", "Shift+Tab", "Escape"]);

/**
 * Bindings of keys to actions (SPEC §10.2). {@link parseKeymap} reads one
 * from `data-keys`; {@link resolve} makes the one a field uses, whose
 * {@link Keymap.lookup} says what the field does with a key.
 */
export class Keymap {
  readonly #bindings = new Map<string, Action>();
  /** Whether the field is multi-line: the actions only it has are the field's. */
  readonly multiline: boolean;

  constructor(multiline = false) {
    this.multiline = multiline;
  }

  /**
   * Binds a key to an action, as a host reads a binding: false, and
   * nothing bound, when the key does not parse, the action is unknown, or
   * the key is Tab, Shift+Tab or Escape. A key bound again keeps its place.
   */
  bind(key: string, action: string): boolean {
    const k = parseKey(key);
    if (k === undefined || !isAction(action) || UNBINDABLE.has(k)) return false;
    this.#bindings.set(k, action);
    return true;
  }

  /** The bindings, in the order their keys were first bound. */
  bindings(): ReadonlyMap<string, Action> {
    return this.#bindings;
  }

  /** The keymap as a `data-keys` value: `key=action`, separated by a space. */
  format(): string {
    return [...this.#bindings].map(([k, a]) => `${k}=${a}`).join(" ");
  }

  /**
   * What the field does with a key: an action; {@link INSERT} for a
   * character it types; undefined when the key is not the field's (it
   * reaches the program, or Tab moves focus).
   */
  lookup(key: string): Action | typeof INSERT | undefined {
    const k = parseKey(key);
    if (k === undefined || UNBINDABLE.has(k)) return undefined;
    const [mods, value] = splitKey(k)!;
    let a = this.#bindings.get(k);
    if (a === undefined && mods.includes("Shift")) {
      a = this.#bindings.get(
        keyName(
          mods.filter((m) => m !== "Shift"),
          value,
        ),
      );
    }
    if (a !== undefined) return a === "program" || (MULTILINE_ACTIONS.has(a) && !this.multiline) ? undefined : a;
    if (isChar(value) && !mods.some((m) => m !== "Shift")) return INSERT;
    return undefined;
  }
}

/** A `data-keys` value's bindings, without those a host ignores (SPEC §10.2). */
export function parseKeymap(value: string): Keymap {
  const m = new Keymap();
  // ASCII white space separates bindings; NBSP and the rest do not.
  for (const b of value.split(/[ \t\n\f\r]+/)) {
    const i = b.lastIndexOf("=");
    if (i >= 0) m.bind(b.slice(0, i), b.slice(i + 1));
  }
  return m;
}

/**
 * A field's keymap: SPEC §10.2's default for an `input`, or for a
 * multi-line field, then each `data-keys` value in turn, the root's first.
 */
export function resolve(multiline: boolean, ...values: string[]): Keymap {
  const m = new Keymap(multiline);
  const base: [string, Action][] = [
    ["ArrowLeft", "char-backward"],
    ["ArrowRight", "char-forward"],
    ["Home", "line-start"],
    ["End", "line-end"],
    ["Backspace", "delete-char-backward"],
    ["Delete", "delete-char-forward"],
    ["ArrowUp", "line-previous"],
    ["ArrowDown", "line-next"],
    ["PageUp", "page-up"],
    ["PageDown", "page-down"],
    ["Enter", multiline ? "newline" : "submit"],
  ];
  for (const [k, a] of base) m.bind(k, a);
  for (const v of values) for (const [k, a] of parseKeymap(v).bindings()) m.bind(k, a);
  return m;
}
