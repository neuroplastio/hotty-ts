// The Link: a byte stream however it is split, and a push environment
// (SDK.md §4.2) that hands over complete sequences, strips their
// terminators, and keeps the DA1 answers for itself, as OpenTUI's input
// parser does while it probes the terminal.

import assert from "node:assert/strict";

import { doc, encode, place, Scanner, setText } from "../src/index.ts";
import { type Input, Link, NoAnswerError } from "../src/link.ts";
import { Host, type HostOptions } from "../src/test/index.ts";
import { FakeClock, settle } from "./clock.ts";
import { describe, test } from "./harness.ts";

const bin = (b: Uint8Array) => String.fromCharCode(...b);

// A push environment on a host: what the host sends goes through the
// environment's own parser, which hands the link each OSC without its
// terminator, and DA1 answers only when it does not eat them.
function pushed(opts: HostOptions & { eatDa1?: boolean } = {}) {
  const h = new Host(opts);
  const clock = new FakeClock();
  const sc = new Scanner({ da1: true });
  const passed: string[] = []; // what the environment kept
  const pump = () => {
    for (const s of sc.feed(h.take())) {
      if (s.kind === "osc") {
        const seq = bin(s.data).replace(/(\x1b\\|\x07)$/, "");
        if (!link.osc(seq)) passed.push(seq);
      } else if (s.kind === "da1") {
        if (opts.eatDa1 || !link.da1()) passed.push(bin(s.data));
      }
    }
  };
  const link: Link = new Link({
    write: (s) => {
      h.write(s);
      queueMicrotask(pump);
    },
    name: "p",
    clock,
  });
  return { h, link, clock, passed, pump };
}

describe("Link in a push environment", () => {
  test("a host is decided when its reply arrives, and done 300 ms later without the DA1", async () => {
    const { link, clock, passed } = pushed({ eatDa1: true });
    let decided: boolean | undefined;
    let done: boolean | undefined;
    void link.detect({ decided: true }).then((n) => (decided = n));
    void link.detect().then((n) => (done = n));
    await settle();
    assert.equal(decided, true);
    assert.equal(done, undefined);
    assert.equal(link.caps?.v, "0.1");
    await clock.advance(300);
    assert.equal(done, true);
    assert.deepEqual(passed, ["\x1b[?62;22c"], "the environment kept the DA1 it ate");
  });

  test("with the DA1 handed over, a host is done when it arrives, and the link swallows it", async () => {
    const { link, passed } = pushed();
    assert.equal(await link.detect(), true);
    assert.deepEqual(passed, []);
    // After detection, a DA1 nothing waits for is someone else's.
    assert.equal(link.da1(), false);
  });

  test("a terminal that is not a host, with its DA1 eaten, is text at 1.5 s", async () => {
    const { link, clock } = pushed({ text: true, eatDa1: true });
    let native: boolean | undefined;
    void link.detect({ decided: true }).then((n) => (native = n));
    await clock.advance(1499);
    assert.equal(native, undefined);
    await clock.advance(1);
    assert.equal(native, false);
  });

  test("osc says whether a sequence was HOTTY's; events reach the listener", async () => {
    const { h, link } = pushed();
    await link.detect();
    assert.equal(link.osc("\x1b]11;rgb:0/0/0"), false);
    const got: Input[] = [];
    link.listen((i) => got.push(i));
    link.send(doc("p-f", "<button id=go>Go</button>"), place("p-f", { cols: 8, rows: 1 }));
    await settle();
    h.click("p-f", "go");
    link.osc(bin(new TextEncoder().encode(encode([["a", "ev"], ["s", "p-f"], ["e", "zoom"], ["t", ""]]))));
    await settle();
    // The pump runs after writes; hand over what the click sent.
    const sc = new Scanner();
    for (const s of sc.feed(h.take())) if (s.kind === "osc") link.osc(s.data);
    const kinds = got.map((i) => (i.kind === "message" ? i.message.event()?.kind : "data"));
    assert.deepEqual(kinds, ["zoom", "focus", "click"]);
  });

  test("requests and fences complete through pushed replies", async () => {
    const { link } = pushed();
    await link.detect();
    link.send(doc("p-a", "<p id=t>x</p>", { q: 0 })); // an ok reply nothing asked for
    const r = await link.request((o) => setText("p-a", "t", "y", o));
    assert.equal(r.ok, true);
    assert.equal(r.n, 2);
    assert.deepEqual(
      (await link.fence()).map((r) => [r.re, r.ok]),
      [["doc", true]],
      "the fence claims the unnumbered reply the listener had not taken",
    );
  });
});

describe("Link on a byte stream", () => {
  test("a reply cut anywhere is one message; the keys around it pass as they were", () => {
    const reply = encode([["a", "ev"], ["s", "f"], ["e", "click"], ["t", "go"]]);
    const stream = new TextEncoder().encode("ab" + reply + "é\x1b[A");
    for (let cut = 0; cut <= stream.length; cut++) {
      const link = new Link({ write: () => {} });
      const got: string[] = []; // adjacent data merged
      link.listen((i) => {
        if (i.kind === "message") got.push("ev:" + i.message.event()?.target);
        else if (i.kind !== "data") got.push(i.kind);
        else if (got.length > 0 && !got.at(-1)!.startsWith("ev:")) got[got.length - 1] += bin(i.data);
        else got.push(bin(i.data));
      });
      link.bytes(stream.subarray(0, cut));
      link.bytes(stream.subarray(cut));
      link.end();
      assert.deepEqual(got, ["ab", "ev:go", bin(new TextEncoder().encode("é\x1b[A"))], `cut at ${cut}`);
    }
  });

  test("a lone ESC at the end of a read is the Escape key, once nothing follows within 25 ms", async () => {
    const clock = new FakeClock();
    const link = new Link({ write: () => {}, clock });
    const got: Uint8Array[] = [];
    link.listen((i) => i.kind === "data" && got.push(i.data));
    link.bytes("\x1b");
    await clock.advance(24);
    assert.deepEqual(got, []);
    await clock.advance(1);
    assert.deepEqual(got.map(bin), ["\x1b"]);
    // A sequence cut right after its ESC is not.
    link.bytes("\x1b");
    await clock.advance(10);
    link.bytes("[A");
    assert.deepEqual(got.map(bin), ["\x1b", "\x1b[A"]);
    const now = new Link({ write: () => {}, escapeDelay: 0 });
    const at: string[] = [];
    now.listen((i) => i.kind === "data" && at.push(bin(i.data)));
    now.bytes("\x1b");
    assert.deepEqual(at, ["\x1b"], "escapeDelay 0: at once");
  });

  test("a DA1 nothing waits for passes as data", () => {
    const link = new Link({ write: () => {} });
    const got: string[] = [];
    link.listen((i) => i.kind === "data" && got.push(bin(i.data)));
    link.bytes("\x1b[?62;22c");
    assert.deepEqual(got, ["\x1b[?62;22c"]);
  });

  test("the input ending gives up what waits; nothing decided is text", async () => {
    const link = new Link({ write: () => {} });
    const r = link.request((o) => setText("s", "t", "x", o));
    const det = link.detect();
    link.end();
    await assert.rejects(r, NoAnswerError);
    assert.equal(await det, false);
  });

  test("names take the link's prefix and are made valid", () => {
    const link = new Link({ write: () => {}, name: "my tool:7" });
    assert.equal(link.surface("card"), "my_tool_7-card");
    assert.equal(link.surface("ünï"), "my_tool_7-_n_");
    assert.deepEqual(link.surfaces(), ["my_tool_7-card", "my_tool_7-_n_"]);
  });
});
