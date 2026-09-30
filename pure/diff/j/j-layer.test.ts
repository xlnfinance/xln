import { describe, expect, test } from "bun:test";
import { seedOf, seedTag } from "../seed.ts";
import { Interface } from "ethers";
import { Depository__factory } from "../../../contracts/typechain-types/factories/Depository.sol/Depository__factory.ts";
import { loadShippedRpcPublic, shippedDepositoryAbi } from "../rig/contracts.ts";
import { EntityProvider__factory } from "../../../contracts/typechain-types/factories/EntityProvider__factory.ts";
import { DEPOSITORY_J_EVENTS, ENTITY_PROVIDER_J_EVENTS } from "../../../core/jurisdiction/machine/event-catalog.ts";
import { extractCanonicalDepositoryEventArgs } from "../../../core/jurisdiction/adapter/events/depository-event-codec.ts";
import { rawEventToJEvents } from "../../../core/jurisdiction/adapter/events/j-event-payloads.ts";
import { computeBatchHankoHash, createEmptyBatch, decodeJBatch, encodeJBatch, getOpenOutgoingDebtTotals, simulateDraftBatchReserveAvailability } from "../../../core/jurisdiction/machine/batch/index.ts";
import { handleR2R } from "../../../core/entity/tx/handlers/j-batch/r2r.ts";
import { handleR2C } from "../../../core/entity/tx/handlers/j-batch/r2c.ts";
import { handleR2E } from "../../../core/entity/tx/handlers/j-batch/r2e.ts";
import { takeBroadcastBatch as ogTakeBroadcastBatch } from "../../../core/entity/tx/handlers/j-batch/j-broadcast.ts";
import { applyHankoBatchProcessedEvent } from "../../../core/entity/tx/j-events-batch.ts";
import { encodeInt512, encodeUint512 } from "../../../core/protocol/crypto/abi-money.ts";
import { hashProofBodyStruct } from "../../../core/protocol/dispute/proof-builder.ts";
import { handleJEventClaim } from "../../../core/account/tx/handlers/j-events/claim.ts";
import { prepareAccountJClaimTx } from "../../../core/account/j-claims/j-claim-transition.ts";
import { createAccountJClaimSession } from "../../../core/account/j-claims/j-claim-session.ts";
import { createEmptyAccountJClaimAccumulator, createAccountJClaimRecord, verifyAccountJClaimProof } from "../../../core/account/j-claims/j-claim-accumulator.ts";
import { computeFrameHash } from "../../../core/account/consensus/frame/hash.ts";
import { canonicalJurisdictionEventsHash } from "../../../core/jurisdiction/machine/event-observation.ts";
import { applyAccountSettledJEvent } from "../../../core/entity/tx/j-events-account-settled.ts";
import { mergeJEventClaimOps } from "../../../core/entity/tx/j-events-account.ts";
import { applyDebtJEvent, applyReserveUpdatedJEvent } from "../../../core/entity/tx/j-events-observations/index.ts";
import { EntityAccountCandidateMap } from "../../../core/entity/state/persistent-account-map.ts";
import { readEntityFrameEvents } from "../../../core/entity/frame-events.ts";
import {
  J_EVENT_SIGNATURES, jEventTopic, readJEvents, decodeBatch, disputeProofEvidence, finalizationEvidence, withDisputeCalldata, encodeBatch, emptyBatch, contractBatch, emptyQueuedBatch, proofBodyHash, PROCESS_BATCH_SELECTOR, WATCHTOWER_COUNTER_DISPUTE_SELECTOR,
  admit, applyAccountInput, committed, frameStateHash, getDelta, planAccountProposal, replicaId, entityJEvents, observeJBlocks, applyDebtEvent, withBatchNonces, EMPTY_DEBTS,
  simulateBatchReserves, openOutgoingDebtTotals, queueR2R, queueR2C, queueR2E, jBroadcast, takeBroadcastBatch, applyHankoBatchProcessed, initJBatch, genesisHost, applyHost, DORMANT, ogJBatchOf, ogJBatchState, sentOf,
  type JObserver, type JObservation, type JBlock, type DebtLedger, type JEntity, type JBatch, type QueuedBatch, type JQueued, type Result,
  type Batch, type ProofBody, type JEvent, type AccountFrame, type AccountInput, type AccountReplica, type EntityId, type ProposedAccount, type WireAccountTx,
} from "../../xln.ts";
import { ALICE, BOB, CLOCK, NOW, TERMS, TOKEN, ackInput, genesisAB, hankoVerify, offerOf, partyIn, proposeInput, signAccountFrame, unwrap } from "../../xln_run.ts";

const prng = (base: number) => { let seed = seedOf(base); return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const rng = prng(0x5eed_1a);
const ri = (n: number) => Math.floor(rng() * n);
const pick = <X,>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
const W = (b: string) => `0x${b.repeat(32 / (b.length / 2))}`;
const U256 = (1n << 256n) - 1n, SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const b32 = () => W(pick(["11", "22", "aB", "00", "fe"]));
const addr = () => pick([`0x${"ab".repeat(20)}`, "0x5FbDB2315678afecb367f032d93F642f64180aa3", `0x${"01".repeat(20)}`]);
/** The Depository we control (contracts/): the rewrite decodes its calldata. */
const DEPOSITORY = new Interface(Depository__factory.abi);
/** og's decoders are frozen with og's Depository (jurisdictions/); they are fed og-shaped calldata for the same batch. */
const OG_DEPOSITORY = new Interface(shippedDepositoryAbi as never);
/**
 * og's dispute-evidence decoders read the Depository interface once, at import. In the one-process suite an earlier
 * file has already loaded rpc-public with the fork installed, so the decoders are loaded fresh, with the shipped ABI.
 */
const ogRpc = await loadShippedRpcPublic();
const { decodeDisputeFinalizationEvidenceCalldata, decodeDisputeProofBodyEvidenceCalldata } = ogRpc;
const { resolveDisputeFinalizationEvidence, resolveDisputeProofBodyEvidence } = ogRpc;
const PROCESS_BATCH_ENTITY = `0x${"e1".repeat(32)}`;
const PROVIDER = new Interface(EntityProvider__factory.abi);
const COORDS = { blockNumber: 7, blockHash: W("0b"), transactionHash: W("0c"), logIndex: 3 };

/** og ingress for one raw log: carrier parse, canonical args, then rawEventToJEvents (normalizers); null when og refuses. */
const ogIngress = (iface: Interface, log: { topics: readonly string[]; data: string }, entityId: string, extraArgs: Record<string, unknown> = {}): any[] | null => {
  try {
    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data })!;
    return rawEventToJEvents({ name: parsed.name, args: { ...extractCanonicalDepositoryEventArgs(parsed), ...extraArgs }, ...COORDS }, entityId);
  } catch { return null; }
};
const rwIngress = (log: { topics: readonly string[]; data: string }): readonly JEvent[] | null => { try { return readJEvents([{ topics: log.topics, data: log.data, ...COORDS }]); } catch { return null; } };
/** The rewrite's decoded fields in og's normalized JurisdictionEvent data form. */
const S = (n: bigint) => n.toString(), N = (n: bigint) => Number(n);
const asOg = (e: JEvent): { type: string; data: Record<string, unknown> } => {
  switch (e.type) {
    case "HankoBatchProcessed": return { type: e.type, data: { entityId: e.entityId, batchHash: e.batchHash, nonce: N(e.nonce) } };
    case "ReserveUpdated": return { type: e.type, data: { entity: e.entity, tokenId: N(e.tokenId), newBalance: S(e.newBalance) } };
    case "SecretRevealed": return { type: e.type, data: { hashlock: e.hashlock, revealer: e.revealer, secret: e.secret } };
    case "CounterDisputeRegistered": return { type: e.type, data: { sender: e.sender, counterentity: e.counterentity, nonce: N(e.nonce), proposerIsLeft: e.proposerIsLeft, proofbodyHash: e.proofbodyHash } };
    case "HashLadderRevealRegistered": return { type: e.type, data: { entity: e.entity, counterpartyEntity: e.counterpartyEntity, ladderHash: e.ladderHash, fillRatio: e.fillRatio, fullSecret: e.fullSecret, reveals: [...e.reveals], targetRole: e.targetRole, revealedAt: N(e.revealedAt) } };
    case "DebtCreated": return { type: e.type, data: { debtor: e.debtor, creditor: e.creditor, tokenId: N(e.tokenId), amount: S(e.amount), debtIndex: N(e.debtIndex) } };
    case "DebtEnforced": return { type: e.type, data: { debtor: e.debtor, creditor: e.creditor, tokenId: N(e.tokenId), amountPaid: S(e.amountPaid), remainingAmount: S(e.remainingAmount), newDebtIndex: N(e.newDebtIndex) } };
    case "DebtForgiven": return { type: e.type, data: { debtor: e.debtor, creditor: e.creditor, tokenId: N(e.tokenId), amountForgiven: S(e.amountForgiven), debtIndex: N(e.debtIndex) } };
    case "FoundationBootstrapped": return { type: e.type, data: { recipient: e.recipient, boardHash: e.boardHash, controlTokenId: S(e.controlTokenId), dividendTokenId: S(e.dividendTokenId) } };
    case "EntityRegistered": return { type: e.type, data: { entityId: e.entityId, entityNumber: S(e.entityNumber), boardHash: e.boardHash } };
    case "BoardActivated": return { type: e.type, data: { entityId: e.entityId, previousBoardHash: e.previousBoardHash, newBoardHash: e.newBoardHash, previousBoardValidUntil: S(e.previousBoardValidUntil) } };
    case "EntityProviderActionExecuted": return { type: e.type, data: { entityId: e.entityId, actionNonce: S(e.actionNonce), actionHash: e.actionHash, actionKind: e.actionKind } };
    case "EntityProviderActionCancelled": return { type: e.type, data: { entityId: e.entityId, actionNonce: S(e.actionNonce), cancelledActionHash: e.cancelledActionHash, cancelHash: e.cancelHash, cancelledActionKind: e.cancelledActionKind } };
    default: throw new Error(`asOg: ${e.type}`);
  }
};
const stripMeta = (e: any) => { const { blockNumber: _a, blockHash: _b, transactionHash: _c, logIndex: _d, eventIndex: _e, ...rest } = e; return rest; };

describe(seedTag("J event ingress (og core/jurisdiction/adapter/events/*, machine/event-normalizers.ts)"), () => {
  test("MATCH: every consensus Depository and EntityProvider event has the contract's signature and topic0 (event-catalog.ts)", () => {
    const expected = [...DEPOSITORY_J_EVENTS.consensus.map((n) => [n, DEPOSITORY] as const), ...ENTITY_PROVIDER_J_EVENTS.consensus.map((n) => [n, PROVIDER] as const)];
    expect(Object.keys(J_EVENT_SIGNATURES).sort()).toEqual(expected.map(([n]) => n).sort());
    for (const [n, iface] of expected) {
      const e = iface.getEvent(n)!;
      expect<string>(J_EVENT_SIGNATURES[n as keyof typeof J_EVENT_SIGNATURES]).toBe(e.format("sighash"));
      expect(jEventTopic(n as keyof typeof J_EVENT_SIGNATURES)).toBe(e.topicHash);
    }
  });

  test("MATCH: random logs of the eleven non-dispute consensus events decode to og's normalized data, and og-invalid payloads are refused by both (100 rounds)", () => {
    const uintish = () => pick([0n, 1n, 2n, 7n, SAFE, SAFE + 1n, U256, BigInt(ri(1e9))]);
    const small = () => pick([0n, 1n, 5n, BigInt(ri(1e6)), SAFE, SAFE + 1n]);
    const u512 = () => pick([0n, 1n, U256, U256 + 1n, (1n << 511n) + 5n, BigInt(ri(1e9))]);
    let agreeOk = 0, agreeRefuse = 0;
    for (let i = 0; i < 100; i++) {
      const logs: [Interface, { topics: readonly string[]; data: string }][] = [
        [DEPOSITORY, DEPOSITORY.encodeEventLog("HankoBatchProcessed", [b32(), b32(), small()])],
        [DEPOSITORY, DEPOSITORY.encodeEventLog("ReserveUpdated", [b32(), small(), uintish()])],
        [DEPOSITORY, DEPOSITORY.encodeEventLog("SecretRevealed", [b32(), b32(), b32()])],
        [DEPOSITORY, DEPOSITORY.encodeEventLog("CounterDisputeRegistered", [b32(), b32(), small(), rng() < 0.5, b32()])],
        [DEPOSITORY, DEPOSITORY.encodeEventLog("HashLadderRevealRegistered", [b32(), b32(), b32(), pick([0, 1, 65535, ri(65536)]), b32(), [b32(), b32(), b32(), b32()], rng() < 0.5, small()])],
        [DEPOSITORY, DEPOSITORY.encodeEventLog("DebtCreated", [b32(), b32(), small(), encodeUint512(u512()), small()])],
        [DEPOSITORY, DEPOSITORY.encodeEventLog("DebtEnforced", [b32(), b32(), small(), uintish(), encodeUint512(u512()), small()])],
        [DEPOSITORY, DEPOSITORY.encodeEventLog("DebtForgiven", [b32(), b32(), small(), encodeUint512(u512()), small()])],
        [PROVIDER, PROVIDER.encodeEventLog("FoundationBootstrapped", [addr(), b32(), uintish(), uintish()])],
        [PROVIDER, PROVIDER.encodeEventLog("EntityRegistered", [b32(), uintish(), b32()])],
        [PROVIDER, PROVIDER.encodeEventLog("BoardActivated", [b32(), b32(), b32(), pick([0n, 1n, uintish()])])],
        [PROVIDER, PROVIDER.encodeEventLog("EntityProviderActionExecuted", [b32(), pick([0n, 1n, uintish()]), b32(), pick([0, 1])])],
        [PROVIDER, PROVIDER.encodeEventLog("EntityProviderActionCancelled", [b32(), pick([0n, 1n, uintish()]), b32(), pick([0, 1]), b32()])],
      ];
      for (const [iface, log] of logs) {
        // og requires the calldata ProofBody on a counter-dispute; its log fields are compared here, the body in the calldata suite.
        const counter = iface.parseLog(log)?.name === "CounterDisputeRegistered", body = ogProof(proofBody());
        const og = ogIngress(iface, log, W("11"), counter ? { counterProofbody: body } : {}), rw = rwIngress(log);
        if (og !== null && counter) delete og[0].data.counterProofbody;
        expect({ event: iface.parseLog(log)?.name, refused: rw === null }).toEqual({ event: iface.parseLog(log)?.name, refused: og === null });
        if (og === null || rw === null) { agreeRefuse++; continue; }
        expect(og.length).toBe(1);
        expect(rw.length).toBe(1);
        expect(asOg(rw[0]!)).toEqual(stripMeta(og[0]));
        expect(rw[0]!.meta).toEqual(COORDS);
        agreeOk++;
      }
    }
    expect(agreeOk).toBeGreaterThan(500);
    expect(agreeRefuse).toBeGreaterThan(50);
  }, 30_000);
});

// ---------------------------------------------------------------- calldata (og rpc-public.ts)
const proofBody = (): ProofBody => ({
  watchSeed: b32(), leftResponseSeconds: BigInt(ri(100)), rightResponseSeconds: BigInt(ri(100)), offdeltas: Array.from({ length: ri(3) }, () => pick([0n, 5n, -7n, (1n << 300n), -(1n << 400n)])),
  tokenIds: Array.from({ length: ri(3) }, () => BigInt(1 + ri(9))),
  transformers: Array.from({ length: ri(2) }, () => ({ transformerAddress: addr().toLowerCase(), encodedBatch: pick(["0x", "0xab", "0x" + "cd".repeat(40)]), allowances: Array.from({ length: ri(2) }, () => ({ deltaIndex: BigInt(ri(4)), rightAllowance: BigInt(ri(1e6)), leftAllowance: BigInt(ri(1e6)) })) })),
});
/** og ProofBodyStruct (ABI-shaped) from the rewrite's ProofBody. */
const ogProof = (b: ProofBody) => ({ ...b, leftResponseSeconds: Number(b.leftResponseSeconds), rightResponseSeconds: Number(b.rightResponseSeconds), offdeltas: b.offdeltas.map(encodeInt512) });
/** The rewrite's ProofBody from og's decoded struct. */
const rwProof = (b: any): ProofBody => ({ watchSeed: b.watchSeed.toLowerCase(), leftResponseSeconds: BigInt(b.leftResponseSeconds), rightResponseSeconds: BigInt(b.rightResponseSeconds), offdeltas: b.offdeltas.map((o: any) => (BigInt(o.high) << 256n) + BigInt(o.low)), tokenIds: b.tokenIds.map(BigInt),
  transformers: b.transformers.map((t: any) => ({ transformerAddress: t.transformerAddress.toLowerCase(), encodedBatch: t.encodedBatch, allowances: t.allowances.map((a: any) => ({ deltaIndex: BigInt(a.deltaIndex), rightAllowance: BigInt(a.rightAllowance), leftAllowance: BigInt(a.leftAllowance) })) })) });
const lowerProof = (b: ProofBody): ProofBody => ({ ...b, watchSeed: b.watchSeed.toLowerCase(), transformers: b.transformers.map((t) => ({ ...t, transformerAddress: t.transformerAddress.toLowerCase() })) });
const randomBatch = (): Batch => {
  const b = emptyBatch() as any;
  const nonceish = () => pick([1n, 2n, BigInt(ri(1e6)), SAFE, SAFE + 1n]);
  b.reserveToReserve = Array.from({ length: ri(2) }, () => ({ receivingEntity: b32(), tokenId: nonceish(), amount: BigInt(ri(1e9)) }));
  b.disputeStarts = Array.from({ length: ri(3) }, () => { const p = proofBody(); return { counterentity: b32(), nonce: nonceish(), proposerIsLeft: rng() < 0.5, proofbodyHash: rng() < 0.8 ? proofBodyHash(p) : b32(), initialProofbody: p, watchSeed: b32(), sig: "0x" + "12".repeat(ri(3)), starterInitialArguments: "0x", starterCounterArguments: "0xab", starterCounterProofCommitment: b32() }; });
  b.counterDisputes = Array.from({ length: ri(2) }, () => ({ counterentity: b32(), initialNonce: nonceish(), initialProofbodyHash: b32(), counterNonce: nonceish(), proposerIsLeft: rng() < 0.5, counterProofbody: proofBody(), sig: "0x01" }));
  b.disputeFinalizations = Array.from({ length: ri(2) }, () => ({ counterentity: b32(), initialNonce: nonceish(), finalNonce: nonceish(), proposerIsLeft: rng() < 0.5, initialProofbodyHash: b32(), finalProofbody: proofBody(), starterArguments: pick(["0x", "0xaa"]), otherArguments: pick(["0x", "0xbb01"]), sig: pick(["0x", "0x" + "cc".repeat(65)]), startedByLeft: rng() < 0.5, cooperative: rng() < 0.3 }));
  b.settlements = Array.from({ length: ri(2) }, () => ({ leftEntity: b32(), rightEntity: b32(), diffs: [{ tokenId: 1n, leftDiff: -5n, rightDiff: 0n, collateralDiff: 5n, ondeltaDiff: 5n }], forgiveDebtsInTokenIds: [2n], sig: "0x", nonce: nonceish() }));
  return b as Batch;
};
const ogBatchOf = (b: Batch): any => {
  const n = Number;
  return { ...createEmptyBatch(),
    reserveToReserve: b.reserveToReserve.map((r) => ({ ...r, tokenId: n(r.tokenId) })),
    settlements: b.settlements.map((s) => ({ ...s, nonce: n(s.nonce), forgiveDebtsInTokenIds: s.forgiveDebtsInTokenIds.map(n), diffs: s.diffs.map((d) => ({ ...d, tokenId: n(d.tokenId) })) })),
    disputeStarts: b.disputeStarts.map((s) => ({ ...s, nonce: n(s.nonce), initialProofbody: ogProof(s.initialProofbody) })),
    counterDisputes: b.counterDisputes.map((c) => ({ ...c, initialNonce: n(c.initialNonce), counterNonce: n(c.counterNonce), counterProofbody: ogProof(c.counterProofbody) })),
    disputeFinalizations: b.disputeFinalizations.map((f) => ({ ...f, initialNonce: n(f.initialNonce), finalNonce: n(f.finalNonce), finalProofbody: ogProof(f.finalProofbody) })),
  };
};
/** The same batch as calldata for each Depository: the fork's takes the acting Entity first (C2), og's does not. */
const processBatchCalldata = (b: Batch) => ({
  og: OG_DEPOSITORY.encodeFunctionData("processBatch", [encodeBatch(b), "0x", 1n]),
  rw: DEPOSITORY.encodeFunctionData("processBatch", [PROCESS_BATCH_ENTITY, encodeBatch(b), "0x", 1n]),
});

describe(seedTag("dispute calldata evidence (og rpc-public.ts decodeDisputeProofBodyEvidenceCalldata / decodeJBatch)"), () => {
  test("MATCH: processBatch and watchtowerCounterDispute selectors equal the Depository ABI's", () => {
    expect(PROCESS_BATCH_SELECTOR).toBe(DEPOSITORY.getFunction("processBatch")!.selector);
    expect(PROCESS_BATCH_SELECTOR).not.toBe(OG_DEPOSITORY.getFunction("processBatch")!.selector);
    expect(WATCHTOWER_COUNTER_DISPUTE_SELECTOR).toBe(DEPOSITORY.getFunction("watchtowerCounterDispute")!.selector);
  });

  test("MATCH: decodeBatch == og decodeJBatch on random batches, including og's safe-integer refusals (80 rounds)", () => {
    let accepted = 0, refused = 0;
    for (let i = 0; i < 80; i++) {
      const b = randomBatch(), encoded = encodeBatch(b);
      const og = (() => { try { return decodeJBatch(encoded); } catch { return null; } })();
      const rw = (() => { try { return decodeBatch(encoded); } catch { return null; } })();
      expect(rw === null).toBe(og === null);
      if (og === null || rw === null) { refused++; continue; }
      accepted++;
      expect(rw.disputeStarts.map((s) => ({ ...s, initialProofbody: lowerProof(s.initialProofbody) }))).toEqual(og.disputeStarts.map((s: any) => ({ ...s, counterentity: s.counterentity, nonce: BigInt(s.nonce), initialProofbody: rwProof(s.initialProofbody) })));
      expect(rw.counterDisputes.map((c) => c.counterProofbody).map(lowerProof)).toEqual(og.counterDisputes.map((c: any) => rwProof(c.counterProofbody)));
      expect(rw.disputeFinalizations.map((f) => [f.initialNonce, f.finalNonce, f.sig, f.startedByLeft, f.cooperative])).toEqual(og.disputeFinalizations.map((f: any) => [BigInt(f.initialNonce), BigInt(f.finalNonce), f.sig, f.startedByLeft, f.cooperative]));
      expect(rw.settlements.map((s) => s.diffs)).toEqual(og.settlements.map((s: any) => s.diffs.map((d: any) => ({ ...d, tokenId: BigInt(d.tokenId) }))));
      expect(encodeBatch(rw)).toBe(encoded);
    }
    expect(accepted).toBeGreaterThan(5);
    expect(refused).toBeGreaterThan(5);
  });

  test("MATCH: dispute ProofBody evidence and finalization evidence from processBatch / watchtower calldata equal og's, and each dispute log resolves to og's ProofBody (60 rounds)", () => {
    let resolved = 0;
    for (let i = 0; i < 60; i++) {
      const b = randomBatch();
      const ogOk = (() => { try { encodeJBatch(ogBatchOf(b)); decodeJBatch(encodeBatch(b)); return true; } catch { return false; } })();
      if (!ogOk) continue;
      const { og: ogCalldata, rw: calldata } = processBatchCalldata(b);
      expect(encodeJBatch(ogBatchOf(b))).toBe(encodeBatch(b));
      const og = decodeDisputeProofBodyEvidenceCalldata(ogCalldata), rw = disputeProofEvidence(calldata);
      expect(rw.map((c) => ({ ...c, proofbody: lowerProof(c.proofbody) }))).toEqual(og.map((c: any) => ({ ...c, nonce: BigInt(c.nonce), ...(c.initialNonce === undefined ? {} : { initialNonce: BigInt(c.initialNonce) }), proofbody: rwProof(c.proofbody) })));
      const ogFin = decodeDisputeFinalizationEvidenceCalldata(ogCalldata), rwFin = finalizationEvidence(calldata);
      expect(rwFin).toEqual(ogFin.map((f: any) => ({ ...f, initialNonce: BigInt(f.initialNonce), finalNonce: BigInt(f.finalNonce) })));
      // Each start's DisputeStarted log resolves to the same body (og resolveDisputeProofBodyEvidence), with a proposer flip refused by both.
      for (const s of b.disputeStarts) {
        for (const flip of [false, true]) {
          const args = { counterentity: s.counterentity, nonce: s.nonce, proofbodyHash: s.proofbodyHash, proposerIsLeft: flip ? !s.proposerIsLeft : s.proposerIsLeft };
          const ogBody = (() => { try { return rwProof(resolveDisputeProofBodyEvidence(og, "DisputeStarted", args)); } catch { return null; } })();
          const ev: JEvent = { type: "DisputeStarted", sender: W("99"), counterentity: s.counterentity.toLowerCase(), nonce: s.nonce, proposerIsLeft: args.proposerIsLeft, proofbodyHash: s.proofbodyHash.toLowerCase(), watchSeed: s.watchSeed, starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: W("00"), disputeTimeout: 3n, disputeStartTimestamp: 1n, leftResponseSeconds: 1n, rightResponseSeconds: 1n };
          const rwBody = (() => { try { const e = withDisputeCalldata(ev, calldata); return e.type === "DisputeStarted" && e.initialProofbody !== undefined ? lowerProof(e.initialProofbody) : null; } catch { return null; } })();
          expect(rwBody).toEqual(ogBody);
          if (rwBody !== null) resolved++;
        }
      }
      // Finalizations: og resolveDisputeFinalizationEvidence by the logged evidence hash; the rewrite attaches the same evidence and final body.
      for (const f of b.disputeFinalizations) {
        const finalProofbodyHash = hashProofBodyStruct(ogProof(f.finalProofbody) as any);
        const candidate = ogFin.find((c: any) => c.counterentity === f.counterentity.toLowerCase() && BigInt(c.initialNonce) === f.initialNonce)!;
        const evidenceHash = (() => { const { finalizationEvidenceHash } = require("../../xln.ts"); return finalizationEvidenceHash(rwFin.find((c) => c.counterentity === candidate.counterentity && c.initialNonce === f.initialNonce)!); })();
        const args = { sender: W("99"), counterentity: f.counterentity, initialNonce: f.initialNonce, finalProofbodyHash, finalizationEvidenceHash: evidenceHash };
        const ogEvidence = resolveDisputeFinalizationEvidence(ogFin, W("0c"), args);
        const ev: JEvent = { type: "DisputeFinalized", sender: W("99"), counterentity: f.counterentity.toLowerCase(), nonce: f.initialNonce, finalProofbodyHash, finalizationEvidenceHash: evidenceHash, meta: { transactionHash: W("0c") } };
        const got = withDisputeCalldata(ev, calldata);
        if (got.type !== "DisputeFinalized") throw new Error("type");
        expect(got.evidence).toEqual({ ...ogEvidence, initialNonce: BigInt(ogEvidence.initialNonce), finalNonce: BigInt(ogEvidence.finalNonce) });
        expect(lowerProof(got.finalProofbody!)).toEqual(rwProof(resolveDisputeProofBodyEvidence(og, "DisputeFinalized", args)));
        expect(got.initialProofbodyHash).toBe(ogEvidence.initialProofbodyHash);
        resolved++;
      }
    }
    expect(resolved).toBeGreaterThan(20);
  }, 30_000);

  test("MATCH: a watchtowerCounterDispute call yields the CounterDisputeRegistered + DisputeFinalized pair like og", () => {
    for (let i = 0; i < 10; i++) {
      const f = { counterentity: b32(), initialNonce: BigInt(1 + ri(9)), finalNonce: BigInt(1 + ri(9)), proposerIsLeft: rng() < 0.5, initialProofbodyHash: b32(), finalProofbody: proofBody(), starterArguments: "0x", otherArguments: "0x01", sig: "0x02", startedByLeft: rng() < 0.5, cooperative: false };
      const calldata = DEPOSITORY.encodeFunctionData("watchtowerCounterDispute", [W("33"), { ...f, finalProofbody: ogProof(f.finalProofbody) }, 5n, 6n, "0x"]);
      const ogCalldata = OG_DEPOSITORY.encodeFunctionData("watchtowerCounterDispute", [W("33"), { ...f, finalProofbody: ogProof(f.finalProofbody) }, 5n, 6n, "0x"]);
      expect(calldata).toBe(ogCalldata);
      const og = decodeDisputeProofBodyEvidenceCalldata(ogCalldata), rw = disputeProofEvidence(calldata);
      expect(rw.map((c) => ({ ...c, proofbody: lowerProof(c.proofbody) }))).toEqual(og.map((c: any) => ({ ...c, nonce: BigInt(c.nonce), initialNonce: BigInt(c.initialNonce), proofbody: rwProof(c.proofbody) })));
      expect(finalizationEvidence(calldata)).toEqual(decodeDisputeFinalizationEvidenceCalldata(ogCalldata).map((x: any) => ({ ...x, initialNonce: BigInt(x.initialNonce), finalNonce: BigInt(x.finalNonce) })));
    }
    // Unknown or unsupported calldata: both refuse.
    const empty = { og: OG_DEPOSITORY.encodeFunctionData("processBatch", ["0x", "0x", 1n]), rw: DEPOSITORY.encodeFunctionData("processBatch", [PROCESS_BATCH_ENTITY, "0x", "0x", 1n]) };
    for (const bad of [{ og: "0xdeadbeef", rw: "0xdeadbeef" }, empty]) {
      expect(() => decodeDisputeProofBodyEvidenceCalldata(bad.og)).toThrow();
      expect(() => disputeProofEvidence(bad.rw)).toThrow();
    }
  });
});

// ---------------------------------------------------------------- multi-claim Account frames (og j-claims/*, proposal/transactions.ts)
const PMap = class<K, V> extends Map<K, V> { put(k: K, v: V): this { this.set(k, v); return this; } del(k: K): void { this.delete(k); } };
const PARTY_LEFT = partyIn(genesisAB(), ALICE).left ? ALICE : BOB, PARTY_RIGHT = PARTY_LEFT === ALICE ? BOB : ALICE;
/** og side: prepareAccountJClaimTx against the evolving tries, then the real handleJEventClaim; a node store outlives each tx like the proposal session. */
const ogClaimAccount = () => {
  const state: any = { leftEntity: PARTY_LEFT, rightEntity: PARTY_RIGHT, deltas: new PMap(), locks: new PMap(), swapOffers: new PMap(), requestedRebalance: new PMap(), requestedRebalanceFeeState: new PMap(),
    domain: TERMS.domain, jNonce: 0, lastFinalizedJHeight: 0, leftPendingJClaims: createEmptyAccountJClaimAccumulator(), rightPendingJClaims: createEmptyAccountJClaimAccumulator() };
  const account: any = { proofHeader: { fromEntity: PARTY_LEFT, toEntity: PARTY_RIGHT }, state, currentHeight: 1, shadow: { rebalance: { submittedAtByToken: new PMap() } } };
  const jurisdictions: any = { jReplicas: new Map([["j", { chainId: TERMS.domain.chainId, contracts: { depository: TERMS.domain.depositoryAddress, entityProvider: `0x${"c1".repeat(20)}`, account: `0x${"c2".repeat(20)}`, deltaTransformer: `0x${"c3".repeat(20)}` } }]]) };
  const store = new Map<string, any>();
  const apply = (tx: any, byLeft: boolean): any | null => {
    const before = { ...state, deltas: new PMap([...state.deltas].map(([k, v]: any) => [k, { ...v }])) };
    const session = createAccountJClaimSession({ get: (h: string) => store.get(h) });
    try {
      const prepared = prepareAccountJClaimTx(state, tx, TERMS.domain, session);
      const r = handleJEventClaim(account, prepared, byLeft, 1, PARTY_LEFT, [], jurisdictions, session);
      if (!r.ok) { Object.assign(state, before); return null; }
      for (const { hash, node } of session.changes()?.newNodes ?? []) store.set(hash, node);
      return prepared;
    } catch { Object.assign(state, before); return null; }
  };
  return { state, apply };
};
type ClaimToken = { tokenId: number; collateral: bigint; ondelta: bigint; eventIndex?: number };
type ClaimCase = { h: number; blk: string; nonce: number; tokens: ClaimToken[]; meta?: { blockNumber: number; blockHash: string; transactionHash: string; logIndex: number } };
const rwClaimOf = (c: ClaimCase): WireAccountTx => ({ type: "j_event_claim", jHeight: BigInt(c.h), jBlockHash: c.blk, observedAt: 1n, events: [{ left: PARTY_LEFT, right: PARTY_RIGHT, nonce: BigInt(c.nonce),
  tokens: c.tokens.map((t) => ({ tokenId: BigInt(t.tokenId), leftReserve: 0n, rightReserve: 0n, collateral: t.collateral, ondelta: t.ondelta, ...(t.eventIndex === undefined ? {} : { eventIndex: t.eventIndex }) })), ...(c.meta === undefined ? {} : { meta: c.meta }) }] }) as unknown as WireAccountTx;
const ogClaimOf = (c: ClaimCase) => ({ type: "j_event_claim", data: { jHeight: c.h, jBlockHash: c.blk, events: c.tokens.map((t) => ({ ...(c.meta ?? {}), ...(t.eventIndex === undefined ? {} : { eventIndex: t.eventIndex }), type: "AccountSettled",
  data: { leftEntity: PARTY_LEFT, rightEntity: PARTY_RIGHT, tokenId: t.tokenId, leftReserve: "0", rightReserve: "0", collateral: t.collateral.toString(), ondelta: t.ondelta.toString(), nonce: c.nonce } })) } });
const randomClaim = (): ClaimCase => {
  const h = 1 + ri(6), blk = W(pick(["0a", "0b"])), n = 1 + ri(2), first = 1 + ri(3);
  const tokens = Array.from({ length: n }, (_, i) => ({ tokenId: first + i, collateral: BigInt(ri(50)), ondelta: BigInt(ri(9)) - 4n, ...(n > 1 ? { eventIndex: n - 1 - i } : {}) }));
  return { h, blk, nonce: ri(4), tokens, ...(ri(2) === 0 ? { meta: { blockNumber: h, blockHash: ri(2) === 0 ? blk : `0x${blk.slice(2).toUpperCase()}`, transactionHash: W(pick(["0c", "Dd"])), logIndex: ri(3) } } : {}) };
};
const stepIn = (r: AccountReplica, input: AccountInput, self: EntityId) => applyAccountInput(r, input, { verify: hankoVerify, self, now: NOW });

describe(seedTag("multi-claim Account frames (og prepareAccountJClaimTx / verifyAccountJClaimProof / activatePostSettlementProof)"), () => {
  test("MATCH: 30 random claim sequences, 1-3 claims per frame from either side (metadata, eventIndex, stale, conflicts, finalizing second claims): proposer witnesses, frame hash, tries and finality equal og; the peer replays and acks", () => {
    let tampered = 0, branched = 0;
    for (let n = 0; n < 30; n++) {
      const og = ogClaimAccount();
      const reps = new Map<EntityId, AccountReplica>([[ALICE, genesisAB()], [BOB, genesisAB()]]);
      for (let f = 0; f < 6; f++) {
        const proposer = pick([ALICE, BOB]), peer = proposer === ALICE ? BOB : ALICE, byLeft = proposer === PARTY_LEFT;
        const cases = Array.from({ length: 1 + ri(3) }, randomClaim);
        const leftRootBefore = og.state.leftPendingJClaims.root;
        const prepared = cases.map((c) => og.apply(ogClaimOf(c), byLeft)).filter((x) => x !== null);
        // the proposal path is under test: seed the mempool directly (og admission would already drop exact duplicates, see diff/book-admission.test.ts)
        const base = reps.get(proposer)!, opened = { ...base, mempool: [...base.mempool, ...cases.map(rwClaimOf)] } as AccountReplica;
        const plan = unwrap(planAccountProposal(opened, proposer, CLOCK, hankoVerify));
        if (plan._tag === "idle") { expect(prepared.length).toBe(0); continue; }
        const proposed = unwrap(stepIn(opened, proposeInput(opened, proposer), proposer)).replica as ProposedAccount;
        const frame = proposed.candidate.frame;
        expect(frame.txs.length).toBe(prepared.length);
        frame.txs.forEach((tx: any, i) => {
          expect(tx.leftProof).toEqual(prepared[i].data.leftProof);
          expect(tx.rightProof).toEqual(prepared[i].data.rightProof);
          if (tx.leftProof.nodes.length > 1 || tx.rightProof.nodes.length > 1) branched++;
        });
        const ogFrame = { height: Number(frame.height), timestamp: Number(frame.timestamp), jHeight: Number(frame.jHeight), prevFrameHash: frame.prevFrameHash, accountStateRoot: frame.accountStateRoot, stateHash: "", accountTxs: prepared };
        expect(computeFrameHash(ogFrame)).toBe(frame.stateHash);
        // A received witness that is not the regenerated path refuses the frame, as og verifyAccountJClaimProof throws on it.
        const first: any = frame.txs[0];
        if (first !== undefined && first.leftProof.nodes.length > 0 && tampered < 12) {
          // og inspectAccountJClaimProof: empty (LENGTH_INVALID), a broken link, a proper prefix (TERMINAL_LEAF_MISSING), a node past the leaf
          const nodes: any[] = first.leftProof.nodes, other: any = { version: 1, type: "branch", bit: 7, left: W("01"), right: W("02") };
          const forged = [[], [other, ...nodes.slice(1)], nodes.slice(0, -1), [...nodes, other], [...nodes.slice(0, -1), other]][tampered++ % 5]!;
          const badProof = { version: 1, nodes: forged };
          const bad = { ...frame, txs: frame.txs.map((tx, i) => (i === 0 ? { ...tx, leftProof: badProof } : tx)) } as AccountFrame;
          const signed = { ...bad, stateHash: unwrap(frameStateHash(bad, replicaId(opened), byLeft)) };
          const offer = { ...offerOf(proposed, proposer), frame: signed, frameHanko: signAccountFrame(signed, proposer) };
          const p = prepared[0].data;
          const record = createAccountJClaimRecord({ ...TERMS.domain, leftEntity: PARTY_LEFT, rightEntity: PARTY_RIGHT }, "left", { jHeight: p.jHeight, jBlockHash: p.jBlockHash, eventsHash: canonicalJurisdictionEventsHash(p.events) });
          let ogThrown = "og accepted";
          try { verifyAccountJClaimProof(leftRootBefore, record, badProof); } catch (e) { ogThrown = (e as Error).message; }
          // og's thrown Error aborts the whole input (og replayIncomingFrameOnClone does not catch it): same text
          expect(stepIn(reps.get(peer)!, offer as AccountInput, peer)).toEqual({ ok: false, error: { _tag: "account_tx_thrown", message: ogThrown } });
        }
        const received = unwrap(stepIn(reps.get(peer)!, offerOf(proposed, proposer), peer)).replica;
        const acked = unwrap(stepIn(received, ackInput(received, peer), peer));
        const ack = acked.outputs.find((o: any) => o.kind === "ack") as AccountInput;
        const done = unwrap(stepIn(proposed, ack, proposer)).replica;
        reps.set(proposer, done); reps.set(peer, acked.replica);
        for (const r of [done, acked.replica]) {
          const v: any = unwrap(committed(r.state)).view;
          expect(v.leftPendingJClaims.root).toBe(og.state.leftPendingJClaims.root);
          expect(v.rightPendingJClaims.root).toBe(og.state.rightPendingJClaims.root);
          expect(Number(v.lastFinalizedJHeight)).toBe(og.state.lastFinalizedJHeight);
          expect(v.jNonce).toBe(og.state.jNonce);
          for (const [tk, d] of og.state.deltas as Map<number, any>) expect(getDelta(r.state.account, String(tk) as any).collateral).toBe(d.collateral);
        }
      }
    }
    expect(tampered).toBeGreaterThan(0);
    expect(branched).toBeGreaterThan(0);
  }, 80_000);
});

// ---------------------------------------------------------------- Entity J observation (og core/entity/tx/j-events*.ts)
const ENTITY = W("e1"), PEER_ACTIVE = W("0f"), PEER_FROZEN = W("f0"), PEER_MISSING = W("f7");
const settledLog = (rows: readonly { left: string; right: string; nonce: bigint; tokens: readonly { tokenId: bigint; leftReserve: bigint; rightReserve: bigint; collateral: bigint; ondelta: bigint }[] }[]) =>
  DEPOSITORY.encodeEventLog("AccountSettled", [rows.map((r) => [r.left, r.right, r.tokens.map((t) => [t.tokenId, t.leftReserve, t.rightReserve, t.collateral, encodeInt512(t.ondelta)]), r.nonce])]);
const ogSettledEvent = (row: any) => {
  const t = row.tokens[0], m = row.meta ?? {};
  return { ...m, ...(t.eventIndex === undefined ? {} : { eventIndex: t.eventIndex }), type: "AccountSettled",
    data: { leftEntity: row.left, rightEntity: row.right, tokenId: Number(t.tokenId), leftReserve: S(t.leftReserve), rightReserve: S(t.rightReserve), collateral: S(t.collateral), ondelta: S(t.ondelta), nonce: Number(row.nonce) } };
};
const randomSettledRows = () => Array.from({ length: 1 + ri(3) }, () => {
  const peer = pick([PEER_ACTIVE, PEER_FROZEN, PEER_MISSING, W("aa")]), mine = rng() < 0.8, [left, right] = mine ? (ENTITY < peer ? [ENTITY, peer] : [peer, ENTITY]) : [W("aa"), W("bb")];
  return { left, right, nonce: BigInt(ri(4)), tokens: Array.from({ length: 1 + ri(2) }, (_, k) => ({ tokenId: BigInt(1 + k + ri(2)), leftReserve: BigInt(ri(1e6)), rightReserve: BigInt(ri(1e6)), collateral: BigInt(ri(1e6)), ondelta: BigInt(ri(2000)) - 1000n })) };
});
/** og FinalizedJEventContext around a plain Entity state whose accounts sit behind a candidate-map shell. */
const ogEntity = () => {
  const accounts = new Map<string, any>([[PEER_ACTIVE, { status: "active", state: {} }], [PEER_FROZEN, { status: "disputed", state: {} }]]);
  const shell = Object.assign(Object.create(EntityAccountCandidateMap.prototype), { get: (id: string) => accounts.get(id), getForWrite: (id: string) => accounts.get(id), has: (id: string) => accounts.has(id) });
  const state: any = { entityId: ENTITY, reserves: new Map<number, bigint>(), accounts: shell };
  const accountTxs: any[] = [];
  const apply = (event: any, blockNumber: number) => {
    const context: any = { entityState: state, newState: state, event, blockNumber, transactionHash: event.transactionHash ?? "", accountTxs, outputs: [], dirtyAccounts: new Set<string>(), env: {}, accountConsensusContext: {} };
    if (event.type === "AccountSettled") applyAccountSettledJEvent(context, []);
    else if (event.type === "ReserveUpdated") applyReserveUpdatedJEvent(context);
    else applyDebtJEvent(context);
  };
  return { state, accountTxs, apply };
};
const rwObserver = (): JObserver => ({ entityId: ENTITY, reserves: new Map(), debts: EMPTY_DEBTS, accounts: new Map([[PEER_ACTIVE, { active: true }], [PEER_FROZEN, { active: false }]]) });
const ledgerRows = (book: ReadonlyMap<number, ReadonlyMap<string, any>> | undefined) => [...(book ?? new Map()).entries()].map(([tk, b]) => [tk, [...b.values()].map((d: any) => ({ ...d }))]);

describe(seedTag("Entity J observation (og j-event-payloads expandAccountSettled, j-events-account-settled.ts, j-events-observations/*, mergeJEventClaimOps)"), () => {
  test("MATCH: 80 random AccountSettled logs expand per Entity like og rawEventToJEvents (rows naming the Entity, one event per token, eventIndex only when several); none naming it refuses in both", () => {
    let expanded = 0, empty = 0;
    for (let i = 0; i < 80; i++) {
      const log = settledLog(randomSettledRows()), og = ogIngress(DEPOSITORY, log, ENTITY);
      let rw: readonly JEvent[] | null;
      try { rw = entityJEvents(readJEvents([{ ...log, ...COORDS }]), ENTITY); } catch { rw = null; }
      expect(rw === null).toBe(og === null);
      if (og === null || rw === null) { empty++; continue; }
      expect(rw.map((e) => (e.type === "AccountSettled" ? ogSettledEvent(e.settled[0]) : e))).toEqual(og);
      expanded += og.length;
    }
    expect(expanded).toBeGreaterThan(80);
    expect(empty).toBeGreaterThan(0);
  });

  test("MATCH: 40 random blocks of AccountSettled / ReserveUpdated: own reserves, claim suppression for missing and non-active Accounts, and the merged claim order equal og's handlers + mergeJEventClaimOps", () => {
    let claims = 0;
    for (let n = 0; n < 40; n++) {
      const og = ogEntity(), blocks: JBlock[] = [];
      for (let b = 0; b < 1 + ri(3); b++) {
        const blockNumber = 10 + b, blockHash = W(pick(["b1", "b2"])), events: JEvent[] = [];
        for (let k = 0; k < 1 + ri(3); k++) {
          const coords = { blockNumber, blockHash, transactionHash: W(pick(["c1", "c2"])), logIndex: ri(5) };
          const log = rng() < 0.7 ? settledLog(randomSettledRows()) : DEPOSITORY.encodeEventLog("ReserveUpdated", [pick([ENTITY, W("aa")]), BigInt(1 + ri(3)), BigInt(ri(1e6))]);
          const ogEvents = (() => { try { const parsed = DEPOSITORY.parseLog(log)!; return rawEventToJEvents({ name: parsed.name, args: extractCanonicalDepositoryEventArgs(parsed), ...coords }, ENTITY); } catch { return null; } })();
          if (ogEvents === null) continue;
          for (const e of ogEvents) og.apply(e, blockNumber);
          events.push(...entityJEvents(readJEvents([{ ...log, ...coords }]), ENTITY));
        }
        blocks.push({ blockNumber, events });
      }
      mergeJEventClaimOps(og.accountTxs);
      const rw = unwrap(observeJBlocks(rwObserver(), blocks) as any) as JObservation;
      expect(new Map(rw.observer.reserves)).toEqual(og.state.reserves);
      expect(rw.claims.map((c) => ({ accountId: c.accountId, tx: { type: "j_event_claim", data: { jHeight: Number(c.tx.jHeight), jBlockHash: c.tx.jBlockHash, events: c.tx.events.map(ogSettledEvent) } } }))).toEqual(og.accountTxs);
      claims += og.accountTxs.length;
    }
    expect(claims).toBeGreaterThan(10);
  });

  test("MATCH: 60 random debt sequences (created / enforced / forgiven, both directions, conflicts, divergence) keep the ledger equal to og applyDebtCreated / applyDebtEnforced / applyDebtForgiven", () => {
    let refused = 0, retired = 0;
    for (let n = 0; n < 60; n++) {
      const og = ogEntity();
      let ledger: DebtLedger = EMPTY_DEBTS;
      for (let s = 0; s < 12; s++) {
        const open = [...(og.state.outDebtsByToken?.values() ?? []), ...(og.state.inDebtsByToken?.values() ?? [])].flatMap((b: Map<string, any>) => [...b.values()]);
        const known = open.length > 0 && rng() < 0.6 ? pick(open) : undefined;
        const [debtor, creditor] = known !== undefined ? [known.debtor, known.creditor] : pick([[ENTITY, PEER_ACTIVE], [PEER_ACTIVE, ENTITY], [W("aa"), W("bb")]]);
        const tokenId = known?.tokenId ?? 1 + ri(2), meta = { blockNumber: ri(3), transactionHash: W(pick(["c1", "C2"])) };
        const kind = known === undefined ? pick(["DebtCreated", "DebtCreated", "DebtEnforced", "DebtForgiven"]) : pick(["DebtEnforced", "DebtForgiven", "DebtCreated"]);
        let rwEvent: any, ogData: any;
        if (kind === "DebtCreated") {
          const amount = pick([0n, 5n, 10n]), debtIndex = ri(3);
          rwEvent = { type: kind, debtor, creditor, tokenId: BigInt(tokenId), amount, debtIndex: BigInt(debtIndex) };
          ogData = { debtor, creditor, tokenId, amount: S(amount), debtIndex };
        } else if (kind === "DebtEnforced") {
          const remaining = known !== undefined && rng() < 0.7 ? pick([0n, known.remainingAmount - 1n]) : pick([0n, 3n]);
          const paid = known !== undefined && rng() < 0.8 ? known.remainingAmount - remaining : pick([0n, 2n]);
          const idx = known !== undefined && rng() < 0.8 ? (remaining === 0n ? known.currentDebtIndex + 1 : known.currentDebtIndex) : ri(3);
          rwEvent = { type: kind, debtor, creditor, tokenId: BigInt(tokenId), amountPaid: paid, remainingAmount: remaining, newDebtIndex: BigInt(idx) };
          ogData = { debtor, creditor, tokenId, amountPaid: S(paid), remainingAmount: S(remaining), newDebtIndex: idx };
        } else {
          const amount = known !== undefined && rng() < 0.8 ? known.remainingAmount : pick([1n, 5n]), idx = known !== undefined && rng() < 0.8 ? known.currentDebtIndex : ri(3);
          rwEvent = { type: kind, debtor, creditor, tokenId: BigInt(tokenId), amountForgiven: amount, debtIndex: BigInt(idx) };
          ogData = { debtor, creditor, tokenId, amountForgiven: S(amount), debtIndex: idx };
        }
        let ogOk = true;
        try { og.apply({ type: kind, data: ogData, ...meta }, meta.blockNumber); } catch { ogOk = false; }
        const r = applyDebtEvent(ledger, ENTITY, { ...rwEvent, meta });
        expect(r.ok).toBe(ogOk);
        if (!r.ok) { refused++; break; }
        if (kind !== "DebtCreated" && (ledgerRows(r.value.out).length + ledgerRows(r.value.in).length) < (ledgerRows(ledger.out).length + ledgerRows(ledger.in).length)) retired++;
        ledger = r.value;
        expect(ledgerRows(ledger.out)).toEqual(ledgerRows(og.state.outDebtsByToken));
        expect(ledgerRows(ledger.in)).toEqual(ledgerRows(og.state.inDebtsByToken));
      }
    }
    expect(refused).toBeGreaterThan(5);
    expect(retired).toBeGreaterThan(0);
  });

  test("PORT (og enrichDisputeBatchNonces is module-private): a dispute event takes the HankoBatchProcessed nonce its sender logged in the same transaction (og enrichDisputeBatchNonces)", () => {
    const tx = W("c1"), other = W("c2"), meta = { blockNumber: 1, blockHash: W("b1"), transactionHash: tx, logIndex: 0 };
    const started = (sender: string, transactionHash: string): JEvent => ({ type: "DisputeStarted", sender, counterentity: PEER_ACTIVE, nonce: 1n, proposerIsLeft: true, proofbodyHash: W("aa"), watchSeed: W("bb"), starterInitialArguments: "0x", starterCounterArguments: "0x",
      starterCounterProofCommitment: W("00"), disputeTimeout: 3n, disputeStartTimestamp: 1n, leftResponseSeconds: 1n, rightResponseSeconds: 1n, meta: { ...meta, transactionHash } });
    const out = withBatchNonces([{ type: "HankoBatchProcessed", entityId: ENTITY, batchHash: W("dd"), nonce: 7n, meta }, started(ENTITY, tx.toUpperCase().replace("0X", "0x")), started(ENTITY, other), started(PEER_ACTIVE, tx)]);
    expect(out.map((e) => (e.type === "DisputeStarted" ? e.batchNonce : "batch"))).toEqual(["batch", 7, undefined, undefined]);
  });
});

// ---------------------------------------------------------------- jBatchState queue, reserve admission, broadcast (og jurisdiction/machine/batch, entity/tx/handlers/j-batch, j-events-batch.ts)
const OTHER = W("aa"), DEP = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/** The J batch a queue op must have produced. */
const queuedBatch = (r: Result<JQueued, unknown>): JBatch => {
  const q = unwrap(r as any) as JQueued;
  if (q._tag !== "queued") throw new Error(`refused: ${q.message}`);
  return q.jBatch as JBatch;
};
const ogDecoded = (b: QueuedBatch): any => decodeJBatch(encodeBatch(contractBatch(b)));
const amt = () => BigInt(ri(100));
const tok = () => 1 + ri(3);
const randomReserves = () => new Map(Array.from({ length: 3 }, (_, k) => [k + 1, BigInt(ri(150))] as const).filter(() => rng() < 0.8));
const randomDebt = () => new Map(Array.from({ length: 3 }, (_, k) => [k + 1, BigInt(ri(60))] as const).filter(([, d]) => d > 0n && rng() < 0.4));
/** A debt book whose open outgoing totals equal `debt` (og getOpenOutgoingDebtTotals reads only status and remainingAmount). */
const debtBook = (debt: ReadonlyMap<number, bigint>) => new Map([...debt].map(([tk, d]) => [tk, new Map([[`d${tk}`, { status: "open", remainingAmount: d } as any]])] as const));
const randomDraft = (): QueuedBatch => {
  const b: any = emptyQueuedBatch();
  for (let k = ri(7); k > 0; k--) {
    const t = tok();
    switch (ri(6)) {
      case 0: b.externalTokenToReserve.push({ entity: pick([ENTITY, OTHER]), contractAddress: "0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB", externalTokenId: 0n, tokenType: 0, internalTokenId: t, amount: amt() }); break;
      case 1: b.reserveToReserve.push({ receivingEntity: pick([ENTITY, PEER_ACTIVE, OTHER]), tokenId: t, amount: amt() }); break;
      case 2: b.collateralToReserve.push({ counterparty: PEER_ACTIVE, tokenId: t, amount: amt(), nonce: 1, sig: "0x" }); break;
      case 3: {
        const [l, r] = pick([[PEER_ACTIVE, ENTITY], [PEER_ACTIVE, OTHER]]);
        b.settlements.push({ leftEntity: l, rightEntity: r, diffs: Array.from({ length: 1 + ri(2) }, () => ({ tokenId: tok(), leftDiff: amt() - 50n, rightDiff: amt() - 50n, collateralDiff: 0n, ondeltaDiff: 0n })), forgiveDebtsInTokenIds: [], sig: "0x", nonce: 1 });
        break;
      }
      case 4: b.reserveToCollateral.push({ tokenId: t, receivingEntity: ENTITY, pairs: Array.from({ length: 1 + ri(2) }, () => ({ entity: pick([PEER_ACTIVE, OTHER]), amount: 1n + amt() })) }); break;
      default: b.reserveToExternalToken.push({ receivingEntity: OTHER, tokenId: t, amount: amt() });
    }
  }
  return b;
};

describe(seedTag("jBatchState (og jurisdiction/machine/batch, entity/tx/handlers/j-batch/*, j-events-batch.ts; entity-runtime ER-16)"), () => {
  test("MATCH: 400 random drafts simulate the initiator's reserves like og simulateDraftBatchReserveAvailability (debt sweeps, implicit flash deficit, batchRevert issues, final maps)", () => {
    let issues = 0, deficits = 0;
    for (let n = 0; n < 400; n++) {
      const reserves = randomReserves(), debt = randomDebt(), b = randomDraft();
      expect(ogDecoded(b)).toEqual(b);
      const rw = simulateBatchReserves(ENTITY, reserves, b, debt), og = simulateDraftBatchReserveAvailability(ENTITY, reserves, ogDecoded(b), debt);
      expect(rw.issues).toEqual(og.issues);
      expect(new Map(rw.reservesByToken)).toEqual(og.reservesByToken);
      expect(new Map(rw.outgoingDebtByToken)).toEqual(og.outgoingDebtByToken);
      expect(new Map(rw.deficitByToken)).toEqual(og.deficitByToken);
      expect(openOutgoingDebtTotals(debtBook(debt) as any)).toEqual(getOpenOutgoingDebtTotals(debtBook(debt)));
      issues += og.issues.length; deficits += og.issues.filter((i) => i.unrepaidDeficit > 0n).length;
    }
    expect(issues).toBeGreaterThan(40);
    expect(deficits).toBeGreaterThan(5);
  }, 30_000);

  test("MATCH: 25 random r2r / r2c / r2e sequences (60 ops, debt-aware admission, R2C aggregation, local-account check, 50-op limit) queue exactly like og handleR2R / handleR2C / handleR2E", async () => {
    let refusedR2C = 0, thrown = 0, queued = 0;
    for (let n = 0; n < 25; n++) {
      const reserves = new Map([[1, BigInt(ri(400))], [2, BigInt(ri(400))], [3, BigInt(ri(400))]]), debt = randomDebt();
      const og: any = { entityId: ENTITY, reserves: new Map(reserves), outDebtsByToken: debtBook(debt), accounts: new Map([[PEER_ACTIVE, {}]]) };
      let rw: JEntity = { entityId: ENTITY, reserves, debts: { out: debtBook(debt) as any, in: new Map() }, jBatch: DORMANT, accounts: new Set([PEER_ACTIVE]) };
      for (let s = 0; s < 60; s++) {
        const tokenId = rng() < 0.05 ? 0 : tok(), amount = BigInt(ri(40));
        const before = og.jBatchState === undefined ? undefined : encodeJBatch(og.jBatchState.batch);
        const said = readEntityFrameEvents(og).length;
        let ogThrew = false;
        const kind = pick(["r2r", "r2c", "r2c", "r2e"] as const), to = pick([PEER_ACTIVE, OTHER]);
        try {
          if (kind === "r2r") await handleR2R(og, { type: "r2r", data: { toEntityId: to, tokenId, amount } }, true);
          else if (kind === "r2e") await handleR2E(og, { type: "r2e", data: { receivingEntity: OTHER, tokenId, amount } }, true);
        } catch { ogThrew = true; }
        if (kind === "r2c") {
          const counterparty = pick([PEER_ACTIVE, PEER_ACTIVE, OTHER, ENTITY]), receivingEntityId = rng() < 0.2 ? OTHER : undefined;
          try { await handleR2C({} as any, og, { type: "r2c", data: { counterpartyId: counterparty, receivingEntityId, tokenId, amount } } as any, true); } catch { ogThrew = true; }
          const r = queueR2C(rw, counterparty, tokenId, amount, receivingEntityId);
          expect(r.ok).toBe(!ogThrew);
          if (r.ok) {
            const ogChanged = og.jBatchState !== undefined && encodeJBatch(og.jBatchState.batch) !== before;
            expect(r.value._tag === "queued").toBe(ogChanged);
            expect([r.value.message]).toEqual(readEntityFrameEvents(og).slice(said).map((e: any) => e.message));
            if (r.value._tag === "queued") rw = { ...rw, jBatch: r.value.jBatch }; else refusedR2C++;
          }
        } else {
          const r = kind === "r2r" ? queueR2R(rw, to, tokenId, amount) : queueR2E(rw, OTHER, tokenId, amount);
          expect(r.ok).toBe(!ogThrew);
          if (r.ok && r.value._tag === "queued") {
            expect([r.value.message]).toEqual(readEntityFrameEvents(og).slice(said).map((e: any) => e.message));
            rw = { ...rw, jBatch: r.value.jBatch };
          } else thrown++;
        }
        const rwOg = ogJBatchOf(rw.jBatch);
        if (og.jBatchState !== undefined && rwOg !== undefined) {
          expect(rwOg.batch).toEqual(og.jBatchState.batch);
          expect(rwOg.status).toBe(og.jBatchState.status);
        }
        queued++;
      }
    }
    expect(refusedR2C).toBeGreaterThan(20);
    expect(thrown).toBeGreaterThan(20);
    expect(queued).toBe(25 * 60);
  }, 120_000);

  test("MATCH: 200 random drafts split for broadcast like og takeBroadcastBatch (dispute priority, one finalization, registrations with starts)", () => {
    const fields = ["reserveToReserve", "reserveToCollateral", "collateralToReserve", "settlements", "disputeStarts", "counterDisputes", "disputeFinalizations", "externalTokenToReserve", "reserveToExternalToken", "revealSecrets", "hashLadderRegistrations"] as const;
    let priority = 0;
    for (let n = 0; n < 200; n++) {
      const b: any = createEmptyBatch();
      for (const f of fields) for (let k = rng() < 0.5 ? 0 : ri(3); k > 0; k--) b[f].push({ f, k });
      const og = ogTakeBroadcastBatch(structuredClone(b)), rw = takeBroadcastBatch(b);
      expect(rw).toEqual(og as any);
      if (og.disputePriority) priority++;
    }
    expect(priority).toBeGreaterThan(100);
  });

  test("MATCH: 60 random broadcast / HankoBatchProcessed lifecycles: the sealed batch hash equals og computeBatchHankoHash(encodeJBatch) at entityNonce+1, and the event (exact, other hash, lower / higher nonce, other Entity) updates the state like og applyHankoBatchProcessedEvent", async () => {
    const outcomes = new Set<string>();
    for (let n = 0; n < 60; n++) {
      const e: JEntity = { entityId: ENTITY, reserves: new Map([[1, 1000n], [2, 1000n]]), debts: EMPTY_DEBTS, jBatch: DORMANT, accounts: new Set([PEER_ACTIVE]) };
      let s: JBatch = { ...initJBatch(), chainNonce: ri(4) };
      for (let k = 1 + ri(3); k > 0; k--) s = queuedBatch(queueR2R({ ...e, jBatch: s }, OTHER, 1 + ri(2), BigInt(1 + ri(9))));
      if (rng() < 0.4) {
        const drafted = s;
        s = { ...initJBatch(), chainNonce: drafted.chainNonce, recovery: [drafted.draft] };
        if (rng() < 0.6) s = queuedBatch(queueR2R({ ...e, jBatch: s }, PEER_ACTIVE, 2, 5n));
      }
      const sealed = unwrap(jBroadcast(s, { entityId: ENTITY, chainId: 31337, depository: DEP, signerId: "s1", timestamp: 5 }) as any) as any;
      const sent = sentOf(sealed.jBatch)!;
      expect(sent.entityNonce).toBe(s.chainNonce + 1);
      expect(sent.batchHash).toBe(computeBatchHankoHash(31337n, DEP, encodeJBatch(ogDecoded(sent.batch)), BigInt(sent.entityNonce)));
      expect(sealed.jTx.data.encodedBatch).toBe(encodeJBatch(ogDecoded(sent.batch)));
      const kind = pick(["exact", "exact", "hash", "lower", "higher", "entity"] as const);
      const nonce = kind === "lower" ? Math.max(1, sent.entityNonce - 1) : kind === "higher" ? sent.entityNonce + 1 : sent.entityNonce;
      const event = { type: "HankoBatchProcessed" as const, entityId: kind === "entity" ? OTHER : ENTITY.toUpperCase().replace("0X", "0x"), batchHash: kind === "exact" ? sent.batchHash.toUpperCase().replace("0X", "0x") : W("dd"), nonce: BigInt(nonce) };
      const toOg = (live: JBatch): any => {
        const j = ogJBatchState(live);
        return { ...j, batch: ogDecoded(j.batch), ...(j.sentBatch === undefined ? {} : { sentBatch: { ...j.sentBatch, batch: ogDecoded(j.sentBatch.batch) } }), ...(j.recoveryBatches === undefined ? {} : { recoveryBatches: j.recoveryBatches.map(ogDecoded) }) };
      };
      const og: any = { entityId: ENTITY, timestamp: 77, config: { validators: ["s1"] }, jBatchState: toOg(sealed.jBatch) }, outputs: any[] = [];
      await applyHankoBatchProcessedEvent({ newState: og, event: { type: "HankoBatchProcessed", data: { entityId: event.entityId, batchHash: event.batchHash, nonce } }, blockNumber: 1, outputs });
      const rw = unwrap(applyHankoBatchProcessed(sealed.jBatch, ENTITY, event, 77) as any) as any;
      const after = ogJBatchState(rw.jBatch);
      expect(after.status).toBe(og.jBatchState.status);
      expect(after.entityNonce).toBe(og.jBatchState.entityNonce);
      expect(after.sentBatch?.terminalFailure).toEqual(og.jBatchState.sentBatch?.terminalFailure);
      expect(after.sentBatch === undefined).toBe(og.jBatchState.sentBatch === undefined);
      expect(after.batch).toEqual(og.jBatchState.batch);
      expect(rw.autoBroadcast).toBe(outputs.length > 0);
      outcomes.add(`${after.status}:${rw.autoBroadcast}`);
    }
    expect(outcomes.size).toBeGreaterThan(3);
  }, 60_000);

  test("PORT (og handleJBroadcast needs a runtime jurisdiction registry): j_broadcast refuses while a batch is in flight, skips an empty draft, seals recovery work first and latches autoBroadcastDraft while work remains", () => {
    const ctx = { entityId: ENTITY, chainId: 31337, depository: DEP, signerId: "s1", timestamp: 9 };
    expect(unwrap(jBroadcast(initJBatch(), ctx))).toEqual({ jBatch: initJBatch(), note: "j_broadcast skipped: jBatch is empty" });
    const e: JEntity = { entityId: ENTITY, reserves: new Map([[1, 100n]]), debts: EMPTY_DEBTS, jBatch: DORMANT, accounts: new Set() };
    const draft = queuedBatch(queueR2R(e, OTHER, 1, 3n)), recovered = queuedBatch(queueR2R(e, PEER_ACTIVE, 1, 4n));
    const first = unwrap(jBroadcast({ ...draft, recovery: [recovered.draft] }, ctx) as any) as any;
    expect(sentOf(first.jBatch)?.batch).toEqual(recovered.draft);
    expect(first.jBatch.draft).toEqual(draft.draft);
    expect(first.jBatch.recovery).toEqual([]);
    expect(first.jBatch.autoBroadcast).toBe(true);
    expect(first.hashToSign).toEqual({ hash: sentOf(first.jBatch)?.batchHash, type: "jBatch", context: `jBatch:${ENTITY.slice(-4)}:nonce:1` });
    expect(jBroadcast(first.jBatch, ctx).ok).toBe(false);
  });

  test("MATCH (ER-16): the Host's r2r only queues into jBatchState; reserves move only on the finalized ReserveUpdated J event", () => {
    const host = unwrap(genesisHost(ALICE, genesisAB()));
    const ctx = { timestamp: 1n, jHeight: 0n };
    const funded = unwrap(applyHost(host, { layer: "j", tx: { type: "j_event", blockNumber: 1, event: { type: "ReserveUpdated", entity: ALICE, tokenId: 1n, newBalance: 50n } } }, ctx, hankoVerify));
    expect(funded.state.j.reserves).toEqual(new Map([[1, 50n]]));
    expect(applyHost(funded.state, { layer: "j", tx: { type: "r2r", toEntity: BOB, tokenId: "1", amount: 60n } } as any, ctx, hankoVerify).ok).toBe(false);
    const queued = unwrap(applyHost(funded.state, { layer: "j", tx: { type: "r2r", toEntity: BOB, tokenId: "1", amount: 20n } } as any, ctx, hankoVerify) as any) as any;
    expect(queued.state.j.reserves).toEqual(new Map([[1, 50n]]));
    expect(queued.state.j.jBatch.draft.reserveToReserve).toEqual([{ receivingEntity: BOB, tokenId: 1, amount: 20n }]);
  });
});
