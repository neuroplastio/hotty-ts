// What a peer sends is bounded before it is held: a message by the
// Decoder's max, after base64 and zlib, and a chunked one as its chunks
// come (plexos HOTTY-INFLATE-01).

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { DEFAULT_MAX, Decoder } from "../src/index.ts";
import { describe, test } from "./harness.ts";

const HEAD = "\x1b]7279;";
const ST = "\x1b\\";
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const bomb = (n: number) => b64(deflateSync(new Uint8Array(n), { level: 9 }));

describe("Decoder max", () => {
  test("inflating stops past max", () => {
    const z = bomb(4 << 20); // about 4 KB of base64
    for (const [max, want] of [
      [1 << 20, "invalid"],
      [4 << 20, "complete"],
      [(4 << 20) - 1, "invalid"],
    ] as const) {
      const d = new Decoder();
      d.max = max;
      assert.equal(d.feed(HEAD + "a=res:id=x:type=text/plain:o=z;" + z + ST).result, want, `max ${max}`);
    }
    const d = new Decoder(); // DEFAULT_MAX
    assert.equal(d.feed(HEAD + "a=res:id=x:type=text/plain:o=z;" + bomb(DEFAULT_MAX + 1) + ST).result, "invalid");
    assert.equal(d.invalid, 1);
  });

  test("a plain payload past max", () => {
    const d = new Decoder();
    d.max = 4;
    const enc = (s: string) => b64(new TextEncoder().encode(s));
    assert.equal(d.feed(HEAD + "a=res:id=x:type=text/plain;" + enc("abcd") + ST).result, "complete");
    assert.equal(d.feed(HEAD + "a=res:id=x:type=text/plain;" + enc("abcde") + ST).result, "invalid");
  });

  test("a chunked message past max is dropped as it comes, and counted once", () => {
    const d = new Decoder();
    d.max = 1024;
    const chunk = "A".repeat(400); // 300 bytes each
    assert.equal(d.feed(HEAD + "a=res:id=x:type=text/plain:m=1;" + chunk + ST).result, "partial");
    for (let i = 0; i < 10; i++) assert.equal(d.feed(HEAD + "m=1;" + chunk + ST).result, "partial", `chunk ${i}`);
    assert.equal(d.invalid, 1);
    assert.equal(d.feed(HEAD + "m=0;" + chunk + ST).result, "invalid");
    assert.equal(d.invalid, 1);
    // A message after it decodes as usual.
    const after = d.feed(HEAD + "a=hide:s=x" + ST);
    assert.equal(after.result, "complete");
    assert.equal(after.message?.get("a"), "hide");
    // A dropped message that another interrupts is counted once.
    d.feed(HEAD + "a=res:id=x:type=text/plain:m=1;" + "A".repeat(2000) + ST);
    assert.equal(d.feed(HEAD + "a=hide:s=x" + ST).result, "complete");
    assert.equal(d.invalid, 2);
    // A malformed one too.
    d.feed(HEAD + "a=res:id=x:type=text/plain:m=1;" + "A".repeat(2000) + ST);
    assert.equal(d.feed(HEAD + "a b" + ST).result, "invalid");
    assert.equal(d.invalid, 4);
  });
});
