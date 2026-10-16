// What 0.3 changed in Encode and the Decoder: chunks, and zlib's level
// (SPEC §3.4, SDK.md §3.3).

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { Decoder, encode } from "../src/index.ts";
import { describe, test } from "./harness.ts";

describe("encode", () => {
  const chunks = (out: string) => out.split("\x1b\\").filter((x) => x !== "").map((x) => x.slice("\x1b]7279;".length));

  test("a payload over 4096 base64 bytes is chunked: the first carries the control, a further one only m (SPEC §3.4)", () => {
    // Random-looking bytes do not compress, so the chunks are the payload's.
    let x = 2463534242;
    const bytes = new Uint8Array(6000).map(() => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), x & 0xff));
    const seqs = chunks(encode([["a", "res"], ["id", "x"], ["q", "2"], ["type", "image/png"]], bytes));
    assert.deepEqual(seqs.map((s) => s.split(";")[0]), ["a=res:id=x:q=2:type=image/png:m=1", "m=0"]);
    assert.deepEqual(seqs.map((s) => s.split(";")[1]!.length), [4096, 8000 - 4096]);
  });

  test("a further chunk with anything but m is no continuation: the message in progress is malformed (SPEC §3.4, §3.7)", () => {
    const dec = new Decoder();
    assert.equal(dec.feed("\x1b]7279;a=doc:s=x:m=1;QUJD\x1b\\").result, "partial");
    const f = dec.feed("\x1b]7279;m=0:q=1;REVG\x1b\\");
    // q is no longer a continuation's: the doc is aborted, and this is a
    // message of its own, not its end.
    assert.equal(dec.invalid, 1, "the aborted message");
    assert.deepEqual([f.result, f.message?.get("q"), f.message?.text()], ["complete", "1", "DEF"]);
  });

  test("a payload is compressed at zlib's level 6 (SDK.md §3.3)", () => {
    const payload = "body { color: var(--hotty-ansi-4); } .row { display: flex; gap: 12px; }\n".repeat(300);
    const [seq] = chunks(encode([["a", "res"]], payload));
    const [control, b64] = seq!.split(";");
    assert.equal(control, "a=res:o=z");
    assert.equal(b64, deflateSync(payload, { level: 6 }).toString("base64"));
  });
});
