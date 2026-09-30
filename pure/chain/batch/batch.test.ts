// The batch encoder against the contract's own ABI: the Batch type as the compiler emitted it (typechain), filled with
// sample values in every slot of every operation, encoded by ethers, compared byte for byte; and the batches the real
// Depository accepted in contracts/vectors/lifecycle.json, decoded and encoded again.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { DeltaTransformer__factory, DepositoryBounds__factory } from "../../../contracts/typechain-types/index.ts";
import { encode } from "../../kernel/encoding/abi.ts";
import { bytesToHex } from "../../kernel/encoding/bytes.ts";
import { unwrapOr, type Result } from "../../kernel/core/result.ts";
import { emptyBatch, encodeBatch, type Batch } from "./batch.ts";
import { encodeDeltaBatch } from "./clauses.ts";
import { signedAmountAbi } from "../money.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const batchParam = DepositoryBounds__factory.createInterface().getFunction("assertBatch")!.inputs[0]!;
const must = <T, E>(r: Result<T, E>): T => unwrapOr(r, (e) => expect.unreachable(JSON.stringify(e)));

// ---- samples, derived from the ABI ----

type Mode = "small" | "wide" | "mixed";
const digest = (path: string): string => ethers.keccak256(ethers.toUtf8Bytes(path));
const distinct = (path: string, bits: number): bigint =>
  (BigInt(digest(path)) % (1n << BigInt(Math.min(bits, 20)))) + 1n;
/** The value a sample takes in each mode: the smallest that is legal, the widest that fits, a distinct one. */
const byMode = <T>(mode: Mode, values: Readonly<Record<Mode, T>>): T => values[mode];
const bitsOf = (baseType: string): number => Number(/\d+$/.exec(baseType)?.[0] ?? 256);

const sample = (p: ethers.ParamType, path: string, mode: Mode): unknown => {
  switch (true) {
    case p.baseType === "array": {
      const fixed = p.arrayLength !== null && p.arrayLength >= 0 ? p.arrayLength : null;
      const length = fixed ?? byMode(mode, { small: 1, wide: 2, mixed: 2 });
      return Array.from({ length }, (_, i) => sample(p.arrayChildren!, `${path}[${i}]`, mode));
    }
    case p.baseType === "tuple":
      return Object.fromEntries(p.components!.map((c, i) => {
        const name = c.name || `f${i}`;
        return [name, sample(c, `${path}.${name}`, mode)];
      }));
    case p.baseType === "bool":
      return byMode(mode, { small: false, wide: true, mixed: BigInt(digest(path)) % 2n === 0n });
    case p.baseType === "address": return ethers.getAddress(`0x${digest(path).slice(26)}`);
    case p.baseType === "bytes32": return digest(path);
    case p.baseType === "bytes": {
      const filled = `0x${digest(path).slice(2, 76)}`;
      return byMode(mode, { small: "0x", wide: filled, mixed: filled });
    }
    case p.baseType.startsWith("uint"): {
      const bits = bitsOf(p.baseType);
      return byMode(mode, { small: 7n, wide: (1n << BigInt(bits)) - 1n, mixed: distinct(path, bits) });
    }
    case p.baseType.startsWith("int"): {
      const bits = bitsOf(p.baseType) - 1;
      return byMode(mode, { small: -7n, wide: -(1n << BigInt(bits)), mixed: -distinct(path, bits) });
    }
    default: return expect.unreachable(`no sample for ${p.baseType}`);
  }
};

// ---- the contract's values to the encoder's types ----

type Plain = any;
/** Named tuple results become objects keyed by component name; arrays stay arrays. */
const plain = (value: unknown, p: ethers.ParamType): Plain => {
  switch (p.baseType) {
    case "array": return (value as unknown[]).map((x) => plain(x, p.arrayChildren!));
    case "tuple": return Object.fromEntries(p.components!.map((c, i) => [c.name, plain((value as any)[i], c)]));
    default: return value;
  }
};
const signed = (a: { negative: boolean; magnitude: bigint }): bigint => (a.negative ? -a.magnitude : a.magnitude);
const bodyOf = (b: Plain) => ({
  ...b, offdeltas: b.offdeltas.map((o: { high: bigint; low: bigint }) => (o.high << 256n) + o.low),
});
const batchOf = (j: Plain): Batch => ({
  ...j,
  settlements: j.settlements.map((s: Plain) => ({
    ...s, diffs: s.diffs.map((d: Plain) => ({
      ...d, leftDiff: signed(d.leftDiff), rightDiff: signed(d.rightDiff),
      collateralDiff: signed(d.collateralDiff), ondeltaDiff: signed(d.ondeltaDiff),
    })),
  })),
  disputeStarts: j.disputeStarts.map((d: Plain) => ({ ...d, initialProofbody: bodyOf(d.initialProofbody) })),
  counterDisputes: j.counterDisputes.map((d: Plain) => ({ ...d, counterProofbody: bodyOf(d.counterProofbody) })),
  disputeFinalizations: j.disputeFinalizations.map((d: Plain) => ({ ...d, finalProofbody: bodyOf(d.finalProofbody) })),
});

describe("R-J2 encodeBatch equals the compiled ABI", () => {
  (["small", "wide", "mixed"] as const).forEach((mode) => {
    test(`${mode} sample: every slot of every operation`, () => {
      const value = sample(batchParam, "batch", mode);
      expect(must(encodeBatch(batchOf(value)))).toBe(coder.encode([batchParam], [value]));
    });
  });

  test("the sample touches every operation list the contract's Batch has", () => {
    const names = batchParam.components!.map((c) => c.name);
    expect(names).toEqual(Object.keys(emptyBatch(0n)));
  });

  test("an empty batch is the gas budget and eleven empty lists", () => {
    const value = sample(batchParam, "empty", "small") as Record<string, unknown>;
    const empty = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? [] : v]));
    expect(must(encodeBatch(emptyBatch(7n)))).toBe(coder.encode([batchParam], [empty]));
  });
});

describe("R-J2 the batches the deployed Depository accepted (contracts/vectors/lifecycle.json)", () => {
  const lifecyclePath = new URL("../../../contracts/vectors/lifecycle.json", import.meta.url);
  const lifecycle = JSON.parse(readFileSync(lifecyclePath, "utf8"));
  (["deposit", "settle", "disputeStart", "disputeFinalize"] as const).forEach((step) => {
    test(`${step}: decode the accepted bytes, encode them again, get the same bytes`, () => {
      const accepted: string = lifecycle[step].encodedBatch;
      const decoded = plain(coder.decode([batchParam], accepted)[0], batchParam);
      expect(must(encodeBatch(batchOf(decoded)))).toBe(accepted);
    });
  });
  test("the dispute start carries the epoch (S1) and the finalization does not", () => {
    const start = plain(coder.decode([batchParam], lifecycle.disputeStart.encodedBatch)[0], batchParam);
    expect(start.disputeStarts[0].ondeltaEpoch).toBe(BigInt(lifecycle.disputeStart.epoch));
  });
});

describe("a value the contract would refuse to decode is refused here", () => {
  test("a token type past uint8, inside an external token deposit", () => {
    const value = sample(batchParam, "tokenType", "small") as Plain;
    const [deposit] = value.externalTokenToReserve;
    const tooBig = { ...value, externalTokenToReserve: [{ ...deposit, tokenType: 256n }] };
    expect(encodeBatch(batchOf(tooBig))).toEqual({ ok: false, error: { _tag: "out_of_range", type: "uint8" } });
  });
  test("a gas budget past uint64", () => {
    expect(encodeBatch(emptyBatch(1n << 64n))).toEqual({ ok: false, error: { _tag: "out_of_range", type: "uint64" } });
  });
  test("a hash-ladder fill ratio past uint16, deep inside the batch", () => {
    const value = sample(batchParam, "ratio", "small") as Plain;
    const [registration] = value.hashLadderRegistrations;
    const witness = { ...registration.witness, fillRatio: 65_536n };
    const tooBig = { ...value, hashLadderRegistrations: [{ ...registration, witness }] };
    expect(encodeBatch(batchOf(tooBig))).toEqual({ ok: false, error: { _tag: "out_of_range", type: "uint16" } });
  });
});

describe("R-J2 the transformer clause payload equals the compiled DeltaTransformer ABI in every slot", () => {
  const clauseParam = DeltaTransformer__factory.createInterface().getFunction("encodeBatch")!.inputs[0]!;
  const clauseOf = (j: Plain) => ({
    payments: j.payment.map((p: Plain) => ({ ...p, amount: signed(p.amount) })),
    swaps: j.swap,
    pulls: j.pull.map((p: Plain) => ({ ...p, amount: signed(p.amount) })),
  });
  (["small", "wide", "mixed"] as const).forEach((mode) => {
    test(`${mode} sample`, () => {
      const value = sample(clauseParam, "clause", mode);
      expect(must(encodeDeltaBatch(clauseOf(value)))).toBe(coder.encode([clauseParam], [value]));
    });
  });
});

describe("R-J2 a zero amount is never negative (WideMath.NonCanonicalSign)", () => {
  const signedParam = ethers.ParamType.from("tuple(bool negative, uint256 magnitude)");
  [0n, 1n, -1n, (1n << 256n) - 1n, -((1n << 256n) - 1n)].forEach((n) => {
    test(`${n}`, () => {
      const encoded = must(encode([signedAmountAbi(n)]));
      expect(bytesToHex(encoded)).toBe(coder.encode([signedParam], [{ negative: n < 0n, magnitude: n < 0n ? -n : n }]));
    });
  });
  test("a settlement diff of zeros encodes as positive zeros", () => {
    const value = sample(batchParam, "zeros", "small") as Plain;
    const zero = { negative: false, magnitude: 0n };
    const diff = {
      ...value.settlements[0].diffs[0], leftDiff: zero, rightDiff: zero, collateralDiff: zero, ondeltaDiff: zero,
    };
    const zeroed = { ...value, settlements: [{ ...value.settlements[0], diffs: [diff] }] };
    expect(must(encodeBatch(batchOf(zeroed)))).toBe(coder.encode([batchParam], [zeroed]));
  });
});
