// msgpack (https://github.com/msgpack/msgpack/blob/master/spec.md), the
// form of a host's bodies (SPEC §3.3): a reader, and a writer for the test
// host. Here rather than from a package, since JavaScript has one number
// type: a reader of hotty's bodies keeps msgpack's floats apart from its
// ints (an int field sent as 7.0 is the wrong type), and a writer is told
// which numbers are floats, so that 2.0 goes out as one.

/** How deep a body may nest, its map being the first level (SDK.md §3.9). */
export const MAX_DEPTH = 32;

/**
 * A float that msgpack sent, as {@link unpack} gives it when asked to keep
 * floats apart: once it is a number, 2.0 is 2. The writer sends one as a
 * float, whole or not.
 */
export class Float {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}

/**
 * A time, as msgpack's timestamp carries it (extension −1, SPEC §3.3):
 * seconds since 1970-01-01T00:00:00Z, and nanoseconds into the second. No
 * field of hotty 0.2 carries one.
 */
export class Time {
  /** Seconds since the Unix epoch, negative before it. */
  readonly sec: number;
  /** Nanoseconds into the second, from 0 to 999 999 999. */
  readonly nsec: number;

  constructor(sec: number, nsec = 0) {
    this.sec = sec;
    this.nsec = nsec;
  }

  /** The time as a Date, which keeps milliseconds: the rest of the nanoseconds is dropped. */
  toDate(): Date {
    return new Date(this.sec * 1000 + Math.floor(this.nsec / 1e6));
  }
}

/**
 * A body field's type (SPEC §3.3): `int`, `float`, `str` or `bool`; `[t]`,
 * an array of t; or a map, by its fields' types, or `{"*": t}`, from
 * strings to t. A field a map's type does not name may be of any type.
 */
export type Type = "int" | "float" | "str" | "bool" | readonly [Type] | { readonly [field: string]: Type };

// What a value is, from its first byte. The scalars are named as their types.
type Kind = "bool" | "int" | "float" | "str" | "bin" | "array" | "map" | "ext";

const MAX_INT = BigInt(Number.MAX_SAFE_INTEGER);
// A str that is not UTF-8 does not decode; a BOM is a character like any other.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Why the bytes do not decode: a SyntaxError, as JSON.parse throws.
function fail(why: string): never {
  throw new SyntaxError("msgpack: " + why);
}

// A field set on a map's object, __proto__ included.
function put(o: Record<string, unknown>, k: string, v: unknown) {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

// Reads msgpack from bytes it does not copy, one value at a time, each
// container's depth checked as it opens.
class Reader {
  readonly #b: Uint8Array;
  readonly #dv: DataView;
  #i = 0;
  // What the last head read: a scalar's value, or a container's length.
  #v: unknown;

  constructor(b: Uint8Array) {
    this.#b = b;
    this.#dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  // Where the next n bytes are, which are then read.
  #take(n: number): number {
    const at = this.#i;
    if (n > this.#b.length - at) fail("cut short");
    this.#i = at + n;
    return at;
  }

  #is(k: Kind, v: unknown): Kind {
    this.#v = v;
    return k;
  }

  // One value's head: what it is, and in #v a scalar's value or the length
  // of an array or a map, whose entries follow. A nil does not decode: no
  // host sends one (SPEC §3.3).
  #head(): Kind {
    const b = this.#b;
    const dv = this.#dv;
    const c = b[this.#take(1)]!;
    if (c <= 0x7f) return this.#is("int", c);
    if (c >= 0xe0) return this.#is("int", c - 0x100);
    if (c <= 0x8f) return this.#is("map", c & 0x0f);
    if (c <= 0x9f) return this.#is("array", c & 0x0f);
    if (c <= 0xbf) return this.#str(c & 0x1f);
    switch (c) {
      case 0xc0:
        return fail("a nil, which no host sends");
      case 0xc2:
        return this.#is("bool", false);
      case 0xc3:
        return this.#is("bool", true);
      case 0xc4:
        return this.#bin(b[this.#take(1)]!);
      case 0xc5:
        return this.#bin(dv.getUint16(this.#take(2)));
      case 0xc6:
        return this.#bin(dv.getUint32(this.#take(4)));
      case 0xc7:
        return this.#ext(b[this.#take(1)]!);
      case 0xc8:
        return this.#ext(dv.getUint16(this.#take(2)));
      case 0xc9:
        return this.#ext(dv.getUint32(this.#take(4)));
      case 0xca:
        return this.#is("float", dv.getFloat32(this.#take(4)));
      case 0xcb:
        return this.#is("float", dv.getFloat64(this.#take(8)));
      case 0xcc:
        return this.#is("int", b[this.#take(1)]!);
      case 0xcd:
        return this.#is("int", dv.getUint16(this.#take(2)));
      case 0xce:
        return this.#is("int", dv.getUint32(this.#take(4)));
      case 0xcf:
        return this.#is("int", safe(dv.getBigUint64(this.#take(8))));
      case 0xd0:
        return this.#is("int", dv.getInt8(this.#take(1)));
      case 0xd1:
        return this.#is("int", dv.getInt16(this.#take(2)));
      case 0xd2:
        return this.#is("int", dv.getInt32(this.#take(4)));
      case 0xd3:
        return this.#is("int", safe(dv.getBigInt64(this.#take(8))));
      case 0xd4:
        return this.#ext(1);
      case 0xd5:
        return this.#ext(2);
      case 0xd6:
        return this.#ext(4);
      case 0xd7:
        return this.#ext(8);
      case 0xd8:
        return this.#ext(16);
      case 0xd9:
        return this.#str(b[this.#take(1)]!);
      case 0xda:
        return this.#str(dv.getUint16(this.#take(2)));
      case 0xdb:
        return this.#str(dv.getUint32(this.#take(4)));
      case 0xdc:
        return this.#is("array", dv.getUint16(this.#take(2)));
      case 0xdd:
        return this.#is("array", dv.getUint32(this.#take(4)));
      case 0xde:
        return this.#is("map", dv.getUint16(this.#take(2)));
      case 0xdf:
        return this.#is("map", dv.getUint32(this.#take(4)));
    }
    return fail("no type starts with 0xc1");
  }

  #str(n: number): Kind {
    const at = this.#take(n);
    let s: string;
    try {
      s = utf8.decode(this.#b.subarray(at, at + n));
    } catch {
      return fail("a str that is not UTF-8");
    }
    return this.#is("str", s);
  }

  #bin(n: number): Kind {
    const at = this.#take(n);
    return this.#is("bin", this.#b.slice(at, at + n));
  }

  // An extension: a time when its type is −1, and any other undefined.
  #ext(n: number): Kind {
    const type = this.#dv.getInt8(this.#take(1));
    const at = this.#take(n);
    return this.#is("ext", type === -1 ? this.#time(at, n) : undefined);
  }

  // A timestamp of 32, 64 or 96 bits.
  #time(at: number, n: number): Time {
    const dv = this.#dv;
    let sec: number;
    let nsec = 0;
    if (n === 4) sec = dv.getUint32(at);
    else if (n === 8) {
      // 30 bits of nanoseconds, then 34 of seconds.
      const hi = dv.getUint32(at);
      nsec = hi >>> 2;
      sec = (hi & 3) * 2 ** 32 + dv.getUint32(at + 4);
    } else if (n === 12) {
      nsec = dv.getUint32(at);
      sec = safe(dv.getBigInt64(at + 4));
    } else return fail(`a timestamp of ${n} bytes`);
    if (nsec > 999_999_999) fail("a timestamp's nanoseconds past a second");
    return new Time(sec, nsec);
  }

  // The length of the container just read, which opens at depth (the
  // body's map at 0). Each entry takes a byte at least, so a length past
  // the bytes left is cut short, and nothing is made that long.
  #open(depth: number, bytes: number): number {
    if (depth >= MAX_DEPTH) fail(`nested more than ${MAX_DEPTH} deep`);
    const n = this.#v as number;
    if (n * bytes > this.#b.length - this.#i) fail("cut short");
    return n;
  }

  // A map's key, which is a str its map has not given before (SPEC §3.3):
  // one of another type, or given twice, does not decode, whatever follows
  // it. Keys compare as the strings they are, whatever their form.
  #key(given: Set<string>): string {
    const k = this.#head();
    if (k !== "str") fail(`${k} for a key`);
    const key = this.#v as string;
    if (given.has(key)) fail(`the key ${JSON.stringify(key)} given twice`);
    given.add(key);
    return key;
  }

  /** One value, as unpack has it. */
  value(depth: number, floats: boolean): unknown {
    switch (this.#head()) {
      case "float":
        return floats ? new Float(this.#v as number) : this.#v;
      case "array": {
        const n = this.#open(depth, 1);
        const a: unknown[] = [];
        for (let k = 0; k < n; k++) a.push(this.value(depth + 1, floats));
        return a;
      }
      case "map": {
        const n = this.#open(depth, 2);
        const o: Record<string, unknown> = {};
        const given = new Set<string>();
        for (let k = 0; k < n; k++) {
          const key = this.#key(given);
          const v = this.value(depth + 1, floats);
          if (v !== undefined) put(o, key, v);
        }
        return o;
      }
    }
    return this.#v;
  }

  /** One value of type t, or a SyntaxError when it is of another. */
  typed(t: Type, depth: number): unknown {
    const k = this.#head();
    if (typeof t === "string") return k === t ? this.#v : fail(`${k} for ${t}`);
    if (Array.isArray(t)) {
      if (k !== "array") fail(`${k} for an array`);
      const n = this.#open(depth, 1);
      const a: unknown[] = [];
      for (let i = 0; i < n; i++) a.push(this.typed(t[0] as Type, depth + 1));
      return a;
    }
    if (k !== "map") fail(`${k} for a map`);
    const fields = t as { readonly [field: string]: Type };
    const each = Object.hasOwn(fields, "*") ? fields["*"] : undefined;
    const n = this.#open(depth, 2);
    const o: Record<string, unknown> = {};
    const given = new Set<string>();
    for (let i = 0; i < n; i++) {
      const key = this.#key(given);
      const f = each ?? (Object.hasOwn(fields, key) ? fields[key] : undefined);
      // A field this reader does not know is kept as it came.
      const v = f !== undefined ? this.typed(f, depth + 1) : this.value(depth + 1, false);
      if (v !== undefined) put(o, key, v);
    }
    return o;
  }

  /** The bytes are read: nothing may follow the value. */
  end(): void {
    if (this.#i !== this.#b.length) fail("bytes after the value");
  }
}

// An int of 64 bits, as a number: one further than 2^53 − 1 from zero
// would be rounded, and does not decode (SDK.md §3.9).
function safe(x: bigint): number {
  if (x > MAX_INT || x < -MAX_INT) fail("an int further than 2^53 − 1 from zero");
  return Number(x);
}

/** Options of {@link unpack}. */
export interface UnpackOptions {
  /** Keep floats apart from ints: each float comes as a {@link Float}. */
  floats?: boolean;
}

/**
 * The one msgpack value the bytes hold, as plain values: an int or a float
 * is a number (a Float, with `floats`), a str a string, bin a Uint8Array, a
 * timestamp a {@link Time}, an array an array, and a map an object. Another
 * extension is skipped: left out of a map, undefined in an array.
 *
 * Throws a SyntaxError, as JSON.parse does, when the bytes are not one
 * value: cut short, followed by more, or starting with 0xc1. So does one
 * that holds, anywhere in it, what no host sends (SPEC §3.3, SDK.md §3.9):
 * a nil, a map key that is not a str or is given twice in one map, a str
 * that is not UTF-8, an int further than 2^53 − 1 from zero, or a timestamp
 * of another size than 4, 8 or 12 bytes, with a second's nanoseconds or
 * more, or with seconds further than 2^53 − 1 from 1970; and one nested
 * more than {@link MAX_DEPTH} deep.
 */
export function unpack(data: Uint8Array, options: UnpackOptions = {}): unknown {
  const r = new Reader(data);
  const v = r.value(0, options.floats ?? false);
  r.end();
  return v;
}

/**
 * A body read as its type (SDK.md §3.9): one map, each field the type
 * names read as its type, and the others kept as unpack has them.
 * Undefined when the body does not decode: it is not one map, a field the
 * type names holds another type, or it holds anywhere, in a field the type
 * names or not, what {@link unpack} throws for (a nil, a key that is not a
 * str).
 */
export function readBody(data: Uint8Array, t: Type): Record<string, unknown> | undefined {
  try {
    const r = new Reader(data);
    const v = r.typed(t, 0);
    r.end();
    return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof SyntaxError) return undefined;
    throw e;
  }
}

// --- writing -----------------------------------------------------------------

const toUtf8 = new TextEncoder();

// A plain object, which the writer writes as a map.
function isPlain(v: unknown): v is object {
  if (typeof v !== "object" || v === null) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

// Writes msgpack to a buffer that grows: each value in its smallest form,
// but floats, which are 64 bits.
class Writer {
  #b = new Uint8Array(64);
  #dv = new DataView(this.#b.buffer);
  #n = 0;

  bytes(): Uint8Array {
    return this.#b.slice(0, this.#n);
  }

  // Makes room for n bytes, and returns where they go. The buffer may move:
  // #b and #dv are read after.
  #room(n: number): number {
    if (this.#n + n > this.#b.length) {
      const b = new Uint8Array(Math.max(this.#b.length * 2, this.#n + n));
      b.set(this.#b.subarray(0, this.#n));
      this.#b = b;
      this.#dv = new DataView(b.buffer);
    }
    const at = this.#n;
    this.#n += n;
    return at;
  }

  // A head byte, and room for the n bytes after it: where they go.
  #head(c: number, n: number): number {
    const at = this.#room(1 + n);
    this.#b[at] = c;
    return at + 1;
  }

  // A length's head: the fix form up to fixMax, then 8, 16 or 32 bits (a
  // c8 of 0 has no 8-bit form).
  #len(n: number, fix: number, fixMax: number, c8: number, c16: number, c32: number) {
    if (n <= fixMax) this.#head(fix | n, 0);
    else if (c8 && n < 0x100) {
      const at = this.#head(c8, 1);
      this.#b[at] = n;
    } else if (n < 0x10000) {
      const at = this.#head(c16, 2);
      this.#dv.setUint16(at, n);
    } else {
      const at = this.#head(c32, 4);
      this.#dv.setUint32(at, n);
    }
  }

  #int(x: number) {
    if (!Number.isSafeInteger(x)) throw new RangeError(`msgpack: ${x} is no int a host sends (SPEC §3.3)`);
    if (x >= -0x20 && x < 0x80) {
      this.#head(x & 0xff, 0);
      return;
    }
    // The smallest form that holds it: unsigned when it is not negative.
    const n = x >= 0 ? (x < 0x100 ? 1 : x < 0x10000 ? 2 : x < 2 ** 32 ? 4 : 8) : x >= -0x80 ? 1 : x >= -0x8000 ? 2 : x >= -(2 ** 31) ? 4 : 8;
    const c = (x >= 0 ? 0xcc : 0xd0) + Math.log2(n);
    const at = this.#head(c, n);
    const dv = this.#dv;
    if (n === 8) {
      if (x >= 0) dv.setBigUint64(at, BigInt(x));
      else dv.setBigInt64(at, BigInt(x));
    } else if (n === 4) {
      if (x >= 0) dv.setUint32(at, x);
      else dv.setInt32(at, x);
    } else if (n === 2) {
      if (x >= 0) dv.setUint16(at, x);
      else dv.setInt16(at, x);
    } else if (x >= 0) dv.setUint8(at, x);
    else dv.setInt8(at, x);
  }

  #float(x: number) {
    const at = this.#head(0xcb, 8);
    this.#dv.setFloat64(at, x);
  }

  #raw(u: Uint8Array) {
    const at = this.#room(u.length);
    this.#b.set(u, at);
  }

  // A timestamp in its smallest form: 32 bits for whole seconds from 1970
  // to 2106, 64 bits to 2514, else 96.
  #time(t: Time) {
    const { sec, nsec } = t;
    if (!Number.isSafeInteger(sec) || !Number.isInteger(nsec) || nsec < 0 || nsec > 999_999_999) {
      throw new RangeError(`msgpack: no timestamp is ${sec} s and ${nsec} ns`);
    }
    if (nsec === 0 && sec >= 0 && sec < 2 ** 32) {
      const at = this.#head(0xd6, 5);
      this.#dv.setInt8(at, -1);
      this.#dv.setUint32(at + 1, sec);
    } else if (sec >= 0 && sec < 2 ** 34) {
      const at = this.#head(0xd7, 9);
      this.#dv.setInt8(at, -1);
      this.#dv.setUint32(at + 1, nsec * 4 + Math.floor(sec / 2 ** 32));
      this.#dv.setUint32(at + 5, sec % 2 ** 32);
    } else {
      const at = this.#head(0xc7, 14);
      this.#dv.setUint8(at, 12);
      this.#dv.setInt8(at + 1, -1);
      this.#dv.setUint32(at + 2, nsec);
      this.#dv.setBigInt64(at + 6, BigInt(sec));
    }
  }

  /** A value, its numbers steered by t: see pack. */
  value(v: unknown, t: Type | undefined): void {
    if (v instanceof Float) this.#float(v.value);
    else if (typeof v === "number") {
      if (t === "float" || !Number.isInteger(v)) this.#float(v);
      else this.#int(v);
    } else if (typeof v === "string") {
      const u = toUtf8.encode(v);
      this.#len(u.length, 0xa0, 31, 0xd9, 0xda, 0xdb);
      this.#raw(u);
    } else if (typeof v === "boolean") this.#head(v ? 0xc3 : 0xc2, 0);
    else if (v instanceof Uint8Array) {
      this.#len(v.length, 0, -1, 0xc4, 0xc5, 0xc6);
      this.#raw(v);
    } else if (v instanceof Time) this.#time(v);
    else if (Array.isArray(v)) {
      const each = Array.isArray(t) ? (t[0] as Type) : undefined;
      this.#len(v.length, 0x90, 15, 0, 0xdc, 0xdd);
      for (const x of v) this.value(x, each);
    } else if (isPlain(v)) {
      const fields = typeof t === "object" && !Array.isArray(t) ? (t as { readonly [field: string]: Type }) : undefined;
      // A field with nothing in it is left out: a host never sends nil.
      const entries = Object.entries(v).filter(([, x]) => x !== undefined && x !== null);
      this.#len(entries.length, 0x80, 15, 0, 0xde, 0xdf);
      for (const [k, x] of entries) {
        this.value(k, undefined);
        const f = fields && (Object.hasOwn(fields, "*") ? fields["*"] : Object.hasOwn(fields, k) ? fields[k] : undefined);
        this.value(x, f);
      }
    } else {
      throw new TypeError(`msgpack: ${v === null ? "null" : typeof v}, which a host does not send`);
    }
  }
}

/**
 * A value as msgpack, as a host writes a body (SPEC §3.3): one map, each
 * field as its type. A number is an int when it is whole, and a float when
 * it is not, when t says the field is a float, or when it is a
 * {@link Float}. A string is a str, a Uint8Array bin, a {@link Time} a
 * timestamp, an array an array, and a plain object a map keyed by its
 * names, strs, which leaves out a field that is undefined or null. Throws a
 * TypeError for anything else, null and undefined among them (in an array
 * too), and a RangeError for an int further than 2^53 − 1 from zero: it
 * writes nothing a host does not send.
 */
export function pack(v: unknown, t?: Type): Uint8Array {
  const w = new Writer();
  w.value(v, t);
  return w.bytes();
}
