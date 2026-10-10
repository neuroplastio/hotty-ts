// The types of a host's bodies (SPEC §3.3): an error's (§3.6), the
// capabilities (§4), and each event kind's detail (§9). Reply, Event and
// Caps read a body as its type (SDK.md §3.9), and the test host writes it
// by its type, so that a float goes out as one even when it is whole.

import type { Type } from "./msgpack.ts";

export const ERROR: Type = { code: "str", detail: "str" };

export const CAPS: Type = {
  v: "str",
  ops: ["str"],
  events: ["str"],
  cell: { w: "int", h: "int" },
  scale: "float",
  scheme: "str",
  limits: { "*": "int" },
  net: { "*": ["str"] },
  passthrough: "bool",
  scroll: "bool",
  steps: "bool",
  host: "str",
  version: "str",
};

const AREA: Type = { c: "int", r: "int", w: "int", h: "int" };
const DRAG: Type = { c: "int", r: "int", keys: ["str"], x: "int", y: "int" };

/** Each kind's detail; a kind not here carries none a program reads. */
export const DETAIL: ReadonlyMap<string, Type> = new Map([
  ["click", { value: "str", href: "str", url: "str", area: AREA }],
  ["press", { area: AREA }],
  ["change", { checked: "bool", value: "str" }],
  ["input", { value: "str" }],
  ["submit", { "*": "str" }],
  ["resize", { w: "float", h: "float" }],
  ["fit", { r: "int" }],
  ["dragstart", DRAG],
  ["drag", DRAG],
  ["dragend", DRAG],
  ["hover", { c: "int", r: "int", out: "bool" }],
]);
