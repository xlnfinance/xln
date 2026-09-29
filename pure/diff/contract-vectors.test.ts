// The rewrite's encoders for the Depository we control (contracts/) against contracts/vectors, which the deployed fork
// bytecode produced. og's encoders are compared with og's in hashes.test.ts; this file is the other side: the fork's.
// Vectors whose chain id does not fit a JS number (the "wide" samples) are pinned by contracts/test/vm/vectors.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { seedTag } from "./seed.ts";
import {
  encodeForkBatchHash, encodeForkCooperativeUpdateHash, encodeForkDisputeProofHash,
  FORK_DEPOSITORY_BATCH_HANKO_DOMAIN, DEPOSITORY_BATCH_HANKO_DOMAIN,
} from "../xln.ts";

const committed = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/vectors/${name}.json`, import.meta.url), "utf8"));
type Vector = { function: string; label: string; args: any[]; returnData: string };
const vectorsFor = (fn: string): Vector[] => committed("functions").vectors.filter((v: Vector) => v.function.startsWith(`${fn}(`));
const fits = (chainId: string): boolean => BigInt(chainId) <= BigInt(Number.MAX_SAFE_INTEGER);

describe(seedTag("fork encoders (contracts/vectors)"), () => {
  test("the batch domain is V2, distinct from og's V1", () => {
    expect(FORK_DEPOSITORY_BATCH_HANKO_DOMAIN).not.toBe(DEPOSITORY_BATCH_HANKO_DOMAIN);
  });

  // The codec takes the domain as a parameter (a sample in its vectors); the Depository's own constant is what the
  // lifecycle's emitted batchHash pins, so that is the batch check.
  test("MATCH: encodeForkBatchHash == the batchHash the deployed Depository emitted for each lifecycle batch", () => {
    const l = committed("lifecycle");
    [l.deposit, l.settle, l.disputeStart, l.disputeFinalize].forEach((b) => {
      const hash = encodeForkBatchHash({ chainId: Number(l.chainId), depository: l.depository, entityId: b.entityId, encodedBatch: b.encodedBatch, nonce: b.entityNonce });
      expect(hash).toBe(b.batchHashEmitted);
      expect(hash).toBe(b.batchHashComputed);
    });
  });

  // The "small" sample has chainId, epoch and nonce all 7 and "wide" is all ones, so both are blind to swapping two slots.
  // The "mixed" sample has a different value in every slot: a swap of ondeltaEpoch and nonce (C1's whole point) fails here.
  test("the mixed samples exist and carry a distinct epoch and nonce", () => {
    for (const fn of ["computeDisputeProofHankoHashForDomain", "computeCooperativeUpdateHankoHashForDomain"]) {
      const mixed = vectorsFor(fn).filter((v) => v.label === "mixed");
      expect(mixed.length).toBe(1);
      const [chainId, , , epoch, nonce] = mixed[0]!.args;
      expect(new Set([chainId, epoch, nonce]).size).toBe(3);
    }
  });

  test("MATCH: encodeForkDisputeProofHash == the deployed computeDisputeProofHankoHash (epoch after the account key)", () => {
    const small = vectorsFor("computeDisputeProofHankoHashForDomain").filter((v) => fits(v.args[0]));
    expect(small.length).toBeGreaterThan(0);
    small.forEach((v) => {
      const [chainId, contractAddress, accountKey, ondeltaEpoch, nonce, proposerIsLeft, proofbodyHash, watchSeed] = v.args;
      expect(encodeForkDisputeProofHash({ messageType: 1, chainId: Number(chainId), contractAddress, accountKey, ondeltaEpoch, nonce, proposerIsLeft, proofbodyHash, watchSeed })).toBe(v.returnData);
    });
  });

  test("MATCH: encodeForkCooperativeUpdateHash == the deployed computeCooperativeUpdateHankoHash (epoch after the account key)", () => {
    const small = vectorsFor("computeCooperativeUpdateHankoHashForDomain").filter((v) => fits(v.args[0]));
    expect(small.length).toBeGreaterThan(0);
    small.forEach((v) => {
      const [chainId, contractAddress, accountKey, ondeltaEpoch, nonce, diffs, forgiveDebtsInTokenIds] = v.args;
      const signed = (d: { negative: boolean; magnitude: string }): string => `${d.negative ? "-" : ""}${d.magnitude}`;
      const text = diffs.map((d: any) => ({ tokenId: d.tokenId, leftDiff: signed(d.leftDiff), rightDiff: signed(d.rightDiff), collateralDiff: signed(d.collateralDiff), ondeltaDiff: signed(d.ondeltaDiff) }));
      expect(encodeForkCooperativeUpdateHash({ messageType: 0, chainId: Number(chainId), contractAddress, accountKey, ondeltaEpoch, nonce, diffs: text, forgiveDebtsInTokenIds })).toBe(v.returnData);
    });
  });

  test("the epoch is bound: a different epoch is a different digest", () => {
    const base = { messageType: 1, chainId: 7, contractAddress: `0x${"11".repeat(20)}`, accountKey: "0x", nonce: "7", proposerIsLeft: false, proofbodyHash: `0x${"22".repeat(32)}`, watchSeed: `0x${"33".repeat(32)}` };
    expect(encodeForkDisputeProofHash({ ...base, ondeltaEpoch: "1" })).not.toBe(encodeForkDisputeProofHash({ ...base, ondeltaEpoch: "2" }));
  });
});
