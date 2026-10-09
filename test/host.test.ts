// The test host where the host vectors cannot see. Its morph (SPEC §6.2):
// the vectors inspect a document's markup, not which elements stayed the
// same, and with them what the user did there. Scroll and area (SPEC §5.1,
// §9), whose host vectors land with the hosts. And keys (SPEC §10.2) on
// every kind of element, beyond the vectors'.

import assert from "node:assert/strict";

import { Decoder, doc, focus, morphTo, place, placeAt, SCROLL_HORIZONTAL, SCROLL_VERTICAL } from "../src/index.ts";
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

  test("a document's scroll axes are its own; a host without scroll ignores them", () => {
    const h = new Host();
    h.write(doc("s", "<ul><li>a</li></ul>", { scroll: SCROLL_VERTICAL | SCROLL_HORIZONTAL }) + place("s", { cols: 10, rows: 2 }));
    assert.equal(h.surface("s")!.scroll, 3);
    assert.equal(h.caps.scroll, true);
    h.write(doc("s", "<p>b</p>"));
    assert.equal(h.surface("s")!.scroll, 0, "a new document without it does not scroll");
    h.write(doc("s", "<p>b</p>", { scroll: 4 }));
    assert.equal(h.surface("s")!.scroll, 0, "anything but 1, 2 or 3 does not scroll");
    const old = new Host({ caps: { scroll: false } });
    old.write(doc("s", "<p>c</p>", { scroll: SCROLL_VERTICAL }));
    assert.equal(old.surface("s")!.scroll, 0);
    assert.equal(old.caps.scroll, false);
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
    for (const k of ["A", "d", "a", "Backspace", "Space", "Shift+A"]) assert.ok(h.key(k), `${k} in a text field`);
    assert.deepEqual(sent(h), [
      'ev input t=name {"value":"A"}',
      'ev input t=name {"value":"Ad"}',
      'ev input t=name {"value":"Ada"}',
      'ev input t=name {"value":"Ad"}',
      'ev input t=name {"value":"Ad "}',
      'ev input t=name {"value":"Ad A"}',
    ]);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      h.key("Tab");
      order.push(s.focused());
    }
    assert.deepEqual(order, ["notes", "ok", "size", "go"]);
    assert.deepEqual(sent(h), ['ev change t=name {"value":"Ad A"}']);

    // Shift+Tab goes back; a key with Control is the program's.
    h.key("Shift+Tab");
    assert.equal(s.focused(), "size");
    assert.equal(h.key("Control+s"), false);
    assert.deepEqual(sent(h), ["\x13"]);

    // A select picks by the arrows and by the first letter.
    for (const k of ["ArrowDown", "l", "Home", "ArrowUp"]) h.key(k);
    assert.deepEqual(sent(h), [
      'ev change t=size {"value":"medium"}',
      'ev change t=size {"value":"large"}',
      'ev change t=size {"value":"small"}',
    ]);

    // Space checks a checkbox; Enter on a button clicks it.
    for (const k of ["Shift+Tab", " ", "Tab", "Tab", "Enter"]) h.key(k);
    assert.deepEqual(sent(h), ['ev change t=ok {"checked":true,"value":"yes"}', "ev click t=go"]);

    // Past the last element the surface loses the keyboard.
    h.key("Tab");
    assert.deepEqual(sent(h), ["ev blur t="]);
    assert.equal(h.key("Tab"), false);
    assert.deepEqual(sent(h), ["\t"]);

    // A textarea takes Enter as a new line; Enter in a field submits.
    h.write(focus("s", "notes"));
    for (const k of ["h", "Enter", "i", "ArrowUp"]) h.key(k);
    h.write(focus("s", "name"));
    h.key("Enter");
    assert.deepEqual(sent(h), [
      'ev change t=notes {"value":"h\\ni"}',
      'ev submit t=f {"name":"Ad A","notes":"h\\ni","ok":"yes","size":"small"}',
    ]);

    // Escape is never the surface's.
    assert.equal(h.key("Escape"), false);
    assert.deepEqual(sent(h), ["\x1b"]);
  });

  test("a key the focused element's keymap binds to program reaches the program, whatever the element; outside a text field other bindings do nothing but take a key back (SPEC §10.2)", () => {
    const { h, s } = surface(
      '<div data-keys="ArrowDown=program End=program Space=program Enter=program Tab=program">' +
        "<select id=s><option>a<option>b<option>c</select>" +
        '<select id=own data-keys="End=line-end ArrowUp=program"><option>a<option>b<option>c</select>' +
        '<button id=b data-keys="Enter=submit">B</button>' +
        "<input id=c type=checkbox>" +
        "<a id=l href=/x>L</a>" +
        "<details><summary id=m>M</summary></details>" +
        '<input id=d type=date data-keys="ArrowLeft=program">' +
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
    for (const k of ["ArrowDown", "Shift+ArrowDown", "End", "Space", "Enter"]) assert.equal(h.key(k), false, k);
    assert.deepEqual(sent(h), ["\x1b[B\x1b[B\x1b[F \r"]);
    for (const k of ["c", "ArrowUp"]) h.key(k);
    assert.deepEqual(sent(h), ['ev change t=s {"value":"c"}', 'ev change t=s {"value":"b"}']);

    // Tab cannot be bound: it moves focus. A nearer binding to another
    // action takes End back, and the select uses it.
    h.key("Tab");
    assert.equal(s.focused(), "own");
    for (const k of ["End", "ArrowUp", "ArrowDown"]) h.key(k);
    assert.deepEqual(sent(h), ['ev change t=own {"value":"c"}', "\x1b[A\x1b[B"]);

    // A button clicks with Enter, which it binds to an action of its own,
    // and gives Space to the program.
    at("b");
    for (const k of ["Enter", "Space"]) h.key(k);
    assert.deepEqual(sent(h), ["ev click t=b", " "]);

    // A checkbox, a link and a summary give the program the keys that
    // would toggle or click them.
    for (const [id, k, seq] of [
      ["c", "Space", " "],
      ["l", "Enter", "\r"],
      ["m", "Space", " "],
    ] as const) {
      at(id);
      assert.equal(h.key(k), false, `#${id} used ${k}`);
      assert.deepEqual(sent(h), [seq]);
    }

    // A date input gives the program a key its own keymap would use.
    at("d");
    assert.equal(h.key("ArrowLeft"), false);
    assert.equal(h.key("Backspace"), true);
    assert.deepEqual(sent(h), ["\x1b[D"]);

    // A text field's keymap starts from the default one: End is still the
    // program's, and the field edits with the rest.
    at("f");
    for (const k of ["x", "End", "ArrowLeft", "y"]) h.key(k);
    assert.deepEqual(sent(h), ['ev input t=f {"value":"x"}', "\x1b[F", 'ev input t=f {"value":"yx"}']);

    // Outside the div, the keys are the select's again. The field commits
    // as focus leaves it.
    h.write(focus("s", "free"));
    h.key("ArrowDown");
    assert.deepEqual(sent(h), ['ev change t=f {"value":"yx"}', 'ev change t=free {"value":"b"}']);
  });

  test("with no element focused there is no keymap: no data-keys are read, and every key but Tab reaches the program (SPEC §10.2)", () => {
    const { h, s } = surface('<div data-keys="ArrowDown=line-next Enter=submit Space=program"><p>text</p></div>');
    h.write(focus("s"));
    h.take();
    for (const k of ["ArrowDown", "Enter", "Space", "a"]) assert.equal(h.key(k), false, k);
    assert.deepEqual(sent(h), ["\x1b[B\r a"]);
    assert.equal(h.keyboard, s);
    assert.equal(s.focused(), "");
    // Tab finds nothing to focus, and gives the keyboard back.
    h.key("Tab");
    assert.deepEqual(sent(h), ["ev blur t="]);
  });

  test("a select picks with its keys, past disabled options, by an option's label; each pick sends input and change at once (SPEC §10.2)", () => {
    const { h } = surface('<select id=s data-on=input><option>a<option label=Bee>b<option disabled>c<option>d</select>');
    h.write(focus("s", "s"));
    h.take();
    for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "B", "PageDown", "PageUp", "ArrowUp", "Space", "Enter"]) {
      assert.ok(h.key(k), `${k} on a select`);
    }
    const pick = (v: string) => [`ev input t=s {"value":"${v}"}`, `ev change t=s {"value":"${v}"}`];
    assert.deepEqual(sent(h), [...pick("b"), ...pick("d"), ...pick("b"), ...pick("d"), ...pick("a")]);

    // Choosing from a list, as the user does with the pointer, is a pick too.
    h.choose("s", "s", "d");
    assert.deepEqual(sent(h), pick("d"));
  });
});

describe("Host keys in a field", () => {
  test("the caret starts at the end of the field's value, and stays where the keys leave it", () => {
    const { h } = surface("<input id=f value=abc data-on=input>");
    h.write(focus("s", "f"));
    h.take();
    for (const k of ["x", "ArrowLeft", "ArrowLeft", "y"]) h.key(k);
    assert.deepEqual(sent(h), ['ev input t=f {"value":"abcx"}', 'ev input t=f {"value":"abycx"}']);
  });
});
