// The package as a program gets it: dist, imported by the package's name
// and its subpaths, plain JavaScript. make package runs it on Node and on
// Bun.

import assert from "node:assert/strict";

import { Decoder, Float, TERMINAL_KEYS, VERSION, decodeKeys, doc, resolve, unpack } from "@neuroplastio/hotty";
import { Field } from "@neuroplastio/hotty/field";
import { Link } from "@neuroplastio/hotty/link";
import { Session } from "@neuroplastio/hotty/session";
import { Terminal } from "@neuroplastio/hotty/terminal";
import { Host } from "@neuroplastio/hotty/test";

const f = new Decoder().feed(doc("card", "<p>hi</p>"));
assert.equal(f.result, "complete");
assert.equal(f.message.get("s"), "card");
assert.equal(f.message.text(), "<p>hi</p>");
assert.equal(VERSION, "0.2");
// A host's body is msgpack, its floats kept apart from its ints.
assert.deepEqual(unpack(new Uint8Array([0x82, 0xa1, 0x77, 0xca, 0x43, 0xa0, 0x40, 0x00, 0xa1, 0x72, 0x07]), { floats: true }), { w: new Float(320.5), r: 7 });

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
assert.deepEqual([t.caps?.v, t.caps?.scale, t.caps?.limits.surfaces], ["0.2", 1, 64]);
const s = new Session({ link: t, onMessage: () => {} });
assert.equal(typeof s.flush(), "string");
t.print("card", "<p id=m>hi</p>", { cols: 10, rows: 1 });
assert.deepEqual(await t.fence(), []);
assert.equal(h.surface("smoke-card")?.textOf("m"), "hi");
t.close();

console.log(`package: ok (${typeof Bun === "undefined" ? "node" : "bun"})`);
