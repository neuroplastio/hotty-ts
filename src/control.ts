// A command's control: an ordered list of keys and values (SDK.md §3.2).

/** A pair of a key and its value. */
export type Pair = readonly [key: string, value: string];

/**
 * What {@link encode} takes as a control: a {@link Control}, pairs in
 * order, or an object, whose keys keep the order they were written in
 * (control keys begin with a letter, so no key is an array index).
 */
export type ControlLike = Control | Iterable<readonly [string, string | number]> | Readonly<Record<string, string | number>>;

/**
 * A command's keys and values, in the order they are sent. It is
 * immutable: {@link Control.with} returns a new one.
 */
export class Control implements Iterable<Pair> {
  readonly #pairs: Pair[];

  constructor(pairs: Iterable<readonly [string, string | number]> = []) {
    this.#pairs = [];
    for (const [k, v] of pairs) this.#pairs.push([k, String(v)]);
  }

  /** The control as given: a Control as it is, anything else read in order. */
  static from(c: ControlLike): Control {
    if (c instanceof Control) return c;
    if (Symbol.iterator in c) return new Control(c as Iterable<readonly [string, string | number]>);
    return new Control(Object.entries(c));
  }

  /** A key's value, or undefined when the control lacks the key. */
  get(key: string): string | undefined {
    for (const [k, v] of this.#pairs) if (k === key) return v;
    return undefined;
  }

  /** Whether the control has the key. */
  has(key: string): boolean {
    return this.#pairs.some(([k]) => k === key);
  }

  /** The control with a key set: in place if it has the key, at the end if not. */
  with(key: string, value: string | number): Control {
    const out = new Control(this.#pairs);
    const pairs = out.#pairs;
    const i = pairs.findIndex(([k]) => k === key);
    if (i >= 0) pairs[i] = [key, String(value)];
    else pairs.push([key, String(value)]);
    return out;
  }

  /** The number of keys. */
  get size(): number {
    return this.#pairs.length;
  }

  /** The keys, in order. */
  keys(): string[] {
    return this.#pairs.map(([k]) => k);
  }

  [Symbol.iterator](): Iterator<Pair> {
    return this.#pairs[Symbol.iterator]();
  }
}
