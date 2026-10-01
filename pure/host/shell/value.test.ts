// The text of a row and back: nothing changes in the round trip, and what has no exact text is refused at the write.
import { describe, expect, test } from "bun:test";
import { aliceRun, ALICE, BOB, bobRun, walOf } from "./fixtures.ts";
import { decodeValue, encodeValue } from "./value.ts";

const roundTrip = (v: unknown) => {
  const text = encodeValue(v);
  return text.ok ? decodeValue(text.value) : text;
};

describe("host/shell/value a value comes back as it went", () => {
  test("R-DURABLE every row of two real Runtimes comes back equal, bigints and bytes and all", () => {
    const rows = [...walOf(aliceRun, ALICE), ...walOf(bobRun, BOB)];
    expect(rows.length).toBeGreaterThan(8);
    rows.forEach((row) => expect(roundTrip(row)).toEqual({ ok: true, value: row }));
  });

  test("the secret of a reveal stays bytes, and a bigint beyond 2^53 stays exact", () => {
    const secret = Uint8Array.from([0, 255, 1, 128]);
    const big = { n: 2n ** 80n + 1n, negative: -7n, secret };
    const back = roundTrip(big);
    expect(back.ok && back.value).toEqual(big);
    expect(back.ok && (back.value as { secret: unknown }).secret).toBeInstanceOf(Uint8Array);
  });

  test("an absent field comes back absent, and one that is undefined comes back undefined", () => {
    const back = roundTrip({ a: undefined, list: [undefined, null, 0, "", false] });
    expect(back).toEqual({ ok: true, value: { a: undefined, list: [undefined, null, 0, "", false] } });
    expect(back.ok && Object.keys(back.value as object)).toEqual(["a", "list"]);
    const absent = roundTrip({ list: [] });
    expect(absent.ok && Object.keys(absent.value as object)).toEqual(["list"]);
  });
});

describe("host/shell/value what has no exact text is refused, at the place it is", () => {
  test("a Map, a Set, a function, a symbol and a NaN are not stored", () => {
    const refused = { ok: false, error: { _tag: "unsupported", at: "$.m", kind: "object" } } as const;
    expect(encodeValue({ m: new Map() })).toEqual(refused);
    expect(encodeValue([new Set()])).toMatchObject({ ok: false, error: { at: "$[0]" } });
    expect(encodeValue({ f: () => 1 })).toMatchObject({ ok: false, error: { kind: "function" } });
    expect(encodeValue({ s: Symbol("x") })).toMatchObject({ ok: false, error: { kind: "symbol" } });
    expect(encodeValue(Number.NaN)).toMatchObject({ ok: false, error: { kind: "number" } });
    expect(encodeValue(Number.POSITIVE_INFINITY)).toMatchObject({ ok: false });
  });

  test("an object that has a tag's own key is refused, so a plain value never reads as a tag", () => {
    const refused = { ok: false, error: { _tag: "reserved_key", at: "$.x", key: "$n" } } as const;
    expect(encodeValue({ x: { $n: "5" } })).toEqual(refused);
    expect(encodeValue({ $u: 0 })).toMatchObject({ ok: false, error: { key: "$u" } });
    expect(encodeValue({ $x: "0x00" })).toMatchObject({ ok: false });
  });

  test("text that is not JSON, or a tag with nothing readable in it, is a fault and not a value", () => {
    expect(decodeValue("{nope")).toMatchObject({ ok: false, error: { _tag: "not_json" } });
    expect(decodeValue('{"$n":"1.5"}')).toEqual({ ok: false, error: { _tag: "bad_tag", at: "$" } });
    expect(decodeValue('{"a":{"$x":"0xzz"}}')).toEqual({ ok: false, error: { _tag: "bad_tag", at: "$.a" } });
    expect(decodeValue('{"$x":7}')).toMatchObject({ ok: false, error: { _tag: "bad_tag" } });
  });
});
