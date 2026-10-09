// The host vectors' send, inspect and key steps (SDK.md §4.4), against the
// test host. It lays nothing out, so the rows it gives r=auto are an
// estimate, and the vectors' pointer steps, the events that follow from a
// layout, and the keys of vectors that need one, are not run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Decoder, encode, type Event, type Reply } from "../src/index.ts";
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

// The events the host sent since the last call.
function events(h: Host): Event[] {
  const text = new TextDecoder().decode(h.take());
  const dec = new Decoder();
  const out: Event[] = [];
  for (const seq of text.match(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g) ?? []) {
    const f = dec.feed(seq);
    const e = f.result === "complete" ? f.message.event() : undefined;
    if (e) out.push(e);
  }
  return out;
}

// A key step's key as SPEC §10.4 names it: the modifiers held, in its order,
// before the key; Shift left out before a character.
function keyName(st: Any): string {
  const held = new Set<string>(st.keys ?? []);
  const one = [...st.key].length === 1;
  const mods = [
    ["ctrl", "Control"],
    ["alt", "Alt"],
    ["meta", "Meta"],
    ["shift", "Shift"],
  ].filter(([k]) => held.has(k!) && (k !== "shift" || !one));
  return mods.map(([, m]) => m + "+").join("") + (st.key === " " ? "Space" : st.key);
}

// Presses a key step's key, and checks where it went and the events it made.
function checkKey(h: Host, i: number, st: Any) {
  h.take();
  const name = keyName(st);
  const used = h.key(name);
  if (st.terminal !== undefined) assert.equal(!used, st.terminal, `step ${i} (${name}): reached the program`);
  if (st.events === undefined) return;
  const got = events(h);
  const seen = got.map((e) => `${e.kind} t=${e.target} ${JSON.stringify(e.detail)}`);
  assert.equal(got.length, st.events.length, `step ${i} (${name}): events ${seen.join(", ")}`);
  st.events.forEach((w: Any, j: number) => {
    const g = got[j]!;
    assert.deepEqual([g.kind, g.surface, g.target], [w.e, w.s, w.t], `step ${i} (${name}): event ${j}`);
    if (w.detail === undefined) return;
    const want = structuredClone(w.detail);
    // This host lays nothing out, so it knows no element's area.
    if (want !== null && typeof want === "object" && !Array.isArray(want)) {
      delete want.area;
      if (Object.keys(want).length === 0 && g.detail === undefined) return;
    }
    assert.deepEqual(g.detail, want, `step ${i} (${name}): event ${j} detail`);
  });
}

describe("host vectors", () => {
  for (const v of data.vectors) {
    // Keys are pressed only in vectors with no pointer, and that require
    // nothing: this host lays nothing out, so where a pointer is says
    // nothing here, and it has no passthrough or hover, and scrolls nothing.
    const keys = v.requires === undefined && !v.steps.some((st: Any) => st.pointer);
    // A vector whose every check is in steps the runner does not run (the
    // pointer, keys it does not press) is skipped, not passed.
    const checks = v.steps.some(
      (st: Any) => st.inspect || (st.send && st.reply !== undefined) || (keys && st.key !== undefined),
    );
    (checks ? test : test.skip)(v.name, () => {
      const h = new Host({ lenient: true });
      v.steps.forEach((st: Any, i: number) => {
        if (st.key !== undefined) {
          if (keys) checkKey(h, i, st);
          return;
        }
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
