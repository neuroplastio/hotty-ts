// What a host or a relay reads of a program's 0.4 commands, which the SDK
// sections of the vectors do not cover: a delta's ops (SPEC §6.1) and a menu
// (SPEC §10.7), and the builders that make them.

import assert from "node:assert/strict";

import {
  after,
  append,
  attr,
  before,
  Decoder,
  delta,
  deltaOf,
  HottyError,
  inner,
  menu,
  menuFind,
  menuHide,
  menuLevelOf,
  menuOf,
  menuShow,
  menuShowOf,
  type Message,
  morph,
  MENU_DEPTH,
  prepend,
  remove,
  replace,
  revealOp,
  text,
  unattr,
  varOp,
  type MenuItem,
  type MenuTree,
  type Op,
} from "../src/index.ts";
import { pack } from "../src/msgpack.ts";
import { encode } from "../src/encode.ts";
import { describe, test } from "./harness.ts";

// A command as a host receives it.
function received(out: string): Message {
  const f = new Decoder().feed(out);
  assert.equal(f.result, "complete");
  return f.message!;
}

// A delta command whose body is whatever is given.
const withBody = (body: unknown, control: [string, string][] = [["a", "delta"], ["s", "x"]]) => received(encode(control, pack(body)));

// What deltaOf throws, as [code, detail, op].
function fault(m: Message): [string, string | undefined, number | undefined] {
  try {
    deltaOf(m);
  } catch (e) {
    assert.ok(e instanceof HottyError, String(e));
    return [e.code, e.detail, e.op];
  }
  return assert.fail("no error");
}

describe("op builders", () => {
  test("each makes an op, with a value where the op takes one", () => {
    assert.deepEqual(
      [morph("", "<p id=a></p>"), inner("l", "<li>"), replace("l", "<b>"), append("l", "<i>"), prepend("l", "<u>"), before("l", "<s>"), after("l", "<q>")],
      [
        { op: "morph", target: "", key: "", value: "<p id=a></p>" },
        { op: "inner", target: "l", key: "", value: "<li>" },
        { op: "replace", target: "l", key: "", value: "<b>" },
        { op: "append", target: "l", key: "", value: "<i>" },
        { op: "prepend", target: "l", key: "", value: "<u>" },
        { op: "before", target: "l", key: "", value: "<s>" },
        { op: "after", target: "l", key: "", value: "<q>" },
      ],
    );
    assert.deepEqual(remove("old"), { op: "remove", target: "old" });
    assert.deepEqual(unattr("a", "disabled"), { op: "unattr", target: "a", key: "disabled" });
    assert.deepEqual(attr("a", "title", 3), { op: "attr", target: "a", key: "title", value: "3" });
    assert.deepEqual(text("a", ""), { op: "text", target: "a", key: "", value: "" }, "an empty text is a value all the same");
    assert.deepEqual(varOp("bar", "w", "40%"), { op: "var", target: "bar", key: "w", value: "40%" });
    assert.deepEqual(revealOp("s"), { op: "reveal", target: "s" });
    assert.deepEqual(revealOp("s", "end"), { op: "reveal", target: "s", key: "", value: "end" });
  });

  test("a delta of them is one command, one body, and q=2 unless asked", () => {
    const m = received(delta("x", [text("a", "hi"), remove("b")]));
    assert.deepEqual(Object.fromEntries(m.control), { a: "delta", s: "x", q: "2" });
    assert.deepEqual(m.body(), { ops: [{ op: "text", t: "a", v: "hi" }, { op: "remove", t: "b" }] });
    assert.deepEqual(Object.fromEntries(received(delta("x", [remove("b")], { n: 4 })).control), { a: "delta", s: "x", n: "4" }, "n alone asks for the reply");
  });
});

describe("deltaOf", () => {
  test("reads the ops a delta carries, as the program built them", () => {
    const ops: Op[] = [morph("", "<p id=a>1</p>"), text("a", "hi"), varOp("bar", "w", "1"), unattr("a", "x"), revealOp("s"), revealOp("s", "start"), remove("r")];
    const got = deltaOf(received(delta("x", ops)));
    assert.deepEqual(
      got,
      [
        { op: "morph", value: "<p id=a>1</p>" },
        { op: "text", target: "a", value: "hi" },
        { op: "var", target: "bar", key: "w", value: "1" },
        { op: "unattr", target: "a", key: "x" },
        { op: "reveal", target: "s" },
        { op: "reveal", target: "s", value: "start" },
        { op: "remove", target: "r" },
      ],
    );
  });

  test("a body that is not a delta's is EINVAL, with the first op at fault when an op is", () => {
    assert.deepEqual(fault(received(encode([["a", "delta"], ["s", "x"]]))), ["EINVAL", "body does not decode", undefined], "no body");
    assert.deepEqual(fault(withBody({ ops: [] })), ["EINVAL", "no ops", undefined]);
    assert.deepEqual(fault(withBody({})), ["EINVAL", "no ops", undefined]);
    assert.deepEqual(fault(withBody({ ops: "x" })), ["EINVAL", "body does not decode", undefined]);
    assert.deepEqual(fault(withBody({ ops: [{ op: "text", t: "a", v: "ok" }, 5] })), ["EINVAL", "op is not a map of strs", 1]);
    assert.deepEqual(fault(withBody({ ops: [{ op: "text", t: "a", v: 7 }] })), ["EINVAL", "op is not a map of strs", 0], "a key of another type is the op at fault");
    assert.deepEqual(fault(withBody({ ops: [{ op: "text", t: "a", v: "x" }, { op: "frob", t: "a" }] })), ["EINVAL", "unknown op frob", 1]);
    assert.deepEqual(fault(withBody({ ops: [{ op: "text", v: "x" }] })), ["EINVAL", "missing t", 0]);
    assert.deepEqual(fault(withBody({ ops: [{ op: "text", t: "", v: "x" }] })), ["EINVAL", "missing t", 0], "an empty one is none");
    assert.deepEqual(fault(withBody({ ops: [{ op: "attr", t: "a", v: "x" }] })), ["EINVAL", "missing k", 0]);
    assert.deepEqual(fault(withBody({ ops: [{ op: "reveal", t: "a", v: "middle" }] })), ["EINVAL", "reveal middle", 0]);
    assert.deepEqual(fault(received(encode([["a", "frob"]], pack({ ops: [] })))), ["EINVAL", "not a delta command", undefined]);
  });

  test("what an op does not take, and a key this SDK does not know, are ignored", () => {
    assert.deepEqual(deltaOf(withBody({ ops: [{ op: "remove", t: "a", v: "ignored", later: [1, 2.5] }] })), [{ op: "remove", target: "a", value: "ignored" }]);
  });
});

const tree: MenuTree = {
  label: "Files",
  items: [
    {
      key: "space",
      label: "Leader",
      items: [
        { key: "f", label: "File", items: [{ key: "n", label: "New", name: "file-new" }, { key: "r", label: "Rename", name: "file-rename", enabled: false }] },
        { key: "q", label: "Quit", name: "quit" },
        { label: "Sort", name: "sort-name" },
      ],
    },
    { label: "Reload", name: "reload", items: [] },
  ],
};

describe("menu", () => {
  test("menuOf reads what menu sends, every field filled; no body leaves the program none", () => {
    const got = menuOf(received(menu(tree)))!;
    assert.equal(got.label, "Files");
    assert.deepEqual(got.items[0]!.items![0], {
      key: "f",
      label: "File",
      name: "",
      enabled: true,
      items: [
        { key: "n", label: "New", name: "file-new", enabled: true, items: [] },
        { key: "r", label: "Rename", name: "file-rename", enabled: false, items: [] },
      ],
    });
    assert.deepEqual(got.items[1], { key: "", label: "Reload", name: "reload", enabled: true, items: [] });
    assert.equal(menuOf(received(menu())), undefined);
  });

  test("menuOf refuses a body that is no menu, a field of another type, and items nested past eight levels (EINVAL)", () => {
    const bad = (body: unknown): string | undefined => {
      try {
        menuOf(received(encode([["a", "menu"]], pack(body))));
      } catch (e) {
        assert.ok(e instanceof HottyError);
        assert.equal(e.code, "EINVAL");
        return e.detail;
      }
      return undefined;
    };
    assert.equal(bad({ label: 5, items: [] }), "body does not decode");
    assert.equal(bad({ items: "x" }), "body does not decode");
    assert.equal(bad({ items: [{ key: 1 }] }), "body does not decode");
    assert.equal(bad({ items: [{ enabled: "yes" }] }), "body does not decode");
    const nest = (n: number): unknown[] => (n === 0 ? [] : [{ key: "a", enabled: true, items: nest(n - 1) }]);
    assert.equal(bad({ items: nest(MENU_DEPTH) }), undefined, "eight levels");
    assert.equal(bad({ items: nest(MENU_DEPTH + 1) }), "items nest deeper than eight");
  });

  test("menuShowOf reads the keys typed; no body, or none in it, is the top level", () => {
    assert.deepEqual(menuShowOf(received(menuShow(["space", "f"]))), ["space", "f"]);
    assert.deepEqual(menuShowOf(received(menuShow())), []);
    assert.deepEqual(menuShowOf(received(encode([["a", "menu"], ["show", "1"]], pack({})))), []);
    assert.throws(() => menuShowOf(received(encode([["a", "menu"], ["show", "1"]], pack({ seq: "x" })))), HottyError);
    assert.throws(() => menuShowOf(received(encode([["a", "menu"], ["show", "1"]], pack({ seq: [1] })))), HottyError);
    assert.equal(received(menuHide()).get("show"), "0");
  });

  test("menuLevelOf is the level the keys reach, compared as the platform reads them; keys that reach no group reach none", () => {
    const t = menuOf(received(menu(tree)))!;
    const keys = (items: readonly MenuItem[] | undefined) => items?.map((i) => i.key);
    assert.deepEqual(keys(menuLevelOf(t, {}, [])), ["space", ""]);
    assert.deepEqual(keys(menuLevelOf(t, {}, ["space"])), ["f", "q", ""]);
    assert.deepEqual(keys(menuLevelOf(t, {}, ["space", "f"])), ["n", "r"]);
    assert.equal(menuLevelOf(t, {}, ["space", "q"]), undefined, "q is an action, not a group");
    assert.equal(menuLevelOf(t, {}, ["z"]), undefined);
    assert.equal(menuLevelOf(t, {}, ["Hyper+x"]), undefined, "a key that does not parse");
    assert.equal(menuLevelOf(undefined, {}, []), undefined);
    const mod: MenuTree = { items: [{ key: "mod+k", items: [{ key: "a", name: "a" }] }] };
    assert.ok(menuLevelOf(mod, {}, ["ctrl+k"]), "mod is ctrl by default");
    assert.equal(menuLevelOf(mod, { mod: "super" }, ["ctrl+k"]), undefined, "and a super platform has mod as super");
    assert.ok(menuLevelOf(mod, { mod: "super" }, ["super+k"]));
  });

  test("menuFind is the first item of the name, depth first; an item with no name is never found", () => {
    const t = menuOf(received(menu(tree)))!;
    assert.equal(menuFind(t, "file-rename")?.label, "Rename");
    assert.equal(menuFind(t, "reload")?.label, "Reload");
    assert.equal(menuFind(t, "nope"), undefined);
    assert.equal(menuFind(t, ""), undefined);
    assert.equal(menuFind(undefined, "quit"), undefined);
    const dup: MenuTree = { items: [{ label: "A", items: [{ name: "x", label: "deep" }] }, { name: "x", label: "late" }] };
    assert.equal(menuFind(dup, "x")?.label, "deep");
  });
});
