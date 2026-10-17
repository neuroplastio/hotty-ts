// hotty sequences out of a byte stream, however the reads split it
// (SDK.md §3.7).

import { NUMBER } from "./constants.ts";

/**
 * A piece of the stream: `pass`, bytes that are not hotty's, unchanged;
 * `osc`, one complete hotty sequence from `ESC ] 7279 ;` to its terminator;
 * `da1`, an answer to Primary Device Attributes, from a Scanner that looks
 * for them.
 */
export interface Segment {
  kind: "pass" | "osc" | "da1";
  data: Uint8Array;
}

/** The longest hotty sequence a Scanner keeps, its terminator not counted. */
export const SCAN_MAX = 64 << 10;

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const PREFIX = new TextEncoder().encode("\x1b]" + NUMBER + ";");
const DA1_PREFIX = new TextEncoder().encode("\x1b[?");
const utf8 = new TextEncoder();

// A growable byte buffer.
class Bytes {
  buf = new Uint8Array(64);
  len = 0;
  push(c: number) {
    if (this.len === this.buf.length) this.grow(this.len + 1);
    this.buf[this.len++] = c;
  }
  append(b: Uint8Array) {
    if (this.len + b.length > this.buf.length) this.grow(this.len + b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  grow(n: number) {
    let size = this.buf.length * 2;
    while (size < n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  take(): Uint8Array {
    const out = this.buf.slice(0, this.len);
    this.len = 0;
    return out;
  }
  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

// Whether the first n bytes of b are p's first n.
function startsWith(p: Uint8Array, b: Uint8Array, n: number): boolean {
  if (n > p.length) return false;
  for (let i = 0; i < n; i++) if (p[i] !== b[i]) return false;
  return true;
}

const MODE = { ground: 0, osc: 1, discard: 2 } as const;
type Mode = (typeof MODE)[keyof typeof MODE];

/** Options of a {@link Scanner}. */
export interface ScannerOptions {
  /** Cut out DA1 answers (`CSI ? <digits and ;> c`) as `da1` segments, for an SDK that reads DA1 itself. */
  da1?: boolean;
}

/**
 * Cuts hotty sequences out of a byte stream (SDK.md §3.7). It holds only
 * what may still become a segment of its own: the start of `ESC ] 7279 ;`
 * (or of a DA1 answer), and a hotty sequence in progress. Everything else
 * goes out in the same feed that brought it, so the segments do not depend
 * on how the stream was split.
 */
export class Scanner {
  /** Whether it cuts out DA1 answers. */
  readonly da1: boolean;
  /** The sequences it dropped as malformed. */
  invalid = 0;
  #mode: Mode = MODE.ground;
  #held = new Bytes(); // a prefix of a sequence, or the hotty sequence in progress
  #esc = false; // the last byte inside a hotty sequence was ESC
  #out: Segment[] = [];
  #pass = new Bytes();

  constructor(options: ScannerOptions = {}) {
    this.da1 = options.da1 ?? false;
  }

  /** The bytes held for the next feed. */
  get holding(): Uint8Array {
    return this.#held.view().slice();
  }

  /** Takes the next bytes of the stream (a string is UTF-8), and returns the segments they complete. */
  feed(data: Uint8Array | string): Segment[] {
    const b = typeof data === "string" ? utf8.encode(data) : data;
    let i = 0;
    while (i < b.length) {
      // Bytes with nothing held and no ESC among them go out as they are.
      if (this.#mode === MODE.ground && this.#held.len === 0) {
        let j = b.indexOf(ESC, i);
        if (j < 0) j = b.length;
        if (j > i) {
          this.#pass.append(b.subarray(i, j));
          i = j;
          continue;
        }
      }
      this.#byte(b[i]!);
      i++;
    }
    return this.#take();
  }

  /**
   * Ends the stream: what is held goes out as pass, except a hotty
   * sequence in progress, which is dropped as malformed.
   */
  flush(): Segment[] {
    if (this.#mode === MODE.osc) this.invalid++;
    else if (this.#mode === MODE.ground && this.#held.len > 0) this.#pass.append(this.#held.view());
    this.#mode = MODE.ground;
    this.#held.len = 0;
    this.#esc = false;
    return this.#take();
  }

  #take(): Segment[] {
    this.#endPass();
    const out = this.#out;
    this.#out = [];
    return out;
  }

  #endPass() {
    if (this.#pass.len > 0) this.#out.push({ kind: "pass", data: this.#pass.take() });
  }

  #emit(kind: "osc" | "da1", data: Uint8Array) {
    this.#endPass();
    this.#out.push({ kind, data });
  }

  #byte(c: number) {
    if (this.#mode === MODE.discard) {
      // Dropping a hotty sequence longer than SCAN_MAX, up to its end.
      if (this.#esc) {
        this.#esc = false;
        this.#mode = MODE.ground;
        if (c !== BACKSLASH) {
          this.#held.push(ESC); // an ESC that is not ST begins a new sequence
          this.#ground(c);
        }
      } else if (c === BEL) {
        this.#mode = MODE.ground;
      } else if (c === ESC) {
        this.#esc = true;
      }
      return;
    }
    if (this.#mode === MODE.osc) {
      if (this.#esc) {
        this.#esc = false;
        if (c === BACKSLASH) {
          this.#held.push(c);
          this.#emit("osc", this.#held.take());
          this.#mode = MODE.ground;
          return;
        }
        // ESC without \ ends the sequence unfinished: it is dropped, and
        // the ESC begins whatever comes next.
        this.invalid++;
        this.#mode = MODE.ground;
        this.#held.len = 0;
        this.#held.push(ESC);
        this.#ground(c);
        return;
      }
      if (c === BEL) {
        this.#held.push(c);
        this.#emit("osc", this.#held.take());
        this.#mode = MODE.ground;
        return;
      }
      if (this.#held.len >= SCAN_MAX) {
        this.invalid++;
        this.#mode = MODE.discard;
        this.#held.len = 0;
        this.#esc = c === ESC;
        return;
      }
      this.#esc = c === ESC;
      this.#held.push(c);
      return;
    }
    this.#ground(c);
  }

  #ground(c: number) {
    const held = this.#held;
    if (held.len > 0) {
      held.push(c);
      const cand = held.view();
      if (startsWith(PREFIX, cand, cand.length)) {
        if (cand.length === PREFIX.length) this.#mode = MODE.osc;
        return;
      }
      if (this.da1 && this.#da1Step(cand, c)) return;
      held.len--; // c is looked at again below
      this.#pass.append(held.view());
      held.len = 0;
    }
    if (c === ESC) {
      held.push(c);
      return;
    }
    this.#pass.push(c);
  }

  // Whether cand, the held bytes and c, is still a DA1 answer, or is one.
  #da1Step(cand: Uint8Array, c: number): boolean {
    if (startsWith(DA1_PREFIX, cand, cand.length)) return true;
    if (cand.length > DA1_PREFIX.length && startsWith(DA1_PREFIX, cand, DA1_PREFIX.length)) {
      if (c === 0x63) {
        // 'c'
        this.#emit("da1", this.#held.take());
        return true;
      }
      if ((c >= 0x30 && c <= 0x39) || c === 0x3b) return true;
    }
    return false;
  }
}
