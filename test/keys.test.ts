// Keymap.program, which the keymap vectors do not cover: a key any focused
// element's keymap gives the program (SPEC §10.2, keys for the program).

import assert from "node:assert/strict";

import { Caps, parseKeymap, resolve } from "../src/index.ts";
import { describe, test } from "./harness.ts";

describe("Keymap.program", () => {
  test("a key bound to program, Shift with it, read from data-keys with no default keymap", () => {
    // The root gives the arrows and End to the program; the element takes
    // End back with an action, which counts for nothing outside a field.
    const m = parseKeymap({}, ["ArrowDown=program ArrowUp=program End=program j=program", "End=line-end"].join(" "));
    const want: Record<string, boolean> = {
      ArrowDown: true,
      "Shift+ArrowDown": true,
      ArrowUp: true,
      j: true,
      End: false,
      Home: false,
      Enter: false,
      J: false,
      "Control+ArrowDown": false,
      Tab: false,
      Escape: false,
      "": false,
      "Hyper+a": false,
    };
    for (const [k, w] of Object.entries(want)) assert.equal(m.program(k), w, k);
  });

  test("a key with Shift bound to an action of its own is not looked up without Shift", () => {
    assert.equal(parseKeymap({}, "ArrowDown=program Shift+ArrowDown=line-next").program("Shift+ArrowDown"), false);
  });

  test("in a field's keymap, lookup says as much", () => {
    const f = resolve({}, false, "ArrowLeft=program");
    assert.equal(f.program("ArrowLeft"), true);
    assert.equal(f.lookup("ArrowLeft"), undefined);
    assert.equal(f.program("ArrowRight"), false);
  });
});

describe("Caps.merge", () => {
  test("a field a caps event empties became absent, and merge drops it (SPEC §9)", () => {
    const c = new Caps({ mod: "Control", edit: { copy: ["Control+c"] }, keys: { leader: "Space", timeout: 2000 } });
    const m = c.merge(new Caps({ edit: {}, keys: {} }));
    assert.deepEqual(Object.keys(m.raw), ["mod"]);
    assert.equal(m.mod, "Control");
    assert.equal(m.keys, undefined);
    assert.equal(c.merge(new Caps({ mod: "Meta" })).raw.edit !== undefined, true);
  });
});
