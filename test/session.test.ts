// The Session (SDK.md §4.3) against the test host. An adapter's frame is
// the framework's bytes, watched on their way out, then what flush
// returns, in one write.

import assert from "node:assert/strict";

import { doc, SCROLL_VERTICAL, Scanner, setText } from "../src/index.ts";
import { Link } from "../src/link.ts";
import { Session, type SessionMessage, type Want } from "../src/session.ts";
import { Terminal } from "../src/terminal.ts";
import { Host, type HostOptions } from "../src/test/index.ts";
import { FakeClock, settle } from "./clock.ts";
import { describe, test } from "./harness.ts";

const bin = (b: Uint8Array) => String.fromCharCode(...b);

function setup(opts: HostOptions = {}, limit?: number) {
  const h = new Host(opts);
  const clock = new FakeClock();
  const t = new Terminal({ input: h, output: h, name: "app", size: () => h, clock });
  const msgs: SessionMessage[] = [];
  const s = new Session({ link: t, onMessage: (m) => msgs.push(m), limit });
  const frame = (cells = "") => {
    s.watch(cells);
    h.write(cells + s.flush());
  };
  // The messages since the last call, as kinds.
  const kinds = () => msgs.splice(0).map((m) => m.kind);
  return { h, t, s, clock, msgs, frame, kinds };
}

async function ready(opts: HostOptions = {}, limit?: number) {
  const st = setup(opts, limit);
  st.s.detect();
  await st.t.detect();
  await settle();
  return st;
}

const card = (name: string, x: number, y: number, more: Partial<Want> = {}): Want => ({
  name,
  rect: { x, y, w: 10, h: 2 },
  doc: () => `<p id=t>${name}</p>`,
  ...more,
});

const names = (h: Host) => h.surfaces().map((x) => x.name);

describe("Session", () => {
  test("ready when detection decides; a document once, and a placement where the surface is", async () => {
    const { h, s, msgs, frame } = await ready();
    assert.deepEqual(msgs.splice(0), [{ kind: "ready", mode: "native", caps: s.caps }]);
    assert.equal(s.mode, "native");
    assert.equal(s.caps?.host, "hotty-ts-test");
    s.layout([card("a", 3, 4)]);
    frame();
    const a = h.surface("a")!;
    assert.ok(a.placed && !a.detached);
    assert.equal(a.textOf("t"), "a");
    assert.deepEqual([a.col, a.row, a.placement.cols, a.placement.rows], [3, 4, 10, 2]);
    assert.deepEqual(h.cursor(), { col: 0, row: 0, shown: true }, "the cursor is where the frame left it");
    s.layout([card("a", 3, 4)]);
    assert.equal(s.flush(), "", "an unchanged layout sends nothing");
    assert.deepEqual(s.counts, { docs: 1, places: 1, hides: 0, deletes: 0, relayouts: 0 });
    assert.deepEqual(h.errors(), []);
  });

  test("a moved surface is placed again; a clipped one shows the window inside; one clipped to nothing goes", async () => {
    const { h, s, frame } = await ready();
    s.layout([card("a", 0, 0)]);
    frame();
    s.layout([card("a", 0, 5)]);
    frame();
    assert.equal(h.surface("a")!.row, 5);
    s.layout([card("a", 0, 5, { z: 1, press: true })]);
    frame();
    assert.deepEqual([h.surface("a")!.placement.z, h.surface("a")!.placement.press], [1, true], "options changed: placed again");
    // Half scrolled out of a region from row 2 to row 9: its bottom row shows.
    const region = { x: 0, y: 2, w: 80, h: 8 };
    s.layout([card("a", 0, 1, { clip: region })]);
    frame();
    const a = h.surface("a")!;
    assert.equal(a.row, 2);
    assert.deepEqual(a.placement.window, { x: 0, y: 1, w: 10, h: 1 });
    s.layout([card("a", 0, -5, { clip: region })]);
    frame();
    assert.equal(h.surface("a"), undefined, "out of view and not kept: deleted");
    assert.deepEqual(s.counts, { docs: 1, places: 4, hides: 0, deletes: 1, relayouts: 0 });
  });

  test("a kept surface is hidden, takes deltas, and is placed again without its document", async () => {
    const { h, s, frame } = await ready();
    s.layout([card("k", 0, 0, { keep: true })]);
    frame();
    s.layout([]);
    frame();
    assert.equal(h.surface("k")!.placed, false);
    assert.ok(s.has("k") && !s.placed("k"));
    s.send(setText("k", "t", "changed"));
    s.layout([card("k", 0, 0, { keep: true })]);
    frame();
    assert.ok(h.surface("k")!.placed);
    assert.equal(h.surface("k")!.textOf("t"), "changed");
    assert.deepEqual(s.counts, { docs: 1, places: 2, hides: 1, deletes: 0, relayouts: 0 });
    s.delete("k");
    frame();
    assert.equal(h.surface("k"), undefined, "delete: kept or not");
  });

  test("a scrolling surface asks the host with its document; another scroll sends the document again", async () => {
    const { h, s, frame } = await ready();
    let built = 0;
    const want = (scroll?: number) => card("x", 0, 1, { scroll, doc: () => `<p id=t>${++built}</p>` });
    s.layout([want(SCROLL_VERTICAL)]);
    frame();
    const x = h.surface("x")!;
    assert.ok(x.placed);
    assert.equal(x.scroll, SCROLL_VERTICAL);
    s.layout([want(SCROLL_VERTICAL)]);
    assert.equal(s.flush(), "", "an unchanged layout sends nothing");
    // The axes are the document's: another value sends it again, and the
    // placement stays.
    s.layout([want()]);
    const out = s.flush();
    assert.ok(out.includes("a=doc") && !out.includes("scroll=") && !out.includes("a=place"), out);
    h.write(out);
    assert.ok(h.surface("x")!.placed);
    assert.deepEqual([h.surface("x")!.scroll, h.surface("x")!.textOf("t")], [0, "2"]);
    assert.equal(built, 2);
    assert.deepEqual(s.counts, { docs: 2, places: 1, hides: 0, deletes: 0, relayouts: 0 });
    assert.deepEqual(h.errors(), []);
  });

  test("in a terminal that is not a host it is text, and sends nothing", async () => {
    const { h, s, msgs, clock, frame } = setup({ text: true });
    s.detect();
    assert.equal(s.mode, "detecting");
    await clock.advance(150); // the DA1 came alone: decided after the grace
    assert.deepEqual(msgs, [{ kind: "ready", mode: "text" }]);
    s.layout([card("a", 0, 0)]);
    s.send(setText("a", "t", "x"));
    s.ping();
    assert.equal(s.flush(), "\x1b[c", "a ping still goes: DA1 is every terminal's");
    frame("cells");
    assert.equal(h.commands().length, 1, "only the query");
    assert.deepEqual(h.errors(), []);
  });

  test("relayout after the framework erases, scrolls, sets a region, leaves the alternate screen or resets", async () => {
    const { s, frame, kinds } = await ready();
    kinds();
    const seqs = ["\x1b[2J", "\x1b[3J", "\x1b[S", "\x1b[2T", "\x1b[L", "\x1b[3M", "\x1b[3;20r", "\x1bM", "\x1b[?1049l", "\x1b[?1047l", "\x1b[?47l", "\x1bc"];
    for (const seq of seqs) {
      s.layout([card("a", 0, 0)]);
      frame();
      s.watch("text" + seq + "more");
      assert.ok(s.placed("a"), "not from inside the framework's write");
      await settle();
      assert.deepEqual(kinds(), ["relayout"], JSON.stringify(seq));
      assert.equal(s.placed("a"), false);
    }
    assert.equal(s.counts.relayouts, seqs.length);
    // Not these; and a sequence split between writes when it is whole.
    s.layout([card("a", 0, 0)]);
    frame();
    for (const seq of ["\x1b[J", "\x1b[1J", "\x1b[H", "\x1b[?2026h\x1b[?2026l", "\x1b[?1049h", "\x1b]0;\x1b[2J\x07", "\x1bP\x1b[S\x1b\\", "\x1b["]) s.watch(seq);
    s.watch("2");
    await settle();
    assert.deepEqual(kinds(), []);
    s.watch("J");
    await settle();
    assert.deepEqual(kinds(), ["relayout"]);
    // Several in one write, or one with nothing on screen: one relayout, or none.
    s.layout([card("a", 0, 0)]);
    frame();
    s.watch("\x1b[2J\x1b[S");
    s.relayout();
    await settle();
    assert.deepEqual(kinds(), ["relayout"]);
    s.relayout();
    await settle();
    assert.deepEqual(kinds(), []);
    assert.ok(s.watched > 0);
  });

  test("after a full reset, the next layout sends the documents again", async () => {
    const { h, s, frame, kinds } = await ready();
    s.layout([card("a", 0, 0), card("k", 0, 2, { keep: true })]);
    frame();
    s.layout([card("a", 0, 0)]);
    frame();
    kinds();
    frame("\x1bc");
    await settle();
    assert.deepEqual(kinds(), ["relayout"]);
    assert.deepEqual(names(h), []);
    assert.equal(s.has("k"), false, "hidden ones went too");
    s.layout([card("a", 0, 0), card("k", 0, 2, { keep: true })]);
    frame();
    await settle();
    assert.deepEqual(names(h), ["a", "k"]);
    assert.ok(h.surface("a")!.placed && h.surface("k")!.placed);
    assert.deepEqual(kinds(), [], "no error");
    assert.equal(s.counts.docs, 4);
  });

  test("a document the host lost answers its placement with ENOENT, and is sent again", async () => {
    const { h, s, frame, kinds } = await ready();
    frame("\x1b[?1049h\x1b[H\x1b[2J");
    s.layout([card("a", 0, 0)]);
    frame();
    kinds();
    // Leaving the alternate screen takes the placements made there, and
    // this host deletes their surfaces too (SPEC §5.4, SHOULD).
    frame("\x1b[?1049l");
    await settle();
    assert.deepEqual(kinds(), ["relayout"]);
    assert.equal(h.surface("a"), undefined);
    s.layout([card("a", 0, 0)]);
    frame();
    await settle();
    assert.deepEqual(kinds(), ["relayout"], "the ENOENT, as a relayout");
    assert.equal(s.has("a"), false);
    s.layout([card("a", 0, 0)]);
    frame();
    assert.ok(h.surface("a")?.placed);
    assert.equal(s.counts.docs, 2);
  });

  test("limits: the Session's own makes room; the host's makes a surface wait for room", async () => {
    const own = await ready({}, 2);
    own.s.layout([card("a", 0, 0), card("b", 0, 2)]);
    own.frame();
    own.s.layout([card("b", 0, 2)]);
    own.frame();
    own.s.layout([card("c", 0, 4, { keep: true })]);
    own.frame();
    assert.deepEqual(names(own.h), ["c"], "a was deleted when it went, b to make room for c");
    // The host holds two: the third waits until one goes.
    const { h, s, frame } = await ready({ caps: { limits: { surfaces: 2 } } });
    s.layout([card("a", 0, 0, { keep: true }), card("b", 0, 2), card("c", 0, 4)]);
    frame();
    assert.deepEqual(names(h), ["a", "b"]);
    assert.equal(s.has("c"), false);
    s.layout([card("b", 0, 2), card("c", 0, 4)]);
    frame();
    assert.deepEqual(names(h), ["b", "c"], "the hidden one made room");
    assert.deepEqual(h.errors(), []);
  });

  test("an EQUOTA teaches the Session the host's limit", async () => {
    const { h, s, frame, kinds } = await ready();
    h.write(doc("theirs-1", "<p>x</p>") + doc("theirs-2", "<p>x</p>"));
    // A host that counts surfaces the Session did not send: it holds 64,
    // and 62 are left.
    for (let i = 3; i <= 62; i++) h.write(doc(`theirs-${i}`, "<p>x</p>"));
    kinds();
    s.limit = 64;
    s.layout([card("a", 0, 0), card("b", 0, 2), card("c", 0, 4)]);
    frame();
    await settle();
    assert.deepEqual(kinds(), ["relayout"], "the EQUOTA, as a relayout; the placement's ENOENT is the Session's");
    assert.equal(s.has("c"), false);
    s.layout([card("a", 0, 0), card("b", 0, 2), card("c", 0, 4)]);
    frame();
    await settle();
    assert.deepEqual(kinds(), [], "the third waits");
    assert.equal(s.flush(), "");
    s.layout([card("b", 0, 2), card("c", 0, 4)]);
    frame();
    assert.ok(h.surface("c")?.placed);
  });

  test("events, acks, errors and other input come back as messages, in order", async () => {
    const { h, s, frame, msgs } = await ready();
    msgs.length = 0;
    s.layout([{ name: "f", rect: { x: 0, y: 0, w: 10, h: 2 }, doc: () => "<button id=go>Go</button><p id=t>x</p>" }]);
    frame();
    h.click("f", "go");
    s.send(setText("f", "t", "y", { n: 7 }), setText("f", "missing", "y", { q: 1 }), setText("f", "t", "z", { q: 1 }));
    frame();
    h.type("k");
    await settle();
    const got = msgs.map((m) => {
      if (m.kind === "event") return `event ${m.event.kind} ${m.event.target}`;
      if (m.kind === "ack") return `ack ${m.reply.re} ${m.reply.n}`;
      if (m.kind === "error") return `error ${m.reply.code}`;
      if (m.kind === "input") return `input ${bin(m.data)}`;
      return m.kind;
    });
    assert.deepEqual(got, ["event focus ", "event click go", "ack delta 7", "error ENOTARGET", "input k"]);
    assert.equal(h.surface("f")!.textOf("t"), "z");
  });

  test("ping: a pong once the terminal took the frame before it, or after 100 ms without one", async () => {
    const { s, h, frame, kinds, clock } = await ready();
    kinds();
    s.ping();
    s.ping(); // one at a time
    s.layout([card("a", 0, 0)]);
    const out = s.flush();
    assert.ok(out.endsWith("\x1b[c") && out.indexOf("\x1b[c") === out.length - 3, "the DA1 after the frame's commands");
    h.write(out);
    await settle();
    assert.deepEqual(kinds(), ["pong"]);
    s.ping();
    await clock.advance(99);
    assert.deepEqual(kinds(), []);
    await clock.advance(1);
    assert.deepEqual(kinds(), ["pong"]);
    s.ping();
    frame();
    await clock.advance(100);
    assert.deepEqual(kinds(), ["pong"], "a ping goes once");
  });

  test("close deletes the Session's surfaces and no one else's, and ends it", async () => {
    const { h, s, frame } = await ready();
    s.layout([card("a", 0, 0), card("k", 0, 2, { keep: true })]);
    frame();
    s.layout([card("a", 0, 0)]);
    frame();
    h.write(doc("theirs", "<p>not the Session's</p>"));
    h.write(s.close());
    assert.deepEqual(names(h), ["theirs"]);
    s.layout([card("a", 0, 0)]);
    s.send(setText("a", "t", "x"));
    assert.equal(s.flush(), "", "a frame drawn after close sends nothing");
  });

  test("detachAll detaches the Session's surfaces, to leave them on the screen", async () => {
    const { h, s, frame } = await ready();
    s.layout([card("a", 0, 0), card("b", 0, 2)]);
    frame();
    s.detachAll();
    frame();
    assert.ok(h.surface("a")!.detached && h.surface("b")!.detached && h.surface("a")!.placed);
  });
});

// A framework that parses its own input (SDK.md §4.2): it hands the link
// each HOTTY sequence without its terminator, eats DA1, and writes what
// the Session returns between its frames.
describe("Session on a link a framework feeds", () => {
  function pushed() {
    const h = new Host();
    const clock = new FakeClock();
    const sc = new Scanner({ da1: true });
    const kept: string[] = []; // what the framework kept: its keys, the DA1s it ate
    const pump = () => {
      for (const seg of sc.feed(h.take())) {
        if (seg.kind === "osc") link.osc(bin(seg.data).replace(/(\x1b\\|\x07)$/, ""));
        else kept.push(bin(seg.data));
      }
    };
    const link: Link = new Link({ write: (x) => h.write(x), clock });
    const msgs: SessionMessage[] = [];
    const s = new Session({ link, onMessage: (m) => msgs.push(m) });
    return { h, clock, link, s, msgs, pump, kept };
  }

  test("ready when the reply arrives; layout, events and pongs work the same", async () => {
    const { h, clock, link, s, msgs, pump, kept } = pushed();
    s.detect();
    pump();
    await settle();
    assert.equal(msgs.shift()?.kind, "ready");
    assert.equal(s.mode, "native");
    assert.deepEqual(kept, ["\x1b[?62;22c"], "the framework ate the DA1");
    s.layout([{ name: "f", rect: { x: 1, y: 1, w: 8, h: 1 }, doc: () => "<button id=go>Go</button>" }]);
    link.send(s.flush());
    assert.ok(h.surface("f")?.placed);
    h.click("f", "go");
    h.type("q");
    pump();
    await settle();
    assert.deepEqual(
      msgs.splice(0).map((m) => (m.kind === "event" ? m.event.kind : m.kind)),
      ["focus", "click"],
    );
    assert.deepEqual(kept.slice(1), ["q"], "keys are the framework's");
    // A pong measures the round trip: the answer comes 7 ms later. Here the
    // framework hands the DA1 over, once detection is done (300 ms after
    // the reply; a DA1 before that is detection's).
    await clock.advance(300);
    s.ping();
    link.send(s.flush());
    clock.t += 7;
    for (const seg of new Scanner({ da1: true }).feed(h.take())) if (seg.kind === "da1") link.da1();
    await settle();
    assert.deepEqual(msgs, [{ kind: "pong", took: 7 }]);
  });
});
