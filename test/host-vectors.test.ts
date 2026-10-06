// The host vectors' send and inspect steps (SDK.md §4.4), against the test
// host. It lays nothing out, so the rows it gives r=auto are an estimate,
// and the vectors' pointer steps, and the events that follow from a layout,
// are not run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Decoder, encode, type Reply } from "../src/index.ts";
import { Host } from "../src/test/index.ts";
import { describe, test } from "./harness.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const here = dirname(fileURLToPath(import.meta.url));
const data: Any = JSON.parse(readFileSync(join(here, "testdata", "vectors.json"), "utf8"));

// A vector's control as the program sends it: a first, the rest in a stable order.
function vectorControl(m: Record<string, string>): [string, string][] {
  const keys = Object.keys(m).filter((k) => k !== "a").sort();
  return [...(m.a !== undefined ? [["a", m.a] as [string, string]] : []), ...keys.map((k) => [k, m[k]!] as [string, string])];
}

// The replies the host sent since the last call.
function replies(h: Host): Reply[] {
  const text = new TextDecoder().decode(h.take());
  const dec = new Decoder();
  const out: Reply[] = [];
  for (const seq of text.match(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g) ?? []) {
    const f = dec.feed(seq);
    const r = f.result === "complete" ? f.message.reply() : undefined;
    if (r) out.push(r);
  }
  return out;
}

describe("host vectors", () => {
  for (const v of data.vectors) {
    // A vector whose every check is in steps the runner does not run (the
    // pointer, keys) is skipped, not passed.
    const checks = v.steps.some((st: Any) => st.inspect || (st.send && st.reply !== undefined));
    (checks ? test : test.skip)(v.name, () => {
      const h = new Host({ lenient: true });
      v.steps.forEach((st: Any, i: number) => {
        if (st.inspect) {
          const [surface, id] = st.inspect;
          const e = h.surface(surface)?.element(id);
          if (st.expect === null) {
            assert.equal(e, undefined, `step ${i}: #${id} exists`);
            return;
          }
          assert.ok(e, `step ${i}: no #${id} in ${surface}`);
          if (st.expect.tag !== undefined) assert.equal(e.tag, st.expect.tag, `step ${i}: tag`);
          if (st.expect.attrs !== undefined) assert.deepEqual(e.attrs, st.expect.attrs, `step ${i}: attrs`);
          if (st.expect.text !== undefined) assert.equal(e.text, st.expect.text, `step ${i}: text`);
          if (st.expect.children !== undefined) {
            const got = e.children.map((c) => [c.tag, c.id ?? null, c.text]);
            assert.deepEqual(got, st.expect.children, `step ${i}: children`);
          }
          return;
        }
        if (!st.send) return; // a pointer step
        h.write(encode(vectorControl(st.send), st.payload ?? ""));
        const got = replies(h);
        if (st.reply === undefined) return;
        if (st.reply === null) {
          assert.equal(got.length, 0, `step ${i}: a reply where none is due`);
          return;
        }
        assert.ok(got.length > 0, `step ${i}: no reply, want ${JSON.stringify(st.reply)}`);
        const r = got[0]!;
        const want = { ...st.reply };
        // The host lays nothing out: the rows it gives r=auto are an estimate.
        if (st.send.a === "place" && (st.send.r === undefined || st.send.r === "auto")) delete want.r;
        for (const [k, val] of Object.entries(want)) {
          const g = k === "code" ? r.code : k === "detail" ? r.detail : r.message.get(k);
          assert.equal(g, val, `step ${i}: ${k} (${JSON.stringify(Object.fromEntries(r.message.control))})`);
        }
      });
    });
  }
});
