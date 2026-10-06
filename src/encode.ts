// One command as OSC sequences (SDK.md §3.3).

import { toBase64 } from "./base64.ts";
import { CHUNK, NUMBER } from "./constants.ts";
import { Control, type ControlLike } from "./control.ts";
import { getZlib } from "./zlib.ts";

/** ESC ] 7279 ; */
export const PREFIX = "\x1b]" + NUMBER + ";";
/** String Terminator: ESC \ */
export const ST = "\x1b\\";
// Payloads shorter than this are not worth compressing.
const COMPRESS_FROM = 256;

const encoder = new TextEncoder();

/** A payload as bytes: a string is UTF-8. */
export function bytesOf(payload: Uint8Array | string | undefined): Uint8Array {
  if (payload === undefined) return new Uint8Array(0);
  return typeof payload === "string" ? encoder.encode(payload) : payload;
}

/** Whether a control value may hold the character: printable ASCII but `:`, `;` and `=`. */
const valueChar = (c: number) => c >= 0x20 && c <= 0x7e && c !== 0x3a && c !== 0x3b && c !== 0x3d;

/**
 * A control value as it may be sent: each character it may not hold
 * becomes one `_`, one for each code point (SPEC §3.2). A lone surrogate
 * counts as one.
 */
export function cleanValue(v: string): string {
  let clean = true;
  for (let i = 0; i < v.length; i++) {
    if (!valueChar(v.charCodeAt(i))) {
      clean = false;
      break;
    }
  }
  if (clean) return v;
  let out = "";
  for (const ch of v) out += ch.length === 1 && valueChar(ch.charCodeAt(0)) ? ch : "_";
  return out;
}

/** Options of {@link encode}. */
export interface EncodeOptions {
  /**
   * Compress a payload of 256 bytes or more with zlib, when that makes it
   * smaller, and mark it `o=z` (SPEC §3.3). Default: true, where the
   * runtime has zlib.
   */
  compress?: boolean;
}

/**
 * One command: the control and the payload, base64-encoded and split into
 * chunks of at most 4096 bytes (SPEC §3.3, §3.4). Keys go out in order, as
 * they are, but a given `o` or `m`, which are Encode's own (SDK.md §3.3);
 * each character a value may not hold becomes `_`. A string payload is
 * UTF-8.
 */
export function encode(control: ControlLike, payload?: Uint8Array | string, options: EncodeOptions = {}): string {
  const data = bytesOf(payload);
  let body = data;
  let zipped = false;
  if (options.compress !== false && data.length >= COMPRESS_FROM) {
    const z = getZlib();
    if (z) {
      const packed = z.deflate(data);
      if (packed.length < data.length) {
        body = packed;
        zipped = true;
      }
    }
  }
  const b64 = toBase64(body);

  const parts: string[] = [];
  let quiet: string | undefined;
  for (const [k, v] of Control.from(control)) {
    // o and m are Encode's: it marks compression and chunks itself.
    if (k === "o" || k === "m") continue;
    const value = cleanValue(v);
    parts.push(k + "=" + value);
    if (k === "q") quiet = value;
  }
  if (zipped) parts.push("o=z");
  const ctl = parts.join(":");

  if (b64.length <= CHUNK) return PREFIX + ctl + (b64 ? ";" + b64 : "") + ST;
  let out = "";
  for (let i = 0; i < b64.length; i += CHUNK) {
    const piece = b64.slice(i, i + CHUNK);
    if (i === 0) {
      out += PREFIX + ctl + ":m=1;" + piece + ST;
      continue;
    }
    const more = i + CHUNK >= b64.length ? "0" : "1";
    out += PREFIX + "m=" + more + (quiet !== undefined ? ":q=" + quiet : "") + ";" + piece + ST;
  }
  return out;
}
