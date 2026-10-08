// The package as a program gets it: dist, imported by the package's name
// and its subpaths, plain JavaScript. make package runs it on Node and on
// Bun.

import assert from "node:assert/strict";

import { Decoder, TERMINAL_KEYS, VERSION, decodeKeys, doc, resolve } from "@neuroplastio/hotty";
import { Field } from "@neuroplastio/hotty/field";
import { Link } from "@neuroplastio/hotty/link";
import { Session } from "@neuroplastio/hotty/session";
import { Terminal } from "@neuroplastio/hotty/terminal";
import { Host } from "@neuroplastio/hotty/test";

const f = new Decoder().feed(doc("card", "<p>hi</p>"));
assert.equal(f.result, "complete");
assert.equal(f.message.get("s"), "card");
assert.equal(f.message.text(), "<p>hi</p>");
assert.equal(VERSION, "0.1");

// A field in cells, edited with the keymap its surfaces get.
const keys = resolve(false, TERMINAL_KEYS);
const field = new Field({ value: "foo bar" });
assert.equal(field.do(keys.lookup(decodeKeys("\x17")[0])), true);
assert.equal(field.value, "foo ");

// A program's test: its Terminal on the test host.
const h = new Host();
const t = new Terminal({ input: h, output: h, name: "smoke" });
assert.ok(t instanceof Link);
assert.equal(await t.detect(), true);
const s = new Session({ link: t, onMessage: () => {} });
assert.equal(typeof s.flush(), "string");
t.print("card", "<p id=m>hi</p>", { cols: 10, rows: 1 });
assert.deepEqual(await t.fence(), []);
assert.equal(h.surface("smoke-card")?.textOf("m"), "hi");
t.close();

console.log(`package: ok (${typeof Bun === "undefined" ? "node" : "bun"})`);
