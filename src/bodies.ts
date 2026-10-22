// The types of a host's bodies (SPEC §3.3): an error's (§3.6), the
// capabilities (§4), and each event kind's detail (§9). Reply, Event and
// Caps read a body as its type (SDK.md §3.9), and the test host writes it
// by its type, so that a float goes out as one even when it is whole.

import type { Type } from "./msgpack.ts";

export const ERROR: Type = { code: "str", detail: "str" };

export const CAPS: Type = {
  v: "str",
  cellcss: { w: "float", h: "float" },
  scale: "float",
  scheme: "str",
  mod: "str",
  features: ["str"],
  limits: { "*": "int" },
  net: { "*": ["str"] },
  edit: { "*": ["str"] },
  host: "str",
  version: "str",
};

const AREA: Type = { c: "int", r: "int", w: "int", h: "int" };
const DRAG: Type = { c: "int", r: "int", mods: "int", x: "int", y: "int", tx: "int", ty: "int" };

/** Each kind's detail; a kind not here carries none a program reads. */
export const DETAIL: ReadonlyMap<string, Type> = new Map([
  ["click", { value: "str", href: "str", url: "str", area: AREA, mods: "int", count: "int" }],
  ["press", { area: AREA, mods: "int" }],
  ["change", { checked: "bool", value: "str", rev: "int" }],
  ["input", { value: "str", rev: "int", sel: ["int"] }],
  ["caret", { sel: ["int"], rev: "int" }],
  ["submit", { fields: [["str"]] }],
  ["fit", { r: "int" }],
  ["dragstart", DRAG],
  ["drag", DRAG],
  ["dragend", DRAG],
  ["hover", { c: "int", r: "int", out: "bool" }],
  ["view", { in: { "*": AREA }, end: "bool" }],
  ["command", { name: "str", key: "str", text: "str" }],
  ["caps", CAPS],
]);
