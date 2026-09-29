// Pins `toSExprString`'s byte-identity on BOTH the no-caps path and the caps (truncation) path.
// `toSExprString` must stay byte-identical regardless of what else the serializer grows (e.g.
// `serializeWithExtras`'s binary-leaf extraction) — a diff here on an unrelated change means
// something in the render/caps/shrink path moved; investigate before touching anything downstream.
//
// The fixtures are held fixed and the expected strings are exact (`toBe`, never a fuzzy matcher or
// an auto-approved snapshot) — a snapshot file can be silently re-approved with `-u`; a hardcoded
// literal cannot.

import { describe, expect, it } from "vitest";

import { toSExprString } from "../serializer.js";

describe("R0 pin — serializer byte-identity (no-caps path)", () => {
  it("a representative mixed fixture renders to the exact TODAY string, uncapped", () => {
    const fixture = {
      id: 42,
      name: 'hello "world"\nline2\ttab',
      active: true,
      tags: ["a", "b", "c"],
      nested: { x: 1, y: [1, 2, 3], z: null },
      count: 3.14,
      big: -9007199254740993n,
      aSet: new Set([1, 2, 3]),
      aMap: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      aDate: new Date("2024-01-01T00:00:00.000Z"),
    };

    const out = toSExprString(fixture);

    expect(out).toBe(
      '{:id 42 :name "hello \\"world\\"\\nline2\\ttab" :active #t :tags [a b c] ' +
        ":nested {:x 1 :y [1 2 3] :z nil} :count 3.14 :big -9007199254740993 " +
        ':aSet (set 1 2 3) :aMap (map :k1 1 :k2 2) :aDate "2024-01-01T00:00:00.000Z"}',
    );
  });

  it("a bare indent number is still 'no caps' — same byte output as the default call", () => {
    const fixture = { a: 1, b: [1, 2, 3] };
    expect(toSExprString(fixture)).toBe(toSExprString(fixture, 0));
  });
});

describe("R0 pin — serializer byte-identity (caps / truncation / shrink-to-fit path)", () => {
  it("a fixture that forces maxItems + maxStringChars + shrink-to-fit renders to the exact TODAY string", () => {
    const bigArr = Array.from({ length: 40 }, (_, i) => ({ idx: i, label: `item-${i}-${"x".repeat(20)}` }));

    const out = toSExprString(bigArr, { maxItems: 4, maxStringChars: 15, maxTotalChars: 600 });

    expect(out).toBe(
      "[\n" +
        '  {:idx 0 :label "item-0-xxxxxxxx…(+12 chars)"}\n' +
        '  {:idx 1 :label "item-1-xxxxxxxx…(+12 chars)"}\n' +
        '  {:idx 2 :label "item-2-xxxxxxxx…(+12 chars)"}\n' +
        '  {:idx 3 :label "item-3-xxxxxxxx…(+12 chars)"}\n' +
        "  #| +36 more of 40 |#]",
    );
    expect(out.length).toBe(217);
  });
});
