// The test host's morph (SPEC §6.2): what the host vectors cannot see,
// since they inspect a document's markup, is which elements stayed the
// same, and with them what the user did there.

import assert from "node:assert/strict";

import { doc, morphTo, placeAt } from "../src/index.ts";
import { Host } from "../src/test/index.ts";
import { describe, test } from "./harness.ts";

function surface(html: string) {
  const h = new Host();
  h.write(doc("s", html) + placeAt("s", 0, 0, { cols: 40, rows: 4 }));
  const s = h.surface("s")!;
  return { h, s };
}

describe("Host morph", () => {
  test("elements that stay keep their identity, the user's text and focus; moved, not made again", () => {
    const { h, s } = surface("<div id=box><input id=a><input id=b><details id=d><summary>s</summary>x</details></div>");
    h.fill("s", "a", "typed");
    h.fill("s", "b", "other");
    const a = s.byId("a");
    const b = s.byId("b");
    h.write(morphTo("s", "box", "<div id=box><input id=b class=x><input id=a></div>"));
    assert.equal(s.byId("a"), a);
    assert.equal(s.byId("b"), b);
    assert.deepEqual([s.value("a"), s.value("b")], ["typed", "other"]);
    assert.equal(s.focused(), "b");
    assert.equal(s.attr("b", "class"), "x");
    assert.equal(s.byId("d"), undefined, "an old child not taken is removed");
    assert.deepEqual(s.element("box")!.children.map((c) => c.id), ["b", "a"]);
  });

  test("a changed default sets the control's value, unless it is focused", () => {
    const { h, s } = surface("<div id=box><input id=a><input id=b></div>");
    h.fill("s", "a", "typed");
    h.fill("s", "b", "editing");
    h.write(morphTo("s", "box", "<div id=box><input id=a value=set><input id=b value=set></div>"));
    assert.deepEqual([s.value("a"), s.value("b")], ["set", "editing"]);
    // An attribute that is not the default leaves the value alone.
    h.write(morphTo("s", "box", "<div id=box><input id=a value=set title=t><input id=b value=set></div>"));
    assert.equal(s.value("a"), "set");
    h.fill("s", "a", "again");
    h.blur("s");
    h.write(morphTo("s", "box", "<div id=box><input id=a value=set title=u><input id=b value=set></div>"));
    assert.equal(s.value("a"), "again", "the default did not change");
  });

  test("an element that does not match is replaced, and what the user did there goes with it", () => {
    const { h, s } = surface("<div id=box><input id=a><p id=p>x</p></div>");
    h.fill("s", "a", "typed");
    h.blur("s");
    const p = s.byId("p");
    h.write(morphTo("s", "box", "<div id=box><textarea id=a></textarea><p id=p>x</p></div>"));
    assert.equal(s.byId("a")?.tagName, "textarea");
    assert.equal(s.value("a"), "");
    assert.equal(s.byId("p"), p);
    h.write(morphTo("s", "p", "<p id=q>y</p>"));
    assert.equal(s.byId("p"), undefined, "another id: replaced");
    assert.equal(s.textOf("q"), "y");
  });

  test("children without an id match by kind, in order; text changes in place", () => {
    const { h, s } = surface("<ul id=l><li>one</li><li>two</li></ul>");
    const before = s.byId("l")!.childNodes.slice();
    h.write(morphTo("s", "l", "<ul id=l><li>uno</li><li>two</li><li>three</li></ul>"));
    const after = s.byId("l")!.childNodes;
    assert.equal(after.length, 3);
    assert.equal(after[0], before[0]);
    assert.equal(after[1], before[1]);
    assert.equal(s.textOf("l"), "unotwothree");
  });

  test("morph without a target matches top-level elements by id; the unknown ones are one ENOTARGET", () => {
    const { h, s } = surface("<p id=x>1</p><p id=y>2</p>");
    const y = s.byId("y");
    h.write(morphTo("s", "", "<p id=x>10</p><p id=z>3</p><p id=w>4</p><p id=y>20</p>", { q: 1 }));
    assert.deepEqual([s.textOf("x"), s.textOf("y")], ["10", "20"]);
    assert.equal(s.byId("y"), y);
    const r = h.replies().at(-1)!.reply()!;
    assert.deepEqual([r.ok, r.code, r.detail], [false, "ENOTARGET", "z,w"]);
  });
});
