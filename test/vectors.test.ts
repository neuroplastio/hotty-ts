// The conformance vectors' SDK sections (conformance/README.md): wire,
// build, encode, decode, scan, detect, keys, keymap and edit, every one of
// them.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Field } from "../src/field.ts";
import * as hotty from "../src/index.ts";
import { describe, test } from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const copy = join(here, "testdata", "vectors.json");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const data: Any = JSON.parse(readFileSync(copy, "utf8"));

// What this SDK implements, of what a vector may require: everything.
const FEATURES = new Set([
  "place.hover",
  "event.hover",
  "caps.passthrough",
  "caps.version",
  "caps.lenient",
  "caps.drag-kinds",
  "options.unordered",
  "doc.scroll",
  "event.area",
  "caps.scroll",
  "decode.abort-count",
  "decode.unterminated",
  "scanner.da1",
  "graphemes",
]);

const runs = (v: Any) => (v.requires ?? []).every((r: string) => FEATURES.has(r));
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
// Bytes as a string of their codes, for comparing and printing.
const bin = (b: Uint8Array) => String.fromCharCode(...b);
// undefined as the vectors write it.
const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

function sections(name: string, run: (v: Any) => void) {
  describe(name, () => {
    for (const v of data[name] ?? []) {
      (runs(v) ? test : test.skip)(v.name, () => run(v));
    }
  });
}

test("the vectors are this SDK's version", () => {
  assert.equal(data.version, hotty.VERSION);
});

// The copy is the spec's, when a checkout is at hand (HOTTY_DIR, else one
// next to this repository).
{
  const dir = process.env.HOTTY_DIR ? resolve(process.env.HOTTY_DIR) : resolve(here, "../../../hotty/main");
  const spec = join(dir, "conformance", "vectors.json");
  (existsSync(spec) ? test : test.skip)("the vectors are current (make vectors copies them)", () => {
    assert.ok(readFileSync(spec).equals(readFileSync(copy)), `${copy} differs from ${spec}: run make vectors`);
  });
}

// A builder's or encoder's output as raw bytes and HOTTY sequences.
function oscSegments(out: string): { raw?: string; osc?: Uint8Array }[] {
  const sc = new hotty.Scanner();
  const segs = [...sc.feed(out), ...sc.flush()];
  return segs.map((s) => (s.kind === "pass" ? { raw: fromUtf8.decode(s.data) } : { osc: s.data }));
}

const controlObject = (m: hotty.Message) => Object.fromEntries(m.control);

// --- wire --------------------------------------------------------------------

sections("wire", (v) => {
  const sc = new hotty.Scanner();
  const dec = new hotty.Decoder();
  const got: hotty.Message[] = [];
  for (const s of [...sc.feed(v.stream), ...sc.flush()]) {
    if (s.kind !== "osc") continue;
    const f = dec.feed(s.data);
    if (f.result === "complete") got.push(f.message);
  }
  assert.equal(sc.invalid + dec.invalid, v.invalid, "invalid");
  assert.equal(got.length, v.commands.length, "commands");
  v.commands.forEach((want: Any, i: number) => {
    const m = got[i]!;
    assert.ok(!m.control.has("m") && !m.control.has("o"), "m or o left in the control");
    for (const [k, val] of Object.entries(want.control)) assert.equal(m.get(k), val, `${k}`);
    assert.equal(m.text(), want.payload, "payload");
  });
});

// --- build -------------------------------------------------------------------

function placement(p: Any): hotty.Placement {
  return {
    cols: p.cols,
    rows: p.rows,
    window: p.window,
    z: p.z,
    press: p.press,
    fit: p.fit,
    hover: p.hover,
    keepCursor: p.keep_cursor,
  };
}

function build(b: Any): string {
  const a = b.args ?? {};
  const o = b.options ?? {};
  const ro: hotty.ReplyOptions = { n: o.n, q: o.q };
  switch (b.build) {
    case "query":
      return hotty.query(a.n, { late: o.late });
    case "withdraw_late":
      return hotty.withdrawLate();
    case "doc":
      return hotty.doc(a.surface, a.html, { ...ro, detached: o.detached, scroll: o.scroll });
    case "place":
      return hotty.place(a.surface, placement(a.placement), ro);
    case "place_at":
      return hotty.placeAt(a.surface, a.x, a.y, placement(a.placement), ro);
    case "hide":
      return hotty.hide(a.surface, ro);
    case "delta":
      return hotty.delta(a.surface, a.op, a.target ?? "", a.key ?? "", a.payload ?? "", ro);
    case "set_text":
      return hotty.setText(a.surface, a.target, a.text, ro);
    case "set_var":
      return hotty.setVar(a.surface, a.target, a.name, a.value, ro);
    case "set_attr":
      return hotty.setAttr(a.surface, a.target, a.name, a.value, ro);
    case "remove_attr":
      return hotty.removeAttr(a.surface, a.target, a.name, ro);
    case "morph_to":
      return hotty.morphTo(a.surface, a.target, a.html, ro);
    case "res":
      return hotty.res(a.id, a.mime, a.data, ro);
    case "del_res":
      return hotty.delRes(a.id, ro);
    case "del":
      return hotty.del(a.surface, ro);
    case "del_all":
      return hotty.delAll(ro);
    case "detach":
      return hotty.detach(a.surface, ro);
    case "focus":
      return hotty.focus(a.surface, a.target ?? "", ro);
    case "blur":
      return hotty.blur(a.surface, ro);
    case "sync":
      return hotty.sync(...a.commands.map(build));
  }
  throw new Error(`no builder ${b.build}`);
}

sections("build", (v) => {
  const dec = new hotty.Decoder();
  const got = oscSegments(build(v)).map((s) => {
    if (s.raw !== undefined) return { raw: s.raw };
    const f = dec.feed(s.osc!);
    assert.equal(f.result, "complete", "a command did not decode");
    return { cmd: { control: controlObject(f.message!), payload: f.message!.text() } };
  });
  const want = v.out.map((s: Any) => (s.cmd ? { cmd: { control: s.cmd.control, payload: s.cmd.payload ?? "" } } : s));
  assert.deepEqual(got, want);
});

// --- encode ------------------------------------------------------------------

sections("encode", (v) => {
  const payload: Uint8Array = v.payload_b64 !== undefined ? hotty_fromBase64(v.payload_b64) : utf8.encode(v.payload);
  const out = hotty.encode(v.control, payload);
  if (v.bytes !== undefined) assert.equal(out, v.bytes, "bytes");
  const seqs = oscSegments(out).flatMap((s) => (s.osc ? [s.osc] : []));
  if (v.chunks !== undefined) {
    const got = seqs.map((s) => {
      const inner = bin(s).slice("\x1b]7279;".length, -2);
      const semi = inner.indexOf(";");
      return { control: inner.slice(0, semi), len: inner.length - semi - 1 };
    });
    assert.deepEqual(got, v.chunks, "chunks");
  }
  const dec = new hotty.Decoder();
  const results = seqs.map((s) => dec.feed(s));
  const last = results.at(-1);
  assert.equal(last?.result, "complete", "does not decode");
  assert.ok(Buffer.from(last!.message!.payload).equals(Buffer.from(payload)), "the payload differs after the round trip");
  // The keys in order, but m and o, which are Encode's (SDK.md §3.3).
  const keys = v.control.map((p: string[]) => p[0]).filter((k: string) => k !== "m" && k !== "o");
  assert.deepEqual([...last!.message!.control.keys()], keys, "control keys");
});

function hotty_fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

// --- decode ------------------------------------------------------------------

function replyView(r: hotty.Reply) {
  return {
    ok: r.ok,
    re: nul(r.re),
    n: nul(r.n),
    surface: nul(r.surface),
    cols: nul(r.cols),
    rows: nul(r.rows),
    code: nul(r.code),
    detail: nul(r.detail),
  };
}

function eventView(e: hotty.Event) {
  const link = e.link();
  const hover = e.hover();
  const drag = e.drag();
  return {
    surface: e.surface,
    kind: e.kind,
    target: e.target,
    value: nul(e.value()),
    checked: nul(e.checked()),
    fields: nul(e.fields()),
    link: link ? { href: link.href, url: nul(link.url) } : null,
    size: nul(e.size()),
    fit_rows: nul(e.fitRows()),
    drag: drag ? { ...drag, x: nul(drag.x), y: nul(drag.y) } : null,
    hover: hover ? { c: nul(hover.c), r: nul(hover.r), out: hover.out } : null,
    area: nul(e.area()),
  };
}

function capsView(c: hotty.Caps, want: Any) {
  return {
    v: nul(c.v),
    ops: c.ops,
    events: c.events,
    cell: nul(c.cell),
    scale: nul(c.scale),
    scheme: nul(c.scheme),
    limits: c.limits,
    net: c.net,
    passthrough: c.passthrough,
    scroll: c.scroll,
    steps: c.steps,
    host: nul(c.host),
    version: nul(c.version),
    drags: c.drags(),
    hovers: c.hovers(),
    light: c.light(),
    cell_css: c.cellCss(),
    supports: Object.fromEntries(Object.keys(want.supports ?? {}).map((op) => [op, c.supports(op)])),
    sends: Object.fromEntries(Object.keys(want.sends ?? {}).map((k) => [k, c.sends(k)])),
  };
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Every key want lists equals got's: objects key by key, numbers as numbers.
function match(got: Record<string, unknown>, want: Record<string, unknown>, path: string) {
  for (const [k, w] of Object.entries(want)) {
    const g = got[k] ?? null;
    if (isPlain(w) && isPlain(g)) match(g, w, `${path}.${k}`);
    else assert.deepEqual(g, w, `${path}.${k}`);
  }
}

sections("decode", (v) => {
  const dec = new hotty.Decoder();
  const results: string[] = [];
  const msgs: hotty.Message[] = [];
  for (const s of v.seqs) {
    const f = dec.feed(s);
    results.push(f.result);
    if (f.result === "complete") msgs.push(f.message);
  }
  assert.deepEqual(results, v.results, "results");
  assert.equal(dec.invalid, v.invalid, "invalid");
  assert.equal(msgs.length, v.messages.length, "messages");
  v.messages.forEach((want: Any, i: number) => {
    const m = msgs[i]!;
    assert.deepEqual(controlObject(m), want.control, "control");
    if (want.reply) {
      const r = m.reply();
      assert.ok(r, "not a reply");
      match(replyView(r), want.reply, "reply");
    }
    if (want.event) {
      const e = m.event();
      assert.ok(e, "not an event");
      match(eventView(e), want.event, "event");
    }
    if (want.caps) {
      const c = m.reply()?.caps();
      assert.ok(c, "no caps");
      match(capsView(c, want.caps), want.caps, "caps");
    }
  });
});

// --- scan --------------------------------------------------------------------

type Seg = [string, string];
const segs = (ss: hotty.Segment[]): Seg[] => {
  const out: Seg[] = [];
  for (const s of ss) {
    const last = out.at(-1);
    if (last && s.kind === "pass" && last[0] === "pass") last[1] += bin(s.data);
    else out.push([s.kind, bin(s.data)]);
  }
  return out;
};
const wantSegs = (ss: Any[] | undefined): Seg[] =>
  (ss ?? []).map((s) => {
    const [kind, text] = Object.entries(s)[0] as [string, string];
    return [kind, bin(utf8.encode(text))];
  });

sections("scan", (v) => {
  const stream = utf8.encode(v.stream);
  const da1 = (v.requires ?? []).includes("scanner.da1");
  // Every offset, and byte by byte; a long stream is cut at every offset
  // near its ends and at a stride between.
  let offsets: number[] = [];
  for (let i = 1; i < stream.length; i++) offsets.push(i);
  if (stream.length > 512) {
    const set = new Set<number>();
    for (let i = 1; i < 64; i++) set.add(i);
    for (let i = stream.length - 64; i < stream.length; i++) set.add(i);
    for (let i = 64; i < stream.length - 64; i += 4999) set.add(i);
    offsets = [...set].sort((a, b) => a - b);
  }
  const splits: number[][] = [[], ...offsets.map((i) => [i])];
  const all: number[] = [];
  for (let i = 1; i < stream.length; i++) all.push(i);
  splits.push(all);
  const want = wantSegs(v.segments);
  const wantFlush = wantSegs(v.flush);
  const wantHeld = bin(utf8.encode(v.held ?? ""));
  for (const cuts of splits) {
    const sc = new hotty.Scanner({ da1 });
    const got: hotty.Segment[] = [];
    let prev = 0;
    for (const c of [...cuts, stream.length]) {
      got.push(...sc.feed(stream.subarray(prev, c)));
      prev = c;
    }
    const where = `cut at ${cuts.slice(0, 3).join(",")}${cuts.length > 3 ? "…" : ""}`;
    assert.deepEqual(segs(got), want, `${where}: segments`);
    assert.equal(bin(sc.holding), wantHeld, `${where}: held`);
    assert.deepEqual(segs(sc.flush()), wantFlush, `${where}: flush`);
    assert.equal(sc.invalid, v.invalid ?? 0, `${where}: invalid`);
  }
});

// --- detect ------------------------------------------------------------------

sections("detect", (v) => {
  const det = new hotty.Detector({ n: v.n ?? 1, late: v.late ?? false });
  const dec = new hotty.Decoder();
  v.steps.forEach((st: Any, i: number) => {
    const at: number = st.at;
    let took: boolean | null = null;
    if (st.start) det.start(at);
    else if (st.da1) took = det.da1(at);
    else if (st.osc !== undefined) {
      const f = dec.feed(st.osc);
      const r = f.result === "complete" ? f.message.reply() : undefined;
      took = r ? det.reply(r, at) : false;
    } else if (st.tick) det.tick(at);
    else if (st.end) det.end(at);
    const got: Record<string, unknown> = { took, state: det.state, decided: det.decided, done: det.done, deadline: nul(det.deadline) };
    for (const k of ["took", "state", "decided", "done", "deadline"]) {
      if (k in st) assert.equal(got[k], st[k], `step ${i} (at ${at}): ${k}`);
    }
  });
  if (v.caps) {
    assert.ok(det.caps, "no caps");
    match({ v: nul(det.caps.v) }, v.caps, "caps");
  }
});

// --- keys, keymap, edit ------------------------------------------------------

sections("keys", (v) => {
  if ("input" in v) assert.deepEqual(hotty.decodeKeys(v.input).map(nul), v.keys);
  else assert.equal(nul(hotty.parseKey(v.key)), v.canon);
});

sections("keymap", (v) => {
  if ("program" in v || "scroll" in v) {
    // An element's keymap outside a text field: no default keymap.
    const m = hotty.parseKeymap(v.keys.join(" "));
    for (const [key, want] of Object.entries(v.program ?? {})) assert.equal(m.program(key), want, key);
    for (const [key, want] of Object.entries(v.scroll ?? {})) assert.equal(nul(m.scroll(key)), want, key);
    return;
  }
  if (!("lookup" in v)) {
    assert.equal(hotty.parseKeymap(v.parse ?? hotty.TERMINAL_KEYS).format(), v.format);
    return;
  }
  const m = hotty.resolve(v.multiline, ...(v.terminal_keys ? [hotty.TERMINAL_KEYS] : []), ...v.keys);
  for (const [key, want] of Object.entries(v.lookup)) assert.equal(nul(m.lookup(key)), want, key);
});

sections("edit", (v) => {
  const f = new Field(v.field);
  v.steps.forEach((st: Any, i: number) => {
    const changed = "do" in st ? f.do(st.do) : f.type(st.type);
    const got: Record<string, unknown> = { value: f.value, caret: f.caret, changed };
    for (const k of ["value", "caret", "changed"]) {
      if (k in st) assert.deepEqual(got[k], st[k], `step ${i} (${st.do ?? JSON.stringify(st.type)}): ${k}`);
    }
  });
});
