// The test host where the host vectors cannot see. Its morph (SPEC §6.2):
// the vectors inspect a document's markup, not which elements stayed the
// same, and with them what the user did there. Scroll and area (SPEC §5.1,
// §9), whose host vectors land with the hosts. Keys (SPEC §10.2) on every
// kind of element, beyond the vectors'. And the types of its bodies' fields
// (SPEC §3.3), which the vectors' JSON does not show.

import assert from "node:assert/strict";

import {
  attr,
  blur,
  DEFAULT_MAX,
  Decoder,
  delta,
  doc,
  encode,
  Float,
  focus,
  menu,
  menuHide,
  menuShow,
  morphTo,
  place,
  placeAt,
  query,
  remove,
  res,
  text,
  SCROLL_HORIZONTAL,
  SCROLL_VERTICAL,
  touch,
  TOUCH_MAX,
  type TouchArea,
  unpack,
  withdrawLate,
} from "../src/index.ts";
import { pack } from "../src/msgpack.ts";
import { Host } from "../src/test/index.ts";
import { describe, test } from "./harness.ts";

function surface(html: string) {
  const h = new Host();
  h.write(doc("s", html) + placeAt("s", 0, 0, { cols: 40, rows: 4 }));
  const s = h.surface("s")!;
  return { h, s };
}

describe("Host morph", () => {
  test("elements that stay keep their identity, the user's text and focus; moved, not made again", () => {
    const { h, s } = surface("<div id=box><input id=a><input id=b><details id=d><summary>s</summary>x</details></div>");
    h.fill("s", "a", "typed");
    h.fill("s", "b", "other");
    const a = s.byId("a");
    const b = s.byId("b");
    h.write(morphTo("s", "box", "<div id=box><input id=b class=x><input id=a></div>"));
    assert.equal(s.byId("a"), a);
    assert.equal(s.byId("b"), b);
    assert.deepEqual([s.value("a"), s.value("b")], ["typed", "other"]);
    assert.equal(s.focused(), "b");
    assert.equal(s.attr("b", "class"), "x");
    assert.equal(s.byId("d"), undefined, "an old child not taken is removed");
    assert.deepEqual(s.element("box")!.children.map((c) => c.id), ["b", "a"]);
  });

  test("a changed default sets the control's value, unless it is focused", () => {
    const { h, s } = surface("<div id=box><input id=a><input id=b></div>");
    h.fill("s", "a", "typed");
    h.fill("s", "b", "editing");
    h.write(morphTo("s", "box", "<div id=box><input id=a value=set><input id=b value=set></div>"));
    assert.deepEqual([s.value("a"), s.value("b")], ["set", "editing"]);
    // An attribute that is not the default leaves the value alone.
    h.write(morphTo("s", "box", "<div id=box><input id=a value=set title=t><input id=b value=set></div>"));
    assert.equal(s.value("a"), "set");
    h.fill("s", "a", "again");
    h.blur("s");
    h.write(morphTo("s", "box", "<div id=box><input id=a value=set title=u><input id=b value=set></div>"));
    assert.equal(s.value("a"), "again", "the default did not change");
  });

  test("an element that does not match is replaced, and what the user did there goes with it", () => {
    const { h, s } = surface("<div id=box><input id=a><p id=p>x</p></div>");
    h.fill("s", "a", "typed");
    h.blur("s");
    const p = s.byId("p");
    h.write(morphTo("s", "box", "<div id=box><textarea id=a></textarea><p id=p>x</p></div>"));
    assert.equal(s.byId("a")?.tagName, "textarea");
    assert.equal(s.value("a"), "");
    assert.equal(s.byId("p"), p);
    h.write(morphTo("s", "p", "<p id=q>y</p>"));
    assert.equal(s.byId("p"), undefined, "another id: replaced");
    assert.equal(s.textOf("q"), "y");
  });

  test("children without an id match by kind, in order; text changes in place", () => {
    const { h, s } = surface("<ul id=l><li>one</li><li>two</li></ul>");
    const before = s.byId("l")!.childNodes.slice();
    h.write(morphTo("s", "l", "<ul id=l><li>uno</li><li>two</li><li>three</li></ul>"));
    const after = s.byId("l")!.childNodes;
    assert.equal(after.length, 3);
    assert.equal(after[0], before[0]);
    assert.equal(after[1], before[1]);
    assert.equal(s.textOf("l"), "unotwothree");
  });

  test("morph without a target matches top-level elements by id; the unknown ones are one ENOTARGET", () => {
    const { h, s } = surface("<p id=x>1</p><p id=y>2</p>");
    const y = s.byId("y");
    h.write(morphTo("s", "", "<p id=x>10</p><p id=z>3</p><p id=w>4</p><p id=y>20</p>", { q: 1 }));
    assert.deepEqual([s.textOf("x"), s.textOf("y")], ["10", "20"]);
    assert.equal(s.byId("y"), y);
    const r = h.replies().at(-1)!.reply()!;
    assert.deepEqual([r.ok, r.code, r.detail], [false, "ENOTARGET", "z,w"]);
  });
});

describe("Host scroll and area", () => {
  const events = (h: Host) =>
    h.events().map((e) => [e.kind, e.target, e.area() ?? null] as const);

  test("a document's scroll axes are its own (SPEC §5.1)", () => {
    const h = new Host();
    h.write(doc("s", "<ul><li>a</li></ul>", { scroll: SCROLL_VERTICAL | SCROLL_HORIZONTAL }) + place("s", { cols: 10, rows: 2 }));
    assert.equal(h.surface("s")!.scroll, 3);
    h.write(doc("s", "<p>b</p>"));
    assert.equal(h.surface("s")!.scroll, 0, "a new document without it does not scroll");
    h.write(doc("s", "<p>b</p>", { scroll: 4 }));
    assert.equal(h.surface("s")!.scroll, 0, "anything but 1, 2 or 3 does not scroll");
    h.write(doc("s", "<p>c</p>", { scroll: SCROLL_HORIZONTAL }));
    assert.equal(h.surface("s")!.scroll, 2);
  });

  test("a double click is a click, then a click whose count is 2 (SPEC §9)", () => {
    const h = new Host();
    assert.equal(h.caps.has("count"), true);
    h.write(doc("f", `<button id=open value=x>Open</button><a href="/doc" id=l>doc</a>`) + place("f", { cols: 20, rows: 2 }));
    h.doubleClick("f", "open");
    h.doubleClick("f", "l");
    assert.deepEqual(
      h.events().filter((e) => e.kind === "click").map((e) => [e.target, e.count()]),
      [["open", 1], ["open", 2], ["l", 1], ["l", 2]],
    );
    // Without the feature count, every click reads as the first of its run.
    const plain = new Host({ caps: { features: ["hover"] } });
    plain.write(doc("f", `<button id=open>Open</button>`) + place("f", { cols: 20, rows: 2 }));
    plain.doubleClick("f", "open");
    assert.deepEqual(plain.events().filter((e) => e.kind === "click").map((e) => e.count()), [1, 1]);
  });

  test("the host reports the limit it decodes a message with, and drops a message past it (SPEC §13)", () => {
    assert.equal(new Host().caps.limits.message, DEFAULT_MAX);
    assert.equal(new Host({ caps: { limits: { surfaces: 2 } } }).caps.limits.message, DEFAULT_MAX);
    const h = new Host({ lenient: true, caps: { limits: { message: 8 } } });
    assert.equal(h.caps.limits.message, 8);
    h.write(res("r", "text/css", "012345678") + res("s", "text/css", "01234567"));
    assert.equal(h.resource("r"), undefined);
    assert.ok(h.resource("s"));
  });

  test("a click and a press carry the area the test gave the element, and none otherwise", () => {
    const h = new Host();
    h.write(doc("f", "<form id=f><select id=env><option>a</option></select><button id=go value=x>Go</button><p id=t>t</p></form>") + place("f", { cols: 30, rows: 1, press: true }));
    h.setArea("f", "go", { c: 20, r: 0, w: 4, h: 1 });
    h.setArea("f", "t", { c: -1, r: 3, w: 5, h: 2 });
    h.click("f", "go");
    h.press("f", "t");
    h.press("f", "");
    h.setArea("f", "go", undefined);
    h.click("f", "go");
    assert.deepEqual(events(h).filter(([k]) => k === "click" || k === "press"), [
      ["press", "go", { c: 20, r: 0, w: 4, h: 1 }],
      ["click", "go", { c: 20, r: 0, w: 4, h: 1 }],
      ["press", "t", { c: -1, r: 3, w: 5, h: 2 }],
      ["press", "", null],
      ["press", "go", null],
      ["click", "go", null],
    ]);
    assert.equal(h.events().find((e) => e.kind === "click")!.value(), "x", "the value beside the area");
  });
});

describe("Host bodies", () => {
  // A message's body, each value of its type: a float as a Float.
  const typed = (payload: Uint8Array) => unpack(payload, { floats: true }) as Record<string, unknown>;

  test("the capabilities and an error are msgpack maps, each field of its type: scale a float even when whole, and a field with nothing in it left out (SPEC §3.3, §4)", () => {
    const h = new Host({ caps: { scale: 2, cellcss: { w: 4.5, h: 9 }, host: undefined, later: [1, 0.5] } });
    h.write(query(1) + focus("nope", "", { n: 2 }));
    const [q, err] = h.replies();
    const body = typed(q!.payload);
    assert.equal(body.v, "0.5");
    assert.deepEqual(body.scale, new Float(2));
    assert.deepEqual(body.cellcss, { w: new Float(4.5), h: new Float(9) });
    assert.deepEqual(body.features, ["hover", "count", "menu"]);
    assert.deepEqual(body.later, [1, new Float(0.5)]);
    assert.ok(!("host" in body));
    const caps = q!.reply()!.caps()!;
    assert.deepEqual([caps.v, caps.scale, caps.cellCss, caps.raw.later], ["0.5", 2, { w: 4.5, h: 9 }, [1, 0.5]]);
    assert.deepEqual([caps.has("menu"), caps.has("passthrough")], [true, false]);
    assert.deepEqual(typed(err!.payload), { code: "ENOENT", detail: "no surface nope" });
    assert.deepEqual([err!.reply()!.code, err!.reply()!.detail], ["ENOENT", "no surface nope"]);
  });

  test("an event's detail goes out as its kind's type: a fit's rows as an int; a Float is a float in any field (SPEC §9)", () => {
    const h = new Host();
    h.write(doc("s", "<p>x</p>") + placeAt("s", 0, 0, { cols: 10, rows: 1 }));
    h.emit("s", "fit", "", { r: 3 });
    h.emit("s", "fit", "", { r: new Float(3) });
    h.emit("s", "later", "x", { n: 2, f: 2.5, g: new Float(1), none: null });
    const [fit, fitFloat, later] = h.events();
    assert.deepEqual(typed(fit!.message.payload), { r: 3 });
    assert.equal(fit!.fitRows(), 3);
    // A count of rows sent as a float does not decode, and the event stands.
    assert.deepEqual([fitFloat!.kind, fitFloat!.fitRows(), fitFloat!.detail], ["fit", undefined, { r: 3 }]);
    assert.deepEqual(typed(later!.message.payload), { n: 2, f: new Float(2.5), g: new Float(1) });
    assert.deepEqual(later!.detail, { n: 2, f: 2.5, g: 1 });
  });

  test("a view's areas go out as ints, and an element whose area lacks a field is left out of view(); the event stands (SPEC §9.5)", () => {
    const h = new Host();
    h.write(doc("s", "<p id=a data-on=view>x</p>") + placeAt("s", 0, 0, { cols: 10, rows: 1 }));
    h.emit("s", "view", "", { in: { a: { c: 0, r: -2, w: 4, h: 3 }, b: { c: 0, r: 1, w: 4 } }, end: false });
    h.emit("s", "view", "", { end: true });
    h.emit("s", "view", "", {});
    const [view, end, empty] = h.events();
    assert.deepEqual(typed(view!.message.payload), { in: { a: { c: 0, r: -2, w: 4, h: 3 }, b: { c: 0, r: 1, w: 4 } }, end: false });
    assert.deepEqual(view!.view(), { areas: { a: { c: 0, r: -2, w: 4, h: 3 } }, atEnd: false });
    assert.deepEqual(end!.view(), { areas: {}, atEnd: true });
    assert.deepEqual(empty!.view(), { areas: {}, atEnd: false });
  });
});

// What the host sent the program since the last call: an event as a line,
// "ev click t=go {…}", a reply as "reply", and other bytes as they are.
function sent(h: Host): string[] {
  let rest = new TextDecoder().decode(h.take());
  const dec = new Decoder();
  const out: string[] = [];
  while (rest !== "") {
    const i = rest.indexOf("\x1b]7279;");
    if (i !== 0) {
      const end = i < 0 ? rest.length : i;
      out.push(rest.slice(0, end));
      rest = rest.slice(end);
      continue;
    }
    const end = rest.indexOf("\x1b\\") + 2;
    const f = dec.feed(rest.slice(0, end));
    rest = rest.slice(end);
    const e = f.result === "complete" ? f.message.event() : undefined;
    out.push(e ? `ev ${e.kind} t=${e.target}${e.detail === undefined ? "" : " " + JSON.stringify(e.detail)}` : "reply");
  }
  return out;
}

describe("Host keys", () => {
  test("Tab moves focus in tree order; a text field edits, a select picks, a box checks, a button clicks; the rest is the program's (SPEC §10.2)", () => {
    const { h, s } = surface(
      "<form id=f><input id=name name=name data-on=input>" +
        "<input id=skip tabindex=-1><input id=off disabled>" +
        "<textarea id=notes name=notes></textarea>" +
        "<input id=ok name=ok type=checkbox value=yes>" +
        "<select id=size name=size><option>small<option>medium<option>large</select>" +
        "<button id=go type=button>Go</button>" +
        "<div inert><button id=dead>Dead</button></div></form>",
    );
    h.take();

    // No surface has the keyboard: the key is the program's.
    assert.equal(h.key("a"), false);
    assert.deepEqual(sent(h), ["a"]);

    // The program gives the keyboard; Tab goes in tree order, past what is
    // disabled, inert, or out of the Tab order.
    h.write(focus("s", "name"));
    h.take();
    for (const k of ["shift+a", "d", "a", "backspace", "space", "shift+a"]) assert.ok(h.key(k), `${k} in a text field`);
    assert.deepEqual(sent(h), [
      'ev input t=name {"value":"A","rev":1}',
      'ev input t=name {"value":"Ad","rev":2}',
      'ev input t=name {"value":"Ada","rev":3}',
      'ev input t=name {"value":"Ad","rev":4}',
      'ev input t=name {"value":"Ad ","rev":5}',
      'ev input t=name {"value":"Ad A","rev":6}',
    ]);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      h.key("tab");
      order.push(s.focused());
    }
    assert.deepEqual(order, ["notes", "ok", "size", "go"]);
    assert.deepEqual(sent(h), ['ev change t=name {"value":"Ad A","rev":6}', "ev focus t=notes", "ev focus t=ok", "ev focus t=size", "ev focus t=go"]);

    // shift+tab goes back; a key with ctrl is the program's.
    h.key("shift+tab");
    assert.equal(s.focused(), "size");
    assert.equal(h.key("ctrl+s"), false);
    assert.deepEqual(sent(h), ["ev focus t=size", "\x13"]);

    // A select picks by the arrows and by the first letter.
    for (const k of ["arrow_down", "l", "home", "arrow_up"]) h.key(k);
    assert.deepEqual(sent(h), [
      'ev change t=size {"value":"medium","rev":1}',
      'ev change t=size {"value":"large","rev":2}',
      'ev change t=size {"value":"small","rev":3}',
    ]);

    // Space checks a checkbox; Enter on a button clicks it.
    for (const k of ["shift+tab", "space", "tab", "tab", "enter"]) h.key(k);
    assert.deepEqual(sent(h), [
      "ev focus t=ok",
      'ev change t=ok {"checked":true,"value":"yes","rev":1}',
      "ev focus t=size",
      "ev focus t=go",
      "ev click t=go",
    ]);

    // Past the last element the surface loses the keyboard.
    h.key("tab");
    assert.deepEqual(sent(h), ["ev blur t="]);
    assert.equal(h.key("tab"), false);
    assert.deepEqual(sent(h), ["\t"]);

    // A textarea takes Enter as a new line; Enter in a field submits.
    h.write(focus("s", "notes"));
    for (const k of ["h", "enter", "i", "arrow_up"]) h.key(k);
    h.write(focus("s", "name"));
    h.key("enter");
    assert.deepEqual(sent(h), [
      'ev change t=notes {"value":"h\\ni","rev":3}',
      'ev submit t=f {"fields":[["name","Ad A"],["notes","h\\ni"],["ok","yes"],["size","small"]]}',
    ]);

    // Escape is never the surface's.
    assert.equal(h.key("escape"), false);
    assert.deepEqual(sent(h), ["\x1b"]);
  });

  test("this host does not scroll: a key bound to a scroll action goes on as if its keymap did not bind it, so the element uses it or the program hears it, and a field leaves the binding out (SPEC §10.2)", () => {
    const { h, s } = surface(
      '<div data-keys="arrow_down=program k=program">' +
        '<div tabindex=0 id=v data-keys="j=scroll-down shift+g=scroll-end space=scroll-page-down">' +
        '<select id=s data-keys="arrow_down=scroll-down"><option>a<option>b</select>' +
        "<button id=b>B</button>" +
        '<input id=f data-on=input data-keys="k=scroll-up">' +
        "</div></div>",
    );
    const at = (id: string) => {
      h.write(focus("s", id));
      h.take();
    };
    // The box uses none of them: they reach the program.
    at("v");
    for (const k of ["j", "shift+g", "space"]) assert.equal(h.key(k), false, k);
    assert.deepEqual(sent(h), ["jG "]);
    // A select's nearer scroll binding takes ArrowDown back from the
    // program, and the select picks with it.
    at("s");
    h.key("arrow_down");
    assert.deepEqual(sent(h), ['ev change t=s {"value":"b","rev":1}']);
    // A button uses Space.
    at("b");
    h.key("space");
    assert.deepEqual(sent(h), ["ev click t=b"]);
    // A field leaves j=scroll-down out and types j; k=scroll-up too, which
    // leaves k to the farther program.
    at("f");
    for (const k of ["j", "k"]) h.key(k);
    assert.deepEqual(sent(h), ['ev input t=f {"value":"j","rev":1}', "k"]);
    assert.equal(s.focused(), "f");
  });

  test("becomeHost: a terminal that was not a host answers the query held for a late answer, unless another took its place or a reset came (SPEC §4)", () => {
    const answered = (...writes: string[]) => {
      const h = new Host({ text: true });
      for (const w of writes) h.write(w);
      h.becomeHost();
      return h.replies().map((r) => [r.get("n"), r.get("re")]);
    };
    assert.deepEqual(answered(query(7, { late: true })), [["7", "q"]]);
    assert.deepEqual(answered(query(7, { late: true }), query(8)), [], "a query without late takes its place");
    assert.deepEqual(answered(query(7, { late: true }), withdrawLate()), [], "withdrawn");
    assert.deepEqual(answered(query(7, { late: true }), "\x1bc"), [], "a full reset forgets it");
    assert.deepEqual(answered(query(7)), [], "no late answer asked for");
    const old = new Host({ text: true });
    old.write(encode([["a", "q"], ["n", 7], ["late", 1]]));
    old.becomeHost();
    assert.deepEqual(
      old.replies().map((r) => [r.get("a"), r.get("n"), r.reply()!.code, r.reply()!.detail]),
      [["err", "7", "EVERSION", "0.5"]],
      "answered as any query: one that lists no version is EVERSION",
    );
    const h = new Host({ text: true });
    assert.equal(h.host, false);
    h.becomeHost();
    assert.equal(h.host, true);
    h.write(doc("x", "<p>x</p>"));
    assert.ok(h.surface("x"), "a host from then on");
  });

  test("a key the focused element's keymap binds to program reaches the program, whatever the element; outside a text field other bindings do nothing but take a key back (SPEC §10.2)", () => {
    const { h, s } = surface(
      '<div data-keys="arrow_down=program end=program space=program enter=program tab=program">' +
        "<select id=s><option>a<option>b<option>c</select>" +
        '<select id=own data-keys="end=line-end arrow_up=program"><option>a<option>b<option>c</select>' +
        '<button id=b data-keys="enter=submit">B</button>' +
        "<input id=c type=checkbox>" +
        "<a id=l href=/x>L</a>" +
        "<details><summary id=m>M</summary></details>" +
        '<input id=d type=date data-keys="arrow_left=program">' +
        "<input id=f data-on=input>" +
        "</div>" +
        "<select id=free><option>a<option>b</select>",
    );
    const at = (id: string) => {
      h.write(focus("s", id));
      h.take();
    };

    // A select gives the program what the keymap binds to program, Shift
    // with it, and picks with the rest.
    at("s");
    for (const k of ["arrow_down", "shift+arrow_down", "end", "space", "enter"]) assert.equal(h.key(k), false, k);
    assert.deepEqual(sent(h), ["\x1b[B\x1b[B\x1b[F \r"]);
    for (const k of ["c", "arrow_up"]) h.key(k);
    assert.deepEqual(sent(h), ['ev change t=s {"value":"c","rev":1}', 'ev change t=s {"value":"b","rev":2}']);

    // Tab cannot be bound: it moves focus. A nearer binding to another
    // action takes End back, and the select uses it.
    h.key("tab");
    assert.equal(s.focused(), "own");
    for (const k of ["end", "arrow_up", "arrow_down"]) h.key(k);
    assert.deepEqual(sent(h), ["ev focus t=own", 'ev change t=own {"value":"c","rev":1}', "\x1b[A\x1b[B"]);

    // A button clicks with Enter, which it binds to an action of its own,
    // and gives Space to the program.
    at("b");
    for (const k of ["enter", "space"]) h.key(k);
    assert.deepEqual(sent(h), ["ev click t=b", " "]);

    // A checkbox, a link and a summary give the program the keys that
    // would toggle or click them.
    for (const [id, k, seq] of [
      ["c", "space", " "],
      ["l", "enter", "\r"],
      ["m", "space", " "],
    ] as const) {
      at(id);
      assert.equal(h.key(k), false, `#${id} used ${k}`);
      assert.deepEqual(sent(h), [seq]);
    }

    // A date input gives the program a key its own keymap would use.
    at("d");
    assert.equal(h.key("arrow_left"), false);
    assert.equal(h.key("backspace"), true);
    assert.deepEqual(sent(h), ["\x1b[D"]);

    // A text field's keymap starts from the default one: End is still the
    // program's, and the field edits with the rest.
    at("f");
    for (const k of ["x", "end", "arrow_left", "y"]) h.key(k);
    assert.deepEqual(sent(h), ['ev input t=f {"value":"x","rev":1}', "\x1b[F", 'ev input t=f {"value":"yx","rev":2}']);

    // Outside the div, the keys are the select's again. The field commits
    // as focus leaves it.
    h.write(focus("s", "free"));
    h.key("arrow_down");
    assert.deepEqual(sent(h), ['ev change t=f {"value":"yx","rev":2}', 'ev change t=free {"value":"b","rev":1}']);
  });

  test("with no element focused there is no keymap: no data-keys are read, and every key but tab reaches the program (SPEC §10.2)", () => {
    const { h, s } = surface('<div data-keys="arrow_down=line-next enter=submit space=program"><p>text</p></div>');
    h.write(focus("s"));
    h.take();
    for (const k of ["arrow_down", "enter", "space", "a"]) assert.equal(h.key(k), false, k);
    assert.deepEqual(sent(h), ["\x1b[B\r a"]);
    assert.equal(h.keyboard, s);
    assert.equal(s.focused(), "");
    // Tab finds nothing to focus, and gives the keyboard back.
    h.key("tab");
    assert.deepEqual(sent(h), ["ev blur t="]);
  });

  test("a select picks with its keys, past disabled options, by an option's label; each pick sends input and change at once (SPEC §10.2)", () => {
    const { h } = surface('<select id=s data-on=input><option>a<option label=Bee>b<option disabled>c<option>d</select>');
    h.write(focus("s", "s"));
    h.take();
    for (const k of ["arrow_down", "arrow_down", "arrow_down", "shift+b", "page_down", "page_up", "arrow_up", "space", "enter"]) {
      assert.ok(h.key(k), `${k} on a select`);
    }
    const pick = (v: string, rev: number) => [`ev input t=s {"value":"${v}","rev":${rev}}`, `ev change t=s {"value":"${v}","rev":${rev}}`];
    assert.deepEqual(sent(h), [...pick("b", 1), ...pick("d", 2), ...pick("b", 3), ...pick("d", 4), ...pick("a", 5)]);

    // Choosing from a list, as the user does with the pointer, is a pick too.
    h.choose("s", "s", "d");
    assert.deepEqual(sent(h), pick("d", 6));
  });
});

describe("Host keys in a field", () => {
  test("the caret starts at the end of the field's value, and stays where the keys leave it", () => {
    const { h } = surface("<input id=f value=abc data-on=input>");
    h.write(focus("s", "f"));
    h.take();
    for (const k of ["x", "arrow_left", "arrow_left", "y"]) h.key(k);
    assert.deepEqual(sent(h), ['ev input t=f {"value":"abcx","rev":1}', 'ev input t=f {"value":"abycx","rev":2}']);
  });

  test("fill leaves the caret at the end of its text, with nothing selected", () => {
    const { h } = surface("<input id=f value=abc data-on=input>");
    h.write(focus("s", "f"));
    h.take();
    for (const k of ["shift+arrow_left", "shift+arrow_left"]) assert.ok(h.key(k), k);
    h.fill("s", "f", "xyz");
    h.key("q");
    assert.deepEqual(sent(h), ['ev input t=f {"value":"xyz","rev":1}', 'ev input t=f {"value":"xyzq","rev":2}']);
  });
});

describe("Host drags with steps", () => {
  const doc_ =
    "<i id=track data-on=drag data-steps=20>t</i><i id=pad data-on=drag data-steps='0 4'>p</i>" +
    "<i id=bad data-on=drag data-steps='2.5'>b</i><i id=other data-on=drag>o</i>" +
    "<i id=max data-on=drag data-steps='1 9007199254740991'>m</i><i id=big data-on=drag data-steps='1 9007199254740992'>g</i>";

  test("a drag of an element with data-steps says where in it the pointer is, as the test gives it: clamped, measured against the element the drag began on, a drag each time it changes (SPEC §9.1)", () => {
    const h = new Host();
    h.write(doc("s", doc_) + place("s", { cols: 10, rows: 4 }));
    h.take();
    h.dragStartStep("s", "track", 0, 0, 3, 9);
    h.dragMoveStep("track", 1, 0, 3, 0); // the same element and step: nothing
    h.dragMoveStep("track", 2, 0, 5, 0); // another step: drag
    h.dragMoveStep("", 2, 2, 5, 0); // off the track, at the same step
    h.dragMoveStep("", 9, 2, 99, 0); // past its end: clamped
    h.dragMove("other", 5, 3); // a move with no step keeps the last
    h.dragEndStep("", -4, 3, -1, 0);
    assert.deepEqual(sent(h), [
      'ev dragstart t=track {"c":0,"r":0,"x":3}',
      'ev drag t=track {"c":2,"r":0,"x":5}',
      'ev drag t= {"c":2,"r":2,"x":5}',
      'ev drag t= {"c":9,"r":2,"x":20}',
      'ev drag t=other {"c":5,"r":3,"x":20}',
      'ev dragend t= {"c":-4,"r":3,"x":0}',
    ]);
    // Only the axes an element counts; a value that is not one or two whole
    // numbers up to 2^53 − 1 counts none.
    h.dragStartStep("s", "pad", 0, 1, 7, 2);
    h.dragEndStep("pad", 0, 1, 7, 3);
    h.dragStartStep("s", "bad", 0, 2, 1, 1);
    h.dragEnd("bad", 0, 2);
    h.dragStartStep("s", "max", 0, 3, 1, 2 ** 40);
    h.dragEnd("max", 0, 3);
    h.dragStartStep("s", "big", 0, 3, 1, 1);
    h.dragEnd("big", 0, 3);
    assert.deepEqual(sent(h), [
      'ev dragstart t=pad {"c":0,"r":1,"y":2}',
      'ev dragend t=pad {"c":0,"r":1,"y":3}',
      'ev dragstart t=bad {"c":0,"r":2}',
      'ev dragend t=bad {"c":0,"r":2}',
      `ev dragstart t=max {"c":0,"r":3,"x":1,"y":${2 ** 40}}`,
      `ev dragend t=max {"c":0,"r":3,"x":1,"y":${2 ** 40}}`,
      'ev dragstart t=big {"c":0,"r":3}',
      'ev dragend t=big {"c":0,"r":3}',
    ]);
    const steps = h.events().filter((e) => e.kind.startsWith("drag")).map((e) => [e.drag()?.x, e.drag()?.y]);
    assert.deepEqual(steps.slice(0, 2), [[3, undefined], [5, undefined]], "Event.drag() reads the steps");
  });
});

describe("Host drops", () => {
  const doc_ =
    "<i id=card data-on=drag>c</i><i id=ada data-on=drop>Ada</i><i id=col data-on=drop data-steps='3 2'>col</i>" +
    "<i id=row data-on='drag click'><b id=pin data-on=drop>p</b></i><i id=knob data-on=drag data-steps=4>k</i>";

  test("a host takes a drop-only t, never drags it, reports where in a t with steps the pointer is, and a release on a drop-only element inside the one dragged is its click (SPEC §9.1)", () => {
    const h = new Host();
    h.write(doc("s", doc_) + place("s", { cols: 10, rows: 6 }));
    h.take();
    h.dragStart("s", "card", 1, 0);
    h.dragMove("ada", 1, 1); // a drop-only t
    h.dragMove("col", 1, 2); // a t with steps, at step 0 of it
    h.dragOver("col", 2, 2, 0, 0); // the same step: nothing
    h.dragOver("col", 2, 3, 1, 1); // another step: drag
    h.dragOver("col", 4, 4, 9, 2); // past the count: clamped
    h.dragEndOver("col", 4, 4, 3, 2);
    assert.deepEqual(sent(h), [
      'ev dragstart t=card {"c":1,"r":0}',
      'ev drag t=ada {"c":1,"r":1}',
      'ev drag t=col {"c":1,"r":2,"tx":0,"ty":0}',
      'ev drag t=col {"c":2,"r":3,"tx":1,"ty":1}',
      'ev drag t=col {"c":4,"r":4,"tx":3,"ty":2}',
      'ev dragend t=col {"c":4,"r":4,"tx":3,"ty":2}',
    ]);
    const steps = h.events().filter((e) => e.kind.startsWith("drag")).map((e) => [e.drag()?.tx, e.drag()?.ty]);
    assert.deepEqual(steps.slice(1, 3), [[undefined, undefined], [0, 0]], "Event.drag() reads tx and ty");

    assert.throws(() => h.dragStart("s", "ada", 1, 1), /no element with an id opts in/);
    h.dragStart("s", "pin", 1, 5);
    h.dragEnd("pin", 1, 5);
    assert.deepEqual(sent(h), ['ev dragstart t=row {"c":1,"r":5}', 'ev dragend t=pin {"c":1,"r":5}', "ev click t=row"]);

    // A t that only opts in to drags has no steps in it.
    h.dragStart("s", "card", 1, 0);
    h.dragOver("knob", 1, 6, 2, 0);
    h.dragEndOver("knob", 1, 6, 3, 0);
    assert.deepEqual(sent(h), [
      'ev dragstart t=card {"c":1,"r":0}',
      'ev drag t=knob {"c":1,"r":6}',
      'ev dragend t=knob {"c":1,"r":6}',
    ]);
  });
});

describe("Host 0.5", () => {
  const controls = (h: Host) => h.replies().map((r) => Object.fromEntries(r.control));

  test("a delta is checked whole: a malformed op rejects it all, with its index; a missing target fails its op alone, the others apply (SPEC §6.1)", () => {
    const h = new Host({ lenient: true });
    h.write(doc("s", "<p id=a>a</p><p id=b>b</p>") + place("s", { cols: 10, rows: 2 }));
    const s = h.surface("s")!;
    h.take();
    h.write(delta("s", [text("a", "A"), { op: "frob", target: "a" }, text("b", "B")], { n: 1 }));
    assert.deepEqual([s.textOf("a"), s.textOf("b")], ["a", "b"], "none applied");
    h.write(delta("s", [text("a", "A"), remove("nope"), text("b", "B"), remove("also-not")], { n: 2 }));
    assert.deepEqual([s.textOf("a"), s.textOf("b")], ["A", "B"], "the ops after the failed one still apply");
    const [bad, missing] = h.replies().map((r) => r.reply()!);
    assert.deepEqual([bad!.code, bad!.op, bad!.n], ["EINVAL", 1, 1]);
    assert.deepEqual([missing!.code, missing!.detail, missing!.op, missing!.err()!.op], ["ENOTARGET", "nope", 1, 1]);
    // An error that is not a delta's names no op.
    h.write(focus("nope", "", { n: 3 }));
    assert.equal(h.replies().at(-1)!.reply()!.op, undefined);
  });

  test("errors only, unless asked: q is 1 without n, 0 with it, and the query is always answered (SPEC §3.5)", () => {
    const h = new Host({ lenient: true });
    h.write(query(1));
    h.write(doc("s", "<p>x</p>") + delta("s", [text("nope", "x")]) + blur("s"));
    assert.deepEqual(controls(h), [{ a: "ok", n: "1", re: "q" }], "a doc, a delta with q=2 and a blur say nothing");
    h.write(place("s", { cols: 0 }));
    h.write(blur("nope", { q: 1 }));
    assert.deepEqual(controls(h).slice(1), [
      { a: "err", s: "s", re: "place" },
      { a: "err", s: "nope", re: "blur" },
    ]);
    h.write(doc("s", "<p>x</p>", { n: 5 }));
    assert.deepEqual(controls(h).at(-1), { a: "ok", n: "5", s: "s", re: "doc" });
  });

  test("p, f and v hold on the surface until the program turns them off (SPEC §5.2)", () => {
    const h = new Host();
    h.write(doc("s", "<button id=b>b</button>") + place("s", { cols: 10, rows: 1, press: true, hover: true }));
    const s = h.surface("s")!;
    assert.deepEqual([s.press, s.fit, s.hover], [true, false, true]);
    h.write(place("s", { cols: 10, rows: 1 }));
    assert.deepEqual([s.press, s.fit, s.hover], [true, false, true], "a placement without them leaves them");
    h.take();
    h.press("s", "b");
    h.write(place("s", { cols: 10, rows: 1, press: false, fit: true }));
    assert.deepEqual([s.press, s.fit, s.hover], [false, true, true]);
    assert.throws(() => h.press("s", "b"), /did not ask for presses/);
  });

  test("events carry mods as bits, and t is absent where no element is meant (SPEC §9)", () => {
    const { h } = surface("<button id=b>b</button><a id=l href=/x>l</a>");
    h.write(place("s", { cols: 10, rows: 1, press: true }));
    h.take();
    h.click("s", "b", ["shift", "ctrl"]);
    h.click("s", "b");
    h.press("s", "", ["super"]);
    h.press("s", "");
    h.click("s", "l", ["alt"]);
    const got = h.events().map((e) => [e.kind, e.target, e.mods()]);
    assert.deepEqual(got, [
      ["press", "b", 5],
      ["focus", "b", 0],
      ["click", "b", 5],
      ["press", "b", 0],
      ["click", "b", 0],
      ["press", "", 8],
      ["press", "", 0],
    ]);
    // blur and fit have no t on the wire.
    h.blur("s");
    assert.equal(h.events().at(-1)!.message.get("t"), undefined);
  });

  test("a drag's keys are mods, left out when none is held", () => {
    const { h } = surface("<i id=d data-on=drag>d</i>");
    h.take();
    h.dragStart("s", "d", 1, 1, ["shift"]);
    h.dragMove("", 2, 1, ["shift", "super"]);
    h.dragEnd("", 2, 1);
    assert.deepEqual(
      h.events().filter((e) => e.kind.startsWith("drag")).map((e) => [e.kind, e.mods(), e.drag()]),
      [["dragstart", 1, { c: 1, r: 1 }], ["drag", 9, { c: 2, r: 1 }], ["dragend", 0, { c: 2, r: 1 }]],
    );
  });

  test("change tells the program what differs, once it has asked: the empty value for a field that became absent; a zoom alone says nothing (SPEC §4, §9)", () => {
    const h = new Host();
    h.change((c) => (c.mod = "super"));
    assert.deepEqual(h.events(), [], "the program has not asked");
    h.write(query(1));
    h.take();
    h.change((c) => {
      c.mod = "super";
      c.cellcss = { w: 10, h: 20 };
    });
    h.change((c) => (c.scale = 2));
    h.change((c) => {
      c.edit = { copy: ["super+c"] };
      c.mod = undefined;
    });
    h.change((c) => (c.edit = undefined));
    const changed = h.events().map((e) => e.changed());
    assert.deepEqual(changed.map((c) => Object.keys(c!.raw)), [["cellcss"], ["scale", "mod", "edit"], ["edit"]]);
    // The zoom was not told, so the next change tells it with the rest.
    assert.deepEqual([changed[0]!.cellCss, changed[1]!.raw.mod, changed[1]!.edit, changed[2]!.raw.edit], [{ w: 10, h: 20 }, "", { copy: ["super+c"] }, {}]);
    let folded = h.caps;
    for (const c of changed) folded = folded.merge(c!);
    assert.deepEqual([folded.mod, folded.edit, folded.cellCss], [undefined, undefined, { w: 10, h: 20 }]);
    // The event has no s and no t.
    assert.deepEqual(Object.fromEntries(h.events()[0]!.message.control), { a: "ev", e: "caps" });
  });

  test("a new cell size lays the documents out again: a surface that asked for fit may hear it", () => {
    let rows = 2;
    const h = new Host({ autoRows: () => rows });
    h.write(doc("s", "<p>x</p>") + place("s", { cols: 10, rows: 2, fit: true }));
    h.write(query(1));
    h.take();
    rows = 3;
    h.change((c) => (c.cellcss = { w: 7, h: 14 }));
    assert.deepEqual(sent(h).filter((l) => l.startsWith("ev fit")), ['ev fit t= {"r":3}']);
  });

  test("a key the keymap binds to prefix reaches the program, and so does every key after it, until a=focus (SPEC §10.5)", () => {
    const { h } = surface("<div data-keys='ctrl+b=prefix'><button id=b>b</button><input id=i></div>");
    h.write(focus("s", "b"));
    h.take();
    assert.equal(h.prefix, "");
    assert.equal(h.key("ctrl+b"), false, "the prefix reaches the program");
    assert.equal(h.prefix, "s");
    assert.deepEqual([h.key("enter"), h.key("tab"), h.key("escape"), h.key("x")], [false, false, false, false]);
    assert.equal(h.surface("s")!.focused(), "b", "nothing moved focus");
    assert.equal(sent(h).join(""), "\x02\r\t\x1bx", "as the terminal sends them");
    h.write(focus("s"));
    assert.equal(h.prefix, "");
    h.take();
    h.key("enter");
    assert.deepEqual(sent(h), ["ev click t=b"], "the keys are the surface's again");
    // In a text field the prefix is not the field's either.
    h.write(focus("s", "i"));
    h.key("ctrl+b");
    h.key("a");
    assert.equal(h.surface("s")!.value("i") ?? "", "");
    h.click("s", "b");
    assert.equal(h.prefix, "", "a press that focuses ends it");
  });

  test("the program's menu, per screen: the level shown, hidden by Escape and by a key it does not list, and picks by name (SPEC §10.7)", () => {
    const h = new Host();
    h.write(
      menu({
        items: [
          { key: "space", label: "Leader", items: [{ key: "f", label: "File", name: "file" }, { key: "q", label: "Quit", name: "quit" }] },
          { label: "Reload", name: "reload" },
          { label: "Off", name: "off", enabled: false },
        ],
      }),
    );
    assert.deepEqual(h.shown(), [], "sending a menu shows nothing");
    h.write(menuShow());
    assert.deepEqual(h.shown().map((i) => i.key), ["space"]);
    h.write(menuShow(["space"]));
    assert.deepEqual(h.shown().map((i) => i.key), ["f", "q"]);
    h.type("\x1b");
    assert.deepEqual(h.shown(), [], "Escape hides it");
    h.write(menuShow(["space"]));
    h.key("f");
    assert.equal(h.shown().length, 2, "a key it lists keeps it");
    h.key("z");
    assert.deepEqual(h.shown(), [], "a key it does not list hides it");
    h.write(menuShow(["space"]));
    h.write(menuHide());
    assert.deepEqual(h.shown(), []);
    h.write(menuShow(["Nope"]));
    assert.deepEqual(h.shown(), [], "keys that reach no group show nothing");
    h.take();
    assert.equal(h.pick("reload"), true);
    assert.equal(h.pick("off"), false, "disabled");
    assert.equal(h.pick("nope"), false);
    const [cmd] = h.events();
    assert.deepEqual([cmd!.kind, cmd!.surface, cmd!.target, cmd!.command()], ["command", "", "", { name: "reload", key: "" }]);
    // The alternate screen keeps its own menu, and leaving drops it.
    h.write("\x1b[?1049h");
    assert.equal(h.menu(), undefined);
    h.write(menu({ items: [{ name: "alt" }] }));
    assert.equal(h.pick("alt"), true);
    assert.equal(h.pick("reload"), false);
    h.write("\x1b[?1049l");
    assert.equal(h.menu()!.items.length, 3, "the main screen's is back");
    assert.equal(h.pick("alt"), false);
    h.write("\x1bc");
    assert.equal(h.menu(), undefined, "a full reset drops both");
  });

  test("a host without the feature menu answers a=menu EINVAL; show is 0 or 1", () => {
    const h = new Host({ caps: { features: ["hover"] }, lenient: true });
    h.write(menu({ items: [] }, { n: 1 }));
    assert.deepEqual([h.replies().at(-1)!.reply()!.code, h.errors().length], ["EINVAL", 1]);
    const m = new Host({ lenient: true });
    m.write(encode([["a", "menu"], ["show", "2"], ["n", "1"]]));
    assert.equal(m.replies().at(-1)!.reply()!.code, "EINVAL");
    m.write(encode([["a", "menu"], ["n", "2"]], new Uint8Array([0xc1])));
    assert.equal(m.replies().at(-1)!.reply()!.code, "EINVAL", "a body that is no menu");
  });

  test("the program's touch areas, per screen: the alternate screen keeps its own, leaving drops them, a reset drops both; no map of areas is EINVAL (SPEC §9.6)", () => {
    const h = new Host();
    assert.deepEqual(h.touchAreas(), []);
    const slider: TouchArea[] = [
      { c: 2, r: 3, w: 10, h: 1, drag: "x" },
      { c: 0, r: 5, w: 1, h: 4, drag: "y" },
    ];
    h.write(touch(slider));
    assert.deepEqual(h.touchAreas(), slider);
    h.touchAreas()[0]!.c = 99;
    assert.equal(h.touchAreas()[0]!.c, 2, "touchAreas is a copy");
    h.write("\x1b[?1049h");
    assert.deepEqual(h.touchAreas(), [], "the alternate screen has its own");
    const knob: TouchArea[] = [{ c: 1, r: 1, w: 1, h: 1, drag: "xy" }];
    h.write(touch(knob));
    assert.deepEqual(h.touchAreas(), knob);
    h.write("\x1b[?1049l");
    assert.deepEqual(h.touchAreas(), slider, "the main screen's are back");
    h.write("\x1b[?1049h");
    assert.deepEqual(h.touchAreas(), [], "leaving the alternate screen dropped its own");
    h.write(touch(knob) + "\x1bc");
    assert.deepEqual(h.touchAreas(), [], "a full reset, on the alternate screen");
    h.write("\x1b[?1049l");
    assert.deepEqual(h.touchAreas(), [], "and on the main");
    h.write(touch(slider) + touch());
    assert.deepEqual(h.touchAreas(), [], "a=touch with no areas leaves none");
    // What is no map of areas is EINVAL, and keeps the areas there were.
    const l = new Host({ lenient: true });
    l.write(touch(slider));
    for (const body of [
      ["x"],
      {},
      { areas: { c: 0 } },
      { areas: [1] },
      { areas: [{ c: 0, r: 0, w: 1, drag: "x" }] },
      { areas: [{ c: new Float(1), r: 0, w: 1, h: 1, drag: "x" }] },
      { areas: [{ c: 0, r: 0, w: 1, h: 1, drag: 1 }] },
      { areas: [{ c: 0, r: -1, w: 1, h: 1, drag: "x" }] },
      { areas: [{ c: 0, r: 0, w: 0, h: 1, drag: "x" }] },
      { areas: [{ c: 0, r: 0, w: 1, h: 1, drag: "yx" }] },
    ]) {
      l.write(encode([["a", "touch"], ["n", "1"]], pack(body)));
      assert.equal(l.replies().at(-1)!.reply()!.code, "EINVAL", JSON.stringify(body));
      assert.deepEqual(l.touchAreas(), slider, JSON.stringify(body));
    }
    const many: TouchArea[] = Array.from({ length: TOUCH_MAX + 1 }, (_, i) => ({ c: i % 80, r: Math.floor(i / 80), w: 1, h: 1, drag: "x" }));
    l.write(touch(many, { n: 2 }));
    assert.equal(l.replies().at(-1)!.reply()!.code, "EINVAL", "257 areas");
    l.write(touch(many.slice(0, TOUCH_MAX), { n: 3 }));
    assert.equal(l.replies().at(-1)!.reply()!.code, undefined, "256 areas");
    assert.equal(l.touchAreas().length, TOUCH_MAX);
    l.write(encode([["a", "touch"], ["n", "4"]], pack({ areas: [], more: 1 })));
    assert.equal(l.replies().at(-1)!.reply()!.code, undefined, "a key not known");
    assert.deepEqual(l.touchAreas(), []);
  });

  test("without the feature hover the host never says where the pointer is", () => {
    const h = new Host({ caps: { features: [] } });
    h.write(doc("s", "<i id=a>a</i>") + place("s", { cols: 10, rows: 1, hover: true }));
    h.take();
    h.hover("s", "a", 1, 0);
    h.unhover();
    assert.deepEqual(h.events(), []);
  });
});
