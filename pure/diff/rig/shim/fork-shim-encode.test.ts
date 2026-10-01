// encodeForkBatch (fork-shim.ts) puts the signed gas budget in front of og's batch and, in every dispute start, the Account epoch its signature was made at (C1).
// The walks reach this through the moved-epoch dispute (walk.ts epochLines); this pins the two fields directly and fast, so the argument order and the
// missing-field mutants of the shim (m1 epoch always 0, m6 budget dropped, m7 epoch of the wrong pair) fail here by name.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { createEmptyBatch } from "../../../../core/jurisdiction/machine/batch/index.ts";
import { DepositoryBounds__factory } from "../../../../contracts/typechain-types/factories/DepositoryBounds__factory.ts";
import { SHIM_GAS_BUDGET, encodeForkBatch } from "../fork-shim.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const PARAM = DepositoryBounds__factory.createInterface().getFunction("assertBatch")!.inputs[0]!;
const id = (n: number): string => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const ME = id(1);
const proofbody = { watchSeed: id(0), leftResponseSeconds: 60, rightResponseSeconds: 60, offdeltas: [], tokenIds: [], transformers: [] };
const start = (counterentity: string) => ({
  counterentity, nonce: 5, proposerIsLeft: true, proofbodyHash: id(9), initialProofbody: proofbody, watchSeed: id(0), sig: "0x",
  starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: id(0),
});
const decode = (encoded: string) => coder.decode([PARAM], encoded)[0] as { gasBudget: bigint; disputeStarts: { counterentity: string; ondeltaEpoch: bigint }[] };

describe("C1 and the gas budget: the fork's bytes for og's batch", () => {
  test("the signed budget is in front, and each dispute start carries the epoch of the acting Entity's Account with ITS counterentity", () => {
    const epochs = new Map([[id(2), 7n], [id(3), 11n]]);
    // asked the wrong way round (counterentity first) the answer is 99, so the order is pinned as well
    const epochOf = (left: string, right: string): bigint => (left === ME ? epochs.get(right) ?? 0n : 99n);
    const batch = { ...createEmptyBatch(), disputeStarts: [start(id(2)), start(id(3)), start(id(4))] };
    const decoded = decode(encodeForkBatch(batch, ME, epochOf));
    expect(decoded.gasBudget).toBe(SHIM_GAS_BUDGET);
    expect(decoded.disputeStarts.map((s) => s.ondeltaEpoch)).toEqual([7n, 11n, 0n]);
  });
});
