// The host vectors' send, write, inspect, key and menu steps (SDK.md §4.4), against
// the test host. It lays nothing out, so the rows it gives r=auto are an
// estimate, and the vectors' pointer steps, the events that follow from a
// layout, and the vectors that need one (scroll, steps, drop and view) are
// not run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Decoder, encode, Float, unpack, type Event, type Reply } from "../src/index.ts";
import { pack, readBody, type Type } from "../src/msgpack.ts";
import { Host } from "../src/test/index.ts";
import { describe, test } from "./harness.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const here = dirname(fileURLToPath(import.meta.url));
// A number written with a fraction or an exponent is a float, any other an
// int (conformance/README.md): a float is read as a Float, as unpack keeps
// a body's.
const data: Any = JSON.parse(readFileSync(join(here, "testdata", "vectors.json"), "utf8"), (_k, v, ctx?: { source?: string }) =>
  typeof v === "number" && /[.eE]/.test(ctx?.source ?? "") ? new Float(v) : v,
);

// A vector's control as the program sends it: a first, the rest in a stable order.
function vectorControl(m: Record<string, string>): [string, string][] {
  const keys = Object.keys(m).filter((k) => k !== "a").sort();
  return [...(m.a !== undefined ? [["a", m.a] as [string, string]] : []), ...keys.map((k) => [k, m[k]!] as [string, string])];
}

// What a send step sends: text, bytes that are not UTF-8, or a body written
// from JSON as msgpack, a number with a fraction a float.
function payload(st: Any): string | Uint8Array {
  if (st.body !== undefined) return pack(st.body);
  if (st.payload_b64 !== undefined) return Uint8Array.from(Buffer.from(st.payload_b64, "base64"));
  return st.payload ?? "";
}

// The replies and the events the host sent since the last call.
function sent(h: Host): { replies: Reply[]; events: Event[] } {
  const text = new TextDecoder().decode(h.take());
  const dec = new Decoder();
  const out: { replies: Reply[]; events: Event[] } = { replies: [], events: [] };
  for (const seq of text.match(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g) ?? []) {
    const f = dec.feed(seq);
    if (f.result !== "complete") continue;
    const r = f.message.reply();
    if (r) out.replies.push(r);
    const e = f.message.event();
    if (e) out.events.push(e);
  }
  return out;
}

// What a vector may require of this host (conformance/README.md, SDK.md
// §4.4): the features it reports, whose pointer and key steps it skips all
// the same, since it lays nothing out. A vector that requires anything
// else, scroll, steps, drop, view, touch, mouse, undo, passthrough or
// commands, is skipped.
const implements_ = new Set(["hover", "count", "menu"]);
const requires = (v: Any): string[] => [v.requires ?? []].flat();

// The events a step made, against the step's: kind, surface, target (null:
// none) and detail, each value of its type (conformance/README.md).
function checkEvents(at: string, got: Event[], want: Any[]) {
  const seen = got.map((e) => `${e.kind} t=${e.target} ${JSON.stringify(e.detail)}`);
  assert.equal(got.length, want.length, `${at}: events ${seen.join(", ")}`);
  want.forEach((w: Any, j: number) => {
    const g = got[j]!;
    assert.deepEqual([g.kind, g.surface, g.target], [w.e, w.s ?? "", w.t ?? ""], `${at}: event ${j}`);
    if (w.detail === undefined) return;
    // The detail, each value of its type: a float is not an int.
    const detail = g.message.payload.length > 0 ? unpack(g.message.payload, { floats: true }) : null;
    let expect = w.detail;
    // This host lays nothing out, so it knows no element's area.
    if (expect !== null && typeof expect === "object" && !Array.isArray(expect)) {
      expect = { ...expect };
      delete expect.area;
      if (Object.keys(expect).length === 0 && detail === null) return;
    }
    assert.deepEqual(detail, expect, `${at}: event ${j} detail`);
  });
}

// A key step's key (a DOM key value) as SPEC §10.4 names it: the modifiers
// held, in its order, before the key; a space bar is space, a letter small,
// and Shift left out before a character that is no letter, which it types.
function keyName(st: Any): string {
  const held = new Set<string>(st.keys ?? []);
  const one = [...st.key].length === 1;
  const letter = one && st.key.toLowerCase() !== st.key.toUpperCase();
  const mods = ["super", "ctrl", "alt", "shift"].filter((m) => held.has(m) && (m !== "shift" || !one || letter));
  const key = st.key === " " ? "space" : one ? st.key.toLowerCase() : st.key;
  return [...mods, key].join("+");
}

// Presses a key step's key, and checks where it went and the events it made.
function checkKey(h: Host, i: number, st: Any) {
  h.take();
  const name = keyName(st);
  const used = h.key(name);
  if (st.terminal !== undefined) assert.equal(!used, st.terminal, `step ${i} (${name}): reached the program`);
  if (st.events === undefined) return;
  checkEvents(`step ${i} (${name})`, sent(h).events, st.events);
}

// A menu step: the level the host shows, or a pick by name and the events it
// makes.
function checkMenu(h: Host, i: number, st: Any) {
  if (st.menu === "shown") {
    const got = h.shown().map((it) => ({ key: it.key ?? "", label: it.label ?? "", group: (it.items?.length ?? 0) > 0, enabled: it.enabled !== false }));
    assert.deepEqual(got, st.expect ?? [], `step ${i}: the level shown`);
  } else if (st.menu === "pick") {
    h.take();
    h.pick(st.name);
    checkEvents(`step ${i} (pick ${st.name})`, sent(h).events, st.events);
  } else assert.fail(`step ${i}: menu step ${st.menu}`);
}

describe("host vectors", () => {
  for (const v of data.vectors) {
    const skip = requires(v).find((r) => !implements_.has(r));
    // Keys are pressed only in vectors with no pointer, and that require
    // nothing but menus: this host lays nothing out, so where a pointer is
    // says nothing here, and it has no passthrough and scrolls nothing.
    const pointer = v.steps.some((st: Any) => st.pointer || st.touch);
    const keys = requires(v).every((r) => r === "menu") && !pointer;
    // The fit vectors size a document by the cell, which this host does not
    // lay out: it estimates the rows.
    const fits = v.steps.some((st: Any) => st.send?.f === "1");
    // A vector whose every check is in steps the runner does not run (the
    // pointer, keys it does not press) is skipped, not passed.
    const checks = v.steps.some(
      (st: Any) =>
        st.inspect || st.menu || (st.send && (st.reply !== undefined || (st.events !== undefined && !pointer && !fits))) || (keys && st.key !== undefined),
    );
    (checks && !skip ? test : test.skip)(v.name, () => {
      const h = new Host({ lenient: true });
      v.steps.forEach((st: Any, i: number) => {
        if (st.menu) {
          checkMenu(h, i, st);
          return;
        }
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
        if (st.write !== undefined) {
          // What the program writes that is not hotty's: this host is a
          // terminal, and takes it as one.
          h.write(st.write);
          return;
        }
        if (!st.send) return; // a pointer or touch step
        h.take();
        // A body is msgpack written from JSON: a number with a fraction is a float.
        h.write(encode(vectorControl(st.send), payload(st)));
        const { replies: got, events: made } = sent(h);
        // The events a command makes, in a vector with no pointer, whose
        // events this host cannot make.
        if (st.events !== undefined && !pointer && !fits) checkEvents(`step ${i}`, made, st.events);
        if (st.reply === undefined) return;
        if (st.reply === null) {
          assert.equal(got.length, 0, `step ${i}: a reply where none is due`);
          return;
        }
        assert.ok(got.length > 0, `step ${i}: no reply, want ${JSON.stringify(st.reply)}`);
        const r = got[0]!;
        const { types, body, ...want } = st.reply;
        const hex = Buffer.from(r.message.payload).toString("hex");
        // The body decodes, and each field it has that types names is of
        // its type (conformance/README.md): readBody reads it so.
        if (types !== undefined) {
          assert.ok(readBody(r.message.payload, types as Type), `step ${i}: the body ${hex} is not of its types`);
        }
        // The body has each field body names, equal as values: a float is
        // not an int. Fields it does not name are not checked.
        if (body !== undefined) {
          let have: Any;
          try {
            have = unpack(r.message.payload, { floats: true });
          } catch (e) {
            assert.fail(`step ${i}: the body ${hex} does not decode: ${(e as Error).message}`);
          }
          for (const [k, val] of Object.entries(body)) assert.deepEqual(have?.[k], val, `step ${i}: body ${k} (${hex})`);
        }
        // The host lays nothing out: the rows it gives r=auto are an estimate.
        if (st.send.a === "place" && (st.send.r === undefined || st.send.r === "auto")) delete want.r;
        for (const [k, val] of Object.entries(want)) {
          const g = k === "code" ? r.code : k === "detail" ? r.detail : r.message.get(k);
          // null: the reply must not have the key.
          if (val === null) assert.ok(g === undefined || g === "", `step ${i}: ${k} (${JSON.stringify(Object.fromEntries(r.message.control))}), want none`);
          else assert.equal(g, val, `step ${i}: ${k} (${JSON.stringify(Object.fromEntries(r.message.control))})`);
        }
      });
    });
  }
});
