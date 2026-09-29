// The committed vectors are what the deployed fork bytecode says, and three independent TS encoders agree with them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { allVectors } from "./vectors.ts";
import { COOPERATIVE_UPDATE_DIFF_PARAM_FOR_TEST } from "./rig.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const committed = (name: string) => JSON.parse(readFileSync(new URL(`../../vectors/${name}.json`, import.meta.url), "utf8"));

type Vector = { function: string; label: string; args: any[]; returnData: string };
const vectorsFor = (fn: string): Vector[] => committed("functions").vectors.filter((v: Vector) => v.function.startsWith(`${fn}(`));
const word = (returnData: string): string => ethers.hexlify(coder.decode(["bytes"], returnData)[0] as string);

describe("vectors", () => {
  test("committed files equal a fresh run against the deployed bytecode", async () => {
    const fresh = JSON.parse(JSON.stringify(await allVectors()));
    expect(fresh).toEqual({ functions: committed("functions"), lifecycle: committed("lifecycle") });
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
