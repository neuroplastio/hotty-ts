/**
 * HOTTY, HTML Over The TTY (https://github.com/neuroplastio/hotty), from a
 * TypeScript program: the wire layer (SDK.md §3).
 *
 * A HOTTY host is a terminal that shows surfaces: small HTML documents
 * placed on rectangles of cells. A program sends documents, placements and
 * deltas as escape sequences in its ordinary output, and hears replies and
 * the user's events on its input.
 *
 * This module does no I/O, starts no timers, and reads no clock:
 *
 * - The builders ({@link doc}, {@link place}, {@link setText}, …) return
 *   escape sequences as strings, to write like any other output.
 * - A {@link Scanner} cuts HOTTY sequences out of the bytes a program reads,
 *   a {@link Decoder} turns them into messages, and {@link Reply},
 *   {@link Event} and {@link Caps} read them.
 * - A {@link Detector} decides whether the terminal is a host, with the time
 *   passed in.
 * - {@link parseKey}, {@link decodeKeys} and {@link Keymap} say what a text
 *   field does with a key (SPEC §10.2, §10.4), and {@link TERMINAL_KEYS} is
 *   the SDK's keymap.
 *
 * The SDK layer is beside it, in the package's subpaths:
 * - `@neuroplastio/hotty/terminal` for a program with a terminal;
 * - `@neuroplastio/hotty/session` for a framework's adapter;
 * - `@neuroplastio/hotty/link` for an environment that hands over what it
 *   reads;
 * - `@neuroplastio/hotty/field` for a text field drawn in cells;
 * - `@neuroplastio/hotty/test` for a host that runs inside a test.
 *
 * @module
 */

export * from "./constants.ts";
export { Control, type ControlLike, type Pair } from "./control.ts";
export { encode, cleanValue, type EncodeOptions } from "./encode.ts";
export * from "./commands.ts";
export { validName, surfaceName } from "./names.ts";
export { Decoder, type Fed, type Result } from "./decoder.ts";
export { Scanner, SCAN_MAX, type Segment, type ScannerOptions } from "./scanner.ts";
export * from "./detector.ts";
export * from "./messages.ts";
export { getZlib, setZlib, type Zlib } from "./zlib.ts";
export {
  ACTIONS,
  INSERT,
  Keymap,
  MODIFIERS,
  MULTILINE_ACTIONS,
  TERMINAL_KEYS,
  chars,
  decodeKeys,
  parseKey,
  parseKeymap,
  resolve,
  type Action,
  type Modifier,
} from "./keys.ts";
