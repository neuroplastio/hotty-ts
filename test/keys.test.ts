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

describe("Keymap.prefix", () => {
  test("a key bound to prefix is the program's, and prefix asks which (SPEC §10.5)", () => {
    const m = parseKeymap({}, "Control+b=prefix ArrowDown=program Control+x=line-end");
    assert.deepEqual([m.program("Control+b"), m.prefix("Control+b")], [true, true]);
    assert.deepEqual([m.program("ArrowDown"), m.prefix("ArrowDown")], [true, false]);
    assert.deepEqual([m.program("Control+x"), m.prefix("Control+x")], [false, false]);
    // A key with Shift that no binding names is looked up without it.
    assert.equal(parseKeymap({}, "ArrowDown=prefix").prefix("Shift+ArrowDown"), true);
    assert.equal(parseKeymap({}, "ArrowDown=prefix Shift+ArrowDown=line-next").prefix("Shift+ArrowDown"), false);
  });

  test("a field's keymap leaves the key to the program", () => {
    const f = resolve({}, false, "Control+b=prefix");
    assert.equal(f.lookup("Control+b"), undefined);
    assert.equal(f.prefix("Control+b"), true);
    assert.equal(f.lookup("a"), "insert");
  });
});

describe("Caps.merge", () => {
  test("a field a caps event empties became absent, and merge drops it (SPEC §9)", () => {
    const c = new Caps({ mod: "Control", edit: { copy: ["Control+c"] }, features: ["hover"], scheme: "dark", host: "x" });
    const m = c.merge(new Caps({ edit: {}, features: [], scheme: "" }));
    assert.deepEqual(Object.keys(m.raw), ["mod", "host"]);
    assert.equal(m.mod, "Control");
    assert.deepEqual([m.edit, m.features, m.scheme], [undefined, [], undefined]);
    assert.equal(c.merge(new Caps({ mod: "Meta" })).raw.edit !== undefined, true);
  });

  test("any changed field folds in, the cell among them", () => {
    const c = new Caps({ v: "0.3", cellcss: { w: 9, h: 18 }, features: ["hover"], scale: 1 });
    const m = c.merge(new Caps({ cellcss: { w: 10, h: 20 }, features: ["hover", "menu"], limits: { surfaces: 8 } }));
    assert.deepEqual([m.cellCss, m.features, m.limits, m.scale, m.v], [{ w: 10, h: 20 }, ["hover", "menu"], { surfaces: 8 }, 1, "0.3"]);
    assert.deepEqual([m.has("menu"), c.has("menu")], [true, false]);
  });
});
