// The Terminal (SDK.md §4.1) against the test host, over its streams.

import assert from "node:assert/strict";

import { doc, placeAt, setText } from "../src/index.ts";
import { Host, type HostOptions } from "../src/test/index.ts";
import { type Input, NoAnswerError, Terminal } from "../src/terminal.ts";
import { FakeClock, settle } from "./clock.ts";
import { describe, test } from "./harness.ts";

function setup(opts: HostOptions = {}, known?: { native: boolean }) {
  const h = new Host(opts);
  const clock = new FakeClock();
  const t = new Terminal({ input: h, output: h, name: "tool", size: () => h, clock, known });
  return { h, t, clock };
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("Terminal", () => {
  test("detect: a host replies, and nothing of the detection is left for the input", async () => {
    const { h, t } = setup();
    assert.equal(await t.detect(), true);
    assert.equal(t.native, true);
    assert.equal(t.caps?.host, "hotty-ts-test");
    assert.equal(h.commands().length, 1, "the query");
    assert.equal(h.commands()[0]!.get("a"), "q");
    const got: Input[] = [];
    t.listen((i) => got.push(i));
    await settle();
    assert.deepEqual(got, [], "the DA1 behind the reply was detection's");
    t.close();
  });

  test("late: a late answer reaches the input stream as host, and detect answers true from then on (SPEC §4)", async () => {
    const h = new Host({ text: true });
    const clock = new FakeClock();
    const t = new Terminal({ input: h, output: h, name: "tool", size: () => h, clock, late: true });
    let native: boolean | undefined;
    void t.detect().then((n) => (native = n));
    await clock.advance(150);
    assert.equal(native, false);
    const q = h.commands()[0]!;
    assert.deepEqual([q.get("a"), q.get("n"), q.get("late")], ["q", "1", "1"]);
    const got: Input[] = [];
    t.listen((i) => got.push(i));
    h.becomeHost();
    await settle();
    assert.deepEqual(
      got.map((i) => i.kind),
      ["host"],
    );
    assert.equal(got[0]!.kind === "host" && got[0]!.caps?.host, "hotty-ts-test");
    assert.equal(t.native, true);
    assert.equal(await t.detect(), true);
    t.close();
    assert.equal(h.commands().length, 1, "answered: close withdraws nothing");
  });

  test("late: close withdraws a query no answer came to, with a=q:q=2 (SPEC §4)", async () => {
    const h = new Host({ text: true });
    const clock = new FakeClock();
    const t = new Terminal({ input: h, output: h, name: "tool", size: () => h, clock, late: true });
    void t.detect();
    await clock.advance(150);
    t.close();
    const w = h.commands().at(-1)!;
    assert.deepEqual([w.get("a"), w.get("q"), w.get("n")], ["q", "2", undefined]);
    h.becomeHost();
    assert.equal(h.replies().length, 0, "nothing answers a withdrawn query");
  });

  test("without late, a terminal that becomes a host later answers nothing, and close sends nothing", async () => {
    const { h, t, clock } = setup({ text: true });
    void t.detect();
    await clock.advance(150);
    assert.equal(h.commands()[0]!.get("late"), undefined);
    h.becomeHost();
    assert.equal(h.replies().length, 0);
    t.close();
    assert.equal(h.commands().length, 1);
  });

  test("detect: a terminal that is not a host answers DA1 only, and 150 ms later it is decided", async () => {
    const { h, t, clock } = setup({ text: true });
    let native: boolean | undefined;
    void t.detect().then((n) => (native = n));
    await clock.advance(149);
    assert.equal(native, undefined);
    await clock.advance(1);
    assert.equal(native, false);
    assert.equal(h.errors().length, 0, "nothing but the query went to a terminal that is not a host");
    t.close();
  });

  test("detect: silence is not a host, at 1.5 s", async () => {
    const clock = new FakeClock();
    const t = new Terminal({ input: (async function* () {})(), output: { write() {} }, name: "x", clock });
    // The input ends at once: nothing decided is text.
    assert.equal(await t.detect(), false);
    const quiet = new Terminal({ input: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }, output: { write() {} }, name: "x", clock });
    let native: boolean | undefined;
    void quiet.detect().then((n) => (native = n));
    await clock.advance(1499);
    assert.equal(native, undefined);
    await clock.advance(1);
    assert.equal(native, false);
    quiet.close();
  });

  test("detect runs once; known answers without asking", async () => {
    const { h, t } = setup();
    await t.detect();
    await t.detect();
    assert.equal(h.commands().length, 1);
    const k = setup({}, { native: true });
    assert.equal(await k.t.detect(), true);
    assert.equal(k.h.commands().length, 0, "known: no query");
    t.close();
    k.t.close();
  });

  test("print sends a detached document and places it; fence reads the replies nothing read", async () => {
    const { h, t } = setup({ caps: { limits: { surfaces: 1 } } });
    await t.detect();
    const name = t.print("card", "<p id=msg>hi</p>", { cols: 20, rows: 1 });
    assert.equal(name, "tool-card");
    assert.deepEqual(await t.fence(), []);
    const s = h.surface(name)!;
    assert.ok(s.detached && s.placed);
    assert.equal(s.textOf("msg"), "hi");
    // The host holds one surface: the second document is refused (q=1), and
    // its placement too.
    t.print("other", "<p>no room</p>", { cols: 20 });
    const replies = await t.fence();
    assert.deepEqual(
      replies.map((r) => [r.re, r.code]),
      [
        ["doc", "EQUOTA"],
        ["place", "ENOENT"],
      ],
    );
    assert.match(replies[0]!.err()!.message, /hotty: doc tool-other: EQUOTA/);
    t.close();
  });

  test("request: a numbered command and its reply, never numbered 1", async () => {
    const { h, t } = setup();
    await t.detect();
    t.send(placeAt(t.surface("x"), 0, 0, { cols: 4, rows: 1 })); // no document: ENOENT, q=1
    const r = await t.request((o) => placeAt(t.surface("x"), 0, 0, { cols: 4, rows: 1 }, o));
    assert.equal(r.ok, false);
    assert.equal(r.code, "ENOENT");
    assert.ok(r.n !== undefined && r.n > 1);
    t.send(doc(t.surface("x"), "<p id=a>x</p>"));
    const p = await t.request((o) => placeAt(t.surface("x"), 0, 0, { cols: 4 }, o));
    assert.ok(p.ok);
    assert.equal(p.cols, 4);
    assert.equal(p.rows, 1, "the rows the host chose for auto");
    // The error the first, unnumbered placement caused is the fence's.
    assert.deepEqual(
      (await t.fence()).map((r) => r.code),
      ["ENOENT"],
    );
    assert.equal(h.surface(t.surface("x"))!.placed, true);
    t.close();
  });

  test("request: no reply in 3 s is an error", async () => {
    const { t, clock } = setup({ text: true, lenient: true });
    const got: { err?: unknown } = {};
    void t.request((o) => setText("s", "t", "x", o)).catch((e) => (got.err = e));
    await clock.advance(2999);
    assert.ok(got.err === undefined, "not yet");
    await clock.advance(1);
    assert.ok((got.err as Error | undefined) instanceof NoAnswerError);
    t.close();
  });

  test("fence: no answer in 1 s is an error that carries the replies", async () => {
    const clock = new FakeClock();
    const t = new Terminal({ input: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }, output: { write() {} }, name: "x", clock });
    let err: unknown;
    void t.fence().catch((e) => (err = e));
    await clock.advance(1000);
    assert.ok(err instanceof NoAnswerError);
    assert.deepEqual((err as NoAnswerError).replies, []);
    t.close();
  });

  test("lineStart writes CR LF only when the cursor is not at a line's start", async () => {
    const { h, t } = setup();
    await t.lineStart();
    assert.equal(h.output().includes("\r\n"), false);
    t.send("$ ");
    await t.lineStart();
    assert.equal(h.cursor().col, 0);
    assert.equal(h.cursor().row, 1);
    t.close();
  });

  test("lineStart: no answer in 1 s is at a line's start", async () => {
    const clock = new FakeClock();
    const out: string[] = [];
    const t = new Terminal({ input: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }, output: { write: (s) => out.push(s) }, name: "x", clock });
    let done = false;
    void t.lineStart().then(() => (done = true));
    await clock.advance(1000);
    assert.ok(done);
    assert.deepEqual(out, ["\x1b[6n"]);
    t.close();
  });

  test("events: what no call waits for, in order: keys and the host's events", async () => {
    const { h, t, clock } = setup();
    await t.detect();
    const s = t.surface("form");
    t.send(doc(s, "<button id=go>Go</button>"), placeAt(s, 0, 0, { cols: 10, rows: 1 }));
    await t.fence();
    const got: string[] = [];
    const done = (async () => {
      for await (const i of t.events()) {
        if (i.kind === "data") got.push("data " + JSON.stringify(text(i.data)));
        else if (i.kind === "message") got.push("event " + i.message.event()?.kind + " " + i.message.event()?.target);
        else got.push(i.kind);
        if (got.length === 4) break;
      }
    })();
    h.type("a");
    h.click(s, "go");
    h.type("\x1b");
    await clock.advance(25); // the Escape key, once nothing follows it
    await done;
    assert.deepEqual(got, ['data "a"', "event focus go", "event click go", 'data "\\u001b"']);
    t.close();
  });

  test("surfaces are the program's own, remembered, and detachAll detaches them", async () => {
    const { h, t } = setup();
    await t.detect();
    const a = t.print("a", "<p>a</p>", { cols: 4, rows: 1 });
    const b = t.surface("b");
    assert.equal(t.surface("a"), a);
    assert.deepEqual(t.surfaces(), ["tool-a", "tool-b"]);
    t.send(doc(b, "<p>b</p>"));
    t.detachAll();
    await t.fence();
    assert.equal(h.surface(b)!.detached, true);
    t.close();
  });

  test("kittyGraphics: whether a terminal that is not a host shows images", async () => {
    const yes = setup({ text: true, kittyGraphics: true });
    assert.equal(await yes.t.kittyGraphics(), true);
    yes.t.close();
    const no = setup({ text: true });
    let answer: boolean | undefined;
    void no.t.kittyGraphics().then((a) => (answer = a));
    await no.clock.advance(150);
    assert.equal(answer, false);
    // Nothing of it is left waiting: a fence after it gets its own DA1.
    assert.deepEqual(await no.t.fence(), []);
    no.t.close();
  });

  test("raw mode: calls that wait set it for themselves, and a program's own holds", async () => {
    const h = new Host();
    const modes: boolean[] = [];
    const t = new Terminal({
      input: h,
      output: h,
      name: "x",
      raw: () => {
        modes.push(true);
        return () => modes.push(false);
      },
    });
    await t.detect();
    assert.deepEqual(modes, [true, false]);
    const restore = t.raw();
    await t.fence();
    assert.deepEqual(modes, [true, false, true], "the fence did not restore the program's raw mode");
    restore();
    assert.deepEqual(modes, [true, false, true, false]);
    t.close();
  });

  test("close gives up what waits, and ends the input stream", async () => {
    const { t } = setup({ text: true, lenient: true });
    const r = t.request((o) => setText("s", "t", "x", o));
    const it = t.events();
    const next = it.next();
    t.close();
    await assert.rejects(r, NoAnswerError);
    assert.equal((await next).done, true);
  });
});
