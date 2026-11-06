// The protocol's numbers and named values (SDK.md §3.1).

/** hotty's OSC number: the ASCII codes of H and O. */
export const NUMBER = "7279";
/** The most base64 bytes one sequence carries (SPEC §3.4). */
export const CHUNK = 4096;
/** The most columns or rows a surface has (SPEC §5.2). */
export const MAX_SIZE = 1000;
/** The longest a surface name is (SPEC §3.5). */
export const MAX_NAME = 64;
/**
 * The newest protocol version this SDK speaks (SPEC §4): hotty 0.7. It speaks
 * 0.6 too ({@link VERSIONS}).
 */
export const VERSION = "0.7";
/**
 * Every protocol version this SDK speaks, highest first (SPEC §4, §15). Its
 * query lists them lowest first (`v=0.6,0.7`), and a host's capabilities must
 * name one of them for the SDK to use the host: `caps.v` is the version the
 * session is in. A 0.6 host sends no secondary press (SDK.md §4.7).
 */
export const VERSIONS: readonly string[] = ["0.7", "0.6"];

/**
 * The version a host that speaks `spoken` (highest first, as {@link VERSIONS}
 * is) answers a query listing `listed` in (SPEC §4): the highest one both
 * have, or undefined when they share none, which is EVERSION, its detail
 * `spoken` lowest first.
 */
export function answerVersion(listed: string | undefined, spoken: readonly string[] = VERSIONS): string | undefined {
  const l = (listed ?? "").split(",");
  return spoken.find((v) => l.includes(v));
}

/** Which replies the host sends for a command (SPEC §3.5). */
export type Quiet = 0 | 1 | 2;
/** Reply whatever the outcome. */
export const REPLY_ALWAYS = 0;
/** Reply only on error. */
export const REPLY_ON_ERROR = 1;
/** Never reply. */
export const NO_REPLY = 2;

/** A document that scrolls vertically: {@link DocOptions.scroll}'s bit (SPEC §5.1). */
export const SCROLL_VERTICAL = 1;
/** A document that scrolls horizontally: {@link DocOptions.scroll}'s bit (SPEC §5.1). */
export const SCROLL_HORIZONTAL = 2;

/**
 * The event kinds a host sends (SPEC §9). A program ignores kinds it does
 * not know: later versions add some, and an Event reports its kind as it
 * came.
 */
export const EVENT_KINDS = [
  "click",
  "change",
  "input",
  "caret",
  "submit",
  "press",
  "focus",
  "blur",
  "fit",
  "hover",
  "view",
  "dragstart",
  "drag",
  "dragend",
  "command",
  "caps",
] as const;
/** One of {@link EVENT_KINDS}. */
export type EventKind = (typeof EVENT_KINDS)[number];

/** The error codes of an `a=err` reply (SPEC §3.6). */
export const ERROR_CODES = ["EINVAL", "ENOENT", "ENOTARGET", "EDETACHED", "EQUOTA", "EBUDGET", "ENOTERM", "ESTALE", "EVERSION"] as const;
/** One of {@link ERROR_CODES}. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The optional features a host may have (SPEC §4), as its capabilities list
 * them ({@link Caps.has}). Everything else a 0.6 host does.
 */
export const FEATURES = ["passthrough", "hover", "count", "menu", "backdrop"] as const;
/** One of {@link FEATURES}. */
export type Feature = (typeof FEATURES)[number];

/** Shift held, in an event's `mods` (SPEC §9). */
export const MOD_SHIFT = 1;
/** Alt held, in an event's `mods` (SPEC §9). */
export const MOD_ALT = 2;
/** Ctrl held, in an event's `mods` (SPEC §9). */
export const MOD_CTRL = 4;
/** Super held, in an event's `mods` (SPEC §9). */
export const MOD_SUPER = 8;

/** The delta operations (SPEC §6.1). */
export const OPS = [
  "morph",
  "inner",
  "replace",
  "append",
  "prepend",
  "before",
  "after",
  "remove",
  "attr",
  "unattr",
  "text",
  "var",
  "reveal",
] as const;
/** One of {@link OPS}: what an {@link Op} does. */
export type OpName = (typeof OPS)[number];
