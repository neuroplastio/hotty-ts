// OSC sequences into messages, one at a time, joining chunked ones
// (SDK.md §3.6).

import { fromBase64 } from "./base64.ts";
import { NUMBER } from "./constants.ts";
import { Message } from "./messages.ts";
import { getZlib } from "./zlib.ts";

/** What a Decoder made of one sequence. */
export type Result = "not_hotty" | "partial" | "complete" | "invalid";

/** Decoder.feed's answer: the result, and with `complete`, the message. */
export type Fed = { result: "complete"; message: Message } | { result: "not_hotty" | "partial" | "invalid"; message?: undefined };

const HEAD = "\x1b]" + NUMBER;
const KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
const VALUE = /^[\x20-\x39\x3c\x3e-\x7e]*$/;

/** A sequence as a string of its bytes' codes: bytes are taken one for one. */
function binary(seq: string | Uint8Array): string {
  if (typeof seq === "string") return seq;
  let s = "";
  for (let i = 0; i < seq.length; i += 8192) s += String.fromCharCode(...seq.subarray(i, i + 8192));
  return s;
}

/**
 * The control's pairs, strictly as SPEC §3.2 has them: a key that does not
 * parse, a value outside printable ASCII, a key given twice, or an empty
 * control, and it is undefined.
 */
function parseControl(s: string): Map<string, string> | undefined {
  if (s === "") return undefined;
  const out = new Map<string, string>();
  for (const part of s.split(":")) {
    const eq = part.indexOf("=");
    if (eq < 0) return undefined;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (!KEY.test(k) || !VALUE.test(v) || out.has(k)) return undefined;
    out.set(k, v);
  }
  return out;
}

/** A further chunk's control: `m`, and `q` at most (SPEC §3.4). */
function continuation(ctl: Map<string, string>): boolean {
  if (!ctl.has("m")) return false;
  for (const k of ctl.keys()) if (k !== "m" && k !== "q") return false;
  return true;
}

const fed = (result: "not_hotty" | "partial" | "invalid"): Fed => ({ result });

/**
 * A Decoder's max when it sets none: 16 MiB, enough for a document with its
 * images inline, and a bound on what a peer can make a Decoder hold.
 */
export const DEFAULT_MAX = 16 << 20;

// The most base64 a payload of max bytes is sent as: zlib may make it a
// little longer than it decodes to.
const encodedMax = (max: number) => Math.ceil((max + Math.floor(max / 256) + 64) / 3) * 4;

/**
 * Turns OSC sequences into messages, joining chunked ones (SPEC §3.4). A
 * new Decoder is ready to use.
 */
export class Decoder {
  /** The malformed messages dropped so far, aborted chunked ones included (SPEC §3.7). */
  invalid = 0;
  /**
   * The most bytes a message's payload may decode to, after base64 and
   * zlib; one that would decode to more is invalid, and its chunks are not
   * kept (SPEC §3.4 lets a host limit a message). Zero is
   * {@link DEFAULT_MAX}. A host sets it to what it accepts from a program,
   * at least 1 MiB, and reports it as `limits.message` (SPEC §13).
   */
  max = 0;
  // A chunked message's control and base64 so far; over when it passed
  // max, and its chunks are dropped as they come.
  #pending: { ctl: Map<string, string>; pieces: string[]; size: number; over: boolean } | undefined;

  #max(): number {
    return this.max > 0 ? this.max : DEFAULT_MAX;
  }

  /**
   * Takes one OSC sequence, `ESC ] …`, with or without its terminator (ST
   * or BEL). A string is taken one character a byte: what a parser that
   * hands over sequences as text gives.
   */
  feed(seq: string | Uint8Array): Fed {
    const s = binary(seq);
    if (!s.startsWith(HEAD)) return fed("not_hotty");
    const next = s.charCodeAt(HEAD.length);
    if (next >= 0x30 && next <= 0x39) return fed("not_hotty"); // another number: ESC ] 72790
    let body = s.slice(HEAD.length);
    if (body.endsWith("\x1b\\")) body = body.slice(0, -2);
    else if (body.endsWith("\x07")) body = body.slice(0, -1);
    if (!body.startsWith(";")) return this.#bad();
    const text = body.slice(1);
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return this.#bad();
    const semi = text.indexOf(";");
    const ctlPart = semi < 0 ? text : text.slice(0, semi);
    const b64 = semi < 0 ? "" : text.slice(semi + 1);
    const ctl = parseControl(ctlPart);
    if (!ctl) return this.#bad();

    if (continuation(ctl)) {
      const m = ctl.get("m");
      const pending = this.#pending;
      if (!pending || (m !== "0" && m !== "1")) return this.#bad();
      if (!pending.over && pending.size + b64.length > encodedMax(this.#max())) {
        // Too long: counted once, and its chunks dropped as they come.
        pending.pieces = [];
        pending.over = true;
        this.invalid++;
      }
      if (!pending.over) {
        pending.pieces.push(b64);
        pending.size += b64.length;
      }
      if (m === "1") return fed("partial");
      this.#pending = undefined;
      if (pending.over) return fed("invalid");
      return this.#finish(pending.ctl, pending.pieces.join(""));
    }
    if (this.#pending) {
      // Another message before the last chunk aborts the one in progress.
      if (!this.#pending.over) this.invalid++;
      this.#pending = undefined;
    }
    const m = ctl.get("m");
    if (m === "1") {
      const over = b64.length > encodedMax(this.#max());
      if (over) this.invalid++;
      this.#pending = { ctl, pieces: over ? [] : [b64], size: over ? 0 : b64.length, over };
      return fed("partial");
    }
    if (m !== undefined && m !== "0") return this.#bad();
    return this.#finish(ctl, b64);
  }

  // A malformed message: it aborts a chunked one in progress, which makes
  // two (SPEC §3.7).
  #bad(): Fed {
    if (this.#pending) {
      if (!this.#pending.over) this.invalid++;
      this.#pending = undefined;
    }
    this.invalid++;
    return fed("invalid");
  }

  // A payload that decodes to more than max bytes is refused, and
  // inflating stops past it.
  #finish(ctl: Map<string, string>, b64: string): Fed {
    const max = this.#max();
    let payload = b64.length > encodedMax(max) ? undefined : fromBase64(b64);
    if (payload && ctl.get("o") === "z") {
      const z = getZlib();
      try {
        if (!z) throw new Error("no zlib");
        payload = z.inflate(payload, max);
      } catch {
        payload = undefined;
      }
    }
    if (!payload || payload.length > max) {
      this.invalid++;
      return fed("invalid");
    }
    ctl.delete("m");
    ctl.delete("o");
    return { result: "complete", message: new Message(ctl, payload) };
  }
}
