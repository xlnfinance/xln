// The committed vectors are what the deployed fork bytecode says, and three independent TS encoders agree with them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { allVectors } from "./vectors.ts";
import { COOPERATIVE_UPDATE_DIFF_PARAM_FOR_TEST } from "../rig.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const committed = (name: string) => JSON.parse(readFileSync(new URL(`../../../vectors/${name}.json`, import.meta.url), "utf8"));

type Vector = { function: string; label: string; args: any[]; returnData: string };
const vectorsFor = (fn: string): Vector[] => committed("functions").vectors.filter((v: Vector) => v.function.startsWith(`${fn}(`));
const word = (returnData: string): string => ethers.hexlify(coder.decode(["bytes"], returnData)[0] as string);

describe("vectors", () => {
  test("committed files equal a fresh run against the deployed bytecode", async () => {
    const fresh = JSON.parse(JSON.stringify(await allVectors()));
    expect(fresh).toEqual({ functions: committed("functions"), lifecycle: committed("lifecycle"), baseline: committed("baseline") });
  }, 120_000);

  test("batch payload: packed(domain, chainId, depository, entityId, encodedBatch, nonce)", () => {
    for (const v of vectorsFor("encodeBatchHankoPayloadForDomain")) {
      const [domain, chainId, depository, entityId, encodedBatch, nonce] = v.args;
      expect(word(v.returnData)).toBe(ethers.solidityPacked(["bytes32", "uint256", "address", "bytes32", "bytes", "uint256"], [domain, chainId, depository, entityId, encodedBatch, nonce]));
    }
  });

  test("dispute-proof payload: abi.encode(1, chainId, depository, accountKey, epoch, nonce, proposerIsLeft, bodyHash, watchSeed)", () => {
    for (const v of vectorsFor("encodeDisputeProofHankoPayloadForDomain")) {
      const [chainId, depository, accountKey, epoch, nonce, proposerIsLeft, bodyHash, watchSeed] = v.args;
      expect(word(v.returnData)).toBe(coder.encode(["uint256", "uint256", "address", "bytes", "uint256", "uint256", "bool", "bytes32", "bytes32"], [1, chainId, depository, accountKey, epoch, nonce, proposerIsLeft, bodyHash, watchSeed]));
    }
  });

  test("cooperative-update payload: abi.encode(0, chainId, depository, accountKey, epoch, nonce, diffs, forgiveTokenIds)", () => {
    for (const v of vectorsFor("encodeCooperativeUpdateHankoPayloadForDomain")) {
      const [chainId, depository, accountKey, epoch, nonce, diffs, forgive] = v.args;
      expect(word(v.returnData)).toBe(coder.encode(["uint256", "uint256", "address", "bytes", "uint256", "uint256", COOPERATIVE_UPDATE_DIFF_PARAM_FOR_TEST, "uint256[]"], [0, chainId, depository, accountKey, epoch, nonce, diffs, forgive]));
    }
  });

  test("reopen: after the epoch-advancing finalize a proof needs a nonce strictly above the stored one (timeout finalize stored 7 + 1)", () => {
    const { reopen } = committed("lifecycle");
    expect(reopen.storedNonce).toBe("8");
    expect(reopen.epoch).toBe("2");
    expect(reopen.startAtStoredNonce).toBe("ok, skipped (reason 0)");        // equal is not above: skipped since J2 (was REVERT E2)
    expect(reopen.startAtOldBaselineNonce).toBe("ok, skipped (reason 0)");   // the old baseline nonce is below: skipped since J2
    expect(reopen.settleAtStoredNonce).toBe("ok, batch failed (E2)");   // cooperative updates too: since J5 a failed batch, its outer nonce spent (was REVERT E2)
    expect(reopen.startAboveStoredNonce).toBe("ok");
  });

  test("baseline: a proof signed for epoch + 1 before the settlement or finalize starts a dispute after it", () => {
    const { afterSettlement: s, afterTimeoutFinalize: f, foldedOffdelta: o } = committed("baseline");
    expect([s.baseline.epoch, s.settle, s.epoch, s.storedNonce, s.start]).toEqual(["1", "ok", "1", "5", "ok"]);
    expect([f.firstDisputeStart, f.finalize, f.epoch, f.storedNonce]).toEqual(["ok", "ok", "1", "8"]);
    expect([f.baseline.epoch, f.startAtStoredNonce, f.startAboveStoredNonce]).toEqual(["1", "ok, skipped (reason 0)", "ok"]);
    const payout = (r: { L: string; R: string; collateral: string }) => [r.L, r.R, r.collateral];
    expect(payout(o.folded)).toEqual(payout(o.unfolded));
    expect(payout(o.folded)).toEqual(["970", "1030", "0"]);
  });

  test("baseline offsets: after a settlement F+1..F+3 all start a dispute; after a timeout finalize of the in-flight frame F+1 only F+3 does (F+1 and F+2 are skipped)", () => {
    const { baselineOffsets: o } = committed("baseline");
    expect(o.frameNonce).toBe(7);
    expect(Object.values(o.settlement).map((r: any) => [r.storedNonce, r.epoch, r.start])).toEqual([["7", "1", "ok"], ["7", "1", "ok"], ["7", "1", "ok"]]);
    expect(Object.values(o.timeoutFinalize).map((r: any) => [r.storedNonce, r.epoch, r.start])).toEqual([["9", "1", "ok, skipped (reason 0)"], ["9", "1", "ok, skipped (reason 0)"], ["9", "1", "ok"]]);
  });

  test("lifecycle: production's own hashes match ours, and the epoch advances on settle and finalize", () => {
    const l = committed("lifecycle");
    expect([l.deposit.result, l.settle.result, l.disputeStart.result, l.disputeFinalize.result]).toEqual(["ok", "ok", "ok", "ok"]);
    for (const b of [l.deposit, l.settle, l.disputeStart, l.disputeFinalize]) expect(b.batchHashEmitted).toBe(b.batchHashComputed);
    expect(l.disputeStart.disputeHashStored).toBe(l.disputeStart.disputeHashFromEncodeDisputeHash);
    const finalized = l.disputeFinalize.events.find((e: { name: string }) => e.name === "DisputeFinalized");
    expect(finalized.args.finalizationEvidenceHash).toBe(l.disputeFinalize.finalizationEvidenceHashExpected);
    expect([l.epochAfterSettle, l.epochAfterFinalize]).toEqual(["1", "2"]);
    const advanced = [...l.settle.events, ...l.disputeFinalize.events].filter((e: { name: string }) => e.name === "AccountEpochAdvanced").map((e: { args: { ondeltaEpoch: string } }) => e.args.ondeltaEpoch);
    expect(advanced).toEqual(["1", "2"]);
  });
});
