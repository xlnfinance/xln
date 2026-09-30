import { describe, expect, test } from "bun:test";
import { seedOf, seedTag } from "../seed.ts";
import { decodeJBatch, encodeJBatch } from "../../../core/jurisdiction/machine/batch/index.ts";
import { handleJRebroadcast } from "../../../core/entity/tx/handlers/j-batch/j-rebroadcast.ts";
import { handleJAbortSentBatch } from "../../../core/entity/tx/handlers/j-batch/j-abort-sent-batch.ts";
import { handleJClearBatch } from "../../../core/entity/tx/handlers/j-batch/j-clear-batch.ts";
import { handleMintReserves } from "../../../core/entity/tx/handlers/j-batch/mint-reserves.ts";
import { applyHankoBatchProcessedEvent } from "../../../core/entity/tx/j-events-batch.ts";
import { readEntityFrameEvents } from "../../../core/entity/frame-events.ts";
import { EntityAccountCandidateMap } from "../../../core/entity/state/persistent-account-map.ts";
import { PersistentAccountStateMap } from "../../../core/account/state/persistent-state-map.ts";
import {
  encodeBatch, contractBatch, emptyQueuedBatch, initJBatch, queueR2R, jBroadcast, jRebroadcast, jAbortSentBatch, jClearBatch, mintReservesTx, genesisHost, applyHost, setRebalanceSubmittedAt, EMPTY_DEBTS, DORMANT, ogJBatchOf, ogJBatchState, sentOf,
  type Batch, type JBatch, type JSubmission, type JEntity, type JQueued, type QueuedBatch, type Result,
} from "../../xln.ts";
import { ALICE, BOB, genesisAB, hankoVerify, unwrap } from "../../xln_run.ts";
import { jbOfOg, ogOf } from "../og/og-state.ts";

const prng = (base: number) => { let seed = seedOf(base); return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const rng = prng(0x5e77_1e);
const ri = (n: number) => Math.floor(rng() * n);
const pick = <X,>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
const W = (b: string) => `0x${b.repeat(32 / (b.length / 2))}`;
const ENTITY = W("e1"), PEER = W("0f"), OTHER = W("aa"), DEP = "0x5FbDB2315678afecb367f032d93F642f64180aa3", EP = `0x${"c1".repeat(20)}`, SIGNER = `0x${"5a".repeat(20)}`;
const ogDecoded = (b: QueuedBatch): any => decodeJBatch(encodeBatch(contractBatch(b)));
/** The J batch a queue op must have produced. */
const queuedBatch = (r: Result<JQueued, unknown>): JBatch => {
  const q = unwrap(r as any) as JQueued;
  if (q._tag !== "queued") throw new Error(`refused: ${q.message}`);
  return q.jBatch as JBatch;
};
const toOg = (live: JBatch): any => {
  const j = ogJBatchState(live);
  return { ...j, batch: ogDecoded(j.batch), ...(j.sentBatch === undefined ? {} : { sentBatch: { ...j.sentBatch, batch: ogDecoded(j.sentBatch.batch) } }), ...(j.recoveryBatches === undefined ? {} : { recoveryBatches: j.recoveryBatches.map(ogDecoded) }) };
};
const env: any = { state: { jReplicas: new Map([["j", { name: "j", chainId: 31337, contracts: { depository: DEP, entityProvider: EP }, rpcs: [] }]]) } };
const jurisdiction = { name: "j", chainId: 31337, depositoryAddress: DEP, entityProviderAddress: EP, address: "jreplica://j" };
/** og Entity state around a jBatchState, with accounts behind a candidate-map shell (og getEntityAccountForWrite). */
const ogEntity = (j: JSubmission, accounts: ReadonlyMap<string, any> = new Map()): any => {
  const shell = Object.assign(Object.create(EntityAccountCandidateMap.prototype), { get: (id: string) => accounts.get(id), getForWrite: (id: string) => accounts.get(id), has: (id: string) => accounts.has(id), keys: () => accounts.keys() });
  return { entityId: ENTITY, timestamp: 900, config: { validators: [SIGNER], threshold: 1n, shares: { [SIGNER]: 1n }, mode: "proposer-based", jurisdiction }, accounts: shell, ...(j._tag === "dormant" ? {} : { jBatchState: toOg(j) }) };
};
const messages = (state: any): string[] => readEntityFrameEvents(state).map((e: any) => e.message);
const sameJBatch = (s: JSubmission, og: any): void => {
  const rw = ogJBatchOf(s);
  expect(rw === undefined).toBe(og === undefined);
  if (rw === undefined) return;
  expect(rw.batch).toEqual(og.batch);
  expect(rw.status).toBe(og.status);
  expect(rw.broadcastCount).toBe(og.broadcastCount);
  expect(rw.lastBroadcast).toBe(og.lastBroadcast);
  expect(rw.entityNonce).toBe(og.entityNonce);
  expect(rw.autoBroadcastDraft).toBe(og.autoBroadcastDraft);
  expect(rw.recoveryBatches ?? []).toEqual(og.recoveryBatches ?? []);
  expect(rw.sentBatch === undefined).toBe(og.sentBatch === undefined);
  if (rw.sentBatch === undefined) return;
  const { batch: rb, ...rs } = rw.sentBatch, { batch: ob, ...os } = og.sentBatch;
  expect(rb).toEqual(ob);
  expect(rs).toEqual(os);
};

/** A random jBatchState in every lifecycle shape: draft only, sealed, sealed with recovery, quarantined, an empty stale sentBatch. */
const randomJBatch = (): JBatch => {
  const e: JEntity = { entityId: ENTITY, reserves: new Map([[1, 10_000n], [2, 10_000n]]), debts: EMPTY_DEBTS, jBatch: DORMANT, accounts: new Set([PEER]) };
  let s: JBatch = { ...initJBatch(), chainNonce: ri(4), broadcasts: { count: ri(3), last: 0 } };
  for (let k = ri(4); k > 0; k--) s = queuedBatch(queueR2R({ ...e, jBatch: s }, pick([OTHER, PEER]), 1 + ri(2), BigInt(1 + ri(9))));
  if (rng() < 0.2) return s;
  if (s.draft.reserveToReserve.length === 0) s = queuedBatch(queueR2R({ ...e, jBatch: s }, OTHER, 1, 3n));
  const withOps: QueuedBatch = {
    ...s.draft,
    collateralToReserve: Array.from({ length: ri(3) }, () => ({ counterparty: pick([PEER, OTHER]), tokenId: 1, amount: BigInt(1 + ri(5)), nonce: 1 + ri(4), sig: "0x12" })),
    disputeFinalizations: [],
    reserveToCollateral: rng() < 0.5 ? [] : [{ tokenId: 1 + ri(2), receivingEntity: ENTITY, pairs: [{ entity: pick([PEER, OTHER]), amount: 5n }] }],
  };
  const sealed = unwrap(jBroadcast({ ...s, draft: withOps }, { entityId: ENTITY, chainId: 31337, depository: DEP, signerId: SIGNER, timestamp: 5 }));
  let out = sealed.jBatch as JBatch;
  const sent = sentOf(out)!;
  if (rng() < 0.3) out = { ...out, draft: queuedBatch(queueR2R({ ...e, jBatch: { ...out, phase: { _tag: "idle", accumulating: false } } }, OTHER, 2, 4n)).draft };
  if (rng() < 0.25) out = { ...out, recovery: [queuedBatch(queueR2R(e, PEER, 1, 2n)).draft] };
  if (rng() < 0.15) out = { ...out, phase: { _tag: "quarantined", sent, failure: { message: "J_BATCH_NONCE_CONSUMED_BY_DIFFERENT_HASH:x", failedAt: 3 } } };
  else if (rng() < 0.15) out = { ...out, phase: { _tag: "inFlight", sent: { ...sent, batch: emptyQueuedBatch() } } };
  return out;
};

describe(seedTag("settle-jsubmit: the J submit lifecycle (og entity/tx/handlers/j-batch/{j-rebroadcast,j-abort-sent-batch,j-clear-batch,mint-reserves}.ts)"), () => {
  test("MATCH: 150 random j_rebroadcast calls -- same refusal, same resealed sentBatch, generation, jTx (with gas bump) and jBatch hash to sign as og handleJRebroadcast", async () => {
    const outcomes = new Set<string>();
    for (let n = 0; n < 150; n++) {
      const s: JSubmission = rng() < 0.1 ? DORMANT : randomJBatch(), bump = pick([undefined, 0, 1250, -5, 30_000, 12.7, Number.NaN]);
      const og = ogEntity(s);
      let ogOut: any, ogErr: string | undefined;
      try { ogOut = await handleJRebroadcast(og, { type: "j_rebroadcast", data: { ...(bump === undefined ? {} : { gasBumpBps: bump }) } } as any, env, true); } catch (e) { ogErr = (e as Error).message; }
      const rw = jRebroadcast(s, { entityId: ENTITY, chainId: 31337, depository: DEP, signerId: SIGNER, timestamp: 900, gasBumpBps: bump });
      expect(rw.ok).toBe(ogErr === undefined);
      if (!rw.ok) { expect((rw.error as any).reason).toBe(ogErr); outcomes.add("refused"); continue; }
      const msgs = messages(og);
      expect(rw.value.note).toBe(msgs[msgs.length - 1]);
      sameJBatch(rw.value.jBatch, og.jBatchState);
      const ogTx = ogOut.jOutputs[0]?.jTxs[0];
      expect(rw.value.jTx === undefined).toBe(ogTx === undefined);
      if (ogTx !== undefined) {
        const { batch: rb, ...rd } = rw.value.jTx!.data, { batch: ob, ...od } = ogTx.data;
        expect(rb).toEqual(ob);
        expect(rd).toEqual(od);
        expect(rw.value.jTx!.timestamp).toBe(ogTx.timestamp);
        expect(ogOut.jOutputs[0].jurisdictionName).toBe("j");
        expect([rw.value.hashToSign]).toEqual(ogOut.hashesToSign);
      }
      outcomes.add(ogTx === undefined ? "note" : "resent");
    }
    expect(outcomes).toEqual(new Set(["refused", "note", "resent"]));
  }, 60_000);

  const accountsFor = (jNonce: number, submitted: readonly number[]): Map<string, any> =>
    new Map([[PEER, { status: "active", state: { jNonce }, shadow: { rebalance: { submittedAtByToken: PersistentAccountStateMap.fromEntries("rebalanceShadowSubmitted", submitted.map((t) => [t, 77] as const)) } } }]]);
  const submittedOf = (accounts: Map<string, any>): number[] => [...accounts.get(PEER).shadow.rebalance.submittedAtByToken.keys()].sort((a: number, b: number) => a - b);

  test("MATCH: 150 random j_abort_sent_batch calls (requeue / drop, stale C2R by Account jNonce, R2C submitted markers) change the jBatchState and the Account latches like og handleJAbortSentBatch", async () => {
    const outcomes = new Set<string>();
    for (let n = 0; n < 150; n++) {
      const s: JSubmission = rng() < 0.1 ? DORMANT : randomJBatch(), jNonce = ri(5), submitted = [1, 2].filter(() => rng() < 0.6);
      const requeue = pick([undefined, true, false]), reason = pick([undefined, "", "stuck"]);
      const accounts = accountsFor(jNonce, submitted), og = ogEntity(s, accounts);
      await handleJAbortSentBatch(og, { type: "j_abort_sent_batch", data: { ...(requeue === undefined ? {} : { requeueToCurrent: requeue }), ...(reason === undefined ? {} : { reason }) } } as any, env, true);
      const rw = jAbortSentBatch(s, { requeueToCurrent: requeue, reason }, (c) => (c === PEER ? jNonce : 0));
      expect<string | undefined>(rw.note).toBe(messages(og).at(-1));
      sameJBatch(rw.jBatch, og.jBatchState);
      const body = rw.release.submitted.filter((r) => r.accountId === PEER).reduce((b, r) => setRebalanceSubmittedAt(b, r.tokenId, undefined), { submittedAt: new Map(submitted.map((t) => [t, 77])) } as any);
      expect([...body.submittedAt.keys()].sort()).toEqual(submittedOf(accounts));
      outcomes.add(sentOf(s) === undefined ? "none" : requeue === false ? "dropped" : "requeued");
    }
    expect(outcomes).toEqual(new Set(["none", "dropped", "requeued"]));
  }, 60_000);

  test("MATCH: 100 random j_clear_batch calls empty the draft, sentBatch and recovery batches and reset every submitted marker like og handleJClearBatch", async () => {
    for (let n = 0; n < 100; n++) {
      const s: JSubmission = rng() < 0.1 ? DORMANT : randomJBatch(), submitted = [1, 2, 3].filter(() => rng() < 0.5), reason = pick([undefined, "manual"]);
      const accounts = accountsFor(0, submitted), og = ogEntity(s, accounts);
      await handleJClearBatch(og, { type: "j_clear_batch", data: { ...(reason === undefined ? {} : { reason }) } } as any, env, true);
      const rw = jClearBatch(s, { reason }, new Map([[PEER, submitted]]));
      expect<string | undefined>(rw.note).toBe(messages(og).at(-1));
      sameJBatch(rw.jBatch, og.jBatchState);
      if (s._tag === "live") expect(submittedOf(accounts)).toEqual([]);
      expect(rw.release.submitted.map((r) => r.tokenId)).toEqual(s._tag === "dormant" ? [] : [...submitted].sort((a, b) => a - b));
    }
  });

  test("MATCH: mintReserves emits og's direct `mint` JTx (outside the batch) with the Entity timestamp", async () => {
    for (const [tokenId, amount] of [[1, 5n], [3, 0n], [2, 10n ** 30n]] as const) {
      const og = ogEntity(DORMANT), out = await handleMintReserves(og, { type: "mintReserves", data: { tokenId, amount } } as any, env, true);
      const rw = mintReservesTx(ENTITY, tokenId, amount, 900);
      expect(rw.jTx).toEqual(out.jOutputs[0]!.jTxs[0] as any);
      expect<string | undefined>(rw.note).toBe(messages(og).at(-1));
    }
  });

  test("MATCH: the Host surfaces og's J outputs as effects -- j_broadcast / j_rebroadcast / mintReserves a j_submit (jTx + jBatch hash), a finalized batch with parked work a j_broadcast_request (og finalizePendingBatch self input)", async () => {
    const host0 = unwrap(genesisHost(ALICE, genesisAB()) as any) as any, ctx = { timestamp: 9n, jHeight: 0n };
    const funded = unwrap(applyHost(host0, { layer: "j", tx: { type: "j_event", blockNumber: 1, event: { type: "ReserveUpdated", entity: ALICE, tokenId: 1n, newBalance: 50n } } } as any, ctx, hankoVerify) as any) as any;
    const q1 = unwrap(applyHost(funded.state, { layer: "j", tx: { type: "r2r", toEntity: BOB, tokenId: "1", amount: 20n } } as any, ctx, hankoVerify) as any) as any;
    const sealed = unwrap(applyHost(q1.state, { layer: "j", tx: { type: "j_broadcast", chainId: 31337, depository: DEP, signerId: SIGNER } } as any, ctx, hankoVerify) as any) as any;
    const sent = sentOf(sealed.state.j.jBatch)!;
    expect(sealed.effects).toEqual([{ _tag: "j_submit", jTx: expect.objectContaining({ type: "batch", entityId: ALICE }), hashToSign: { hash: sent.batchHash, type: "jBatch", context: `jBatch:${ALICE.slice(-4)}:nonce:1` } }]);
    const parked = unwrap(applyHost(sealed.state, { layer: "j", tx: { type: "r2r", toEntity: BOB, tokenId: "1", amount: 5n } } as any, ctx, hankoVerify) as any) as any;
    const resent = unwrap(applyHost(parked.state, { layer: "j", tx: { type: "j_rebroadcast", chainId: 31337, depository: DEP, signerId: SIGNER, gasBumpBps: 500 } } as any, ctx, hankoVerify) as any) as any;
    expect(resent.effects[0].jTx.data.feeOverrides).toEqual({ gasBumpBps: 500 });
    expect(resent.effects[0].hashToSign.context).toBe(`jBatch:${ALICE.slice(-4)}:nonce:1:rebroadcast`);
    const auto = { ...resent.state.j.jBatch, autoBroadcast: true };
    const event = { type: "HankoBatchProcessed", entityId: ALICE, batchHash: sent.batchHash, nonce: 1n };
    const done = unwrap(applyHost({ ...resent.state, j: { ...resent.state.j, jBatch: auto } }, { layer: "j", tx: { type: "j_event", blockNumber: 2, event } } as any, ctx, hankoVerify) as any) as any;
    const og: any = { entityId: ALICE, timestamp: 9, config: { validators: [SIGNER] }, jBatchState: toOg(auto) }, outputs: any[] = [];
    await applyHankoBatchProcessedEvent({ newState: og, event: { type: "HankoBatchProcessed", data: { entityId: ALICE, batchHash: sent.batchHash, nonce: 1 } } as any, blockNumber: 2, outputs });
    expect(outputs).toEqual([{ entityId: ALICE, signerId: SIGNER, entityTxs: [{ type: "j_broadcast", data: {} }] }]);
    expect(done.effects).toEqual([{ _tag: "j_broadcast_request", entityId: ALICE }]);
    const mint = unwrap(applyHost(done.state, { layer: "j", tx: { type: "mintReserves", tokenId: 1, amount: 7n } } as any, ctx, hankoVerify) as any) as any;
    expect(mint.effects).toEqual([{ _tag: "j_submit", jTx: { type: "mint", entityId: ALICE, data: { entityId: ALICE, tokenId: 1, amount: 7n }, timestamp: 9 } }]);
  });
});

// ---- og entity/tx/handlers/payments/settle.ts: the settle_* Entity txs on top of the Account settle_transition workspace ----
import { compileOps as ogCompileOps } from "../../../core/protocol/settlement/operations.ts";
import { projectSettlementDeltaOverrides } from "../../../core/account/settlement/settlement-projection.ts";
import { createDefaultDelta } from "../../../core/account/state/delta.ts";
import { handleSettleApprove, handleSettleExecute, handleSettlePropose, handleSettleReject, handleSettleUpdate, canAutoApproveWorkspace as ogCanAutoApprove } from "../../../core/entity/tx/handlers/payments/settle.ts";
import { entityCollectionCommitment as ogCollectionCommitment } from "../../../core/entity/state/persistent-collection-map.ts";
import { batchAddSettlement, initJBatch as ogInitJBatch } from "../../../core/jurisdiction/machine/batch/index.ts";
import {
  applyEntityInput, createEntity, foldTxs, planAccountProposal, isLeft, mapSet, ownWire, wireOf, workspaceHashOf, zeroDelta, tokenId, canAutoApproveWorkspace, entityCollectionCommitment, addSettlementRow,
  type AccountReplica, type EntityId, type EntityTx, type OpenEntity, type SettlementOp, type SettlementWorkspace, type WireAccountTx,
} from "../../xln.ts";
import { CAROL, NOW, TERMS, UNREGISTERED_J, aliceAddr, signedTxs, verifiers } from "../../xln_run.ts";

const T1 = unwrap(tokenId("1"));
/** ALICE (1-of-1) with a committed Account to BOB whose token 1 row holds collateral. */
const settleBase = (): OpenEntity => {
  const created = unwrap(createEntity({ id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), jurisdictionConfig: UNREGISTERED_J }));
  const open = unwrap(applyEntityInput(created, { kind: "txs", timestamp: NOW, txs: [{ type: "openAccount", data: { targetEntityId: BOB, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig } } } as EntityTx] }, { ...verifiers, self: ALICE, signerId: aliceAddr })).replica;
  if (open._tag !== "open") throw new Error(open._tag);
  const child = open.accountReplicas.get(BOB)!;
  const aliceLeft = isLeft(ALICE, child.state.account.id);
  const account = { ...child.state.account, deltas: new Map([[T1, { ...zeroDelta(T1), collateral: 1_000n, ondelta: aliceLeft ? 600n : 400n }]]) };
  // an idle Account (og: no pendingFrame): drop the opening proposal so the workspace sits on the base the next frame builds on
  const funded = { _tag: "open", head: child.head, dispute: child.dispute, mempool: [], state: { ...child.state, account } } as AccountReplica;
  return { ...open, accountReplicas: mapSet(open.accountReplicas, BOB, funded), state: { ...open.state, accounts: mapSet(open.state.accounts, BOB, account) } };
};
const SETTLE_BASE = settleBase();
const ACCOUNT_ID = SETTLE_BASE.accountReplicas.get(BOB)!.state.account.id;
const randomOps = (): SettlementOp[] => Array.from({ length: ri(4) }, (): SettlementOp => {
  const tk = pick([1, 1, 2, 70_000]), amount = pick([0n, 1n, 5n, 50n]);
  switch (ri(6)) {
    case 0: return { type: "forgive", tokenId: tk };
    case 1: return { type: "rawDiff", tokenId: tk, leftDiff: pick([-5n, 0n, 5n]), rightDiff: pick([-5n, 0n, 5n]), collateralDiff: pick([0n, 5n, -5n]), ondeltaDiff: pick([0n, 5n]) };
    default: return { type: pick(["r2c", "c2r", "r2r"] as const), tokenId: tk, amount };
  }
});
type WsKind = "none" | "unsigned" | "signed" | "submitted" | "corrupt";
const workspaceOf = (kind: WsKind, ops: readonly SettlementOp[], byLeft: boolean, executorIsLeft: boolean, memo: string | undefined): SettlementWorkspace | undefined => {
  if (kind === "none") return undefined;
  const body = { ops, lastModifiedByLeft: byLeft, status: kind === "submitted" ? "submitted" as const : "awaiting_counterparty" as const, revision: 1 + ri(3), createdAt: 1, lastUpdatedAt: 2, executorIsLeft, ...(memo === undefined ? {} : { memo }) };
  const workspaceHash = kind === "corrupt" ? W("ab") : unwrap(workspaceHashOf(ACCOUNT_ID, body) as any) as string;
  return { ...body, workspaceHash, ...(kind === "signed" ? { leftHanko: "0x11", settlementHash: W("cd") } : {}) };
};
const ogAccountOf = (w: SettlementWorkspace | undefined, pending: boolean): any => ({
  state: { leftEntity: ACCOUNT_ID.left, rightEntity: ACCOUNT_ID.right, ...(w === undefined ? {} : { settlementWorkspace: structuredClone(w) }) },
  mempool: pending ? [{ type: "settle_transition", data: { kind: "clear", revision: 1, workspaceHash: W("01") } }] : [],
});
const codeOf = (m: string): string => m.split(":")[0]!;

describe(seedTag("settle-jsubmit: settle_propose / update / approve / reject (og payments/settle.ts)"), () => {
  test("MATCH: 400 random settle_* txs against random workspaces -- same fatal refusal, same queued Account settle_transition, same status events and deferred approval as og", async () => {
    const counts = { refused: 0, queued: 0, skipped: 0, admission: 0, deferred: 0, materialize: 0, halted: 0 };
    for (let n = 0; n < 400; n++) {
      const kind = pick<WsKind>(["none", "unsigned", "unsigned", "signed", "submitted", "corrupt"]), wsOps = kind === "none" ? [] : [{ type: "r2c" as const, tokenId: 1, amount: BigInt(1 + ri(9)) }];
      const w = workspaceOf(kind, wsOps, rng() < 0.5, rng() < 0.5, pick([undefined, "memo"])), pending = rng() < 0.15;
      const peer = rng() < 0.08 ? CAROL : BOB, ops = randomOps(), memo = pick([undefined, "m2"]), exec = pick([undefined, true, false]);
      const txKind = pick(["settle_propose", "settle_update", "settle_approve", "settle_reject"] as const);
      const hash = w === undefined ? W("02") : pick([w.workspaceHash, w.workspaceHash, W("03"), w.workspaceHash.toUpperCase().replace("0X", "0x")]);
      const data: any = txKind === "settle_approve" ? { counterpartyEntityId: peer, workspaceHash: hash }
        : txKind === "settle_reject" ? { counterpartyEntityId: peer, ...(rng() < 0.5 ? { reason: "no" } : {}) }
        : { counterpartyEntityId: peer, ops, ...(memo === undefined ? {} : { memo }), ...(exec === undefined ? {} : { executorIsLeft: exec }) };
      const tx = { type: txKind, data } as EntityTx;
      const child = SETTLE_BASE.accountReplicas.get(BOB)!;
      const pendingTx: WireAccountTx[] = pending ? [{ type: "settle_transition", kind: "clear", revision: 1, workspaceHash: W("01") } as any] : [];
      const replicas = mapSet(SETTLE_BASE.accountReplicas, BOB, { ...child, mempool: pendingTx, state: { ...child.state, settlement: w } } as AccountReplica);
      const og: any = { entityId: ALICE, accounts: new Map([[BOB, ogAccountOf(w, pending)]]) };
      const handler = { settle_propose: handleSettlePropose, settle_update: handleSettleUpdate, settle_approve: handleSettleApprove, settle_reject: handleSettleReject }[txKind] as any;
      let ogOut: any, ogErr: string | undefined;
      try { ogOut = await handler(og, { type: txKind, data: structuredClone(data) }, {}, true); } catch (e) { ogErr = (e as Error).message; }
      const rw = foldTxs(SETTLE_BASE.state, replicas, signedTxs(SETTLE_BASE.state, aliceAddr, [tx]), { verify: hankoVerify, timestamp: NOW + 1n });
      if (ogErr !== undefined) {
        expect(rw.ok).toBe(false);
        if (!rw.ok) expect(codeOf((rw.error as any).reason ?? rw.error._tag)).toBe(codeOf(ogErr));
        counts.refused++;
        continue;
      }
      const ogDeferred = og.deferredAccountProposals === undefined ? [] : [...og.deferredAccountProposals.entries()];
      if (!rw.ok && rw.error._tag === "proposal_halt") {
        // og queues the settle_transition (or its deferred approval, or already holds one) and the same frame's proposal throws
        // throwCriticalProposalFailure's SETTLEMENT_TRANSITION_PROPOSAL_FAILED; the fixture's Hankos are not real, so a hanko also fails there
        expect(rw.error.message).toStartWith(`SETTLEMENT_TRANSITION_PROPOSAL_FAILED:`);
        expect(ogOut.accountTxs.length + ogDeferred.length + og.accounts.get(BOB).mempool.length).toBeGreaterThan(0);
        counts.halted++;
        continue;
      }
      if (!rw.ok && rw.error._tag !== "entity_invariant") {
        // og admits the Account tx into the mempool and refuses it at the Account frame; the rewrite's admitAt trial-folds it and evicts the
        // only tx of the input (admission timing, ER-15)
        expect(ogOut.accountTxs.length).toBe(1);
        counts.admission++;
        continue;
      }
      if (!rw.ok) {
        // The handler passed, but og's frame then runs drainPostOrderbookAccountWork, which the rewrite's foldTxs runs too:
        // refreshStaleUncommittedSettlementHankos asserts every queued Account's workspace canonical (the corrupt fixture throws), and
        // materializeDeferredSettlementApprovals -> buildSettlementHankoDraft throws `SETTLEMENT_SIGNED_HASH_MISMATCH:<stored>:<recomputed>`
        // for the signed fixture's fake pinned hash.
        const reason = (rw.error as any).reason as string;
        if (kind === "corrupt") {
          expect(pending).toBe(true);
          expect(reason).toStartWith(`SETTLEMENT_WORKSPACE_HASH_CORRUPTION:${w!.workspaceHash}:`);
        } else {
          expect(ogDeferred.length).toBe(1);
          expect(kind).toBe("signed");
          expect(reason).toStartWith(`SETTLEMENT_SIGNED_HASH_MISMATCH:${w!.settlementHash}:`);
        }
        counts.materialize++;
        continue;
      }
      const folded = unwrap(rw as any) as any;
      if (folded.evicted.length > 0) {
        // og admits the upsert into the mempool and refuses it at the Account frame; the rewrite's admitAt trial-folds it (admission timing, ER-15)
        expect(ogOut.accountTxs.length).toBe(1);
        counts.admission++;
        continue;
      }
      const d = folded.draft, after = d.accountReplicas.get(BOB)!;
      const queued = [...after.mempool, ...(after._tag === "proposed" ? after.candidate.frame.txs : [])].filter((t: any) => t.type === "settle_transition" && !pendingTx.includes(t));
      // og routes a proposal's `🚀 Proposed frame` in proposePendingAccountFrames, after the tx and drain phases this og driver runs
      expect((d.events ?? []).filter((e: any) => !String(e.message).startsWith("🚀 Proposed frame "))).toEqual(readEntityFrameEvents(og) as never);
      const rwDeferred = ogOf(d.state)["deferredAccountProposals"] as ReadonlyMap<string, string> | undefined;
      if (ogDeferred.length > 0 && (rwDeferred === undefined || rwDeferred.size === 0)) {
        // the idle Account's deferred approval was materialized in the same frame: exactly one own hanko transition for og's approved workspace
        expect(ogOut.accountTxs).toEqual([]);
        expect(queued.length).toBe(1);
        expect(queued[0]).toMatchObject({ kind: "hanko", revision: w!.revision, workspaceHash: ogDeferred[0]![1] });
        counts.materialize++;
        continue;
      }
      expect(queued.map((t: any) => ownWire(wireOf(t)))).toEqual(ogOut.accountTxs.map((a: any) => a.tx));
      expect(rwDeferred === undefined ? [] : [...rwDeferred]).toEqual(ogDeferred);
      if (ogDeferred.length > 0) { counts.deferred++; expect(unwrap(entityCollectionCommitment(rwDeferred ?? new Map()) as any)).toEqual(ogCollectionCommitment(og.deferredAccountProposals) as never); }
      if (ogOut.accountTxs.length > 0) counts.queued++; else counts.skipped++;
    }
    expect(counts.refused).toBeGreaterThan(100);
    expect(counts.queued).toBeGreaterThan(20);
    expect(counts.skipped).toBeGreaterThan(5);
    expect(counts.deferred + counts.materialize).toBeGreaterThan(3);
    // SJ-17: admission timing matches og (book-admission.md): an upsert og queues is queued here too, never evicted at enqueue
    expect(counts.admission).toBe(0);
  }, 60_000);

  test("DEPARTS: approving a workspace og cannot sign (a c2r above the collateral) -> og's projection throws, a Runtime halt; the rewrite expires the approval", async () => {
    const child = SETTLE_BASE.accountReplicas.get(BOB)!;
    const bobLeft = !isLeft(ALICE, ACCOUNT_ID);
    const ops: SettlementOp[] = [{ type: "c2r", tokenId: 1, amount: 1_001n }];
    const w = workspaceOf("unsigned", ops, bobLeft, bobLeft, undefined)!;
    const approve = { type: "settle_approve", data: { counterpartyEntityId: BOB, workspaceHash: w.workspaceHash } } as EntityTx;
    // og defers the approval, then signing it projects the settled rows (buildPostSettlementDisputeProof), which throws
    const og: any = { entityId: ALICE, accounts: new Map([[BOB, ogAccountOf(w, false)]]) };
    await handleSettleApprove(og, structuredClone(approve) as never, {} as never, true);
    expect([...og.deferredAccountProposals.entries()]).toEqual([[BOB, w.workspaceHash]]);
    const { diffs, forgiveTokenIds } = ogCompileOps(ops as never, bobLeft);
    const ogRows = { state: { deltas: new Map([[1, { ...createDefaultDelta(1), collateral: 1_000n }]]) } };
    expect(() => projectSettlementDeltaOverrides(ogRows as never, diffs, forgiveTokenIds)).toThrow("SETTLEMENT_PROJECTED_COLLATERAL_RANGE:token=1");
    // the rewrite commits the frame: the approval is gone, nothing is signed, and the Entity says why
    const replicas = mapSet(SETTLE_BASE.accountReplicas, BOB, { ...child, state: { ...child.state, settlement: w } } as AccountReplica);
    const folded = unwrap(foldTxs(SETTLE_BASE.state, replicas, signedTxs(SETTLE_BASE.state, aliceAddr, [approve]), { verify: hankoVerify, timestamp: NOW + 1n }) as any) as any;
    const d = folded.draft, after = d.accountReplicas.get(BOB)!;
    const deferred = ogOf(d.state)["deferredAccountProposals"] as ReadonlyMap<string, string> | undefined;
    expect([...(deferred ?? new Map())]).toEqual([]);
    expect([...after.mempool, ...(after._tag === "proposed" ? after.candidate.frame.txs : [])].filter((t: any) => t.type === "settle_transition")).toEqual([]);
    expect(JSON.stringify(d.events ?? [])).toContain("Settlement approval expired: the workspace cannot be signed (SETTLEMENT_PROJECTED_COLLATERAL_RANGE:token=1)");
  });

  test("HALTS like og: a payment staged beside a deferred approval changes the proof the approval just signed -> proposing the hanko halts with og's POST_SETTLEMENT_PROOF_BODY_HASH_MISMATCH (review/og-issues-halts-2026-09-28.md, issue 2; walk seeds 0x5ef1c1 f52, 0x2f1e55 f11)", () => {
    const child = SETTLE_BASE.accountReplicas.get(BOB)!;
    const bobLeft = !isLeft(ALICE, ACCOUNT_ID);
    const w = workspaceOf("unsigned", [{ type: "c2r", tokenId: 1, amount: 100n }], bobLeft, bobLeft, undefined)!;
    const approve = { type: "settle_approve", data: { counterpartyEntityId: BOB, workspaceHash: w.workspaceHash } } as EntityTx;
    const pay = { type: "directPayment", data: { targetEntityId: BOB, tokenId: T1, amount: 5n, route: [ALICE, BOB], deliveryMode: "direct" } } as EntityTx;
    const ctx = { ...verifiers, self: ALICE, signerId: aliceAddr };
    // the Entity's own not-yet-signed hanko, as its proposal verifies it (pendingVerify)
    const verify = (d: string, h: string, e: string): boolean => (h === `0xfe${d.slice(2).toLowerCase()}` && e === ALICE) || hankoVerify(d, h, e as EntityId);
    const base = { ...SETTLE_BASE, accountReplicas: mapSet(SETTLE_BASE.accountReplicas, BOB, { ...child, state: { ...child.state, settlement: w } } as AccountReplica) };
    // og materializeDeferredSettlementApprovals signs over the empty arrived mempool, after the staged payment
    const first = unwrap(applyEntityInput(base, { kind: "txs", timestamp: NOW + 1n, txs: [approve, pay] }, ctx)).replica as OpenEntity;
    const staged = first.accountReplicas.get(BOB)!;
    expect(staged.mempool.map((t) => t.type)).toEqual(["payment", "settle_transition"]);
    // og throwCriticalProposalFailure: the payment ahead of the hanko changed its post-settlement proof
    const planned = planAccountProposal(staged, ALICE, { timestamp: NOW + 1n, jHeight: 0n } as never, verify as never) as any;
    expect(planned.ok).toBe(false);
    expect(planned.error._tag).toBe("proposal_halt");
    expect(planned.error.message).toMatch(/^SETTLEMENT_TRANSITION_PROPOSAL_FAILED:hanko:POST_SETTLEMENT_PROOF_BODY_HASH_MISMATCH:0x[0-9a-f]{64}:0x[0-9a-f]{64}$/);
  });

  test("MATCH: 300 random workspaces auto-approve exactly when og canAutoApproveWorkspace does (no forgiveness / rawDiff; own reserve and collateral share never shrink)", () => {
    let yes = 0;
    for (let n = 0; n < 300; n++) {
      const ops = randomOps().filter((op) => op.tokenId !== 70_000), byLeft = rng() < 0.5, iAmLeft = rng() < 0.5;
      let ogRes: boolean;
      try { ogRes = ogCanAutoApprove({ ops, lastModifiedByLeft: byLeft } as any, iAmLeft); } catch { ogRes = false; }
      expect(canAutoApproveWorkspace({ ops, lastModifiedByLeft: byLeft }, iAmLeft)).toBe(ogRes);
      if (ogRes) yes++;
    }
    expect(yes).toBeGreaterThan(20);
  });
});

describe(seedTag("settle-jsubmit: settle_execute gates (og payments/settle.ts handleSettleExecute)"), () => {
  test("MATCH: 300 random settle_execute txs -- same skip status, same reject / fatal refusal code as og before the execution is prepared", async () => {
    const counts = { skipped: 0, refused: 0 };
    const aliceLeft = isLeft(ALICE, ACCOUNT_ID);
    for (let n = 0; n < 300; n++) {
      const kind = pick<WsKind>(["none", "unsigned", "signed", "signed", "submitted", "corrupt"]);
      const w = workspaceOf(kind, [{ type: "r2c", tokenId: 1, amount: 3n }], rng() < 0.5, rng() < 0.5, undefined), pending = rng() < 0.2, peer = rng() < 0.1 ? CAROL : BOB;
      // og would go on to prepare and verify the execution (real Hankos): out of this gate test's scope
      if (w !== undefined && kind === "signed" && !pending && peer === BOB && w.executorIsLeft === aliceLeft && !aliceLeft) continue;
      const data: any = { counterpartyEntityId: peer, ...(rng() < 0.3 ? { disableC2RShortcut: true } : {}) };
      const child = SETTLE_BASE.accountReplicas.get(BOB)!;
      const pendingTx: WireAccountTx[] = pending ? [{ type: "settle_transition", kind: "clear", revision: 1, workspaceHash: W("01") } as any] : [];
      const replicas = mapSet(SETTLE_BASE.accountReplicas, BOB, { ...child, mempool: pendingTx, state: { ...child.state, settlement: w } } as AccountReplica);
      const og: any = { entityId: ALICE, accounts: new Map([[BOB, ogAccountOf(w, pending)]]) };
      let ogOut: any, ogErr: string | undefined;
      try { ogOut = await handleSettleExecute(og, { type: "settle_execute", data: structuredClone(data) } as any, {} as any, true); } catch (e) { ogErr = (e as Error).message; }
      const rw = foldTxs(SETTLE_BASE.state, replicas, signedTxs(SETTLE_BASE.state, aliceAddr, [{ type: "settle_execute", data } as EntityTx]), { verify: hankoVerify, timestamp: NOW + 1n });
      if (ogErr !== undefined) {
        expect(rw.ok).toBe(false);
        if (!rw.ok) expect(codeOf((rw.error as any).reason ?? rw.error._tag)).toBe(codeOf(ogErr));
        counts.refused++;
        continue;
      }
      expect(ogOut.accountTxs).toEqual([]);
      if (!rw.ok && rw.error._tag === "proposal_halt") {
        // og's frame then proposes the queued clear, and throwCriticalProposalFailure throws SETTLEMENT_TRANSITION_PROPOSAL_FAILED:clear:<reason>
        expect([pending, rw.error.message.startsWith("SETTLEMENT_TRANSITION_PROPOSAL_FAILED:clear:")]).toEqual([true, true]);
        continue;
      }
      if (!rw.ok) {
        // og's frame then asserts the queued Account's workspace canonical (refreshStaleUncommittedSettlementHankos), as foldTxs does
        expect(kind === "corrupt" && pending).toBe(true);
        expect((rw.error as any).reason).toStartWith("SETTLEMENT_WORKSPACE_HASH_CORRUPTION:");
        continue;
      }
      expect(unwrap(rw).draft.events).toEqual(readEntityFrameEvents(og) as never);
      counts.skipped++;
    }
    expect(counts.skipped).toBeGreaterThan(50);
    expect(counts.refused).toBeGreaterThan(50);
  });
});

describe(seedTag("settle-jsubmit: settle_execute jBatch row (og jurisdiction/machine/batch batchAddSettlement)"), () => {
  test("MATCH: 300 random settlement-row sequences -- same full-settlement / pure-C2R shortcut rows, exact-retry no-op, conflict and limit refusals as og", () => {
    const ids = [W("11"), W("22"), W("33")];
    const diffOf = (): any => {
      const amount = pick([1n, 7n]);
      switch (ri(4)) {
        case 0: return { tokenId: pick([1, 2]), leftDiff: amount, rightDiff: 0n, collateralDiff: -amount, ondeltaDiff: -amount };
        case 1: return { tokenId: pick([1, 2]), leftDiff: 0n, rightDiff: amount, collateralDiff: -amount, ondeltaDiff: 0n };
        case 2: return { tokenId: pick([1, 2]), leftDiff: -amount, rightDiff: 0n, collateralDiff: amount, ondeltaDiff: amount };
        default: return { tokenId: pick([1, 2]), leftDiff: pick([0n, 1n]), rightDiff: pick([0n, -1n]), collateralDiff: pick([0n, -1n]), ondeltaDiff: 0n };
      }
    };
    const counts = { settlements: 0, shortcuts: 0, conflicts: 0 };
    for (let n = 0; n < 300; n++) {
      const og: any = ogInitJBatch();
      let rw = jbOfOg(structuredClone(og)) as JBatch;
      const prior: any[] = [];
      for (let k = 0; k < 1 + ri(4); k++) {
        const retry = prior.length > 0 && rng() < 0.3 ? structuredClone(pick(prior)) : undefined;
        const [a, b] = rng() < 0.05 ? [ids[1]!, ids[0]!] : pick([[ids[0]!, ids[1]!], [ids[0]!, ids[2]!], [ids[1]!, ids[2]!]]);
        const row = retry ?? {
          leftEntity: a, rightEntity: b, diffs: Array.from({ length: rng() < 0.8 ? 1 : ri(3) }, diffOf), forgiveDebtsInTokenIds: rng() < 0.1 ? [1] : [],
          sig: pick(["0xaa", "0xaa", "0xbb", "", "0x"]), nonce: pick([1, 2]), initiator: pick([a, b, undefined]), disable: rng() < 0.2,
        };
        prior.push(row);
        let ogErr: string | undefined;
        try { batchAddSettlement(og, row.leftEntity, row.rightEntity, structuredClone(row.diffs), [...row.forgiveDebtsInTokenIds], row.sig, row.nonce, row.initiator, row.disable); } catch (e) { ogErr = (e as Error).message; }
        const r = addSettlementRow(rw, { leftEntity: row.leftEntity, rightEntity: row.rightEntity, diffs: row.diffs, forgiveDebtsInTokenIds: row.forgiveDebtsInTokenIds, sig: row.sig, nonce: row.nonce }, row.initiator ?? "", row.disable);
        if (ogErr !== undefined) {
          expect(r.ok).toBe(false);
          if (!r.ok) expect((r.error as any).reason).toBe(ogErr);
          if (ogErr.startsWith("J_BATCH_SETTLEMENT_CONFLICT")) counts.conflicts++;
          break;
        }
        expect(r.ok).toBe(true);
        rw = unwrap(r);
      }
      const after = ogJBatchState(rw);
      expect(after.status).toBe(og.status);
      expect(after.batch.settlements).toEqual(og.batch.settlements);
      expect(after.batch.collateralToReserve).toEqual(og.batch.collateralToReserve);
      counts.settlements += og.batch.settlements.length;
      counts.shortcuts += og.batch.collateralToReserve.length;
    }
    expect(counts.settlements).toBeGreaterThan(50);
    expect(counts.shortcuts).toBeGreaterThan(20);
    expect(counts.conflicts).toBeGreaterThan(10);
  });
});

// ---- og entity/tx/handlers/j-batch/r2c.ts collectRebalanceFee ----
import { handleR2C } from "../../../core/entity/tx/handlers/j-batch/r2c.ts";
import { queueR2C } from "../../xln.ts";

describe(seedTag("settle-jsubmit: r2c rebalance-fee path (og j-batch/r2c.ts collectRebalanceFee)"), () => {
  test("MATCH: 300 random r2c deposits with / without rebalanceQuoteId -- og has no activeQuote writer, so a quoted deposit is refused with the same status and the jBatch is untouched", async () => {
    const OTHER = W("77"), counts = { fee: 0, queued: 0 };
    for (let n = 0; n < 300; n++) {
      const reserves = new Map([[1, BigInt(ri(100))]]), tokenId = pick([1, 1, 0]), amount = BigInt(ri(60));
      const counterparty = pick([BOB, BOB, OTHER]), receivingEntityId = rng() < 0.2 ? OTHER : undefined;
      const fee = rng() < 0.5 ? { rebalanceQuoteId: 1000 + ri(5), rebalanceFeeAmount: BigInt(ri(3)), rebalanceFeeTokenId: pick([1, 2]) } : undefined;
      const og: any = { entityId: ALICE, timestamp: 5000, reserves: new Map(reserves), accounts: new Map([[BOB, { shadow: { rebalance: {} } }]]) };
      const ogOut: any = await handleR2C({} as any, og, { type: "r2c", data: { counterpartyId: counterparty, receivingEntityId, tokenId, amount, ...(fee ?? {}) } } as any, true);
      const rw: JEntity = { entityId: ALICE, reserves, debts: EMPTY_DEBTS, jBatch: DORMANT, accounts: new Set([BOB]) };
      const r = unwrap(queueR2C(rw, counterparty, tokenId, amount, receivingEntityId, fee));
      const ogQueued = og.jBatchState !== undefined && og.jBatchState.batch.reserveToCollateral.length > 0;
      expect(r._tag === "queued").toBe(ogQueued);
      expect(ogOut.accountTxs ?? []).toEqual([]);
      expect(messages(og)).toEqual([r.message]);
      if (r.message.startsWith("❌ Rebalance fee")) counts.fee++;
      if (r._tag === "queued") { expect((r.jBatch as JBatch).draft).toEqual(og.jBatchState.batch); counts.queued++; }
    }
    expect(counts.fee).toBeGreaterThan(20);
    expect(counts.queued).toBeGreaterThan(20);
  });
});
