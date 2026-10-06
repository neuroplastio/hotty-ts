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
 * Turns OSC sequences into messages, joining chunked ones (SPEC §3.4). A
 * new Decoder is ready to use.
 */
export class Decoder {
  /** The malformed messages dropped so far, aborted chunked ones included (SPEC §3.7). */
  invalid = 0;
  #pending: { ctl: Map<string, string>; pieces: string[] } | undefined;

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
      pending.pieces.push(b64);
      if (m === "1") return fed("partial");
      this.#pending = undefined;
      return this.#finish(pending.ctl, pending.pieces.join(""));
    }
    if (this.#pending) {
      // Another message before the last chunk aborts the one in progress.
      this.#pending = undefined;
      this.invalid++;
    }
    const m = ctl.get("m");
    if (m === "1") {
      this.#pending = { ctl, pieces: [b64] };
      return fed("partial");
    }
    if (m !== undefined && m !== "0") return this.#bad();
    return this.#finish(ctl, b64);
  }

  // A malformed message: it aborts a chunked one in progress, which makes
  // two (SPEC §3.7).
  #bad(): Fed {
    if (this.#pending) {
      this.#pending = undefined;
      this.invalid++;
    }
    this.invalid++;
    return fed("invalid");
  }

  #finish(ctl: Map<string, string>, b64: string): Fed {
    let payload = fromBase64(b64);
    if (!payload) {
      this.invalid++;
      return fed("invalid");
    }
    if (ctl.get("o") === "z") {
      const z = getZlib();
      try {
        if (!z) throw new Error("no zlib");
        payload = z.inflate(payload);
      } catch {
        this.invalid++;
        return fed("invalid");
      }
    }
    ctl.delete("m");
    ctl.delete("o");
    return { result: "complete", message: new Message(ctl, payload) };
  }
}
