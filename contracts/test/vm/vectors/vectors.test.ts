// The committed vectors are what the deployed fork bytecode says, and three independent TS encoders agree with them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { allVectors } from "./vectors.ts";
import { DepositoryBounds__factory } from "../../../typechain-types/index.ts";
import { COOPERATIVE_UPDATE_DIFF_PARAM_FOR_TEST } from "../rig.ts";
import { encodeCooperativeUpdateDiff } from "../../../../core/hanko/onchain-domain.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const committed = (name: string) => JSON.parse(readFileSync(new URL(`../../../vectors/${name}.json`, import.meta.url), "utf8"));

type Vector = { function: string; label: string; args: any[]; returnData: string };
const vectorsFor = (fn: string): Vector[] => committed("functions").vectors.filter((v: Vector) => v.function.startsWith(`${fn}(`));
const word = (returnData: string): string => ethers.hexlify(coder.decode(["bytes"], returnData)[0] as string);

describe("vectors", () => {
  test("committed files equal a fresh run against the deployed bytecode", async () => {
    const fresh = JSON.parse(JSON.stringify(await allVectors()));
    expect(fresh).toEqual({ functions: committed("functions"), lifecycle: committed("lifecycle"), baseline: committed("baseline"), batch: committed("batch"), hanko: committed("hanko") });
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

  test("batch layout: every op array alone and all together decode on the deployed bytecode, in the field order of the Batch struct", () => {
    const { layout } = committed("batch");
    expect(layout.fields).toEqual(["gasBudget", "reserveToReserve", "reserveToCollateral", "collateralToReserve", "settlements", "disputeStarts", "counterDisputes", "disputeFinalizations", "externalTokenToReserve", "reserveToExternalToken", "revealSecrets", "hashLadderRegistrations"]);
    type LayoutCase = { label: string; accepted: boolean; rejectedWith?: string; encodedBatch: string; input?: unknown; shape?: Record<string, number | number[]> };
    // the label says what the deployed contract must have done: a case is rejected exactly when its label says so
    for (const c of layout.cases as LayoutCase[]) expect([c.label, c.accepted]).toEqual([c.label, !c.label.includes("rejected")]);
    const rejections = (layout.cases as LayoutCase[]).filter((c) => !c.accepted).map((c) => c.rejectedWith);
    expect(rejections.filter((r) => r === "E10").length).toBe(7);                     // budget, 51 ops, 9 starts, 2 finalizations, 65 pairs, 251 pairs, 1000 ops
    expect(rejections.filter((r) => r === "revert with no data").length).toBe(4);     // a value one past uint64, uint8, uint16, bool: the decoder refuses it
    expect(rejections.length).toBe(11);
    // the bounds at their edge, from the shape each case names (DepositoryBounds: 50 ops in all, 8 dispute starts, 1 finalization, 64 pairs an op, 250 pairs in all)
    for (const c of (layout.cases as LayoutCase[]).filter((k) => k.shape)) {
      const counts = Object.fromEntries(Object.entries(c.shape!).filter(([k]) => k !== "pairsPerReserveToCollateral")) as Record<string, number>;
      const pairs = (c.shape!.pairsPerReserveToCollateral ?? []) as number[];
      const ops = Object.values(counts).reduce((a, b) => a + b, 0) + pairs.length;
      const within = ops <= 50 && (counts.disputeStarts ?? 0) <= 8 && (counts.disputeFinalizations ?? 0) <= 1 && pairs.every((n) => n <= 64) && pairs.reduce((a, b) => a + b, 0) <= 250;
      expect([c.label, c.accepted]).toEqual([c.label, within]);
    }
    // the mixed sample earns its name: no two number slots of one struct hold the same value, so swapping two of them changes the bytes
    const structsOf = (value: unknown): Record<string, unknown>[] =>
      Array.isArray(value) ? value.flatMap(structsOf) : value && typeof value === "object" ? [value as Record<string, unknown>, ...Object.values(value).flatMap(structsOf)] : [];
    const mixed = (layout.cases as LayoutCase[]).find((c) => c.label === "every array, mixed values")!;
    for (const struct of structsOf(mixed.input)) {
      const numbers = Object.values(struct).filter((v) => typeof v === "string" && /^-?\d+$/.test(v));
      expect(new Set(numbers).size).toBe(numbers.length);
    }
    // every recorded input is what the bytes encode (numbers as decimal strings), so an encoder elsewhere can build the same bytes from it
    const batchType = DepositoryBounds__factory.createInterface().getFunction("assertBatch")!.inputs[0]!;
    for (const c of (layout.cases as LayoutCase[]).filter((k) => k.input && !k.label.includes("past") && !/\(u?int\d+|bool\)/.test(k.label))) expect([c.label, coder.encode([batchType], [c.input])]).toEqual([c.label, c.encodedBatch]);
    const accepted = (layout.cases as LayoutCase[]).filter((c) => c.accepted);
    expect(accepted.length).toBe(layout.cases.length - rejections.length);
    // each single-field case carries exactly one populated array, at its own position, and the first word of the head is the gas budget
    const word = (hex: string, i: number): bigint => BigInt(`0x${hex.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
    for (const [i, field] of layout.fields.slice(1).entries()) {
      const c = layout.cases.find((k: { label: string }) => k.label.startsWith(`only ${field} `));
      const head = 1 + 1 + i;                          // [tuple offset][gasBudget][array offsets...]: array i is the (i+1)th head slot after the budget
      expect(word(c.encodedBatch, 1)).toBe(BigInt(layout.gasBudget));
      const offsets = Array.from({ length: layout.fields.length - 1 }, (_, k) => word(c.encodedBatch, 2 + k));
      const lengthOf = (offset: bigint) => word(c.encodedBatch, 1 + Number(offset) / 32);   // the batch tuple starts at word 1; offsets are from the start of the tuple
      const lengths = offsets.map(lengthOf);
      expect(lengths.map((n, k) => (k === i ? n > 0n : n === 0n)).every(Boolean)).toBe(true);
      expect(head).toBe(2 + i);
    }
  });

  test("batch ops: each op the lifecycle does not run did what its rules say", () => {
    const { ops } = committed("batch");
    expect([ops.reserveToReserve.result, ops.reserveToReserve.state]).toEqual(["ok", { left: "877", right: "123" }]);
    expect([ops.reserveToCollateral.result, ops.reserveToCollateral.state]).toEqual(["ok", { left: "727", collateralWithRight: "100", collateralWithThird: "50" }]);
    expect([ops.collateralToReserve.result, ops.collateralToReserve.state]).toEqual(["ok", { left: "940", collateral: "60", storedNonce: "3" }]);
    // re-derived here with plain ethers from the recorded fields (the leg's own account, not the lifecycle's)
    const c2r = ops.collateralToReserve;
    const diffs = c2r.signedDiffs.map((d: Record<string, string>) => encodeCooperativeUpdateDiff({ tokenId: BigInt(d.tokenId!), leftDiff: BigInt(d.leftDiff!), rightDiff: BigInt(d.rightDiff!), collateralDiff: BigInt(d.collateralDiff!), ondeltaDiff: BigInt(d.ondeltaDiff!) }));
    expect(c2r.cooperativeUpdateHash).toBe(ethers.keccak256(coder.encode(
      ["uint256", "uint256", "address", "bytes", "uint256", "uint256", COOPERATIVE_UPDATE_DIFF_PARAM_FOR_TEST, "uint256[]"],
      [0, c2r.chainId, c2r.depository, c2r.accountKey, c2r.epoch, 3, diffs, []])));
    expect(ops.revealSecrets.hashlock).toBe(ethers.keccak256(coder.encode(["bytes32"], [ops.revealSecrets.events[0].args.secret])));
    expect([ops.counterDispute.start, ops.counterDispute.result, ops.counterDispute.events[0].name]).toEqual(["ok", "ok", "CounterDisputeRegistered"]);
    // the implicit flash: the reserve is 50 short inside the batch and repaid by the collateral withdrawal, so the batch lands
    expect([ops.composite.result, ops.composite.state]).toEqual(["ok", { left: "50", right: "1950", collateral: "0" }]);
    for (const op of Object.values(ops) as { batchHash?: string; events?: { name: string; args: { batchHash?: string } }[] }[]) {
      const processed = op.events?.find((e) => e.name === "HankoBatchProcessed");
      if (processed) expect(processed.args.batchHash).toBe(op.batchHash);
    }
  });

  test("hanko: every accepted envelope proves the entity its board hashes to, re-derived here from the envelope alone", () => {
    const { cases, depository } = committed("hanko");
    const HANKO = ["tuple(bytes32[] placeholders, bytes packedSignatures, tuple(bytes32 entityId, uint256[] entityIndexes, uint256[] weights, uint256 threshold, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)[] claims, bytes[] memberSignatures)"];
    const BOARD = ["tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)"];
    const lazy = (address: string) => ethers.keccak256(coder.encode(BOARD, [[1, [ethers.zeroPadValue(address, 32)], [1], 0, 0, 0]]));
    const derive = (hanko: string, hash: string) => {
      const [h] = coder.decode(HANKO, hanko) as unknown as [{ placeholders: string[]; packedSignatures: string; claims: { entityId: string; entityIndexes: bigint[]; weights: bigint[]; threshold: bigint; boardChangeDelay: bigint; controlChangeDelay: bigint; dividendChangeDelay: bigint }[] }];
      const packed = ethers.getBytes(h.packedSignatures);
      const count = packed.length === 0 ? 0 : Math.floor((packed.length * 8) / 513);
      const signers = Array.from({ length: count }, (_, i) => {
        const v = (packed[count * 64 + Math.floor(i / 8)]! >> (i % 8)) & 1 ? 28 : 27;
        const signature = ethers.Signature.from({ r: ethers.hexlify(packed.slice(i * 64, i * 64 + 32)), s: ethers.hexlify(packed.slice(i * 64 + 32, i * 64 + 64)), v });
        return ethers.zeroPadValue(ethers.recoverAddress(hash, signature), 32);
      });
      const members = [...h.placeholders, ...signers];
      const ids: string[] = [];
      const power: bigint[] = [];
      for (const claim of h.claims) {
        const memberIds = claim.entityIndexes.map((ix) => (Number(ix) < members.length ? members[Number(ix)]! : ids[Number(ix) - members.length]!));
        ids.push(ethers.keccak256(coder.encode(BOARD, [[claim.threshold, memberIds, claim.weights, claim.boardChangeDelay, claim.controlChangeDelay, claim.dividendChangeDelay]])));
        // power: a signer and a nested claim each bring their weight; a placeholder brings none
        power.push(claim.entityIndexes.reduce((sum, ix, k) => (Number(ix) < h.placeholders.length ? sum : sum + claim.weights[k]!), 0n));
      }
      // the contract fails the whole proof as soon as ANY claim misses its threshold, not only the last one
      const met = h.claims.every((claim, i) => power[i]! >= claim.threshold);
      return { claimIds: ids, proved: ids[h.claims.length - 1]!, met };
    };
    const isBare = (c: { hanko: string }) => c.hanko.length === 2 + 2 * 65;
    const bareSigner = (hanko: string, hash: string) => {
      const bytes = ethers.getBytes(hanko);
      const v = bytes[64]! < 27 ? bytes[64]! + 27 : bytes[64]!;
      return ethers.recoverAddress(hash, ethers.Signature.from({ r: ethers.hexlify(bytes.slice(0, 32)), s: ethers.hexlify(bytes.slice(32, 64)), v }));
    };
    const accepted = cases.filter((c: any) => c.result.success === true);
    const refused = cases.filter((c: any) => c.result.success === false || c.result.revertedWith);
    expect(accepted.length + refused.length).toBe(cases.length);
    for (const c of accepted) {
      if (isBare(c)) { expect(c.result.entityId).toBe(lazy(bareSigner(c.hanko, c.hash))); continue; }
      const d = derive(c.hanko, c.hash);
      expect(d.claimIds).toEqual(c.claimEntityIds);
      expect([d.proved, d.met]).toEqual([c.result.entityId, true]);
    }
    // an envelope the contract answers "success false" to is well formed; by its own rules some claim misses its threshold, or a signature is high-s
    for (const c of cases.filter((k: any) => k.result.success === false && !isBare(k) && !k.label.includes("high-s"))) expect(derive(c.hanko, c.hash).met).toBe(false);
    expect(cases.filter((c: any) => c.result.revertedWith).map((c: any) => c.result.revertedWith).sort()).toEqual(
      ["DuplicateHankoClaimEntity", "DuplicateHankoEntityIndex", "DuplicateHankoPlaceholder", "DuplicateHankoSigner", "HankoProofTooLarge", "InvalidHankoClaimOrder", "InvalidHankoClaimOrder", "InvalidHankoClaimShape", "InvalidHankoClaimShape", "InvalidHankoFirstMember", "InvalidHankoMemberSignatures", "InvalidHankoPackedSignatureLength", "InvalidHankoPackedSignaturePadding", "InvalidHankoThreshold", "InvalidHankoThreshold", "InvalidHankoWeight", "InvalidHankoWeight", "NonCanonicalHankoPlaceholder", "UnusedHankoClaim", "UnusedHankoPlaceholder", "UnusedHankoSignature"]);
    // the nested entity acts: its batch lands, moves its reserve, and the same Hanko over another hash is E4
    expect([depository.result, depository.reserves, depository.signedForAnotherHash]).toEqual(["ok", { entity: "423", target: "77" }, "REVERT E4()"]);
  });
});
