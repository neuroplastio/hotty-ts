// The package's version and the hotty version it speaks (gov P-5 rule 6):
// an SDK's MAJOR.MINOR is the spec's, and its PATCH its own. hotty 0.7 is
// @neuroplastio/hotty 0.7.x. The vectors are VERSION's (vectors.test.ts).

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


test("the SDK speaks 0.7 and 0.6, highest first, and its query lists them lowest first", () => {
  assert.deepEqual([hotty.VERSION, ...VERSIONS], ["0.7", "0.7", "0.6"]);
  const d = new Decoder().feed(query(3).replace("\x1b[c", ""));
  assert.equal(d.result, "complete");
  if (d.result === "complete") assert.equal(d.message.get("v"), "0.6,0.7");
});

test("the detector takes a host that answers in 0.6 or 0.7, and refuses 99.0", () => {
  const outcome = (v: string) => {
    const det = new Detector();
    det.start(0);
    const f = new Decoder().feed(encode([["a", "ok"], ["n", 1], ["re", "q"]], pack({ v })));
    assert.equal(f.result, "complete");
    if (f.result === "complete") det.reply(f.message.reply()!, 5);
    return [det.state, det.caps?.v];
  };
  assert.deepEqual(outcome("0.6"), ["native", "0.6"]);
  assert.deepEqual(outcome("0.7"), ["native", "0.7"]);
  assert.deepEqual(outcome("99.0"), ["text", undefined]);
});

test("the version a host answers in is the highest the query shares with the SDK; none shared is undefined", () => {
  assert.equal(answerVersion("0.6,0.7"), "0.7");
  assert.equal(answerVersion("0.7,0.6"), "0.7");
  assert.equal(answerVersion("0.6"), "0.6");
  assert.equal(answerVersion("0.7"), "0.7");
  for (const none of ["0.5", "99.0", "0.60", "", undefined]) assert.equal(answerVersion(none), undefined);
});

test("the test host answers a query in the shared version, and with EVERSION, 0.6,0.7, when none is shared", () => {
  const ask = (v: string | undefined) => {
    const h = new Host();
    h.write(encode(v === undefined ? [["a", "q"], ["n", 1]] : [["a", "q"], ["n", 1], ["v", v]]));
    const r = h.replies()[0]!.reply()!;
    return [r.ok, r.ok ? r.caps()?.v : r.code, r.detail];
  };
  assert.deepEqual(ask("0.6,0.7"), [true, "0.7", undefined]);
  assert.deepEqual(ask("0.6"), [true, "0.6", undefined]);
  assert.deepEqual(ask("0.7"), [true, "0.7", undefined]);
  assert.deepEqual(ask("0.5"), [false, "EVERSION", "0.6,0.7"]);
  assert.deepEqual(ask(undefined), [false, "EVERSION", "0.6,0.7"]);
});

test("in a 0.6 session the test host keeps every secondary press the terminal's, with Alt too; in a 0.7 one it does not", () => {
  const html = `<div id=o data-on=secondary>o</div>`;
  const run = (v: string, keys: string[]) => {
    const h = new Host();
    h.write(encode([["a", "q"], ["n", 1], ["v", v]]) + doc("p", html) + place("p", { cols: 20, rows: 5, press: true }));
    h.events();
    h.secondaryPress("p", "o", 1, 1, keys);
    return h.events().length;
  };
  assert.deepEqual([run("0.6", []), run("0.6", ["alt"]), run("0.6", ["shift"])], [0, 0, 0]);
  assert.deepEqual([run("0.6,0.7", []), run("0.6,0.7", ["alt"])], [1, 0]);
});
