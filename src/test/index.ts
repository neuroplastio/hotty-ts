/**
 * A hotty host that runs inside a test (SDK.md §4.4), so that a program's
 * tests need no terminal. The program writes to it and reads from it as it
 * would a terminal; the test then looks at what the program showed, and
 * plays the user:
 *
 * ```ts
 * const h = new Host();
 * await run(new Terminal({ input: h, output: h, name: "tool", size: () => h })); // the program under test
 * h.surface("tool-card")?.textOf("status"); // what it shows
 * h.click("tool-card", "retry");             // what the user does
 * ```
 *
 * It needs parse5, the HTML parser, which the package lists as an optional
 * peer dependency: install it beside @neuroplastio/hotty to use this module.
 *
 * @module
 */

export { Host, HostError, defaultCaps, type HostErrorCode, type HostOptions } from "./host.ts";
export { Surface, type Child, type Inspected } from "./dom.ts";
