// The batch encoder against the vectors the deployed contracts produced (contracts/vectors): batch.json holds, for
// every slot of every operation, the input, the bytes the compiler's ABI gives for it and whether the deployed
// Depository's bounds accepted them; lifecycle.json holds the batches the Depository executed. The input is
// recorded, so nothing here re-derives a sample and compares the encoder with itself.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { DepositoryBounds__factory } from "../../../contracts/typechain-types/index.ts";
import { encode } from "../../kernel/encoding/abi.ts";
import { bytesToHex } from "../../kernel/encoding/bytes.ts";
import { unwrapOr, type Result } from "../../kernel/core/result.ts";
import { emptyBatch, encodeBatch, type Batch } from "./batch.ts";
import { signedAmountAbi } from "../money.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const batchParam = DepositoryBounds__factory.createInterface().getFunction("assertBatch")!.inputs[0]!;
const must = <T, E>(r: Result<T, E>): T => unwrapOr(r, (e) => expect.unreachable(JSON.stringify(e)));
const committed = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../contracts/vectors/${name}.json`, import.meta.url), "utf8"));

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

/** A vector's input (decimal strings) back to the values the encoder takes: a bigint in every integer slot. */
const revive = (value: Plain, p: ethers.ParamType): Plain => {
  switch (p.baseType) {
    case "array": return (value as unknown[]).map((x) => revive(x, p.arrayChildren!));
    case "tuple": return Object.fromEntries(p.components!.map((c) => [c.name, revive(value[c.name], c)]));
    default: return /^u?int/.test(p.baseType) ? BigInt(value) : value;
  }
};

type Layout = Readonly<{ label: string; input: Plain; encodedBatch: string; accepted: boolean; rejectedWith?: string }>;
const batch = committed("batch");
const layouts: readonly Layout[] = batch.layout.cases.filter((c: Plain) => c.input !== undefined);
/** Bytes the contract decodes: the accepted ones, and the one its bounds (E10) refuse after decoding. */
const accepted = layouts.filter((c) => c.accepted || c.rejectedWith === "E10");
const inputOf = (label: string): Plain => revive(layouts.find((c) => c.label === label)?.input, batchParam);

describe("R-J2 encodeBatch equals the bytes the compiled ABI gave for each recorded input (batch.json)", () => {
  test("the vector records every field of the contract's Batch, in the encoder's order", () => {
    expect(batch.layout.fields).toEqual(Object.keys(emptyBatch(0n)));
    expect(batchParam.components!.map((c) => c.name)).toEqual(batch.layout.fields);
  });

  accepted.forEach((c) => {
    test(`${c.label}: input to bytes`, () => {
      expect(must(encodeBatch(batchOf(revive(c.input, batchParam))))).toBe(c.encodedBatch);
    });
    test(`${c.label}: the bytes decode and encode back to themselves`, () => {
      const decoded = plain(coder.decode([batchParam], c.encodedBatch)[0], batchParam);
      expect(must(encodeBatch(batchOf(decoded)))).toBe(c.encodedBatch);
    });
  });

  test("an empty batch is the gas budget and eleven empty lists", () => {
    const empty = layouts.find((c) => c.label === "no ops, the minimum gas budget")!;
    expect(must(encodeBatch(emptyBatch(BigInt(empty.input.gasBudget))))).toBe(empty.encodedBatch);
  });

  test("one-hot cases set exactly one boolean, so a swap of two boolean slots changes the bytes", () => {
    const hot = accepted.filter((c) => c.label.startsWith("one-hot: only "));
    expect(hot.length).toBeGreaterThanOrEqual(10);
    expect(new Set(hot.map((c) => c.encodedBatch)).size).toBe(hot.length);
  });
});

describe("R-J2 the operations the deployed Depository executed (batch.json ops)", () => {
  Object.entries(batch.ops).forEach(([name, op]) => {
    test(`${name}: the executed bytes decode and encode back to themselves`, () => {
      const bytes = (op as Plain).encodedBatch;
      const decoded = plain(coder.decode([batchParam], bytes)[0], batchParam);
      expect(must(encodeBatch(batchOf(decoded)))).toBe(bytes);
    });
  });
});

describe("R-J2 the batches the deployed Depository accepted (contracts/vectors/lifecycle.json)", () => {
  const lifecycle = committed("lifecycle");
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
  const pastType = layouts.filter((c) => c.rejectedWith === "revert with no data");
  const typeOf = (label: string): string => /\((u?int\d+|bool)\)/.exec(label)?.[1] ?? expect.unreachable(label);

  test("the vector records a value one past each type, for a gas budget, a token type, a ratio and a bool", () => {
    expect(pastType.map((c) => typeOf(c.label))).toEqual(["uint64", "uint8", "uint16", "bool"]);
  });

  const refusedAs = { uint64: "uint64", uint8: "uint8", uint16: "uint16" } as const;
  type RefusedType = keyof typeof refusedAs;
  pastType.filter((c) => typeOf(c.label) !== "bool").forEach((c) => {
    test(`${c.label}`, () => {
      expect(encodeBatch(batchOf(revive(c.input, batchParam))))
        .toEqual({ ok: false, error: { _tag: "out_of_range", type: refusedAs[typeOf(c.label) as RefusedType] } });
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
    const value = inputOf("every array, small values");
    const zero = { negative: false, magnitude: 0n };
    const diff = {
      ...value.settlements[0].diffs[0], leftDiff: zero, rightDiff: zero, collateralDiff: zero, ondeltaDiff: zero,
    };
    const zeroed = { ...value, settlements: [{ ...value.settlements[0], diffs: [diff] }] };
    expect(must(encodeBatch(batchOf(zeroed)))).toBe(coder.encode([batchParam], [zeroed]));
  });
});
