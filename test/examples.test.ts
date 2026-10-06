// The examples, run against the test host as a terminal that is a host and
// one that is not.

import assert from "node:assert/strict";

import { doc } from "../src/index.ts";
import { NoTerminalError, Terminal } from "../src/terminal.ts";
import { Host, type HostOptions } from "../src/test/index.ts";
import { settle } from "./clock.ts";
import { describe, test } from "./harness.ts";

import * as ask from "../examples/ask.ts";
import * as board from "../examples/board.ts";
import * as hello from "../examples/hello.ts";
import * as progress from "../examples/progress.ts";

class Out {
  text = "";
  write(s: string) {
    this.text += s;
  }
}

function env(name: string, opts: HostOptions = {}) {
  const h = new Host(opts);
  const stdout = new Out();
  const stderr = new Out();
  const open = () => new Terminal({ input: h, output: h, name, size: () => h });
  return { h, stdout, stderr, open };
}

const noTerminal = () => {
  throw new NoTerminalError("not in a test");
};

// Waits until cond holds, on the runtime's own clock: the examples use it.
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), what);
}

describe("examples", () => {
  test("hello: a detached document at the cursor, and a line of text elsewhere", async () => {
    const e = env("hello");
    assert.equal(await hello.run(e), 0);
    const s = e.h.surface("hello-hello")!;
    assert.ok(s.detached && s.placed);
    assert.match(s.text(), /Hello, HTML in the terminal\./);
    assert.deepEqual([e.h.errors(), e.stderr.text], [[], ""]);
    const t = env("hello", { text: true });
    assert.equal(await hello.run(t), 0);
    assert.match(t.stdout.text, /not a HOTTY host/);
    const none = { ...env("hello"), open: noTerminal };
    assert.equal(await hello.run(none), 0);
    assert.equal(none.stdout.text, "Hello.\n");
  });

  test("hello: a host with no room says why", async () => {
    const e = env("hello", { caps: { limits: { surfaces: 1 } } });
    e.h.write(doc("someone-else", "<p>x</p>"));
    assert.equal(await hello.run(e), 1);
    assert.match(e.stderr.text, /EQUOTA/);
  });

  test("progress: a bar moved by deltas, a line redrawn, or a line a step", async () => {
    const fast = { sleep: async () => {}, now: () => 0 };
    const e = env("progress");
    assert.equal(await progress.run(["--files", "3"], { ...e, tty: true, ...fast }), 0);
    const s = e.h.surface("progress-bar")!;
    assert.ok(s.detached && s.placed);
    assert.equal(s.var("fill", "--p"), "100");
    assert.equal(s.textOf("label"), "3 files in 0 ms");
    assert.equal(s.textOf("pct"), "100%");
    assert.equal(s.attr("row", "class"), "row done");
    assert.equal(e.stdout.text, "");
    const t = env("progress", { text: true });
    assert.equal(await progress.run(["--files", "3"], { ...t, tty: true, ...fast }), 0);
    assert.match(t.stdout.text, /\r\x1b\[K\[#{30}\] 100% file-03\.dat\r\x1b\[K✓ 3 files in 0 ms\n$/);
    const p = env("progress");
    assert.equal(await progress.run(["--files", "2"], { ...p, tty: false, ...fast }), 0);
    assert.equal(p.stdout.text, "file-01.dat\nfile-02.dat\n");
    assert.equal(p.h.commands().length, 0, "a pipe: the terminal is not asked");
    assert.equal(await progress.run(["--files", "0"], { ...p, tty: false, ...fast }), 2);
  });

  test("ask: a form that takes the keyboard and reports a submit, then a detached summary", async () => {
    const e = env("ask");
    const code = ask.run(e);
    await until(() => e.h.surface("ask-form")?.placed === true, "the form is placed");
    const f = e.h.surface("ask-form")!;
    assert.equal(f.focused(), "service", "the form has the keyboard");
    e.h.fill("ask-form", "service", "api");
    e.h.choose("ask-form", "env", "production");
    e.h.submit("ask-form", "service");
    assert.equal(await code, 0);
    assert.equal(e.stdout.text, '{"service":"api","env":"production"}\n');
    const s = e.h.surface("ask-form")!;
    assert.ok(s.detached && s.placed);
    assert.equal(s.text(), "Deploying api to production.");
    assert.deepEqual(e.h.errors(), []);
  });

  test("ask: Escape cancels; a terminal that is not a host asks a line at a time", async () => {
    const e = env("ask");
    const code = ask.run(e);
    await until(() => e.h.surface("ask-form")?.placed === true, "the form is placed");
    e.h.type("\x1b");
    assert.equal(await code, 130);
    assert.equal(e.h.surface("ask-form")!.text(), "Cancelled.");
    assert.equal(e.stdout.text, "");
    const t = env("ask", { text: true });
    t.h.type("\rapi\r\r");
    assert.equal(await ask.run(t), 0);
    assert.equal(t.stdout.text, '{"service":"api","env":"staging"}\n');
    assert.match(t.h.output(), /Service: Service: Environment/);
  });

  test("board: cards as surfaces the Session lays out, changed by deltas, laid out again after a repaint", async () => {
    const e = env("board");
    let resize: () => void = () => {};
    const code = board.run({ ...e, onResize: (f) => ((resize = f), () => {}) });
    const card = (i: number) => e.h.surface(`board-card-${i}`);
    await until(() => [0, 1, 2].every((i) => card(i)?.placed), "three cards");
    assert.deepEqual([0, 1, 2].map((i) => card(i)!.row), [2, 6, 10]);
    assert.equal(card(0)!.attr("card", "class"), "card chosen");
    e.h.type("j\r");
    await until(() => card(1)!.textOf("state") === "done", "the second card done");
    assert.deepEqual([0, 1].map((i) => card(i)!.attr("card", "class")), ["card", "card chosen"]);
    e.h.click("board-card-2", "card");
    await until(() => card(2)!.attr("card", "class") === "card chosen", "a click chooses");
    // A repaint erases the screen: the Session asks for a layout, and the
    // cards are placed again, without their documents.
    const docs = () => e.h.commands().filter((m) => m.get("a") === "doc").length;
    const places = () => e.h.commands().filter((m) => m.get("a") === "place").length;
    const [d, p] = [docs(), places()];
    resize();
    await until(() => places() === p + 3, "placed again");
    assert.equal(docs(), d);
    assert.ok([0, 1, 2].every((i) => card(i)!.placed));
    e.h.type("q");
    assert.equal(await code, 0);
    assert.deepEqual(e.h.surfaces(), [], "close deleted them");
    assert.deepEqual([e.h.errors(), e.stderr.text], [[], ""]);
    assert.equal(e.h.cursor().shown, true);
  });

  test("board: in a terminal that is not a host, the cards are text", async () => {
    const e = env("board", { text: true });
    const code = board.run(e);
    await until(() => e.h.lines().some((l) => l.includes("> [ ] Write the spec")), "drawn");
    e.h.type("j\r");
    await until(() => e.h.lines().some((l) => l.includes("> [x] Build the SDK")), "the second done");
    e.h.type("q");
    assert.equal(await code, 0);
    await settle();
    assert.equal(e.h.commands().length, 1, "only the query");
  });
});
