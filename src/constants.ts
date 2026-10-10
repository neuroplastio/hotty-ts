// The protocol's numbers and named values (SDK.md §3.1).

/** HOTTY's OSC number: the ASCII codes of H and O. */
export const NUMBER = "7279";
/** The most base64 bytes one sequence carries (SPEC §3.4). */
export const CHUNK = 4096;
/** The most columns or rows a surface has (SPEC §5.2). */
export const MAX_SIZE = 1000;
/** The longest a surface name is (SPEC §3.5). */
export const MAX_NAME = 64;
/** The protocol version this SDK implements, as capabilities report it (SPEC §4). */
export const VERSION = "0.2";

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
 * came. In a host's capabilities, `drag` stands for the three drag kinds.
 */
export const EVENT_KINDS = [
  "click",
  "change",
  "input",
  "submit",
  "press",
  "focus",
  "blur",
  "resize",
  "fit",
  "hover",
  "dragstart",
  "drag",
  "dragend",
] as const;
/** One of {@link EVENT_KINDS}. */
export type EventKind = (typeof EVENT_KINDS)[number];

/** The error codes of an `a=err` reply (SPEC §3.6). */
export const ERROR_CODES = ["EINVAL", "ENOENT", "ENOTARGET", "EDETACHED", "EQUOTA", "EBUDGET"] as const;
/** One of {@link ERROR_CODES}. */
export type ErrorCode = (typeof ERROR_CODES)[number];

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
] as const;
/** One of {@link OPS}. */
export type Op = (typeof OPS)[number];
