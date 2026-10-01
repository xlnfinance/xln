// The ABI encoder against ethers on random value trees, and the faults the encoder names.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { lcg31, seedOf, seedTag } from "../../diff/seed.ts";
import { A, P, arrayOf, encode, encodePacked, type Abi } from "./abi.ts";
import { bytesToHex } from "./bytes.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();

/** A value tree, its ethers type and the value ethers takes for it. */
type Sample = Readonly<{ abi: Abi; type: string; value: unknown }>;
type Draw = Readonly<{ seed: number; n: number }>;
const next = ({ seed }: Draw): Draw => ({ seed: lcg31(seed), n: lcg31(seed) });
const byteAt = (d: Draw, i: number): string => ((lcg31(d.seed + i) >> 8) & 0xff).toString(16).padStart(2, "0");
const hexOf = (d: Draw, bytes: number): string =>
  `0x${Array.from({ length: bytes }, (_, i) => byteAt(d, i)).join("")}`;

const leaves: readonly ((d: Draw) => Sample)[] = [
  (d) => ({ abi: A.u256(BigInt(d.n) << 200n), type: "uint256", value: BigInt(d.n) << 200n }),
  (d) => ({ abi: A.u16(BigInt(d.n & 0xffff)), type: "uint16", value: d.n & 0xffff }),
  (d) => ({ abi: A.i256(-BigInt(d.n) << 100n), type: "int256", value: -BigInt(d.n) << 100n }),
  (d) => ({ abi: A.bool(d.n % 2 === 0), type: "bool", value: d.n % 2 === 0 }),
  (d) => ({ abi: A.b32(hexOf(d, 32)), type: "bytes32", value: hexOf(d, 32) }),
  (d) => ({ abi: A.address(hexOf(d, 20)), type: "address", value: hexOf(d, 20) }),
  (d) => ({ abi: A.bytes(hexOf(d, d.n % 70)), type: "bytes", value: hexOf(d, d.n % 70) }),
];

const asArray = (d: Draw, count: number): Sample => {
  const items = Array.from({ length: count }, (_, i) => leaves[0]!(next({ seed: d.seed + i, n: d.n })));
  return { abi: arrayOf(items, (s) => s.abi), type: "uint256[]", value: items.map((s) => s.value) };
};

const asTuple = (items: readonly Sample[]): Sample => ({
  abi: A.tuple(items.map((s) => s.abi)), type: `tuple(${items.map((s) => s.type).join(",")})`,
  value: items.map((s) => s.value),
});

/** A leaf, a uint256[] or a tuple of smaller trees; a tuple holding a `bytes` or an array is dynamic. */
const tree = (d: Draw, depth: number): Sample => {
  const pick = d.n % (depth === 0 ? leaves.length : leaves.length + 2);
  const count = 1 + (next(d).n % 3);
  switch (true) {
    case pick < leaves.length: return leaves[pick]!(d);
    case pick === leaves.length: return asArray(d, count);
    default: {
      const child = (i: number): Sample => tree(next({ seed: d.seed + 7 * (i + 1), n: d.n }), depth - 1);
      return asTuple(Array.from({ length: count }, (_, i) => child(i)));
    }
  }
};

describe(seedTag("kernel/abi: encode equals ethers"), () => {
  test("random trees, including nested dynamic tuples", () => {
    const base = seedOf(4401);
    const draws = Array.from({ length: 300 }, (_, i) => next({ seed: base + i * 131, n: 0 }));
    const isDynamicTuple = (s: Sample): boolean => s.type.startsWith("tuple(") && /bytes[,)]|\[\]/.test(s.type);
    const dynamicTuples = draws.map((d) => tree(d, 3)).filter(isDynamicTuple);
    draws.forEach((d) => {
      const s = tree(d, 3);
      const mine = encode([s.abi]);
      expect(mine.ok).toBe(true);
      expect(bytesToHex(mine.ok ? mine.value : new Uint8Array())).toBe(coder.encode([s.type], [s.value]));
    });
    expect(dynamicTuples.length).toBeGreaterThan(0);
  });

  test("a tuple of several values encodes as abi.encode of several arguments", () => {
    const mine = encode([A.u256(7n), A.bytes("0xabcd"), A.b32(`0x${"11".repeat(32)}`)]);
    expect(bytesToHex(mine.ok ? mine.value : new Uint8Array()))
      .toBe(coder.encode(["uint256", "bytes", "bytes32"], [7n, "0xabcd", `0x${"11".repeat(32)}`]));
  });
});

describe("kernel/abi: encodePacked equals ethers", () => {
  test("every packed type at its own width", () => {
    const d = `0x${"22".repeat(20)}`;
    const mine = encodePacked([
      P.u256(5n), P.u32(6n), P.bool(true), P.address(d), P.b32(`0x${"33".repeat(32)}`), P.bytes("0xbeef"),
    ]);
    const theirs = ethers.solidityPacked(
      ["uint256", "uint32", "bool", "address", "bytes32", "bytes"],
      [5n, 6n, true, d, `0x${"33".repeat(32)}`, "0xbeef"],
    );
    expect(bytesToHex(mine.ok ? mine.value : new Uint8Array())).toBe(theirs);
  });
});

describe("kernel/abi: the first leaf that does not fit is named", () => {
  const fault = (v: Abi) => {
    const r = encode([v]);
    return r.ok ? "ok" : r.error;
  };
  test("uint ranges", () => {
    expect(fault(A.u16(65_536n))).toEqual({ _tag: "out_of_range", type: "uint16" });
    expect(fault(A.u16(65_535n))).toBe("ok");
    expect(fault(A.u64(1n << 64n))).toEqual({ _tag: "out_of_range", type: "uint64" });
    expect(fault(A.u256(-1n))).toEqual({ _tag: "out_of_range", type: "uint256" });
    expect(fault(A.u256(1n << 256n))).toEqual({ _tag: "out_of_range", type: "uint256" });
  });
  test("int256 ranges", () => {
    expect(fault(A.i256(1n << 255n))).toEqual({ _tag: "out_of_range", type: "int256" });
    expect(fault(A.i256(-(1n << 255n)))).toBe("ok");
  });
  test("sizes and hex", () => {
    expect(fault(A.b32("0x1234"))).toEqual({ _tag: "wrong_size", type: "bytes32", bytes: 2 });
    expect(fault(A.address(`0x${"11".repeat(21)}`))).toEqual({ _tag: "wrong_size", type: "address", bytes: 21 });
    expect(fault(A.bytes("0xabc"))).toEqual({ _tag: "odd_length", digits: 3 });
    expect(fault(A.bytes("0xzz"))).toEqual({ _tag: "not_hex" });
  });
  test("a fault inside a nested array is still found", () => {
    expect(fault(A.tuple([A.array([A.u8(1n), A.u8(256n)])]))).toEqual({ _tag: "out_of_range", type: "uint8" });
  });
});
