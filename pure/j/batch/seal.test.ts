// The batch the builder seals is the batch the deployed Depository accepted: contracts/vectors/lifecycle.json holds
// four batches it executed (a deposit, a settlement, a dispute start, a finalization) with their bytes and hashes. The
// ops are read back out of those bytes, the builder seals them again, and the bytes and the digest must be the same.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { DepositoryBounds__factory } from "../../../contracts/typechain-types/index.ts";
import { deployment } from "../../chain/proof/deployment.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import type { JOp } from "../op/ops.ts";
import { processBatchCall, sealBatch, MIN_GAS_BUDGET, MAX_NONCE } from "./sealed.ts";
import { MAX_ENCODED_BYTES } from "../op/limits.ts";
import {
  ME, counter, deposit, finalize, fund, idOf, reserveToExternal, reserveToReserve, reveal, settle, start, withdraw,
} from "../fixtures.ts";

type Plain = any;
const coder = ethers.AbiCoder.defaultAbiCoder();
const batchParam = DepositoryBounds__factory.createInterface().getFunction("assertBatch")!.inputs[0]!;
const vectors = new URL("../../../contracts/vectors/lifecycle.json", import.meta.url);
const lifecycle = JSON.parse(readFileSync(vectors, "utf8"));

/** Named tuple results become objects keyed by component name; arrays stay arrays. */
const plain = (value: unknown, p: ethers.ParamType): Plain => {
  switch (p.baseType) {
    case "array": return (value as unknown[]).map((x) => plain(x, p.arrayChildren!));
    case "tuple": return Object.fromEntries(p.components!.map((c, i) => [c.name, plain((value as any)[i], c)]));
    default: return value;
  }
};
const signed = (a: { negative: boolean; magnitude: bigint }): bigint => (a.negative ? -a.magnitude : a.magnitude);
const bodyOf = (b: Plain) =>
  ({ ...b, offdeltas: b.offdeltas.map((o: { high: bigint; low: bigint }) => (o.high << 256n) + o.low) });

/** The contract's decoded Batch as the builder's ops: one op per entry, the inverse of assembling. */
const opsOfBatch = (j: Plain): readonly JOp[] => [
  ...j.externalTokenToReserve.map((leg: Plain): JOp => ({ _tag: "deposit", leg })),
  ...j.reserveToReserve.map((transfer: Plain): JOp => ({ _tag: "reserve_to_reserve", transfer })),
  ...j.collateralToReserve.map((withdrawal: Plain): JOp => ({ _tag: "collateral_to_reserve", withdrawal })),
  ...j.settlements.map((s: Plain): JOp => ({
    _tag: "settle",
    settlement: { ...s, diffs: s.diffs.map((d: Plain) => ({
      ...d, leftDiff: signed(d.leftDiff), rightDiff: signed(d.rightDiff),
      collateralDiff: signed(d.collateralDiff), ondeltaDiff: signed(d.ondeltaDiff),
    })) },
  })),
  ...j.disputeStarts.map((d: Plain): JOp =>
    ({ _tag: "dispute_start", start: { ...d, initialProofbody: bodyOf(d.initialProofbody) } })),
  ...j.counterDisputes.map((d: Plain): JOp =>
    ({ _tag: "dispute_counter", counter: { ...d, counterProofbody: bodyOf(d.counterProofbody) } })),
  ...j.disputeFinalizations.map((d: Plain): JOp =>
    ({ _tag: "dispute_finalize", finalization: { ...d, finalProofbody: bodyOf(d.finalProofbody) } })),
  ...j.reserveToCollateral.map((funding: Plain): JOp => ({ _tag: "reserve_to_collateral", funding })),
  ...j.reserveToExternalToken.map((withdrawal: Plain): JOp => ({ _tag: "reserve_to_external", withdrawal })),
  ...j.revealSecrets.map((reveal: Plain): JOp => ({ _tag: "reveal_secret", reveal })),
];

const chain = unwrapOr(deployment(BigInt(lifecycle.chainId), lifecycle.depository),
  (e) => expect.unreachable(JSON.stringify(e)));

describe("R-J2 the builder seals the batches the deployed Depository executed", () => {
  (["deposit", "settle", "disputeStart", "disputeFinalize"] as const).forEach((step) => {
    const run = lifecycle[step];
    const decoded = plain(coder.decode([batchParam], run.encodedBatch)[0], batchParam);
    test(`${step}: same bytes and same batch hash as the chain emitted`, () => {
      const sealed = sealBatch(
        { deployment: chain, entity: run.entityId, nonce: BigInt(run.entityNonce), gasBudget: decoded.gasBudget },
        opsOfBatch(decoded));
      expect(sealed.ok && sealed.value.encoded).toBe(run.encodedBatch);
      expect(sealed.ok && sealed.value.digest).toBe(run.batchHashEmitted);
    });
  });
  test("each lifecycle batch carries one op; the step called deposit is a funding of the Account (R2C)", () => {
    const counts = (["deposit", "settle", "disputeStart", "disputeFinalize"] as const).map((step) =>
      opsOfBatch(plain(coder.decode([batchParam], lifecycle[step].encodedBatch)[0], batchParam)).map((op) => op._tag));
    expect(counts).toEqual([["reserve_to_collateral"], ["settle"], ["dispute_start"], ["dispute_finalize"]]);
  });
});

describe("the contract reads each op from the list the builder put it in, in the order it was queued", () => {
  const sealing = { deployment: chain, entity: ME, nonce: 1n, gasBudget: MIN_GAS_BUDGET };
  const everyKind: readonly JOp[] = [
    deposit(7n), reserveToReserve(1n), withdraw(idOf(2), 3n, 4n), settle(idOf(2), -3n, 8n), settle(idOf(9), -1n, 9n),
    start(idOf(2)), counter(idOf(2)), reveal(1), reveal(2), finalize(idOf(2)), fund(idOf(9), 2n), reserveToExternal(1n),
  ];
  const decoded = (() => {
    const sealed = sealBatch(sealing, everyKind);
    return plain(coder.decode([batchParam], sealed.ok ? sealed.value.encoded : "0x")[0], batchParam);
  })();

  test("one list per kind, each holding what was queued", () => {
    const lengths = [
      decoded.externalTokenToReserve, decoded.reserveToReserve, decoded.collateralToReserve, decoded.settlements,
      decoded.disputeStarts, decoded.counterDisputes, decoded.revealSecrets, decoded.disputeFinalizations,
      decoded.reserveToCollateral, decoded.reserveToExternalToken,
    ].map((list: readonly unknown[]) => list.length);
    expect(lengths).toEqual([1, 1, 1, 2, 1, 1, 2, 1, 1, 1]);
    expect(decoded.externalTokenToReserve[0].amount).toBe(7n);
    expect(decoded.gasBudget).toBe(MIN_GAS_BUDGET);
  });
  test("two ops of one kind keep their queue order", () => {
    expect(decoded.settlements.map((s: Plain) => s.nonce)).toEqual([8n, 9n]);
    expect(decoded.revealSecrets.map((r: Plain) => r.secret)).toEqual([idOf(1), idOf(2)]);
  });
  test("the ops the vectors' reader finds in those bytes are the ops that were queued", () => {
    expect(opsOfBatch(decoded).map((op) => op._tag).toSorted()).toEqual(everyKind.map((op) => op._tag).toSorted());
  });
});

describe("what the Depository refuses before it reads the Hanko is not signed", () => {
  const sealing = { deployment: chain, entity: ME, nonce: 1n, gasBudget: MIN_GAS_BUDGET };
  test("a gas budget under the minimum", () => {
    expect(sealBatch({ ...sealing, gasBudget: MIN_GAS_BUDGET - 1n }, [deposit(1n)]))
      .toEqual({
        ok: false, error: { _tag: "budget_below_minimum", gasBudget: MIN_GAS_BUDGET - 1n, min: MIN_GAS_BUDGET },
      });
    expect(sealBatch(sealing, [deposit(1n)]).ok).toBe(true);
  });
  test("a nonce above the safe integer", () => {
    expect(sealBatch({ ...sealing, nonce: MAX_NONCE + 1n }, [deposit(1n)]))
      .toEqual({ ok: false, error: { _tag: "nonce_beyond_limit", nonce: MAX_NONCE + 1n, max: MAX_NONCE } });
    expect(sealBatch({ ...sealing, nonce: MAX_NONCE }, [deposit(1n)]).ok).toBe(true);
  });
  test("an encoded batch above 256 KiB, and one of exactly 256 KiB is allowed", () => {
    const withSig = (bytes: number): ReturnType<typeof sealBatch> => {
      const big = settle(idOf(2), -1n);
      const sized = big._tag === "settle"
        ? { ...big, settlement: { ...big.settlement, sig: `0x${"ab".repeat(bytes)}` } } : big;
      return sealBatch(sealing, [sized]);
    };
    const lengthAt = (bytes: number): number => {
      const sealed = withSig(bytes);
      return sealed.ok ? (sealed.value.encoded.length - 2) / 2 : expect.unreachable("sealed");
    };
    const slack = MAX_ENCODED_BYTES - lengthAt(1024);
    const exact = 1024 + slack;
    expect(lengthAt(exact)).toBe(MAX_ENCODED_BYTES);
    expect(withSig(exact).ok).toBe(true);
    const over = withSig(exact + 1);
    const fault = { _tag: "batch_too_large" as const, bytes: MAX_ENCODED_BYTES + 32, max: MAX_ENCODED_BYTES };
    expect(over).toEqual({ ok: false, error: fault });
  });
});

describe("the call the Host sends", () => {
  test("processBatch takes the entity, the encoded batch, the Hanko and the nonce, as sealed", () => {
    const sealed = sealBatch({ deployment: chain, entity: ME, nonce: 4n, gasBudget: MIN_GAS_BUDGET }, [deposit(1n)]);
    const call = sealed.ok ? processBatchCall(sealed.value, "0xabcd") : expect.unreachable("sealed");
    const encodedBatch = sealed.ok ? sealed.value.encoded : "";
    expect(call).toEqual({ entityId: ME, encodedBatch, hankoData: "0xabcd", nonce: 4n });
  });
});

