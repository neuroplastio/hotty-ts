// Surface names (SDK.md §3.5).

import { MAX_NAME } from "./constants.ts";

const nameChar = (c: number) =>
  (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d;

/** Whether s is a surface name: 1 to 64 of `A`–`Z`, `a`–`z`, `0`–`9`, `_` and `-`. */
export function validName(s: string): boolean {
  if (s.length === 0 || s.length > MAX_NAME) return false;
  for (let i = 0; i < s.length; i++) if (!nameChar(s.charCodeAt(i))) return false;
  return true;
}

/**
 * s made a surface name: each character a name may not hold becomes `_`,
 * one for each code point, it is cut to 64, and an empty name becomes `_`.
 */
export function surfaceName(s: string): string {
  if (validName(s)) return s;
  let out = "";
  for (const ch of s) {
    if (out.length === MAX_NAME) break;
    out += ch.length === 1 && nameChar(ch.charCodeAt(0)) ? ch : "_";
  }
  return out || "_";
}
