// RLP against ethers' encoder and the examples in the Ethereum RLP specification.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { bytesToHex, utf8 } from "./bytes.ts";
import { encodeCanonicalValue, rlp, type Rlp } from "./rlp.ts";

const hex = (node: Rlp): string => bytesToHex(rlp(node));

describe("kernel/rlp: the specification's examples", () => {
  test("dog, cat-dog list, empty string, empty list, the integers 0 and 15", () => {
    expect(hex(utf8("dog"))).toBe("0x83646f67");
    expect(hex([utf8("cat"), utf8("dog")])).toBe("0xc88363617483646f67");
    expect(hex(new Uint8Array())).toBe("0x80");
    expect(hex([])).toBe("0xc0");
    expect(hex(Uint8Array.of(0x0f))).toBe("0x0f");
    expect(hex(Uint8Array.of(0x80))).toBe("0x8180");
    expect(hex([[], [[]], [[], [[]]]])).toBe("0xc7c0c1c0c3c0c1c0");
  });

  test("the lorem ipsum string is the spec's long-string example", () => {
    const text = "Lorem ipsum dolor sit amet, consectetur adipisicing elit";
    expect(hex(utf8(text))).toBe(`0xb838${bytesToHex(utf8(text)).slice(2)}`);
  });

  test("lengths around the 55-byte boundary equal ethers", () => {
    [0, 1, 54, 55, 56, 57, 255, 256, 1000].forEach((n) => {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
      expect(hex(bytes)).toBe(ethers.encodeRlp(bytesToHex(bytes)));
      expect(hex([bytes, bytes])).toBe(ethers.encodeRlp([bytesToHex(bytes), bytesToHex(bytes)]));
    });
  });
});

describe("kernel/rlp: canonical values", () => {
  const encoded = (v: unknown): string => {
    const r = encodeCanonicalValue(v);
    return r.ok ? bytesToHex(r.value) : JSON.stringify(r.error);
  };
  test("each kind is labelled, so different kinds never share an encoding", () => {
    const spellings = [null, true, false, 1, 1n, "1", [1], new Map([[1, 1]]), new Set([1]), { a: 1 }].map(encoded);
    expect(new Set(spellings).size).toBe(spellings.length);
  });
  test("map, set and object order does not depend on insertion order", () => {
    expect(encoded(new Map([["a", 1], ["b", 2]]))).toBe(encoded(new Map([["b", 2], ["a", 1]])));
    expect(encoded(new Set([3, 1, 2]))).toBe(encoded(new Set([2, 3, 1])));
    expect(encoded({ x: 1, y: 2 })).toBe(encoded({ y: 2, x: 1 }));
  });
  test("an undefined field is absent", () => {
    expect(encoded({ a: 1, b: undefined })).toBe(encoded({ a: 1 }));
  });
  test("a bigint is its sign and magnitude", () => {
    expect(encoded(-5n)).not.toBe(encoded(5n));
    expect(encoded(0n)).toBe(encoded(0n));
  });
  test("what cannot be spelled is a fault", () => {
    expect(encodeCanonicalValue(Number.NaN)).toEqual({ ok: false, error: { _tag: "non_finite_number" } });
    expect(encodeCanonicalValue(() => 1)).toEqual({ ok: false, error: { _tag: "unsupported_type" } });
    expect(encodeCanonicalValue("\ud800")).toEqual({ ok: false, error: { _tag: "invalid_utf8" } });
    expect(encodeCanonicalValue({ nested: [undefined] })).toEqual({ ok: false, error: { _tag: "unsupported_type" } });
  });
});
