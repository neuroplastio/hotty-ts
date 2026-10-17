// Keymap.program, which the keymap vectors do not cover: a key any focused
// element's keymap gives the program (SPEC §10.2, keys for the program).

import assert from "node:assert/strict";

import { Caps, parseKeymap, resolve } from "../src/index.ts";
import { describe, test } from "./harness.ts";

describe("Keymap.program", () => {
  test("a key bound to program, Shift with it, read from data-keys with no default keymap", () => {
    // The root gives the arrows and End to the program; the element takes
    // End back with an action, which counts for nothing outside a field.
    const m = parseKeymap({}, ["arrow_down=program arrow_up=program end=program j=program", "end=line-end"].join(" "));
    const want: Record<string, boolean> = {
      arrow_down: true,
      "shift+arrow_down": true,
      arrow_up: true,
      j: true,
      end: false,
      home: false,
      enter: false,
      "shift+j": false,
      "ctrl+arrow_down": false,
      tab: false,
      escape: false,
      "": false,
      "hyper+a": false,
    };
    for (const [k, w] of Object.entries(want)) assert.equal(m.program(k), w, k);
  });

  test("a key with Shift bound to an action of its own is not looked up without Shift", () => {
    assert.equal(parseKeymap({}, "arrow_down=program shift+arrow_down=line-next").program("shift+arrow_down"), false);
  });

  test("in a field's keymap, lookup says as much", () => {
    const f = resolve({}, false, "arrow_left=program");
    assert.equal(f.program("arrow_left"), true);
    assert.equal(f.lookup("arrow_left"), undefined);
    assert.equal(f.program("arrow_right"), false);
  });
});

describe("Keymap.prefix", () => {
  test("a key bound to prefix is the program's, and prefix asks which (SPEC §10.5)", () => {
    const m = parseKeymap({}, "ctrl+b=prefix arrow_down=program ctrl+x=line-end");
    assert.deepEqual([m.program("ctrl+b"), m.prefix("ctrl+b")], [true, true]);
    assert.deepEqual([m.program("arrow_down"), m.prefix("arrow_down")], [true, false]);
    assert.deepEqual([m.program("ctrl+x"), m.prefix("ctrl+x")], [false, false]);
    // A key with Shift that no binding names is looked up without it.
    assert.equal(parseKeymap({}, "arrow_down=prefix").prefix("shift+arrow_down"), true);
    assert.equal(parseKeymap({}, "arrow_down=prefix shift+arrow_down=line-next").prefix("shift+arrow_down"), false);
  });

  test("a field's keymap leaves the key to the program", () => {
    const f = resolve({}, false, "ctrl+b=prefix");
    assert.equal(f.lookup("ctrl+b"), undefined);
    assert.equal(f.prefix("ctrl+b"), true);
    assert.equal(f.lookup("a"), "insert");
  });
});

describe("Caps.merge", () => {
  test("a field a caps event empties became absent, and merge drops it (SPEC §9)", () => {
    const c = new Caps({ mod: "ctrl", edit: { copy: ["ctrl+c"] }, features: ["hover"], scheme: "dark", host: "x" });
    const m = c.merge(new Caps({ edit: {}, features: [], scheme: "" }));
    assert.deepEqual(Object.keys(m.raw), ["mod", "host"]);
    assert.equal(m.mod, "ctrl");
    assert.deepEqual([m.edit, m.features, m.scheme], [undefined, [], undefined]);
    assert.equal(c.merge(new Caps({ mod: "super" })).raw.edit !== undefined, true);
  });

  test("any changed field folds in, the cell among them", () => {
    const c = new Caps({ v: "0.4", cellcss: { w: 9, h: 18 }, features: ["hover"], scale: 1 });
    const m = c.merge(new Caps({ cellcss: { w: 10, h: 20 }, features: ["hover", "menu"], limits: { surfaces: 8 } }));
    assert.deepEqual([m.cellCss, m.features, m.limits, m.scale, m.v], [{ w: 10, h: 20 }, ["hover", "menu"], { surfaces: 8 }, 1, "0.4"]);
    assert.deepEqual([m.has("menu"), c.has("menu")], [true, false]);
  });
});
