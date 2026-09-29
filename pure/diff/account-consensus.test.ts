// Behavioural diff: og bilateral Account consensus (core/account/consensus) vs pure/xln.ts.
// Each "DIVERGES:" test PASSES while asserting the observed difference; "MATCH:" tests assert equivalence.
import { describe, expect, test } from "bun:test";
import { lcg31, seedOf, seedTag } from "./seed.ts";

// ---- og ----
import { applyAccountInput as ogApply } from "../../core/account/consensus/index.ts";
import { computeFrameHash, getAccountFrameStructuralError, MAX_ACCOUNT_FRAME_TXS } from "../../core/account/consensus/frame/hash.ts";
import { ACCOUNT_NETWORK_ALLOWANCE_MS as OG_ALLOWANCE, MEMPOOL_LIMIT } from "../../core/account/consensus/constants.ts";
import { getDisputeHankoRequirementError } from "../../core/account/consensus/dispute/hanko.ts";
import { getIncomingAccountDeadlineViolation } from "../../core/account/consensus/dispute/deadline-policy.ts";
import { hashHtlcSecret } from "../../core/protocol/htlc/utils.ts";
import { freezeAccountForDispute, returnPreparedAccountToActive } from "../../core/account/consensus/dispute/policy.ts";
import { getDisputeHankoShapeError } from "../../core/account/consensus/incoming/replay.ts";
import { prepareProposalAdmission } from "../../core/account/consensus/proposal/admission.ts";
import { validateProposalTransactions } from "../../core/account/consensus/proposal/transactions.ts";
import { makeAccount } from "../../core/__tests__/helpers/cross-j.ts";
import { prependUniqueMempoolTxs, buildAccountProofBodyFromJurisdictions } from "../../core/account/consensus/helpers.ts";
import { applyAccountEnqueue } from "../../core/account/input/local-tx-admission.ts";
import { removeCommittedTxsFromMempool } from "../../core/protocol/state/tx-multiset.ts";
import { computeAccountStateRoot } from "../../core/account/commitment/state-root.ts";
import { createEmptyAccountJClaimAccumulator } from "../../core/account/j-claims/j-claim-accumulator.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import { createEmptyEnv } from "../../core/runtime.ts";
import { createAccountConsensusContext } from "../../core/entity/account/account-consensus-context.ts";
import { createDisputeProofHashWithNonce } from "../../core/protocol/dispute/proof-builder.ts";
import { accountInputPeerRejectionCode } from "../../core/account/consensus/result.ts";
import type { AccountConsensusContext } from "../../core/account/consensus/context.ts";
import type { AccountFrame as OgFrame, AccountInput as OgInput, AccountReplica as OgReplica, AccountTx as OgTx } from "../../core/types/account.ts";

// ---- rewrite ----
import {
  ACCOUNT_MEMPOOL_SIZE, tokenId, ACCOUNT_NETWORK_ALLOWANCE_MS, accountDisputeHash, applyEntityInput, createEntity, accountStateRoot, admit, applyAccountInput, committedView, disputeUnsafe, incomingDeadline, keccakUtf8, disputeRequirement, disputeShapes, frameStateHash, localProof, planAccountProposal, proposalPlan, receiverClock, replicaId, unqueued,
} from "../xln.ts";
import type { AccountFrame, AccountInput, AccountReplica, EntityId, FrameClock, WireAccountTx } from "../xln.ts";
import { ALICE, BOB, CLOCK, NOW, TERMS, TOKEN, aliceAddr, verifiers, causeOf, ackInput, disputeFor, envelopeAB, genesisAB, hankoVerify, offerOf, partyIn, proposeInput, signAccountFrame, unwrap, unwrapErr } from "../xln_run.ts";

// ============ og fixture (copied from core/__tests__/account/consensus/account-input-rejection.test.ts) ============
const L = `0x${"11".repeat(32)}`, R = `0x${"22".repeat(32)}`;
const W = (b: string) => `0x${b.repeat(32)}`;
const ogDomain = { chainId: 31_337, depositoryAddress: `0x${"44".repeat(20)}` };
const ogAccount = (local = L, peer = R): OgReplica => {
  const a: OgReplica = {
    state: {
      leftEntity: local < peer ? local : peer, rightEntity: local < peer ? peer : local, domain: { ...ogDomain }, watchSeed: W("33"),
      deltas: PersistentAccountStateMap.empty("deltas"), locks: PersistentAccountStateMap.empty("locks"), swapOffers: PersistentAccountStateMap.empty("swapOffers"),
      pulls: PersistentAccountStateMap.empty("pulls"), leftPendingJClaims: createEmptyAccountJClaimAccumulator(), rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0, disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 }, jNonce: 0,
      requestedRebalance: PersistentAccountStateMap.empty("requestedRebalance"), requestedRebalanceFeeState: PersistentAccountStateMap.empty("requestedRebalanceFeeState"),
    },
    status: "active", mempool: [],
    currentFrame: { height: 0, timestamp: 0, jHeight: 0, accountTxs: [], prevFrameHash: "", accountStateRoot: "", deltas: [], stateHash: "", byLeft: local < peer },
    currentHeight: 0, rollbackCount: 0, proofHeader: { fromEntity: local, toEntity: peer, nextProofNonce: 1 },
    pendingWithdrawals: PersistentAccountStateMap.empty("pendingWithdrawals"),
    shadow: { rebalance: { policy: PersistentAccountStateMap.empty("rebalanceShadowPolicy"), submittedAtByToken: PersistentAccountStateMap.empty("rebalanceShadowSubmitted") } },
  } as unknown as OgReplica;
  a.currentFrame.accountStateRoot = computeAccountStateRoot(a.state);
  return a;
};
const addr = (b: string) => `0x${b.repeat(20)}`;
const ogCtx = (name: string, verify: AccountConsensusContext["verifyHanko"] = async (_h, _d, e) => ({ valid: true, entityId: e })): AccountConsensusContext => {
  const env = createEmptyEnv(name);
  env.quietRuntimeLogs = true;
  const base = createAccountConsensusContext(env);
  // A durable J stack so the og proof body (and hence dispute Hankos) can be built.
  const jReplicas = new Map([["j", { chainId: 31_337, contracts: { depository: ogDomain.depositoryAddress, entityProvider: addr("55"), account: addr("66"), deltaTransformer: addr("77") } }]]);
  return { ...base, jReplicas: jReplicas as unknown as AccountConsensusContext["jReplicas"], verifyHanko: verify };
};
const ogEnvelope = (a: OgReplica) => ({ fromEntityId: a.proofHeader.toEntity, toEntityId: a.proofHeader.fromEntity, domain: { ...a.state.domain }, disputeConfig: { ...a.state.disputeConfig }, watchSeed: a.state.watchSeed });
const ogFrame = (a: OgReplica, over: Partial<OgFrame> = {}): OgFrame => {
  const f = { height: a.currentHeight + 1, timestamp: 1_000, jHeight: 0, accountTxs: [], prevFrameHash: a.currentHeight === 0 ? "genesis" : a.currentFrame.stateHash, accountStateRoot: computeAccountStateRoot(a.state), stateHash: "", ...over };
  f.stateHash = computeFrameHash(f);
  return f;
};
/** Valid peer dispute Hanko for a frame that leaves state unchanged (proof body of the current state). */
const ogPeerDispute = (ctx: AccountConsensusContext, a: OgReplica, proposerIsLeft: boolean, nonce = 1) => {
  const proofBodyHash = buildAccountProofBodyFromJurisdictions(ctx, a).proofBodyHash;
  return { hanko: `0x${"77".repeat(65)}`, hash: createDisputeProofHashWithNonce(a.state, proofBodyHash, a.state.domain, nonce, proposerIsLeft), proofBodyHash, proofNonce: nonce, proposerIsLeft };
};
const scl = (tokenId: number, amount: bigint): OgTx => ({ type: "set_credit_limit", data: { tokenId, amount } }) as OgTx;

/** The Account's status lines (og HandleAccountInputResult `events`), in output order. */
const saidOf = (outputs: readonly { readonly kind: string }[]): string[] =>
  outputs.flatMap((o) => (o.kind === "message" && "message" in o && typeof o.message === "string" ? [o.message] : []));
/** og fixture ids (L/R) and the rewrite's (ALICE/BOB) differ; a message naming `Entity <tail>` is compared with the tail normalized. */
const tails = (xs: readonly string[]): string[] => xs.map((m) => m.replace(/Entity [0-9a-fA-F]{4}/g, "Entity ****"));
// ============ rewrite drivers ============
const DOOR = (self: EntityId, now = NOW) => ({ verify: hankoVerify, self, now });
const leftOf = (): EntityId => (partyIn(genesisAB(), ALICE).left ? ALICE : BOB);
const rightOf = (): EntityId => (leftOf() === ALICE ? BOB : ALICE);
const TOK1 = unwrap(tokenId("1"));
const TX: WireAccountTx = { type: "set_credit_limit", tokenId: TOKEN, limit: 7n };
const TX2: WireAccountTx = { type: "set_credit_limit", tokenId: TOKEN, limit: 9n };
const step = (r: AccountReplica, input: AccountInput, self: EntityId, now = NOW) => unwrap(applyAccountInput(r, input, DOOR(self, now)));
/** Propose one frame from `self` holding `txs`. */
const proposeFrom = (r: AccountReplica, self: EntityId, txs: readonly WireAccountTx[], clock: FrameClock = CLOCK) => {
  const opened = unwrap(admit(r, txs));
  return step(opened, proposeInput(opened, self, clock), self);
};
/** Full round: `proposer` proposes, peer receives and acks, proposer commits. Returns both replicas. */
const round = (p: AccountReplica, q: AccountReplica, proposer: EntityId, peer: EntityId, txs: readonly WireAccountTx[], clock: FrameClock = CLOCK) => {
  const proposed = proposeFrom(p, proposer, txs, clock).replica;
  if (proposed._tag !== "proposed") throw new Error(proposed._tag);
  const received = step(q, offerOf(proposed, proposer), peer).replica;
  const acked = step(received, ackInput(received, peer), peer);
  const ackMsg = acked.outputs.find((o) => o.kind === "ack") as AccountInput;
  const committed = step(proposed, ackMsg, proposer).replica;
  return { p: committed, q: acked.replica, proposedFrame: proposed.candidate.frame, offer: offerOf(proposed, proposer), ack: ackMsg };
};
const peerFrame = (r: AccountReplica, from: EntityId, over: Partial<AccountFrame> & { txs: readonly WireAccountTx[] }): AccountFrame => {
  const bare = { height: r.head.height + 1n, timestamp: NOW, jHeight: 0n, prevFrameHash: r.head.prevFrameHash, accountStateRoot: W("ab"), ...over };
  const byLeft = partyIn(r, from).left;
  return { ...bare, stateHash: unwrap(frameStateHash(bare, replicaId(r), byLeft)) };
};
const ackFrameOf = (r: AccountReplica, from: EntityId, frame: AccountFrame, ack: AccountInput | null = null): AccountInput => ({
  kind: "ack_frame", ...envelopeAB(from), ack: ack === null || ack.kind !== "ack" ? null : { height: ack.height, frameHash: ack.frameHash, frameHanko: ack.frameHanko, ...(ack.disputeHanko ? { disputeHanko: ack.disputeHanko } : {}) },
  frame, frameHanko: signAccountFrame(frame, from),
} as AccountInput);

// =====================================================================================================
describe(seedTag("account-consensus: pure predicates"), () => {
  test("MATCH: dispute-hanko requirement ladder (unexpected / finalized / regression / reuse / body / required)", () => {
    const A = W("aa"), B = W("bb");
    const rows: Array<[string | undefined, string | undefined, number | undefined, number, { nonce: number; body: string } | undefined]> = [
      [undefined, undefined, undefined, 0, undefined], [undefined, undefined, undefined, 0, { nonce: 1, body: A }],
      [A, undefined, undefined, 0, undefined], [A, A, 3, 0, undefined], [A, A, 3, 3, undefined], [A, B, 3, 0, undefined],
      [A, A, 3, 5, { nonce: 5, body: A }], [A, A, 3, 0, { nonce: 2, body: A }], [A, B, 3, 0, { nonce: 3, body: A }],
      [A, A, 3, 0, { nonce: 3, body: A }], [A, A, 3, 0, { nonce: 4, body: B }], [A, B, 3, 0, { nonce: 4, body: A }], [A, A, undefined, 0, { nonce: 1, body: A }],
    ];
    const ogClass = (s: string | undefined) => s === undefined ? undefined : s.startsWith("DISPUTE_HANKO_UNEXPECTED") ? "unexpected" : s.includes("ALREADY_FINALIZED") ? "nonce_finalized"
      : s.includes("REGRESSION") ? "nonce_regression" : s.includes("REUSE") ? "nonce_reuse" : s.includes("PROOFBODY_MISMATCH") ? "body_mismatch" : s.includes("REQUIRED") ? "required" : `?${s}`;
    for (const [exp, prevBody, prevNonce, jNonce, rcv] of rows) {
      const og = getDisputeHankoRequirementError(exp, prevBody, prevNonce, jNonce, rcv && { hanko: "0x01", nonce: rcv.nonce, hash: W("cc"), proofBodyHash: rcv.body, proposerIsLeft: true });
      const pure = disputeRequirement(exp, prevBody, prevNonce, jNonce, rcv && { proofNonce: rcv.nonce, proofBodyHash: rcv.body });
      expect(pure).toBe(ogClass(og) as typeof pure);
    }
  });

  test("MATCH: dispute-hanko hex shape (empty / 0x / odd length rejected, even accepted)", () => {
    for (const h of ["", "0x", "0xabc", "abc", "0xabcd", "abcd", "0X"]) {
      const og = getDisputeHankoShapeError({ kind: "dispute", disputeHanko: { hanko: h } } as unknown as OgInput) !== undefined;
      const pure = !disputeShapes([{ hanko: h, hash: W("aa"), proofBodyHash: W("aa"), proofNonce: 1, proposerIsLeft: true }]).ok;
      expect(pure).toBe(og);
    }
  });

  test("MATCH: future-timestamp allowance is 30s inclusive on both sides", () => {
    expect(Number(ACCOUNT_NETWORK_ALLOWANCE_MS)).toBe(OG_ALLOWANCE);
    const now = 1_000_000;
    const root = W("00");
    for (const skew of [0, 29_999, 30_000, 30_001, 90_000]) {
      const og = getAccountFrameStructuralError({ height: 1, jHeight: 0, timestamp: now + skew, accountTxs: [], accountStateRoot: root } as unknown as OgFrame, now) === "";
      const pure = receiverClock({ timestamp: BigInt(now + skew) } as AccountFrame, BigInt(now)).ok;
      expect(pure).toBe(og);
    }
  });

  test("MATCH: frame tx-count cap and mempool cap are both LIMITS.ACCOUNT_MEMPOOL_SIZE (10000)", () => {
    expect(ACCOUNT_MEMPOOL_SIZE).toBe(MAX_ACCOUNT_FRAME_TXS);
    expect(ACCOUNT_MEMPOOL_SIZE).toBe(MEMPOOL_LIMIT);
  });

  test("MATCH: rollback restore dedupes lifecycle txs but keeps repeated payments, restored txs go FIRST", () => {
    // og: prependUniqueMempoolTxs(account, pendingTxs) -> [...missing, ...mempool]
    const a = ogAccount();
    const dup = scl(1, 5n), pay = { type: "direct_payment", data: { tokenId: 1, amount: 3n, route: [], description: "" } } as unknown as OgTx;
    a.mempool = [dup, pay];
    prependUniqueMempoolTxs(a, [dup, pay, scl(2, 1n)]);
    expect(a.mempool.map((t) => t.type)).toEqual(["direct_payment", "set_credit_limit", "set_credit_limit", "direct_payment"]);
    // rewrite: restore() = [...unqueued(frame.txs, mempool), ...mempool]
    const payW: WireAccountTx = { type: "payment", tokenId: TOKEN, amount: 3n };
    const restored = [...unqueued([TX, payW, TX2], [TX, payW]), TX, payW];
    expect(restored.map((t) => t.type)).toEqual(["payment", "set_credit_limit", "set_credit_limit", "payment"]);
  });
});

// =====================================================================================================
describe(seedTag("account-consensus: driven scenarios"), () => {
  test("MATCH: an authenticated EMPTY peer frame is accepted and commits on both sides", async () => {
    const ctx = ogCtx("diff-empty-frame");
    const a = ogAccount(L, R);                                   // we are LEFT, RIGHT proposes
    const frame = ogFrame(a, { accountTxs: [] });
    const input = { kind: "ack_frame", ...ogEnvelope(a), proposal: { frame, frameHanko: `0x${"66".repeat(65)}`, disputeHanko: ogPeerDispute(ctx, a, false) } } as OgInput;
    const res = await ogApply(ctx, a, input);
    expect(res.ok).toBe(true);
    expect(a.currentHeight).toBe(1);

    const r = genesisAB(), from = rightOf(), self = leftOf();
    const f = peerFrame(r, from, { txs: [], accountStateRoot: unwrap(accountStateRoot(r.state)) });
    const view = unwrap(committedView(r.state));
    const disputeHanko = disputeFor(unwrap(proposalPlan(view, unwrap(localProof(view)), r.dispute, r.dispute, partyIn(r, from).left)), from);
    const received = step(r, { ...ackFrameOf(r, from, f), disputeHanko } as AccountInput, self).replica;
    expect(received._tag).toBe("received");
    const acked = step(received, ackInput(received, self), self);
    expect(acked.replica.head.height).toBe(1n);
    expect(acked.outputs.map((o) => o.kind)).toEqual(["ack", "message"]);
    // og consensus/index.ts: `🤝 Accepted frame 1 from Entity <peer>` (no tx messages for an empty frame)
    expect(tails(saidOf(acked.outputs))).toEqual(tails((res as { events: string[] }).events));
  });

  test("MATCH: frame timestamp 0 is structurally valid on both sides (negative is refused)", () => {
    expect(getAccountFrameStructuralError({ height: 1, jHeight: 0, timestamp: -1, accountTxs: [], accountStateRoot: W("00") } as unknown as OgFrame, 0)).not.toBe("");
    for (const ts of [0, 1]) {
      const og = getAccountFrameStructuralError({ height: 1, jHeight: 0, timestamp: ts, accountTxs: [], accountStateRoot: W("00") } as unknown as OgFrame, 0) === "";
      const r = genesisAB(), from = rightOf(), self = leftOf();
      const f = peerFrame(r, from, { txs: [TX], timestamp: BigInt(ts) });
      const res = applyAccountInput(r, ackFrameOf(r, from, f), DOOR(self));
      const structural = !res.ok && res.error._tag === "frame_structure";
      expect(!structural).toBe(og);
    }
    // A full round at timestamp 0 commits.
    const { p, q } = round(genesisAB(), genesisAB(), ALICE, BOB, [TX], { timestamp: 0n, jHeight: 0n });
    expect([p.head.height, q.head.height]).toEqual([1n, 1n]);
  });

  test("MATCH: local tx admission while a proposal awaits ACK — queued, deduped against mempool + pending frame, kept through the commit", () => {
    const ctx = ogCtx("diff-admit-pending");
    const a = ogAccount();
    a.pendingFrame = ogFrame(a, { accountTxs: [scl(1, 1n)] });
    const res = applyAccountEnqueue(a, { kind: "enqueue", txs: [scl(2, 5n), scl(1, 1n), scl(2, 5n)] }, ctx.jClaimNodeStore);
    expect(res.ok).toBe(true);
    expect(a.mempool.length).toBe(1);

    const proposed = proposeFrom(genesisAB(), ALICE, [TX]).replica;
    expect(proposed._tag).toBe("proposed");
    const queued = unwrap(admit(proposed, [TX2, TX, TX2]));
    expect(queued._tag).toBe("proposed");
    expect(queued.mempool).toEqual([TX2]);
    // The queued tx survives the ACK commit and is proposable next.
    const received = step(genesisAB(), offerOf(proposed as never, ALICE), BOB).replica;
    const ack = step(received, ackInput(received, BOB), BOB).outputs.find((o) => o.kind === "ack") as AccountInput;
    const committed = step(queued, ack, ALICE).replica;
    expect([committed._tag, committed.head.height, committed.mempool]).toEqual(["open", 1n, [TX2]]);
  });

  test("MATCH: proposal disposition — a failed matcher-owned swap_resolve halts, an ordinary failed tx is removed, the rest are proposed", async () => {
    const pctx = { runtimeTimestamp: 1_000, quietLogs: true, jReplicas: new Map(), jClaimNodeStore: new Map(), verifyHanko: async () => ({ valid: true, entityId: null }), resolveSettlementBoardAuthority: async () => undefined } as unknown as AccountConsensusContext;
    const validate = (txs: OgTx[]) => validateProposalTransactions({ consensusContext: pctx, account: makeAccount(L, R), proposalWindow: txs, frameTimestamp: 1_000, frameJHeight: 0, jClaimNodeStore: new Map() });
    const ogHalt = await validate([{ type: "swap_resolve", data: { offerId: "missing", fillRatio: 1, cancelRemainder: true } } as unknown as OgTx]).then(() => "og accepted", (e: Error) => e.message);
    expect(ogHalt).toStartWith("SWAP_RESOLVE_PROPOSAL_FAILED");
    // og applyProposalTransaction rethrows a handler Error: the whole proposal (and Entity input) aborts with og's text
    const ogThrown = await validate([scl(1, 5n), { type: "htlc_lock", data: { lockId: W("5a"), hashlock: W("5a"), timelock: BigInt(CLOCK.timestamp) + 10n ** 8n, revealBeforeHeight: 50, amount: 1n, tokenId: 1, envelope: { version: 9, ciphertext: "x" } } } as unknown as OgTx]).then(() => "og accepted", (e: Error) => e.message);
    const bad = { type: "add_delta", data: { tokenId: 1 << 30 } } as unknown as OgTx;
    const og = await validate([scl(1, 5n), bad, scl(2, 5n)]);
    expect([og.validTxs.length, og.txsToRemove.length, og.deferredTxCount]).toEqual([2, 1, 0]);
    // rewrite
    const resolve = { type: "swap_resolve", offerId: "missing", fillRatio: 1, cancelRemainder: true } as WireAccountTx;
    const halted = unwrap(admit(genesisAB(), [resolve]));
    expect(unwrapErr(applyAccountInput(halted, { kind: "propose", ...CLOCK }, DOOR(ALICE)))).toMatchObject({ _tag: "proposal_halt", txType: "swap_resolve", message: ogHalt });
    const lock = { type: "htlc_lock", lockId: W("5a"), hashlock: W("5a"), timelock: BigInt(CLOCK.timestamp) + 10n ** 8n, revealBeforeHeight: 50n, amount: 1n, tokenId: "1", envelope: { version: 9, ciphertext: "x" } } as unknown as WireAccountTx;
    expect(unwrapErr(applyAccountInput(unwrap(admit(genesisAB(), [{ ...TX, tokenId: TOK1 }, lock])), { kind: "propose", ...CLOCK }, DOOR(ALICE)))).toEqual({ _tag: "account_tx_thrown", message: ogThrown });
    const overdraw: WireAccountTx = { type: "payment", tokenId: TOKEN, amount: 10n ** 30n };
    const proposed = proposeFrom(genesisAB(), ALICE, [TX, overdraw, { ...TX2, tokenId: TOK1 }]).replica;
    if (proposed._tag !== "proposed") throw new Error(proposed._tag);
    expect([proposed.candidate.frame.txs.length, proposed.mempool.length]).toEqual([2, 0]);
    const idle = step(unwrap(admit(genesisAB(), [overdraw])), { kind: "propose", ...CLOCK }, ALICE).replica;
    expect([idle._tag, idle.mempool.length]).toEqual(["open", 0]);
  });

  test("DEPARTS: a settlement transition whose workspace is gone -> og halts the proposal, the rewrite drops it and proposes the rest", async () => {
    const pctx = { runtimeTimestamp: 1_000, quietLogs: true, jReplicas: new Map(), jClaimNodeStore: new Map(), verifyHanko: async () => ({ valid: true, entityId: null }), resolveSettlementBoardAuthority: async () => undefined } as unknown as AccountConsensusContext;
    const validate = (txs: OgTx[]) => validateProposalTransactions({ consensusContext: pctx, account: makeAccount(L, R), proposalWindow: txs, frameTimestamp: 1_000, frameJHeight: 0, jClaimNodeStore: new Map() });
    // an update queued against a workspace that settled on chain (or was cleared) before the proposal
    const ops = [{ type: "r2c", tokenId: 1, amount: 1n }];
    const stale = { type: "settle_transition", data: { kind: "upsert", revision: 2, previousWorkspaceHash: W("61"), ops, executorIsLeft: true } } as unknown as OgTx;
    const ogHalt = await validate([scl(1, 5n), stale]).then(() => "og accepted", (e: Error) => e.message);
    expect(ogHalt).toBe("SETTLEMENT_TRANSITION_PROPOSAL_FAILED:upsert:SETTLEMENT_WORKSPACE_PREVIOUS_MISSING");
    const tx = { type: "settle_transition", kind: "upsert", revision: 2, previousWorkspaceHash: W("61"), ops, executorIsLeft: true } as WireAccountTx;
    const proposed = proposeFrom(genesisAB(), ALICE, [TX, tx]).replica;
    if (proposed._tag !== "proposed") throw new Error(proposed._tag);
    expect([proposed.candidate.frame.txs, proposed.mempool.length]).toEqual([[TX], 0]);
  });

  test("MATCH: standalone peer 'dispute' witness — unexpected without a local draft, nonce ladder against the stored witness, stored on accept", async () => {
    // og
    const ogVerdict = async (setup: (a: OgReplica, body: string) => void, nonce: number) => {
      const ctx = ogCtx("diff-peer-dispute");
      const a = ogAccount(L, R);
      const w = ogPeerDispute(ctx, a, false, nonce);
      setup(a, w.proofBodyHash);
      const res = await ogApply(ctx, a, { kind: "dispute", ...ogEnvelope(a), disputeHanko: w } as unknown as OgInput);
      return { ok: res.ok, stored: a.counterpartyDisputeProofNonce };
    };
    // rewrite: ALICE after one committed round holds her own draft and BOB's witness
    const { p } = round(genesisAB(), genesisAB(), ALICE, BOB, [TX]);
    const view = unwrap(committedView(p.state)), bodyHash = unwrap(localProof(view)).bodyHash;
    const prev = p.dispute.counterparty;
    if (prev === undefined || p.dispute.current === undefined) throw new Error("setup");
    const witness = (r: AccountReplica, nonce: number) => {
      const v = unwrap(committedView(r.state)), b = unwrap(localProof(v)).bodyHash, flag = prev.proposerIsLeft;
      return disputeFor({ _tag: "sign", draft: { hash: unwrap(accountDisputeHash(v, b, nonce, flag)), proofBodyHash: b, proofNonce: nonce, proposerIsLeft: flag } }, BOB)!;
    };
    const peerDispute = (r: AccountReplica, nonce: number) => ({ kind: "dispute", ...envelopeAB(BOB), disputeHanko: witness(r, nonce) }) as AccountInput;
    // no local draft -> unexpected (og: DISPUTE_HANKO_UNEXPECTED_WITHOUT_LOCAL_PROOF)
    expect((await ogVerdict(() => {}, 1)).ok).toBe(false);
    expect(unwrapErr(applyAccountInput(genesisAB(), peerDispute(genesisAB(), 1), DOOR(ALICE)))).toEqual({ _tag: "dispute_hanko", reason: "unexpected" });
    // ladder against the stored witness
    for (const nonce of [0, prev.proofNonce - 1, prev.proofNonce, prev.proofNonce + 1, prev.proofNonce + 5].filter((n) => n >= 0)) {
      const og = await ogVerdict((a, body) => { a.currentDisputeProofBodyHash = body; a.counterpartyDisputeProofBodyHash = body; a.counterpartyDisputeProofNonce = prev.proofNonce; }, nonce);
      const pure = applyAccountInput(p, peerDispute(p, nonce), DOOR(ALICE));
      expect(pure.ok).toBe(og.ok);
      if (pure.ok) expect(pure.value.replica.dispute.counterparty?.proofNonce).toBe(og.stored);
    }
    // the sender must be the peer
    expect(unwrapErr(applyAccountInput(p, { ...peerDispute(p, prev.proofNonce + 1), ...envelopeAB(ALICE) } as AccountInput, DOOR(ALICE)))._tag).toBe("unknown_signer");
    expect(bodyHash).toBe(prev.proofBodyHash);
  });

  test("MATCH: the Entity accountInput lane carries og's peer 'dispute' input to the Account (og inbound-account.ts admits kind 'dispute'); refusal evicts, acceptance stores", async () => {
    const { p } = round(genesisAB(), genesisAB(), ALICE, BOB, [TX]);
    const prev = p.dispute.counterparty;
    if (prev === undefined) throw new Error("setup");
    const v = unwrap(committedView(p.state)), body = unwrap(localProof(v)).bodyHash;
    const witness = (nonce: number) => disputeFor({ _tag: "sign", draft: { hash: unwrap(accountDisputeHash(v, body, nonce, prev.proposerIsLeft)), proofBodyHash: body, proofNonce: nonce, proposerIsLeft: prev.proposerIsLeft } }, BOB)!;
    const entity = unwrap(createEntity({ id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]) }));
    const seeded = { ...entity, state: { ...entity.state, accounts: new Map([[BOB, p.state.account]]) }, accountReplicas: new Map([[BOB, p as AccountReplica]]) };
    const deliver = (nonce: number) => applyEntityInput(seeded, { kind: "txs", timestamp: NOW, txs: [{ type: "accountInput", data: { kind: "dispute", ...envelopeAB(BOB), disputeHanko: witness(nonce) } }] }, { ...verifiers, self: ALICE, signerId: aliceAddr });
    const ogVerdict = async (nonce: number) => {
      const ctx = ogCtx("diff-entity-peer-dispute"), a = ogAccount(L, R), w = ogPeerDispute(ctx, a, false, nonce);
      a.currentDisputeProofBodyHash = w.proofBodyHash; a.counterpartyDisputeProofBodyHash = w.proofBodyHash; a.counterpartyDisputeProofNonce = prev.proofNonce;
      return (await ogApply(ctx, a, { kind: "dispute", ...ogEnvelope(a), disputeHanko: w } as unknown as OgInput)).ok;
    };
    // a regressing nonce: og rejects, the rewrite Entity evicts the only tx and refuses the input
    expect(await ogVerdict(prev.proofNonce - 1)).toBe(false);
    expect(unwrapErr(deliver(prev.proofNonce - 1))).toMatchObject({ _tag: "dispute_hanko" });
    // a fresh nonce: og stores it, the rewrite Entity commits the frame and the child holds the new witness
    expect(await ogVerdict(prev.proofNonce + 1)).toBe(true);
    const committed = unwrap(deliver(prev.proofNonce + 1)).replica;
    expect(committed.head.height).toBe(1n);
    expect(committed.accountReplicas.get(BOB)?.dispute.counterparty?.proofNonce).toBe(prev.proofNonce + 1);
  });

  test("MATCH: the mempool limit counts pending-frame txs (og mempool.ts outstanding = mempool + pendingFrame)", () => {
    const ctx = ogCtx("diff-admit-pending-limit");
    const many = (n: number) => Array.from({ length: n }, (_, i) => scl(2, BigInt(i + 1)));
    const manyW = (n: number) => Array.from({ length: n }, (_, i): WireAccountTx => ({ type: "set_credit_limit", tokenId: TOK1, limit: BigInt(i + 1) }));
    const proposed = proposeFrom(genesisAB(), ALICE, [TX]).replica;
    for (const n of [ACCOUNT_MEMPOOL_SIZE - 1, ACCOUNT_MEMPOOL_SIZE]) {
      const a = ogAccount();
      a.pendingFrame = ogFrame(a, { accountTxs: [scl(1, 1n)] });
      let og = true;
      try { applyAccountEnqueue(a, { kind: "enqueue", txs: many(n) }, ctx.jClaimNodeStore); } catch { og = false; }
      expect(admit(proposed, manyW(n)).ok).toBe(og);
    }
  });

  test("MATCH: proposer clock below the last committed frame — both clamp to max(entityTs, lastFrame.timestamp)", () => {
    const pairs: Array<[number, number]> = [[1_000, 5_000], [5_000, 5_000], [9_000, 5_000], [0, 0], [0, 7]];
    let seed = seedOf(7);
    for (let i = 0; i < 6; i++) { seed = lcg31(seed); pairs.push([seed % 100_000, (seed >> 8) % 100_000]); }
    for (const [entityTs, prevTs] of pairs) {
      const a = ogAccount();
      a.currentHeight = 1;
      a.currentFrame = { ...a.currentFrame, height: 1, timestamp: prevTs, stateHash: W("99") };
      a.mempool = [scl(1, 1n)];
      const adm = prepareProposalAdmission({ runtimeTimestamp: 0, quietLogs: true }, a, entityTs, 0, undefined);
      if (!adm.ok) throw new Error("admission refused");

      const { p } = round(genesisAB(), genesisAB(), ALICE, BOB, [TX], { timestamp: BigInt(prevTs), jHeight: 0n });
      expect(p.head.timestamp).toBe(BigInt(prevTs));
      const second = proposeFrom(p, ALICE, [TX2], { timestamp: BigInt(entityTs), jHeight: 0n }).replica;
      if (second._tag !== "proposed") throw new Error(second._tag);
      expect(second.candidate.frame.timestamp).toBe(BigInt(adm.frameTimestamp));
    }
  });

  test("MATCH: simultaneous proposals — LEFT ignores RIGHT's same-height frame and keeps its own pending frame", async () => {
    // og LEFT
    const ctx = ogCtx("diff-collision-left");
    const a = ogAccount(L, R);
    const own = ogFrame(a, { accountTxs: [scl(1, 1n)] });
    a.pendingFrame = own;
    a.pendingAccountInput = { kind: "ack_frame", fromEntityId: L, toEntityId: R, domain: { ...ogDomain }, disputeConfig: { ...a.state.disputeConfig }, watchSeed: a.state.watchSeed, proposal: { frame: own } } as NonNullable<OgReplica["pendingAccountInput"]>;
    const theirs = ogFrame(a, { accountTxs: [scl(2, 2n)], timestamp: 1_001 });
    const res = await ogApply(ctx, a, { kind: "ack_frame", ...ogEnvelope(a), proposal: { frame: theirs, frameHanko: `0x${"66".repeat(65)}` } } as OgInput);
    expect(res.ok).toBe(true);
    expect(a.pendingFrame?.stateHash).toBe(own.stateHash);
    expect(a.currentHeight).toBe(0);
    // rewrite LEFT
    const left = leftOf(), right = rightOf();
    const lp = proposeFrom(genesisAB(), left, [TX]).replica;
    const rp = proposeFrom(genesisAB(), right, [TX2]).replica;
    if (lp._tag !== "proposed" || rp._tag !== "proposed") throw new Error("setup");
    const out = step(lp, offerOf(rp, right), left);
    expect(out.replica._tag).toBe("proposed");
    expect(out.outputs.filter((o) => o.kind !== "message")).toEqual([]);
    // og collision.ts: `📤 LEFT-WINS: Ignored RIGHT's frame 1 (waiting for their ACK)`
    expect(saidOf(out.outputs)).toEqual((res as { events: string[] }).events);
  });

  test("MATCH: simultaneous proposals — RIGHT rolls back, restores its txs to the FRONT of the mempool and takes LEFT's frame", async () => {
    // og RIGHT (accepting an empty LEFT frame so the og proof/dispute path is simple)
    const ctx = ogCtx("diff-collision-right");
    const b = ogAccount(R, L);
    b.pendingFrame = ogFrame(b, { accountTxs: [scl(1, 1n)] });
    b.mempool = [scl(3, 3n)];
    const theirs = ogFrame(b, { accountTxs: [] });
    const res = await ogApply(ctx, b, { kind: "ack_frame", ...ogEnvelope(b), proposal: { frame: theirs, frameHanko: `0x${"66".repeat(65)}`, disputeHanko: ogPeerDispute(ctx, b, true) } } as OgInput);
    expect(res.ok).toBe(true);
    expect(b.currentHeight).toBe(1);
    expect(b.pendingFrame).toBeUndefined();
    expect(b.mempool.map((t) => (t.data as { tokenId: number }).tokenId)).toEqual([1, 3]);
    // rewrite RIGHT
    const left = leftOf(), right = rightOf();
    const lp = proposeFrom(genesisAB(), left, [TX]).replica;
    const rp = proposeFrom(genesisAB(), right, [TX2]).replica;
    if (lp._tag !== "proposed" || rp._tag !== "proposed") throw new Error("setup");
    const taken = step(rp, offerOf(lp, left), right), out = taken.replica;
    expect(out._tag).toBe("received");
    expect(out.mempool).toEqual([TX2]);
    // og collision.ts: `🔄 ROLLBACK: Discarded our frame 1, restored 1/1 txs to mempool`, `📥 Accepted LEFT's frame 1 ...`; og then commits at once (`🤝`), the rewrite at its local ACK
    const acked = step(out, ackInput(out, right), right);
    // (og's LEFT frame here is empty; the rewrite's carries TX, whose set_credit_limit lines og puts between `📥` and `🤝`)
    const txLines = ["📊 Created delta for token 0", "💳 Right credit limit = 7 for token 0"];
    expect(saidOf(acked.outputs).slice(0, 2)).toEqual(txLines);
    expect(tails([...saidOf(taken.outputs), ...saidOf(acked.outputs).slice(2)])).toEqual(tails((res as { events: string[] }).events));
  });

  test("MATCH: ack_frame with a valid ACK and an invalid successor — both commit the ACK then reject the frame", async () => {
    // og (mirrors core/__tests__/account/consensus/account-input-rejection.test.ts "valid bundled ACK stays committed")
    const ctx = ogCtx("diff-ackframe-atomic");
    const a = ogAccount();
    a.pendingFrame = { height: 1, timestamp: 1, jHeight: 0, accountTxs: [], prevFrameHash: "genesis", accountStateRoot: computeAccountStateRoot(a.state), deltas: [], stateHash: W("55"), byLeft: true } as OgFrame;
    const succ = ogFrame(a, { height: 2, prevFrameHash: W("ff") });
    const res = await ogApply(ctx, a, { kind: "ack_frame", ...ogEnvelope(a), ack: { height: 1, frameHash: W("55"), frameHanko: `0x${"66".repeat(65)}` }, proposal: { frame: succ, frameHanko: `0x${"77".repeat(65)}` } } as OgInput);
    expect(accountInputPeerRejectionCode(res)).toBe("ACCOUNT_INPUT_FRAME_CHAIN_INVALID");
    expect(a.currentHeight).toBe(1);                                          // ACK half kept
    // rewrite
    const proposed = proposeFrom(genesisAB(), ALICE, [TX]).replica;
    if (proposed._tag !== "proposed") throw new Error("setup");
    const received = step(genesisAB(), offerOf(proposed, ALICE), BOB).replica;
    const acked = step(received, ackInput(received, BOB), BOB);
    const ack = acked.outputs.find((o) => o.kind === "ack") as AccountInput;
    const bad = peerFrame(acked.replica, BOB, { txs: [TX2], prevFrameHash: W("ff") });
    const e = unwrapErr(applyAccountInput(proposed, ackFrameOf(acked.replica, BOB, bad, ack), DOOR(ALICE)));
    if (e._tag !== "rejected_after_ack") throw new Error(e._tag);
    expect(e.cause._tag).toBe("hash_mismatch");                               // og ACCOUNT_INPUT_FRAME_CHAIN_INVALID
    expect([e.committed.replica._tag, e.committed.replica.head.height]).toEqual(["open", 1n]);   // ACK half kept
    // Without a bundled ACK nothing commits and the refusal is plain.
    expect(unwrapErr(applyAccountInput(proposed, ackFrameOf(acked.replica, BOB, bad), DOOR(ALICE)))._tag).not.toBe("rejected_after_ack");
    // An unsafe successor after the ACK disputes from the committed head.
    const unsafe = peerFrame(acked.replica, BOB, { txs: [TX2], accountStateRoot: W("ab") });
    const disputed = unwrap(disputeUnsafe(proposed, applyAccountInput(proposed, ackFrameOf(acked.replica, BOB, unsafe, ack), DOOR(ALICE)), DOOR(ALICE))).replica;
    expect([["preparing", "disputed"].includes(disputed._tag), disputed.head.height]).toEqual([true, 1n]);
  });

  test("MATCH: repeated ACK for the current head — exact bytes are a no-op, a different frame Hanko is a loud rejection", async () => {
    // og
    const ctx = ogCtx("diff-repeat-ack");
    const a = ogAccount();
    a.currentHeight = 1;
    a.currentFrame = { ...a.currentFrame, height: 1, prevFrameHash: "genesis", stateHash: W("55") };
    a.counterpartyFrameHanko = `0x${"66".repeat(65)}`;
    const ackOf = (hanko: string) => ({ kind: "ack", ...ogEnvelope(a), ack: { height: 1, frameHash: W("55"), frameHanko: hanko } }) as OgInput;
    expect((await ogApply(ctx, a, ackOf(`0x${"66".repeat(65)}`))).ok).toBe(true);
    expect(accountInputPeerRejectionCode(await ogApply(ctx, a, ackOf(`0x${"99".repeat(65)}`)))).toBe("ACCOUNT_INPUT_ACK_CERTIFICATE_INVALID");
    // rewrite
    const { p, ack } = round(genesisAB(), genesisAB(), ALICE, BOB, [TX]);
    expect(step(p, ack, ALICE).outputs).toEqual([]);
    if (ack.kind !== "ack") throw new Error("setup");
    expect(unwrapErr(applyAccountInput(p, { ...ack, frameHanko: `0x${"99".repeat(65)}` }, DOOR(ALICE)))).toEqual({ _tag: "ack_conflict", field: "frameHanko" });
  });

  test("MATCH: duplicate delivery of the committed head frame re-sends the ACK; a different frame Hanko is rejected", async () => {
    // og
    const ctx = ogCtx("diff-dup-frame");
    const a = ogAccount(L, R);
    const f = ogFrame(a, { accountTxs: [] });
    a.currentHeight = 1; a.currentFrame = f; a.counterpartyFrameHanko = `0x${"66".repeat(65)}`; a.currentFrameHanko = `0x${"88".repeat(65)}`;
    const dup = (h: string) => ({ kind: "ack_frame", ...ogEnvelope(a), proposal: { frame: f, frameHanko: h } }) as OgInput;
    const ok = await ogApply(ctx, a, dup(`0x${"66".repeat(65)}`));
    expect(ok.ok && ok.response?.kind).toBe("ack");
    expect(accountInputPeerRejectionCode(await ogApply(ctx, a, dup(`0x${"99".repeat(65)}`)))).toBe("ACCOUNT_INPUT_FRAME_HANKO_INVALID");
    // rewrite
    const { q, offer } = round(genesisAB(), genesisAB(), ALICE, BOB, [TX]);
    const again = step(q, offer as AccountInput, BOB);
    expect(again.outputs.map((o) => o.kind)).toEqual(["ack", "message"]);
    // og replay.ts: a retained ACK is re-sent; with none retained (this og fixture) it is rebuilt from the certified head
    expect(saidOf(again.outputs)).toEqual(["↩️ Re-sent ACK for duplicate committed frame 1"]);
    expect(saidOf(step({ ...q, acknowledged: undefined } as AccountReplica, offer as AccountInput, BOB).outputs)).toEqual((ok as { events: string[] }).events);
    if (offer.kind !== "ack_frame") throw new Error("setup");
    expect(unwrapErr(applyAccountInput(q, { ...offer, frameHanko: `0x${"99".repeat(65)}` }, DOOR(BOB)))).toEqual({ _tag: "ack_conflict", field: "frameHanko" });
  });

  test("MATCH: ACK older than the immediate predecessor is an idempotent no-op", async () => {
    const ctx = ogCtx("diff-obsolete-ack", async () => ({ valid: false, entityId: null }));
    const a = ogAccount();
    a.currentHeight = 3; a.currentFrame = { ...a.currentFrame, height: 3, prevFrameHash: W("44"), stateHash: W("55") };
    const res = await ogApply(ctx, a, { kind: "ack", ...ogEnvelope(a), ack: { height: 1, frameHash: W("aa"), frameHanko: `0x${"bb".repeat(65)}` } } as OgInput);
    expect(res.ok).toBe(true);
    let p: AccountReplica = genesisAB(), q: AccountReplica = genesisAB(), first: AccountInput | undefined;
    for (const tx of [TX, TX2, { ...TX, limit: 11n } as WireAccountTx]) { const r = round(p, q, ALICE, BOB, [tx]); p = r.p; q = r.q; first ??= r.ack; }
    expect(p.head.height).toBe(3n);
    // og ack-commit.ts handleObsoleteAck: `ℹ️ Ignored stale ACK 1 (current=3)` and nothing else
    expect(step(p, first!, ALICE).outputs).toEqual((res as { events: string[] }).events.map((message) => ({ kind: "message", message })));
  });

  test("MATCH: peer frame with wrong prevFrameHash / wrong height is refused before any replay", () => {
    const r = genesisAB(), from = rightOf(), self = leftOf();
    expect(unwrapErr(applyAccountInput(r, ackFrameOf(r, from, peerFrame(r, from, { txs: [TX], prevFrameHash: W("01") })), DOOR(self)))._tag).toBe("hash_mismatch");
    expect(unwrapErr(applyAccountInput(r, ackFrameOf(r, from, peerFrame(r, from, { txs: [TX], height: 2n })), DOOR(self)))._tag).toBe("height_mismatch");
    const a = ogAccount();
    expect(getAccountFrameStructuralError(ogFrame(a, { accountTxs: [scl(1, 1n)] }), 1_000)).toBe("");
  });

  test("MATCH: authenticated frame whose replay misses accountStateRoot -> dispute (og disposition 'dispute', rewrite dispute_required -> freeze)", async () => {
    const ctx = ogCtx("diff-root-mismatch");
    const a = ogAccount(L, R);
    const f = ogFrame(a, { accountTxs: [scl(1, 1n)], accountStateRoot: W("ab") });
    const res = await ogApply(ctx, a, { kind: "ack_frame", ...ogEnvelope(a), proposal: { frame: f, frameHanko: `0x${"66".repeat(65)}` } } as OgInput);
    expect(!res.ok && res.disposition).toBe("dispute");
    const r = genesisAB(), from = rightOf(), self = leftOf();
    const input = ackFrameOf(r, from, peerFrame(r, from, { txs: [TX], accountStateRoot: W("ab") }));
    const e = unwrapErr(applyAccountInput(r, input, DOOR(self)));
    expect(e._tag).toBe("dispute_required");
    expect(causeOf(e)._tag).toBe("state_root_mismatch");
    // og's failureMessage is the dispute reason the Entity records (disputes-final)
    expect((e as { reason?: string }).reason).toBe(!res.ok && res.disposition === "dispute" ? res.disputeRequired.reason : "og accepted");
    const frozen = unwrap(disputeUnsafe(r, applyAccountInput(r, input, DOOR(self)), DOOR(self))).replica._tag;
    expect(["preparing", "disputed"]).toContain(frozen);
  });

  test("MATCH: authenticated frame whose replay refuses a tx -> dispute reason `Frame application failed: <og handler text>` (og consensus/index.ts replayIncomingFrameOnClone)", async () => {
    const lock = W("5c"), cases: Array<[OgTx, WireAccountTx]> = [
      [{ type: "htlc_resolve", data: { lockId: lock, outcome: "secret", secret: W("01") } } as OgTx, { type: "htlc_resolve", lockId: lock, outcome: "secret", secret: W("01") } as WireAccountTx],
      [{ type: "swap_cancel_request", data: { offerId: "nope" } } as OgTx, { type: "swap_cancel_request", offerId: "nope" } as WireAccountTx],
      [{ type: "direct_payment", data: { tokenId: 1, amount: 5n, route: [L], fromEntityId: R, toEntityId: L, deliveryMode: "direct" } } as OgTx, { type: "payment", tokenId: TOK1, amount: 5n, route: [leftOf()], fromEntityId: rightOf(), toEntityId: leftOf(), deliveryMode: "direct" }],
    ];
    for (const [ogTx, tx] of cases) {
      const ctx = ogCtx("diff-frame-application");
      const a = ogAccount(L, R);
      const res = await ogApply(ctx, a, { kind: "ack_frame", ...ogEnvelope(a), proposal: { frame: ogFrame(a, { accountTxs: [ogTx] }), frameHanko: `0x${"66".repeat(65)}` } } as OgInput);
      const ogReason = !res.ok && res.disposition === "dispute" ? res.disputeRequired.reason : `og ${res.ok ? "accepted" : res.disposition}`;
      expect(ogReason).toStartWith("Frame application failed: ");
      const r = genesisAB(), from = rightOf(), self = leftOf();
      const e = unwrapErr(applyAccountInput(r, ackFrameOf(r, from, peerFrame(r, from, { txs: [tx] })), DOOR(self)));
      expect(e._tag).toBe("dispute_required");
      // og's texts name og's fixture ids (L/R); the rewrite's frame names ALICE/BOB
      const ids = (x: string | undefined) => String(x).replace(/sender [0-9a-fA-F]{4}:/, "sender ****:");
      expect(ids((e as { reason?: string }).reason)).toBe(ids(ogReason));
    }
  });

  test("MATCH: authenticated frame that changes the proof but carries no peer dispute Hanko -> dispute on both", async () => {
    const ctx = ogCtx("diff-dispute-required");
    const a = ogAccount(L, R);
    const res = await ogApply(ctx, a, { kind: "ack_frame", ...ogEnvelope(a), proposal: { frame: ogFrame(a, { accountTxs: [] }), frameHanko: `0x${"66".repeat(65)}` } } as OgInput);
    expect(!res.ok && res.disposition).toBe("dispute");
    expect(!res.ok && res.disposition === "dispute" && res.disputeRequired.reason).toContain("DISPUTE_HANKO_REQUIRED");
    const left = leftOf(), right = rightOf();
    const rp = proposeFrom(genesisAB(), right, [TX]).replica;
    if (rp._tag !== "proposed") throw new Error("setup");
    const stripped = { ...offerOf(rp, right) } as Extract<AccountInput, { kind: "ack_frame" }>;
    delete (stripped as { disputeHanko?: unknown }).disputeHanko;
    const e = unwrapErr(applyAccountInput(genesisAB(), stripped, DOOR(left)));
    expect(e._tag).toBe("dispute_required");
    expect(causeOf(e)).toEqual({ _tag: "dispute_hanko", reason: "required" });
    // same og text shape: DISPUTE_HANKO_REQUIRED over the local proof body hash and jNonce (the bodies differ: og replays an empty frame)
    const shape = (x: string | undefined) => String(x).replace(/0x[0-9a-f]{64}/, "<hash>");
    expect(shape((e as { reason?: string }).reason)).toBe(shape(!res.ok && res.disposition === "dispute" ? res.disputeRequired.reason : "og accepted"));
  });

  // og throws ACCOUNT_MEMPOOL_LIMIT_EXCEEDED, the rewrite returns typed mempool_full: same whole-batch refusal, nothing admitted.
  test("MATCH: mempool overflow refuses the whole batch on both sides (og throw = rewrite mempool_full)", () => {
    const ctx = ogCtx("diff-mempool-limit");
    const a = ogAccount();
    const many = Array.from({ length: ACCOUNT_MEMPOOL_SIZE + 1 }, (_, i) => scl(1, BigInt(i + 1)));
    expect(() => applyAccountEnqueue(a, { kind: "enqueue", txs: many }, ctx.jClaimNodeStore)).toThrow("ACCOUNT_MEMPOOL_LIMIT_EXCEEDED");
    const manyW = Array.from({ length: ACCOUNT_MEMPOOL_SIZE + 1 }, (_, i): WireAccountTx => ({ type: "set_credit_limit", tokenId: TOKEN, limit: BigInt(i + 1) }));
    expect(unwrapErr(admit(genesisAB(), manyW))).toEqual({ _tag: "mempool_full", limit: ACCOUNT_MEMPOOL_SIZE });
    // exactly at the limit both admit
    const b = ogAccount();
    expect(applyAccountEnqueue(b, { kind: "enqueue", txs: many.slice(1) }, ctx.jClaimNodeStore).ok).toBe(true);
    expect(admit(genesisAB(), manyW.slice(1)).ok).toBe(true);
  });
});

// =====================================================================================================
describe(seedTag("account-consensus: dispute preparation"), () => {
  test("MATCH: freeze keeps J claims + matcher evidence while preparing; preparing returns to active keeping only J claims", () => {
    // og
    const a = ogAccount();
    const claimOg = { type: "j_event_claim", data: { jHeight: 3 } } as unknown as OgTx, resolveOg = { type: "swap_resolve", data: { offerId: "o" } } as unknown as OgTx;
    a.mempool = [claimOg, scl(2, 5n), resolveOg];
    a.pendingFrame = ogFrame(a, { accountTxs: [scl(1, 1n)] });
    a.status = "dispute_preparing";
    freezeAccountForDispute(a, true);
    const ogPreparing = a.mempool.map((t) => t.type);
    returnPreparedAccountToActive(a);
    const ogResumed = [a.status, a.mempool.map((t) => t.type)];
    // rewrite (no counterparty witness yet, so the freeze stays in preparing)
    const claim = { type: "j_event_claim", jHeight: 3n, jBlockHash: W("0c"), events: [], observedAt: 3n } as unknown as WireAccountTx;
    const resolve = { type: "swap_resolve", offerId: "o", fillRatio: 1, cancelRemainder: true } as WireAccountTx;
    // og queues whatever the matcher/j-watcher left in the mempool; an empty-events claim would be refused at admission (og ACCOUNT_J_CLAIM_EVENTS_INVALID), so seed it directly.
    const held = proposeFrom(genesisAB(), ALICE, [TX]).replica, proposed = { ...held, mempool: [...held.mempool, claim, TX2, resolve] } as AccountReplica;
    const preparing = step(proposed, { kind: "freeze" }, ALICE).replica;
    expect(preparing._tag).toBe("preparing");
    expect<readonly string[]>(preparing.mempool.map((t) => t.type)).toEqual(ogPreparing);
    const resumed = step(preparing, { kind: "resume" }, ALICE).replica;
    expect<readonly unknown[]>([resumed._tag === "open" ? "active" : resumed._tag, resumed.mempool.map((t) => t.type)]).toEqual(ogResumed);
    // only a preparing Account returns (og ACCOUNT_DISPUTE_PREPARATION_RETURN_INVALID)
    expect(() => returnPreparedAccountToActive(ogAccount())).toThrow("ACCOUNT_DISPUTE_PREPARATION_RETURN_INVALID");
    expect(applyAccountInput(genesisAB(), { kind: "resume" }, DOOR(ALICE)).ok).toBe(false);
  });
});

describe(seedTag("account-consensus: frozen admission"), () => {
  test("MATCH: og applyAccountEnqueue admits in any status — a preparing or disputed Account queues local txs (deduped), and nothing proposes them", () => {
    const ctx = ogCtx("diff-frozen-enqueue");
    for (const status of ["dispute_preparing", "disputed"] as const) {
      const a = ogAccount();
      a.status = status;
      const res = applyAccountEnqueue(a, { kind: "enqueue", txs: [scl(2, 5n), scl(2, 5n)] }, ctx.jClaimNodeStore);
      expect([res.ok, a.mempool.length]).toEqual([true, 1]);
    }
    const preparing = step(proposeFrom(genesisAB(), ALICE, [TX]).replica, { kind: "freeze" }, ALICE).replica;
    const { p } = round(genesisAB(), genesisAB(), ALICE, BOB, [TX]);
    const disputed = step(p, { kind: "freeze" }, ALICE).replica;
    expect([preparing._tag, disputed._tag]).toEqual(["preparing", "disputed"]);
    for (const frozen of [preparing, disputed]) {
      const queued = unwrap(admit(frozen, [TX2, TX2]));
      expect([queued._tag, queued.mempool.length - frozen.mempool.length]).toEqual([frozen._tag, 1]);
      expect(applyAccountInput(queued, { kind: "propose", ...CLOCK }, DOOR(ALICE)).ok).toBe(false);
    }
  });
});

// =====================================================================================================
describe(seedTag("account-consensus: incoming preflight"), () => {
  test("MATCH: HTLC deadline preflight (og getIncomingAccountDeadlineViolation) — none / reject / dispute over randomized frames", () => {
    const now = 1_000_000, fin = 10, secret = W("5a");
    let seed = seedOf(42);
    const rnd = (n: number) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) % n; };
    const around = (base: number, spread: number) => base - spread + rnd(2 * spread + 1);
    const verdicts = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const proposerIsLeft = rnd(2) === 0, senderIsLeft = rnd(2) === 0;
      const lock = { timelock: BigInt(around(now + 30_000, 40_000)), rbh: around(fin + 2, 5) };
      const frame = { timestamp: around(now, 40_000), jHeight: around(fin, 5), height: 2 };
      const kind = rnd(5); // 0 new lock, 1 good secret, 2 bad secret, 3 timeout, 4 manual cancel
      const existing = kind !== 0;
      // og
      const ogLock = { lockId: "L", hashlock: hashHtlcSecret(secret), timelock: lock.timelock, revealBeforeHeight: lock.rbh, amount: 1n, tokenId: 1, senderIsLeft, createdHeight: 1, createdTimestamp: 0 };
      const ogTx = kind === 0 ? { type: "htlc_lock", data: { lockId: "L", hashlock: hashHtlcSecret(secret), timelock: lock.timelock, revealBeforeHeight: lock.rbh, amount: 1n, tokenId: 1 } }
        : kind >= 3 ? { type: "htlc_resolve", data: { lockId: "L", outcome: "error", reason: kind === 3 ? "timeout" : "manual" } }
        : { type: "htlc_resolve", data: { lockId: "L", outcome: "secret", secret: kind === 1 ? secret : W("5b") } };
      const og = getIncomingAccountDeadlineViolation({ ...ogAccount().state, locks: new Map(existing ? [["L", ogLock]] : []) } as never, { ...frame, accountTxs: [ogTx] } as never, proposerIsLeft, { entityTimestamp: now, finalizedJHeight: fin } as never);
      // rewrite
      const hashlock = hashHtlcSecret(secret);
      const rwLock = { lockId: "L", hashlock, timelock: lock.timelock, revealBeforeHeight: BigInt(lock.rbh), amount: 1n, tokenId: "1", senderIsLeft, createdHeight: 1n, createdTimestamp: 0n } as never;
      const rwTx = (kind === 0 ? { type: "htlc_lock", lockId: "L", hashlock, timelock: lock.timelock, revealBeforeHeight: BigInt(lock.rbh), amount: 1n, tokenId: "1" }
        : kind >= 3 ? { type: "htlc_resolve", lockId: "L", outcome: "error", reason: kind === 3 ? "timeout" : "manual" } : { type: "htlc_resolve", lockId: "L", outcome: "secret", secret: kind === 1 ? secret : W("5b") }) as WireAccountTx;
      const body = { ...genesisAB().state, locks: new Map(existing ? [["L", rwLock]] : []) };
      const rw = incomingDeadline(body, { ...frame, timestamp: BigInt(frame.timestamp), jHeight: BigInt(frame.jHeight), height: 2n, txs: [rwTx] } as unknown as AccountFrame, proposerIsLeft, { now: BigInt(now), finalizedJHeight: BigInt(fin) });
      const ogV = og === undefined ? "none" : og.disposition;
      const rwV = rw.ok ? "none" : rw.error.dispute ? "dispute" : "reject";
      verdicts.add(ogV);
      expect(rwV).toBe(ogV);
    }
    expect([...verdicts].sort()).toEqual(["dispute", "none", "reject"]);
  });

  test("MATCH: an incoming frame with a too-short HTLC lock is refused before replay", () => {
    const r = genesisAB(), from = rightOf(), self = leftOf();
    const lock: WireAccountTx = { type: "htlc_lock", lockId: "L", hashlock: keccakUtf8(W("5a")), timelock: NOW + 10_000n, revealBeforeHeight: 100n, amount: 1n, tokenId: TOKEN };
    const e = unwrapErr(applyAccountInput(r, ackFrameOf(r, from, peerFrame(r, from, { txs: [lock] })), DOOR(self)));
    expect(e).toEqual({ _tag: "frame_deadline", reason: "lock_window", lockId: "L" });
  });

  test("MATCH: tx profile is checked before the frame Hanko (og preflight order)", async () => {
    const ctx = ogCtx("diff-profile-order", async () => ({ valid: false, entityId: null }));
    const a = ogAccount(L, R);
    const f = ogFrame(a, { accountTxs: [scl(70_000, 1n)] });
    const res = await ogApply(ctx, a, { kind: "ack_frame", ...ogEnvelope(a), proposal: { frame: f, frameHanko: `0x${"66".repeat(65)}` } } as OgInput);
    expect(accountInputPeerRejectionCode(res)).toBe("ACCOUNT_INPUT_FRAME_TX_TOKEN_ID_OUT_OF_RANGE");
    const r = genesisAB(), from = rightOf(), self = leftOf();
    const good = peerFrame(r, from, { txs: [TX] });
    const bad = { ...good, txs: [{ ...TX, tokenId: "70000" } as WireAccountTx] };
    const input = { ...ackFrameOf(r, from, good), frame: bad, frameHanko: `0x${"66".repeat(65)}` } as AccountInput;
    expect(unwrapErr(applyAccountInput(r, input, DOOR(self)))._tag).toBe("uncommitted");
    // with a valid profile the bad Hanko is what refuses
    expect(unwrapErr(applyAccountInput(r, { ...input, frame: good } as AccountInput, DOOR(self)))._tag).toBe("invalid_hanko");
  });
});

describe(seedTag("account-consensus: proposal selection (og admission.ts selectProposalWindow)"), () => {
  test("MATCH: selected mempool subset — EMPTY / TOO_LARGE / NOT_IN_MEMPOOL refuse in both; a valid subset proposes only it and keeps the rest queued", () => {
    const ogTxs = [scl(1, 1n), scl(2, 2n), scl(3, 3n)];
    const TX3: WireAccountTx = { type: "set_credit_limit", tokenId: TOKEN, limit: 11n }, rwTxs: WireAccountTx[] = [TX, TX2, TX3];
    const TX4: WireAccountTx = { type: "set_credit_limit", tokenId: TOKEN, limit: 13n };
    const ogWindow = (sel: number[] | "none" | "huge" | "foreign"): string => {
      const a = ogAccount(L, R);
      a.mempool = [...ogTxs];
      const selected = sel === "none" ? undefined : sel === "huge" ? Array.from({ length: ACCOUNT_MEMPOOL_SIZE + 1 }, () => ogTxs[0]!) : sel === "foreign" ? [scl(4, 4n)] : sel.map((i) => ogTxs[i]!);
      try {
        const adm = prepareProposalAdmission({ runtimeTimestamp: 0, quietLogs: true }, a, 1_000, 0, selected);
        if (!adm.ok) return "refused";
        return `ok:${adm.proposalWindow.map((tx) => ogTxs.indexOf(tx)).join(",")}|kept:${removeCommittedTxsFromMempool([...a.mempool], adm.proposalWindow).map((tx) => ogTxs.indexOf(tx)).join(",")}`;
      } catch (e) { return String((e as Error).message).split(":")[0]!; }
    };
    const self = leftOf(), opened = unwrap(admit(genesisAB(), rwTxs));
    const rwWindow = (sel: number[] | "none" | "huge" | "foreign"): string => {
      const selected = sel === "none" ? undefined : sel === "huge" ? Array.from({ length: ACCOUNT_MEMPOOL_SIZE + 1 }, () => rwTxs[0]!) : sel === "foreign" ? [TX4] : sel.map((i) => rwTxs[i]!);
      const planned = planAccountProposal(opened, self, CLOCK, hankoVerify, selected);
      if (!planned.ok) return planned.error._tag === "proposal_selection" ? `ACCOUNT_PROPOSAL_SELECTION_${planned.error.reason.toUpperCase()}` : planned.error._tag;
      if (planned.value._tag !== "frame") return "idle";
      const { frame, deferred } = planned.value.preview;
      return `ok:${frame.txs.map((tx) => rwTxs.indexOf(tx)).join(",")}|kept:${deferred.map((tx) => rwTxs.indexOf(tx)).join(",")}`;
    };
    const cases: (number[] | "none" | "huge" | "foreign")[] = ["none", [], "huge", "foreign", [0, 0], [1], [2, 0], [0, 1, 2]];
    for (const c of cases) expect(rwWindow(c)).toBe(ogWindow(c));
    expect(ogWindow("none")).toBe("ok:0,1,2|kept:");
    expect(ogWindow([2, 0])).toBe("ok:2,0|kept:1");
    expect(ogWindow([])).toBe("ACCOUNT_PROPOSAL_SELECTION_EMPTY");
    expect(ogWindow("huge")).toBe("ACCOUNT_PROPOSAL_SELECTION_TOO_LARGE");
    expect(ogWindow([0, 0])).toBe("ACCOUNT_PROPOSAL_SELECTION_NOT_IN_MEMPOOL");
    // The Account input carries the selection: the proposed frame holds only it, the rest stays in the mempool (og finalizeAccountProposal).
    const out = step(opened, proposeInput(opened, self, CLOCK, [TX2]), self).replica;
    if (out._tag !== "proposed") throw new Error(out._tag);
    expect(out.candidate.frame.txs).toEqual([TX2]);
    expect(out.mempool).toEqual([TX, TX3]);
  });
});
