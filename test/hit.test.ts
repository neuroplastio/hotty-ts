// Hit's reply types and quiet levels beyond its conformance vectors
// (SPEC §3.5, §9.7; SDK.md §3.9).

import assert from "node:assert/strict";

import { Decoder, doc, encode, Float, focus, hit, place, type Quiet } from "../src/index.ts";
import { pack } from "../src/msgpack.ts";
import { Host } from "../src/test/index.ts";
import { test } from "./harness.ts";

const received = (out: string) => new Decoder().feed(out).message!;

test("hit implies q=0 with or without n; an explicit quiet level wins", () => {
  for (const n of [undefined, 4]) {
    for (const q of [undefined, 0, 1, 2] as const) {
      const m = received(hit("s", -2, -3, { n, q }));
      assert.equal(m.get("q"), q === undefined || q === 0 ? undefined : String(q));
      assert.equal(m.get("n"), n === undefined ? undefined : String(n));
    }
  }
});

test("Reply.hit reads each step as an int and only an ok reply to hit carries it", () => {
  const reply = (body: Uint8Array, a = "ok", re = "hit") => received(encode([["a", a], ["re", re]], body)).reply()!;
  assert.deepEqual(reply(pack({ t: "drop", ty: 0 })).hit, { t: "drop", tx: undefined, ty: 0 });
  for (const body of [pack({ t: "drop", tx: new Float(1) }), pack({ ty: "1" }), new Uint8Array([0x81, 0xa1, 0x74, 0xc0]), new Uint8Array()]) {
    assert.equal(reply(body).hit, undefined);
  }
  assert.equal(reply(pack({ t: "drop" }), "err").hit, undefined);
  assert.equal(reply(pack({ t: "drop" }), "ok", "place").hit, undefined);
});

test("a test host answers hit on a placed surface with no element, without changing focus or sending an event", () => {
  const h = new Host();
  h.write(doc("s", "<input id=a data-on=drop data-steps=10>") + place("s", { cols: 20, rows: 2 }) + focus("s", "a"));
  for (const q of [undefined, 0, 1, 2] as (Quiet | undefined)[]) h.write(hit("s", -1, 0, { q }));
  assert.deepEqual(h.replies().map((m) => m.reply()!.hit), [{ t: "", tx: undefined, ty: undefined }, { t: "", tx: undefined, ty: undefined }]);
  assert.equal(h.surface("s")!.focused(), "a");
  assert.deepEqual(h.events(), []);
});
