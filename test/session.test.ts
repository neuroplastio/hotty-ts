// The Session (SDK.md §4.3) against the test host. An adapter's frame is
// the framework's bytes, watched on their way out, then what flush
// returns, in one write.

import assert from "node:assert/strict";

import { doc, encode, res, SCROLL_VERTICAL, Scanner, setText } from "../src/index.ts";
import { Link } from "../src/link.ts";
import { pack } from "../src/msgpack.ts";
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

// A Session native from the start, on a link with no host behind it: the
// test hands it the host's answers, each returning the messages it gave.
async function bare() {
  const clock = new FakeClock();
  const link = new Link({ write: () => {}, known: { native: true }, clock });
  const msgs: SessionMessage[] = [];
  const s = new Session({ link, onMessage: (m) => msgs.push(m) });
  s.detect();
  await settle();
  msgs.length = 0;
  const answer = async (wire: string) => {
    link.bytes(wire);
    await settle();
    return msgs.splice(0);
  };
  // The host's ENOENT for a placement of a surface it does not have.
  const gone = (name: string) => answer(encode([["a", "err"], ["s", name], ["re", "place"]], pack({ code: "ENOENT", detail: `no surface ${name}` })));
  // The host's answer to the document in out that marks a loss.
  const marked = (out: string) => {
    const [, name, n] = /a=doc:s=([^:;]+)[^;]*:n=(\d+)/.exec(out) ?? [];
    assert.ok(name && n, `no document numbered: ${out}`);
    return answer(encode([["a", "ok"], ["n", n], ["s", name], ["re", "doc"]]));
  };
  return { clock, s, msgs, gone, marked };
}

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
    assert.deepEqual([h.surface("a")!.placement.z, h.surface("a")!.press], [1, true], "options changed: placed again");
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

  test("press, fit and hover belong to the surface: a placement sends one when it turns on or off, and none when it is as it was (SPEC §5.2)", async () => {
    const { h, s, frame } = await ready();
    const flags = () =>
      h.commands().filter((m) => m.get("a") === "place").map((m) => [m.get("p") ?? null, m.get("f") ?? null, m.get("v") ?? null]);
    s.layout([card("a", 0, 0, { press: true })]);
    frame();
    s.layout([card("a", 0, 2, { press: true })]);
    frame();
    s.layout([card("a", 0, 2, { press: false, hover: true, fit: true })]);
    frame();
    s.layout([card("a", 0, 4, { hover: true })]);
    frame();
    assert.deepEqual(flags(), [
      ["1", null, null], // on
      [null, null, null], // moved: as it was
      ["0", "1", "1"], // press off, fit and hover on
      [null, "0", null], // fit off; hover stays
    ]);
    assert.deepEqual([h.surface("a")!.press, h.surface("a")!.fit, h.surface("a")!.hover], [false, false, true]);
    // A surface deleted and sent again starts from none.
    s.delete("a");
    s.layout([card("a", 0, 4, { hover: true })]);
    frame();
    assert.deepEqual(flags().at(-1), [null, null, "1"]);
    assert.equal(h.surface("a")!.hover, true);
    assert.deepEqual(h.errors(), []);
  });

  test("the caps events keep the Session's capabilities current, and still reach the program (SPEC §4)", async () => {
    const { h, s, t, msgs } = await ready();
    msgs.splice(0);
    h.change((c) => {
      c.mod = "Meta";
      c.cellcss = { w: 10, h: 20 };
    });
    await settle();
    assert.deepEqual([s.caps?.mod, s.caps?.cellCss, t.caps?.mod], ["Meta", { w: 10, h: 20 }, "Meta"]);
    const ev = msgs.find((m) => m.kind === "event");
    assert.equal(ev?.kind === "event" && ev.event.kind, "caps");
    assert.equal(s.caps?.host, "hotty-ts-test", "what did not change stays");
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

  test("with late, a late answer makes a text Session native: ready again, then relayout (SPEC §4)", async () => {
    const h = new Host({ text: true });
    const clock = new FakeClock();
    const t = new Terminal({ input: h, output: h, name: "app", size: () => h, clock });
    const msgs: SessionMessage[] = [];
    const s = new Session({ link: t, onMessage: (m) => msgs.push(m), late: true });
    s.detect();
    await clock.advance(150);
    assert.deepEqual(msgs.splice(0), [{ kind: "ready", mode: "text" }]);
    assert.equal(h.commands()[0]!.get("late"), "1", "the query asks for a late answer");
    h.becomeHost(); // a terminal that is a host attaches
    await settle();
    assert.equal(s.mode, "native");
    assert.equal(s.caps?.host, "hotty-ts-test");
    assert.deepEqual(
      msgs.splice(0).map((m) => m.kind),
      ["ready", "relayout"],
    );
    assert.equal(await t.detect(), true, "detect answers with the late answer");
    s.layout([card("a", 0, 0)]);
    h.write(s.flush());
    assert.ok(h.surface("a")?.placed);
    assert.equal(s.close().includes("a=q"), false, "answered: nothing to withdraw");
    assert.deepEqual(h.errors(), []);
  });

  test("with late and no answer, close withdraws the query, and a host that attaches after answers nothing (SPEC §4)", async () => {
    const h = new Host({ text: true });
    const clock = new FakeClock();
    const t = new Terminal({ input: h, output: h, name: "app", size: () => h, clock });
    const msgs: SessionMessage[] = [];
    const s = new Session({ link: t, onMessage: (m) => msgs.push(m), late: true });
    s.detect();
    await clock.advance(150);
    h.write(s.close());
    const q = h.commands().at(-1)!;
    assert.deepEqual([q.get("a"), q.get("q"), q.get("late")], ["q", "2", undefined], "a=q:q=2 takes the held query's place");
    h.becomeHost();
    await settle();
    assert.equal(h.replies().length, 0, "the withdrawn query is not answered");
    assert.equal(s.mode, "text");
  });

  test("a host of another version is text at once; with late, a reply of this version after it is the late answer, even in the same read (SPEC §4)", async () => {
    const answer = (a: string, body: object) => encode([["a", a], ["n", 1], ["re", "q"]], pack(body));
    const eversion = answer("err", { code: "EVERSION", detail: "0.5" });
    for (const late of [false, true]) {
      const link = new Link({ write: () => {}, clock: new FakeClock() });
      const msgs: SessionMessage[] = [];
      const s = new Session({ link, onMessage: (m) => msgs.push(m), late });
      s.detect();
      link.bytes(eversion + answer("ok", { v: "0.5", host: "later" }));
      await settle();
      if (!late) {
        assert.deepEqual(msgs, [{ kind: "ready", mode: "text" }], "without late: text, and the host's reply changes nothing");
        continue;
      }
      assert.equal(s.mode, "native");
      assert.equal(s.caps?.host, "later");
      assert.deepEqual(
        msgs.map((m) => m.kind),
        ["ready", "relayout"],
        "with late: ready native, once",
      );
    }
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
    const { s, frame, kinds, msgs } = await ready();
    kinds();
    const seqs = ["\x1b[2J", "\x1b[3J", "\x1b[S", "\x1b[2T", "\x1b[L", "\x1b[3M", "\x1b[3;20r", "\x1bM", "\x1b[?1049l", "\x1b[?1047l", "\x1b[?47l", "\x1bc"];
    for (const seq of seqs) {
      s.layout([card("a", 0, 0)]);
      frame();
      s.watch("text" + seq + "more");
      assert.ok(s.placed("a"), "not from inside the framework's write");
      await settle();
      // The host keeps its documents through all but a full reset.
      assert.deepEqual(msgs.splice(0), [{ kind: "relayout", lost: seq === "\x1bc" }], JSON.stringify(seq));
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
    const { h, s, frame, kinds, msgs } = await ready();
    s.layout([card("a", 0, 0), card("k", 0, 2, { keep: true })]);
    frame();
    s.layout([card("a", 0, 0)]);
    frame();
    kinds();
    // The frame that resets moves a: its placement goes out behind the
    // reset, and its ENOENT is the reset's loss.
    s.layout([card("a", 0, 1)]);
    frame("\x1bc");
    await settle();
    assert.deepEqual(msgs.splice(0), [{ kind: "relayout", lost: true }], "the reset ended the session: the resources went too");
    assert.deepEqual(names(h), []);
    assert.equal(s.has("k"), false, "hidden ones went too");
    s.layout([card("a", 0, 0), card("k", 0, 2, { keep: true })]);
    frame();
    await settle();
    assert.deepEqual(names(h), ["a", "k"]);
    assert.ok(h.surface("a")!.placed && h.surface("k")!.placed);
    const marks = h.commands().filter((m) => m.get("a") === "doc" && m.get("n") !== undefined);
    assert.equal(marks.length, 1, "the first document sent again marks the loss");
    assert.deepEqual(kinds(), [], "no error, and the mark's ok is the Session's");
    assert.equal(s.counts.docs, 4);
    // With only a hidden one, nothing is on screen, and the loss is still
    // told; with no document, there is none.
    s.layout([card("k", 0, 2, { keep: true })]);
    frame();
    s.layout([]);
    frame();
    kinds();
    frame("\x1bc");
    await settle();
    assert.deepEqual(msgs.splice(0), [{ kind: "relayout", lost: true }]);
    frame("\x1bc");
    await settle();
    assert.deepEqual(kinds(), []);
  });

  test("a document the host lost answers its placement with ENOENT, and is sent again", async () => {
    const { h, s, frame, kinds, msgs } = await ready();
    frame("\x1b[?1049h\x1b[H\x1b[2J");
    s.layout([card("a", 0, 0)]);
    frame();
    kinds();
    // Leaving the alternate screen takes the placements made there, and
    // this host deletes their surfaces too (SPEC §5.4, SHOULD).
    frame("\x1b[?1049l");
    await settle();
    assert.deepEqual(msgs.splice(0), [{ kind: "relayout", lost: false }]);
    assert.equal(h.surface("a"), undefined);
    s.layout([card("a", 0, 0)]);
    frame();
    await settle();
    assert.deepEqual(msgs.splice(0), [{ kind: "relayout", lost: true }], "the ENOENT, as a relayout that says the host lost it");
    assert.equal(s.has("a"), false);
    s.layout([card("a", 0, 0)]);
    frame();
    assert.ok(h.surface("a")?.placed);
    assert.equal(s.counts.docs, 2);
  });

  // A host that loses its documents loses them all at once, and the program
  // sends its resources again once: the first ENOENT reports the loss, and
  // every document goes again, the first numbered. An ENOENT read before
  // that one's answer is for a placement sent before it: the same loss's.
  test("a loss is told once, however many documents it took", async () => {
    const { s, msgs, gone, marked } = await bare();
    const want = ["a", "b", "c"].map((name, i) => card(name, 0, i * 2));
    s.layout(want);
    s.flush();
    assert.deepEqual(await gone("a"), [{ kind: "relayout", lost: true }], "the first ENOENT");
    assert.deepEqual(await gone("b"), [], "b's ENOENT before the documents went again");
    s.layout(want);
    const out = s.flush();
    for (const name of ["a", "b", "c"]) assert.ok(out.includes(`a=doc:s=${name}`), `${name} not sent again: ${out}`);
    assert.ok(out.split(":n=").length === 2 && out.includes("a=doc:s=a:n="), `one document numbered, the first: ${out}`);
    assert.deepEqual(await gone("c"), [], "c's ENOENT before the mark's answer");
    assert.deepEqual(await marked(out), [], "the mark's answer is the Session's");
    // The placements after the erase went after the mark: a loss of its own.
    s.watch("\x1b[2J");
    await settle();
    assert.deepEqual(msgs.splice(0), [{ kind: "relayout", lost: false }], "the erase");
    s.layout(want);
    assert.equal(s.flush().split("a=place").length - 1, 3, "all three placed again");
    assert.deepEqual(await gone("b"), [{ kind: "relayout", lost: true }], "a second loss");
    assert.deepEqual(await gone("a"), [], "a's ENOENT in the second loss");
  });

  // Two frames in flight when the host loses its documents (margin's case,
  // behind a relay): the second frame's ENOENTs come after the documents
  // went again, and before the mark's answer, so they are still the first
  // loss's.
  test("a loss behind two frames in flight is told once", async () => {
    const { s, gone, marked } = await bare();
    const at = (y: number) => [card("a", 0, y), card("b", 0, y + 2)];
    s.layout(at(0));
    s.flush();
    s.layout(at(1));
    assert.equal(s.flush().split("a=place").length - 1, 2, "the second frame");
    assert.deepEqual(await gone("a"), [{ kind: "relayout", lost: true }], "the first ENOENT");
    assert.deepEqual(await gone("b"), [], "b's first ENOENT");
    s.layout(at(1));
    const out = s.flush();
    for (const name of ["a", "b"]) assert.deepEqual(await gone(name), [], `${name}'s second ENOENT`);
    await marked(out);
    assert.deepEqual(await gone("a"), [{ kind: "relayout", lost: true }], "an ENOENT after the mark's answer");
  });

  // A mark whose answer never comes (the host that would have sent it went
  // away) holds for 3 s; an ENOENT after that is a loss again.
  test("a mark whose answer never comes holds for 3 s", async () => {
    const { s, clock, gone } = await bare();
    const want = [card("a", 0, 0)];
    s.layout(want);
    s.flush();
    await gone("a");
    s.layout(want);
    s.flush();
    assert.deepEqual(await gone("a"), [], "an ENOENT inside the mark");
    clock.t += 2999;
    assert.deepEqual(await gone("a"), [], "an ENOENT just inside it");
    clock.t += 1;
    assert.deepEqual(await gone("a"), [{ kind: "relayout", lost: true }], "an ENOENT past the mark");
  });

  // A mark answered after it timed out, once a second loss has a mark of its
  // own: still the Session's, never an ack, and the second mark holds until
  // its own answer.
  test("an old mark answered late is the Session's", async () => {
    const { s, clock, gone, marked } = await bare();
    const want = [card("a", 0, 0)];
    s.layout(want);
    s.flush();
    await gone("a");
    s.layout(want);
    const first = s.flush();
    clock.t += 3000;
    assert.deepEqual(await gone("a"), [{ kind: "relayout", lost: true }], "an ENOENT past the first mark");
    s.layout(want);
    const second = s.flush();
    assert.notEqual(/:n=(\d+)/.exec(first)?.[1], /:n=(\d+)/.exec(second)?.[1], "two marks");
    assert.deepEqual(await marked(first), [], "the first mark's late answer");
    assert.deepEqual(await gone("a"), [], "an ENOENT inside the second mark");
    assert.deepEqual(await marked(second), [], "the second mark's answer");
    assert.deepEqual(await gone("a"), [{ kind: "relayout", lost: true }], "an ENOENT after it");
  });

  // A hidden surface brought back after a loss goes with its document, rather
  // than finding it gone and reporting the loss again.
  test("a hidden surface goes with its document after a loss", async () => {
    const { s, gone } = await bare();
    const a = card("a", 0, 0);
    const b = card("b", 0, 2, { keep: true });
    s.layout([a, b]);
    s.flush();
    s.layout([a]);
    assert.ok(s.flush().includes("a=hide:s=b"), "b hidden");
    assert.deepEqual(await gone("a"), [{ kind: "relayout", lost: true }], "a's ENOENT");
    assert.equal(s.has("b"), false, "b's document is taken as lost");
    s.layout([a, b]);
    const out = s.flush();
    assert.ok(out.includes("a=doc:s=a") && out.includes("a=doc:s=b"), out);
  });

  // The host loses every document and resource behind the program's back,
  // as one that restarts behind a relay does. The program's renderer erases
  // the screen, which asks for a plain relayout; the card's placement then
  // finds the card gone, and the program hears of the loss once, sends its
  // stylesheet again, and the card follows it.
  test("a program on a host that lost its documents sends its resources again, once, ahead of them", async () => {
    const h = new Host();
    const t = new Terminal({ input: h, output: h, name: "app", size: () => h, clock: new FakeClock() });
    const seen: SessionMessage[] = [];
    const style = res("app-css", "text/css", "p { color: teal }"); // a resource sent once (SPEC §7.1)
    let erase = false;
    const draw = () => {
      s.layout([{ name: "card", rect: { x: 2, y: 1, w: 20, h: 3 }, doc: () => `<link rel="stylesheet" href="cid:app-css"><p id=t>card</p>` }]);
      const cells = erase ? "\x1b[2J" : "";
      erase = false;
      s.watch(cells);
      h.write(cells + s.flush());
    };
    const s: Session = new Session({
      link: t,
      onMessage: (m) => {
        seen.push(m);
        if (m.kind === "ready") s.send(style); // nothing unless the terminal is a host
        if (m.kind === "relayout" && m.lost) s.send(style); // ahead of the card, which goes with the frame
        if (m.kind === "ready" || m.kind === "relayout") draw();
      },
    });
    s.detect();
    await t.detect();
    await settle();
    assert.ok(h.surface("card")?.placed, "the card is placed");
    assert.ok(h.resource("app-css"), "the stylesheet is there");
    seen.length = 0;
    h.forget();
    const before = h.commands().length;
    erase = true;
    draw(); // the renderer repaints
    await settle();
    assert.deepEqual(
      seen.filter((m) => m.kind === "relayout"),
      [
        { kind: "relayout", lost: false }, // the erase lost nothing
        { kind: "relayout", lost: true }, // the placement found the card gone
      ],
    );
    assert.ok(h.surface("card")?.placed, "the card is back");
    assert.ok(h.resource("app-css"), "the stylesheet was sent again");
    assert.deepEqual(
      h.commands().slice(before).map((m) => m.get("a")),
      ["place", "res", "doc", "place"],
      "the placement that found the loss, the stylesheet, the card",
    );
    assert.deepEqual(h.errors(), []);
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
    const { h, s, frame, kinds, msgs } = await ready();
    h.write(doc("theirs-1", "<p>x</p>") + doc("theirs-2", "<p>x</p>"));
    // A host that counts surfaces the Session did not send: it holds 64,
    // and 62 are left.
    for (let i = 3; i <= 62; i++) h.write(doc(`theirs-${i}`, "<p>x</p>"));
    kinds();
    s.limit = 64;
    s.layout([card("a", 0, 0), card("b", 0, 2), card("c", 0, 4)]);
    frame();
    await settle();
    assert.deepEqual(msgs.splice(0), [{ kind: "relayout", lost: false }], "the EQUOTA, as a relayout; the placement's ENOENT is the Session's");
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
    assert.deepEqual(got, ["event focus go", "event click go", "ack delta 7", "error ENOTARGET", "input k"]);
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
// each hotty sequence without its terminator, eats DA1, and writes what
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
