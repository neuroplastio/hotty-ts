// The msgpack reader and writer (SPEC §3.3, SDK.md §3.9), at their edges:
// every form of each type, floats kept apart from ints, depth, ints past
// 2^53 − 1, nil and keys that are not strs, what does not decode, and
// timestamps.

import assert from "node:assert/strict";

import { CAPS, DETAIL } from "../src/bodies.ts";
import { Float, MAX_DEPTH, pack, readBody, Time, type Type, unpack } from "../src/msgpack.ts";
import { describe, test } from "./harness.ts";

const hex = (s: string) => new Uint8Array(Buffer.from(s.replace(/\s+/g, ""), "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const str = (n: number) => "a".repeat(n);
const strHex = (n: number) => "61".repeat(n);
const doesNotDecode = (b: Uint8Array, why: RegExp) => assert.throws(() => unpack(b), (e: unknown) => e instanceof SyntaxError && why.test(e.message));

describe("msgpack: unpack", () => {
  test("each form of an int is an int: fixint, uint 8 to 64, int 8 to 64", () => {
    const cases: [string, number][] = [
      ["00", 0],
      ["7f", 127],
      ["ff", -1],
      ["e0", -32],
      ["cc80", 128],
      ["ccff", 255],
      ["cd0100", 256],
      ["cdffff", 65535],
      ["ce00010000", 65536],
      ["ceffffffff", 2 ** 32 - 1],
      ["cf0000000100000000", 2 ** 32],
      ["cf001fffffffffffff", Number.MAX_SAFE_INTEGER],
      ["d0df", -33],
      ["d080", -128],
      ["d1ff7f", -129],
      ["d18000", -32768],
      ["d2ffff7fff", -32769],
      ["d280000000", -(2 ** 31)],
      ["d3ffffffff7fffffff", -(2 ** 31) - 1],
      ["d3ffe0000000000001", Number.MIN_SAFE_INTEGER],
      ["d00a", 10], // a wider form than the value needs
      ["cf0000000000000007", 7],
    ];
    for (const [h, want] of cases) {
      assert.equal(unpack(hex(h)), want, h);
      assert.equal(unpack(hex(h), { floats: true }), want, `${h}, floats kept`);
      assert.deepEqual(readBody(hex("81a172" + h), { r: "int" }), { r: want }, `${h} as an int field`);
    }
  });

  test("an int further than 2^53 − 1 from zero does not decode, in any form", () => {
    doesNotDecode(hex("cf0020000000000000"), /2\^53/); // 2^53
    doesNotDecode(hex("cfffffffffffffffff"), /2\^53/); // 2^64 − 1
    doesNotDecode(hex("d3ffe0000000000000"), /2\^53/); // −2^53
    doesNotDecode(hex("d38000000000000000"), /2\^53/); // −2^63
    // Where no field is known, the body does not decode all the same.
    assert.equal(readBody(hex("82a176a3302e32a178cf0020000000000000"), { v: "str" }), undefined);
  });

  test("a float of 32 or 64 bits is a float, a Float when floats are kept, and not an int even when whole", () => {
    assert.equal(unpack(hex("cb4000000000000000")), 2);
    assert.deepEqual(unpack(hex("cb4000000000000000"), { floats: true }), new Float(2));
    assert.deepEqual(unpack(hex("ca40000000"), { floats: true }), new Float(2));
    assert.deepEqual(unpack(hex("ca43a04000"), { floats: true }), new Float(320.5));
    assert.deepEqual(unpack(hex("cb4074080000000000"), { floats: true }), new Float(320.5));
    assert.ok(Number.isNaN(unpack(hex("cb7ff8000000000000"))));
    assert.equal(unpack(hex("ca7f800000")), Infinity);
    assert.deepEqual(unpack(hex("92cb3ff000000000000001"), { floats: true }), [new Float(1), 1]);
    // As a field's type: a float is not an int, and an int not a float.
    assert.deepEqual(readBody(hex("81a177ca43a04000"), { w: "float" }), { w: 320.5 });
    assert.deepEqual(readBody(hex("81a177cb4048000000000000"), { w: "float" }), { w: 48 });
    assert.equal(readBody(hex("81a17730"), { w: "float" }), undefined, "48 for a float");
    assert.equal(readBody(hex("81a172cb401c000000000000"), { r: "int" }), undefined, "7.0 for an int");
    assert.equal(readBody(hex("81a172ca40e00000"), { r: "int" }), undefined, "7.0 of 32 bits for an int");
  });

  test("each form of a str is a str: fixstr, str 8, 16 and 32, as UTF-8", () => {
    assert.equal(unpack(hex("a0")), "");
    assert.equal(unpack(hex("a3616263")), "abc");
    assert.equal(unpack(hex("bf" + strHex(31))), str(31));
    assert.equal(unpack(hex("d920" + strHex(32))), str(32));
    assert.equal(unpack(hex("d903616263")), "abc");
    assert.equal(unpack(hex("da0100" + strHex(256))), str(256));
    assert.equal(unpack(hex("da00026162")), "ab");
    assert.equal(unpack(hex("db00010000" + strHex(65536))), str(65536));
    assert.equal(unpack(hex("db000000026162")), "ab");
    assert.equal(unpack(hex("a4e282ac21")), "€!");
    assert.equal(unpack(hex("a3efbbbf")), "﻿", "a BOM is a character like any other");
    doesNotDecode(hex("a2c328"), /UTF-8/);
    doesNotDecode(hex("a3eda080"), /UTF-8/); // a surrogate
  });

  test("true and false; bin of 8, 16 and 32 bits is a Uint8Array", () => {
    assert.equal(unpack(hex("c3")), true);
    assert.equal(unpack(hex("c2")), false);
    assert.deepEqual(unpack(hex("c40200ff")), new Uint8Array([0, 255]));
    assert.deepEqual(unpack(hex("c50002 0102")), new Uint8Array([1, 2]));
    assert.deepEqual(unpack(hex("c600000001 07")), new Uint8Array([7]));
    assert.deepEqual(unpack(hex("c400")), new Uint8Array(0));
  });

  test("each form of an array and a map: fix, 16 and 32 bits", () => {
    assert.deepEqual(unpack(hex("90")), []);
    assert.deepEqual(unpack(hex("93010203")), [1, 2, 3]);
    assert.deepEqual(unpack(hex("dc0002 0102")), [1, 2]);
    assert.deepEqual(unpack(hex("dd00000002 0102")), [1, 2]);
    assert.deepEqual(unpack(hex("dc0010" + "01".repeat(16))), new Array(16).fill(1));
    assert.deepEqual(unpack(hex("80")), {});
    assert.deepEqual(unpack(hex("82a16101a162a3787978")), { a: 1, b: "xyx" });
    assert.deepEqual(unpack(hex("de0001 a16101")), { a: 1 });
    assert.deepEqual(unpack(hex("df00000001 a16101")), { a: 1 });
    // A key twice: the last one stands.
    assert.deepEqual(unpack(hex("82a16101a16102")), { a: 2 });
  });

  test("a nil does not decode, anywhere: the value, in an array, a field known or not, a key, at any depth", () => {
    for (const h of ["c0", "9201c0", "81a178c0", "81c0a178", "82a178c3a179c0", "81a178 81a179 91c0"]) doesNotDecode(hex(h), /nil/);
    assert.equal(readBody(hex("81a176c0"), { v: "str" }), undefined, "in a known field");
    assert.equal(readBody(hex("82a176a3302e32a178c0"), { v: "str" }), undefined, "in a field no one knows");
    assert.equal(readBody(hex("81a6 6c696d697473 81a173c0"), { limits: { "*": "int" } }), undefined, "in a map from strings");
    // The vectors' (SDK.md §3.9): in a field no one knows, a known one, and an event's detail.
    assert.equal(readBody(hex("83a176a3302e32a6667574757265c0a67363726f6c6cc3"), CAPS), undefined);
    assert.equal(readBody(hex("82a176a3302e32a57363616c65c0"), CAPS), undefined);
    assert.equal(readBody(hex("82a7636865636b6564c0a576616c7565a161"), DETAIL.get("change")!), undefined);
  });

  test("a map's key that is not a str does not decode, whatever its type and wherever the map is", () => {
    // An int, a negative one, bin, a bool, a float, an array, a map, a time, another extension.
    const keys = ["01", "ff", "c40178", "c3", "cb3ff0000000000000", "91a178", "81a178a179", "d6ff00000000", "d40500"];
    for (const k of keys) {
      doesNotDecode(hex("81" + k + "a161"), /for a key/);
      doesNotDecode(hex("82a161c3" + k + "a161"), /for a key/);
      doesNotDecode(hex("91 81" + k + "a161"), /for a key/);
      assert.equal(readBody(hex("82a176a3302e32" + k + "a161"), { v: "str" }), undefined, `${k}, the body's own key`);
      assert.equal(readBody(hex("82a176a3302e32 a178 81" + k + "a161"), { v: "str" }), undefined, `${k}, in a field no one knows`);
      assert.equal(readBody(hex("81 a4 63656c6c 81" + k + "02"), { cell: { w: "int" } }), undefined, `${k}, in a known map`);
      assert.equal(readBody(hex("81 a6 6c696d697473 81" + k + "02"), { limits: { "*": "int" } }), undefined, `${k}, in a map from strings`);
    }
    // A key is a str like any other: one that is not UTF-8 does not decode.
    doesNotDecode(hex("81 a2c328 a161"), /UTF-8/);
    // The vectors' (SDK.md §3.9): an int and bin in a field no one knows, an int as the body's own key.
    assert.equal(readBody(hex("83a176a3302e32a66675747572658101a161a67363726f6c6cc3"), CAPS), undefined);
    assert.equal(readBody(hex("83a176a3302e32a666757475726581c40178a161a67363726f6c6cc3"), CAPS), undefined);
    assert.equal(readBody(hex("83a176a3302e3201a161a67363726f6c6cc3"), CAPS), undefined);
    assert.deepEqual(readBody(hex("81 a6 6c696d697473 81 a17301"), { limits: { "*": "int" } }), { limits: { s: 1 } });
  });

  test("__proto__ is a field like any other", () => {
    const v = unpack(hex("81 a9 5f5f70726f746f5f5f 81a16101")) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(v), Object.prototype);
    assert.ok(Object.hasOwn(v, "__proto__"));
    assert.deepEqual(Object.keys(v), ["__proto__"]);
    const f = readBody(hex("81 a9 5f5f70726f746f5f5f a178"), { "*": "str" })!;
    assert.equal(Object.getPrototypeOf(f), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(f, "__proto__")?.value, "x");
  });

  test("bytes after the value, a value cut short, or 0xc1 do not decode", () => {
    doesNotDecode(hex(""), /cut short/);
    doesNotDecode(hex("c3c3"), /after/);
    doesNotDecode(hex("81a576616c7565a3796573c3"), /after/);
    doesNotDecode(hex("c1"), /0xc1/);
    doesNotDecode(hex("91c1"), /0xc1/);
    // A length past the bytes left, before anything is made that long.
    doesNotDecode(hex("ddffffffff"), /cut short/);
    doesNotDecode(hex("dfffffffff00"), /cut short/);
    doesNotDecode(hex("dbffffffff61"), /cut short/);
    doesNotDecode(hex("c9ffffffffff"), /cut short/);
    // A body cut at each of its bytes.
    const body = hex("85 a176a3302e32 a5 7363616c65 cb4000000000000000 a4 63656c6c 82a17710a16820 a3 6f7073 92a56d6f727068a474657874 a1 74 d6ff00000001");
    assert.equal(typeof unpack(body), "object");
    for (let n = 0; n < body.length; n++) doesNotDecode(body.subarray(0, n), /cut short/);
  });

  test(`nested ${MAX_DEPTH} levels deep decodes, the outer value being the first; ${MAX_DEPTH + 1} does not`, () => {
    // A map, then arrays inside it to the level: the innermost is empty.
    const nested = (levels: number) => hex("81a178" + "91".repeat(levels - 2) + "90");
    assert.equal(MAX_DEPTH, 32);
    assert.ok(unpack(nested(32)));
    doesNotDecode(nested(33), /nested more than 32/);
    assert.deepEqual(readBody(nested(32), { v: "str" }), { x: JSON.parse("[".repeat(31) + "]".repeat(31)) });
    assert.equal(readBody(nested(33), { v: "str" }), undefined);
    // Maps count as arrays do, and the check holds however deep it would go.
    assert.ok(unpack(hex("81a178".repeat(32) + "c3")));
    doesNotDecode(hex("81a178".repeat(33) + "c3"), /nested/);
    doesNotDecode(hex("91".repeat(100_000) + "90"), /nested/);
    // A str or an ext is no level.
    assert.ok(unpack(hex("91".repeat(31) + "a0")));
    assert.ok(unpack(hex("91".repeat(31) + "d6ff00000000")));
  });

  test("a timestamp (extension −1) of 32, 64 or 96 bits is a Time; another size, or a second's nanoseconds, does not decode", () => {
    assert.deepEqual(unpack(hex("d6ff00000000")), new Time(0, 0));
    assert.deepEqual(unpack(hex("d6ff5f5e1000")), new Time(1_600_000_000, 0));
    assert.deepEqual(unpack(hex("d6ffffffffff")), new Time(2 ** 32 - 1, 0));
    // 64 bits: 30 of nanoseconds, then 34 of seconds.
    assert.deepEqual(unpack(hex("d7ff 00000005 00000001")), new Time(2 ** 32 + 1, 1));
    assert.deepEqual(unpack(hex("d7ff ee6b27fb ffffffff")), new Time(2 ** 34 - 1, 999_999_998));
    // 96 bits: nanoseconds, then signed seconds.
    assert.deepEqual(unpack(hex("c70cff 000003e8 ffffffffffffffff")), new Time(-1, 1000));
    assert.deepEqual(unpack(hex("c70cff 00000000 001fffffffffffff")), new Time(Number.MAX_SAFE_INTEGER, 0));
    doesNotDecode(hex("c70cff 00000000 0020000000000000"), /2\^53/);
    // A wider form than it needs.
    assert.deepEqual(unpack(hex("c704ff 00000005")), new Time(5, 0));
    doesNotDecode(hex("d7ff ee6b2800 00000000"), /nanoseconds/);
    doesNotDecode(hex("c70cff 3b9aca00 0000000000000000"), /nanoseconds/);
    for (const h of ["d4ff00", "d5ff0000", "d8ff" + "00".repeat(16), "c705ff0000000000", "c700ff"]) doesNotDecode(hex(h), /timestamp of/);
    const t = unpack(hex("d7ff 00f42400 5f5e1000")) as Time; // 1 600 000 000 s and 4 000 000 ns
    assert.equal(t.toDate().toISOString(), "2020-09-13T12:26:40.004Z");
    assert.equal(new Time(-1, 999_000_000).toDate().getTime(), -1);
  });

  test("another extension, of any size, is skipped: undefined in an array, left out of a map", () => {
    const exts = ["d40100", "d5010000", "d60100000000", "d7010000000000000000", "d801" + "00".repeat(16), "c70001", "c70301000000", "c8000201 0000", "c900000001 7f 00"];
    for (const e of exts) {
      assert.deepEqual(unpack(hex("92" + e + "01")), [undefined, 1], e);
      assert.deepEqual(unpack(hex("82a178" + e + "a17901")), { y: 1 }, e);
    }
    // In a field of a known type it is another type.
    assert.equal(readBody(hex("81a176d40100"), { v: "str" }), undefined);
    assert.deepEqual(readBody(hex("82a176a3302e32a178d40100"), { v: "str" }), { v: "0.2" });
  });
});

describe("msgpack: a body read as its type", () => {
  const T: Type = { v: "str", n: "int", f: "float", ok: "bool", tags: ["str"], cell: { w: "int", h: "int" }, limits: { "*": "int" } };

  test("each known field as its type, the others kept whatever they are", () => {
    const b = pack({ v: "0.2", n: 3, f: 2, ok: true, tags: ["a"], cell: { w: 1, h: 2 }, limits: { s: 4 }, future: [1, 2.5, "x"] }, T);
    assert.deepEqual(readBody(b, T), { v: "0.2", n: 3, f: 2, ok: true, tags: ["a"], cell: { w: 1, h: 2 }, limits: { s: 4 }, future: [1, 2.5, "x"] });
    // A field a known map does not name is kept too.
    assert.deepEqual(readBody(pack({ cell: { w: 1, d: null, z: [true] } }), T), { cell: { w: 1, z: [true] } });
  });

  test("a known field of another type, nil among them, and the body does not decode", () => {
    const wrong: [string, unknown][] = [
      ["v", 2],
      ["n", "3"],
      ["n", new Float(3)],
      ["f", 2],
      ["ok", 1],
      ["tags", "a"],
      ["tags", ["a", 1]],
      ["cell", [1, 2]],
      ["cell", { w: 1.5 }],
      ["limits", { s: "x" }],
      ["limits", 1],
    ];
    // Written with no type, so that a whole number is an int.
    for (const [k, v] of wrong) assert.equal(readBody(pack({ [k]: v }), T), undefined, `${k}: ${JSON.stringify(v)}`);
    assert.equal(readBody(hex("81a176c0"), T), undefined, "nil for a str");
    assert.equal(readBody(hex("81a176d6ff00000000"), T), undefined, "a time for a str");
  });

  test("a body that is not one map does not decode", () => {
    for (const b of ["", "91a3796573", "a3796573", "c0", "81a176", "80c0", "c1"]) assert.equal(readBody(hex(b), T), undefined, b);
    assert.deepEqual(readBody(hex("80"), T), {});
  });
});

describe("msgpack: pack", () => {
  test("ints in their smallest form, floats in 64 bits even when whole", () => {
    const cases: [unknown, string, Type?][] = [
      [0, "00"],
      [127, "7f"],
      [128, "cc80"],
      [256, "cd0100"],
      [65536, "ce00010000"],
      [2 ** 32, "cf0000000100000000"],
      [Number.MAX_SAFE_INTEGER, "cf001fffffffffffff"],
      [-1, "ff"],
      [-32, "e0"],
      [-33, "d0df"],
      [-129, "d1ff7f"],
      [-32769, "d2ffff7fff"],
      [-(2 ** 31) - 1, "d3ffffffff7fffffff"],
      [Number.MIN_SAFE_INTEGER, "d3ffe0000000000001"],
      [2.5, "cb4004000000000000"],
      [2, "cb4000000000000000", "float"],
      [new Float(2), "cb4000000000000000"],
      [new Float(2), "cb4000000000000000", "int"],
      [true, "c3"],
      [false, "c2"],
      ["", "a0"],
      [str(31), "bf" + strHex(31)],
      [str(32), "d920" + strHex(32)],
      [str(256), "da0100" + strHex(256)],
      [str(65536), "db00010000" + strHex(65536)],
      [new Uint8Array([1, 2]), "c4020102"],
      [new Uint8Array(256), "c50100" + "00".repeat(256)],
      [[], "90"],
      [new Array(16).fill(0), "dc0010" + "00".repeat(16)],
      [{}, "80"],
      [{ w: 2, h: 2 }, "82a177cb4000000000000000a16802", { w: "float", h: "int" }],
      [{ l: { a: 2 } }, "81a16c81a161cb4000000000000000", { l: { "*": "float" } }],
      [{ k: [1] }, "81a16b91cb3ff0000000000000", { k: ["float"] }],
      [new Time(1), "d6ff00000001"],
      [new Time(2 ** 32, 5), "d7ff0000001500000000"],
      [new Time(-1, 5), "c70cff00000005ffffffffffffffff"],
    ];
    for (const [v, want, t] of cases) assert.equal(toHex(pack(v, t)), want, `${String(v).slice(0, 20)} ${JSON.stringify(t)}`);
    const big = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String.fromCharCode(97 + i), i]));
    assert.equal(toHex(pack(big)).slice(0, 6), "de0010");
  });

  test("a field that is undefined or null is left out: a host never sends nil", () => {
    assert.equal(toHex(pack({ a: undefined, b: null, c: 1 })), "81a16301");
    assert.throws(() => pack(null), TypeError);
    assert.throws(() => pack(undefined), TypeError);
    assert.throws(() => pack([null]), TypeError);
    assert.throws(() => pack([undefined]), TypeError);
    assert.throws(() => pack({ a: [1, null] }), TypeError);
    assert.throws(() => pack({ a: () => 1 }), TypeError);
    assert.throws(() => pack(new Map()), TypeError);
    assert.throws(() => pack(2 ** 53), RangeError);
    assert.throws(() => pack(new Time(0, 1e9)), RangeError);
  });

  test("a key is a str: an object's names, a number's among them; a symbol's is left out, as JSON.stringify leaves it", () => {
    assert.equal(toHex(pack({ 1: 2 })), "81a13102");
    assert.equal(toHex(pack({ [Symbol("s")]: 1, a: 1 })), "81a16101");
  });

  test("what it writes reads back, each value of its type", () => {
    const v = { v: "0.2", scale: new Float(2), cell: { w: 16, h: 32 }, t: new Time(1_600_000_000, 5), b: new Uint8Array([9]), deep: [[["€"]]], n: -70000 };
    assert.deepEqual(unpack(pack(v), { floats: true }), v);
  });
});
