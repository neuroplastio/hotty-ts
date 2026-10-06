// The package as a program gets it: dist, imported by the package's name,
// plain JavaScript. make package runs it on Node and on Bun.

import assert from "node:assert/strict";

import { Decoder, VERSION, doc } from "hotty";

const f = new Decoder().feed(doc("card", "<p>hi</p>"));
assert.equal(f.result, "complete");
assert.equal(f.message.get("s"), "card");
assert.equal(f.message.text(), "<p>hi</p>");
assert.equal(VERSION, "0.1");
console.log(`package: ok (${typeof Bun === "undefined" ? "node" : "bun"})`);
