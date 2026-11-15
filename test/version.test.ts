// The package's version and the hotty version it speaks (gov P-5 rule 6):
// an SDK's MAJOR.MINOR is the spec's, and its PATCH its own. hotty 0.8 is
// @neuroplastio/hotty 0.8.x. The vectors are VERSION's (vectors.test.ts).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as hotty from "../src/index.ts";
import { Decoder, Detector, VERSIONS, answerVersion, doc, encode, place, query } from "../src/index.ts";
import { pack } from "../src/msgpack.ts";
import { Host } from "../src/test/index.ts";
import { test } from "./harness.ts";

test("the package's MAJOR.MINOR is the hotty version it speaks", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-next\.\d+)?$/);
  assert.equal(pkg.version.split(".").slice(0, 2).join("."), hotty.VERSION);
});

// The versions spoken (SPEC §4, §15).


test("the SDK speaks 0.7 and 0.8, lowest first, as its query lists them", () => {
  assert.deepEqual([hotty.VERSION, ...VERSIONS], ["0.8", "0.7", "0.8"]);
  const d = new Decoder().feed(query(3).replace("\x1b[c", ""));
  assert.equal(d.result, "complete");
  if (d.result === "complete") assert.equal(d.message.get("v"), "0.7,0.8");
});

test("the detector takes a host that answers in 0.7 or 0.8, and refuses 0.6 and 99.0", () => {
  const outcome = (v: string) => {
    const det = new Detector();
    det.start(0);
    const f = new Decoder().feed(encode([["a", "ok"], ["n", 1], ["re", "q"]], pack({ v })));
    assert.equal(f.result, "complete");
    if (f.result === "complete") det.reply(f.message.reply()!, 5);
    return [det.state, det.caps?.v];
  };
  assert.deepEqual(outcome("0.6"), ["text", undefined]);
  assert.deepEqual(outcome("0.7"), ["native", "0.7"]);
  assert.deepEqual(outcome("0.8"), ["native", "0.8"]);
  assert.deepEqual(outcome("99.0"), ["text", undefined]);
});

test("the version a host answers in is the highest the query shares with the SDK; none shared is undefined", () => {
  assert.equal(answerVersion("0.7,0.8"), "0.8");
  assert.equal(answerVersion("0.8,0.7"), "0.8");
  assert.equal(answerVersion("0.8"), "0.8");
  assert.equal(answerVersion("0.7"), "0.7");
  assert.equal(answerVersion("0.8,0.10,1.0", ["0.10", "1.0", "0.8"]), "1.0");
  assert.equal(answerVersion("0.8,0.10", ["0.8", "0.10"]), "0.10");
  for (const none of ["0.6", "99.0", "0.70", "", undefined]) assert.equal(answerVersion(none), undefined);
});

test("the test host answers a query in the shared version, and with EVERSION, 0.7,0.8, when none is shared", () => {
  const ask = (v: string | undefined) => {
    const h = new Host();
    h.write(encode(v === undefined ? [["a", "q"], ["n", 1]] : [["a", "q"], ["n", 1], ["v", v]]));
    const r = h.replies()[0]!.reply()!;
    return [r.ok, r.ok ? r.caps()?.v : r.code, r.detail];
  };
  assert.deepEqual(ask("0.7,0.8"), [true, "0.8", undefined]);
  assert.deepEqual(ask("0.8"), [true, "0.8", undefined]);
  assert.deepEqual(ask("0.7"), [true, "0.7", undefined]);
  assert.deepEqual(ask("0.6"), [false, "EVERSION", "0.7,0.8"]);
  assert.deepEqual(ask(undefined), [false, "EVERSION", "0.7,0.8"]);
});

test("in 0.7 and 0.8 sessions the test host reports secondary presses, except with Alt or Shift", () => {
  const html = `<div id=o data-on=secondary>o</div>`;
  const run = (v: string, keys: string[]) => {
    const h = new Host();
    h.write(encode([["a", "q"], ["n", 1], ["v", v]]) + doc("p", html) + place("p", { cols: 20, rows: 5, press: true }));
    h.events();
    h.secondaryPress("p", "o", 1, 1, keys);
    return h.events().length;
  };
  for (const v of ["0.7", "0.8", "0.7,0.8"]) assert.deepEqual([run(v, []), run(v, ["alt"]), run(v, ["shift"])], [1, 0, 0]);
});
