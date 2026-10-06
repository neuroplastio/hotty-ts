// Base64 (RFC 4648, the standard alphabet), here rather than from the
// runtime so that the wire layer reads the same everywhere: a payload is
// base64 with or without padding, whitespace ignored, and any other byte
// makes it malformed (SPEC §3.3).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

/** The bytes as base64, padded. */
export function toBase64(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  if (i + 1 === b.length) {
    const n = b[i]! << 16;
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + "==";
  } else if (i + 2 === b.length) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + "=";
  }
  return out;
}

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * The bytes base64 encodes, with or without padding, whitespace ignored;
 * undefined when it is not base64.
 */
export function fromBase64(s: string): Uint8Array | undefined {
  const digits: number[] = [];
  let pad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isSpace(c)) continue;
    if (c === 0x3d) {
      // '=': padding, only at the end, at most two.
      if (++pad > 2) return undefined;
      continue;
    }
    const v = c < 128 ? VALUES[c]! : -1;
    if (v < 0 || pad > 0) return undefined;
    digits.push(v);
  }
  if (digits.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((digits.length * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < digits.length; i += 4) {
    const n = (digits[i]! << 18) | (digits[i + 1]! << 12) | (digits[i + 2]! << 6) | digits[i + 3]!;
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rest = digits.length - i;
  if (rest === 2) {
    out[o++] = ((digits[i]! << 2) | (digits[i + 1]! >> 4)) & 255;
  } else if (rest === 3) {
    const n = (digits[i]! << 12) | (digits[i + 1]! << 6) | digits[i + 2]!;
    out[o++] = (n >> 10) & 255;
    out[o++] = (n >> 2) & 255;
  }
  return out;
}
