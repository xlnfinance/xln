// Coverage: dispute counter-proofs and Source hub claims on DisputeStarted (og entity/tx/j-events.ts
// queueSelectedPullCounterProof, verifyCounterProofIdentity, batchAddCounterDispute, queueSourceHubClaimRegistration)
// against live og. BOB starts a dispute against ALICE, the Source hub of cross-j routes whose Source pull the frozen
// Account carries, while ALICE holds BOB's newer signed proof: the non-starter locks it before T.
import { describe, expect, test } from "bun:test";
import { applyJEvent as ogApplyJEvent } from "../../core/entity/tx/j-events.ts";
import { readEntityFrameEvents } from "../../core/entity/frame-events.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import { EntityAccountCandidateMap, PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { ensureEntityCollectionCandidate } from "../../core/entity/state/persistent-collection-map.ts";
import { cloneCrossJurisdictionRoute } from "../../core/extensions/cross-j/index.ts";
import { initJBatch as ogInitJBatch } from "../../core/jurisdiction/machine/batch/index.ts";
import { compareCanonicalJurisdictionEvents, normalizeJurisdictionEvent } from "../../core/jurisdiction/machine/events/event-normalization.ts";
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from "../../core/jurisdiction/machine/event-observation.ts";
import { EMPTY_J_HISTORY_ROOT, buildJEventRangeDigest, canonicalJEventRangeHash, foldJHistoryRoot } from "../../core/jurisdiction/machine/history-consensus/index.ts";
import {
  accountDisputeHash, applyCrossFill, committedView, createEntity, foldTx, localProof, ogProofBody, prepareCrossRoute,
  tokenId, zeroDelta,
  type AccountReplica, type ActiveDispute, type Binary, type CrossRoute, type DisputeHanko, type EntityOutput, type EntityState, type EntityTx, type PullRow,
} from "../xln.ts";
import { ALICE, BOB, TERMS, TEST_CONTRACTS, TEST_JREPLICA, aliceAddr, anvilKey, genesisAB, signDigestHex, unwrap, verifiers } from "../xln_run.ts";

// ---- seeded randomness: SEEDX overrides the fixed seed, and every failure names the seed ----
const SEED = process.env["SEEDX"] ? Number(process.env["SEEDX"]) : 0xd15c0;
const prng = (seed: number): (() => number) => {
  const state = { s: seed | 0 };
  return () => {
    state.s = (state.s + 0x6d2b79f5) | 0;
    const t1 = Math.imul(state.s ^ (state.s >>> 15), 1 | state.s);
    const t2 = (t1 + Math.imul(t1 ^ (t1 >>> 7), 61 | t1)) ^ t1;
    return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
  };
};
const rng = prng(SEED);
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <X,>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
const tag = (n: number, what: string): string => `seed=${SEED} case=${n} ${what}`;
/** Rewrite and og agree on one labelled value; the label carries the seed and case into the failure. */
const same = (label: string, rewrite: unknown, og: unknown): void => {
  expect([label, rewrite]).toEqual([label, og]);
};
/** og's typed shells are built from plain data; this is the one place a shell is given its og type. */
const asOg = <T,>(shell: unknown): T => shell as T;
const word = (): string => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[ri(16)]).join("")}`;
const Z32 = `0x${"00".repeat(32)}`;
const W = (b: string): string => `0x${b.repeat(32)}`;

// ---- the jurisdiction both engines read ----
const JEP = TEST_CONTRACTS.entityProvider;
const DT = TEST_CONTRACTS.deltaTransformer;
const OG_J = { name: "j", chainId: TERMS.domain.chainId, depositoryAddress: TERMS.domain.depositoryAddress, entityProviderAddress: JEP };
const JREF = getJEventJurisdictionRef(OG_J);
const JREPLICAS = new Map([["j", { ...TEST_JREPLICA, name: "j" }]]);
const ALICE_SIGNER = aliceAddr.toLowerCase();
const T0 = 1_700_000_050_000;
const NOW_SEC = Math.floor(T0 / 1000);
const RUNTIME_SEED = `0x${"5e".repeat(32)}`;
const L = TERMS.disputeConfig.leftResponseSeconds;
const R = TERMS.disputeConfig.rightResponseSeconds;

type RawEvent = { readonly type: string; readonly data: Record<string, unknown> };
type OgState = { lastFinalizedJHeight?: number; jHistoryFinality?: { eventHistoryRoot?: string } };
/** ALICE's proposer-signed J range, one block per event, above the certified head (og's canonical hashing). */
const aliceRange = (og: OgState, events: readonly RawEvent[]): Record<string, unknown> => {
  const baseHeight = Number(og.lastFinalizedJHeight ?? 0);
  const scannedThroughHeight = baseHeight + Math.max(1, events.length);
  const blocks = events.map((e, i) => {
    const blockNumber = baseHeight + 1 + i;
    const blockHash = word();
    const normalized = normalizeJurisdictionEvent({ ...e, blockNumber, blockHash, transactionHash: word(), logIndex: 0 } as never);
    if (normalized === null || normalized === undefined) throw new Error(`og refused to normalize ${e.type}`);
    const sorted = [normalized].sort(compareCanonicalJurisdictionEvents);
    return { blockNumber, blockHash, eventsHash: canonicalJurisdictionEventsHash(sorted), events: sorted };
  });
  const tipBlockHash = word();
  const heads = blocks.map((b) => ({ jurisdictionRef: JREF, jHeight: b.blockNumber, jBlockHash: b.blockHash, eventsHash: b.eventsHash }));
  const eventHistoryRoot = foldJHistoryRoot(og.jHistoryFinality?.eventHistoryRoot ?? EMPTY_J_HISTORY_ROOT, heads);
  const rangeHash = canonicalJEventRangeHash(JREF, blocks);
  const digest = buildJEventRangeDigest({ entityId: ALICE, jurisdictionRef: JREF, signerId: ALICE_SIGNER, baseHeight, scannedThroughHeight, tipBlockHash, eventHistoryRoot, rangeHash });
  return { from: ALICE_SIGNER, jurisdictionRef: JREF, baseHeight, scannedThroughHeight, observedAt: scannedThroughHeight, tipBlockHash, blocks, eventHistoryRoot, rangeHash, signature: signDigestHex(digest, anvilKey(2)) };
};

// ---- a route whose Source hub is ALICE and Source user BOB, filled so a Source claim is due ----
const T1 = unwrap(tokenId("1"));
/** A route intent: BOB swaps into a foreign stack through ALICE, nothing locked yet. */
const intentRoute = (n: number): CrossRoute => {
  const stack = `stack:${TERMS.domain.chainId}:${TERMS.domain.depositoryAddress}`;
  const clock = { leftResponseSeconds: 60, rightResponseSeconds: 60 };
  return {
    orderId: `C${n}`, makerEntityId: BOB, hubEntityId: ALICE,
    source: { jurisdiction: stack, entityId: BOB, counterpartyEntityId: ALICE, tokenId: 1, amount: BigInt(1 + ri(1e9)) },
    target: { jurisdiction: `stack:1:0x${"ab".repeat(20)}`, entityId: W("03"), counterpartyEntityId: W("04"), tokenId: 2, amount: BigInt(1 + ri(1e12)) },
    sourceDisputeConfig: clock, targetDisputeConfig: clock, status: "intent", createdAt: T0 - 1000, updatedAt: T0 - 1000, expiresAt: T0 + 60_000,
    sourceSignerId: `0x${"a1".repeat(20)}`, sourceHubSignerId: ALICE_SIGNER, targetHubSignerId: `0x${"a3".repeat(20)}`, targetSignerId: `0x${"a4".repeat(20)}`,
  };
};
const sourceRoute = (n: number): CrossRoute => {
  const base = intentRoute(n);
  const prepared = unwrap(prepareCrossRoute(base, { runtimeSeed: RUNTIME_SEED, now: T0 - 500 }));
  const numerator = BigInt(pick([0, 1 + ri(999), 1000]));
  // the uint16 projection is the exact fraction rounded up (og exactFillRatioToUint16)
  const cumulativeFillRatio = Number((numerator * 65_535n + 999n) / 1000n);
  const fill = applyCrossFill(prepared, { cumulativeFillRatio, fillNumerator: numerator, fillDenominator: 1000n }, T0 - 100);
  const filled = numerator > 0n && fill.ok ? fill.value : prepared;
  return { ...filled, status: pick(["resting", "partially_filled", "partially_filled", "cancelled"] as const) };
};
/** The Account row of a route's Source pull. */
const pullRowOf = (route: CrossRoute, claimed = false): PullRow => {
  const pull = route.sourcePull;
  if (pull === undefined) throw new Error("prepared route without a Source pull");
  return {
    pullId: pull.pullId, tokenId: pull.tokenId, amount: pull.signedAmount, claimedRatio: claimed ? (route.cumulativeFillRatio ?? 0) : 0, claimedAmount: 0n,
    fullHash: pull.fullHash, partialRoot: pull.partialRoot,
    crossJurisdiction: { orderId: route.orderId, routeHash: route.routeHash ?? "", leg: "source" },
    createdHeight: 1, createdTimestamp: 1,
  };
};

// ---- og shells ----
const PA = (name: string, entries: ReadonlyMap<unknown, unknown> = new Map()): unknown =>
  PersistentAccountStateMap.fromEntries(asOg(name), asOg<Parameters<typeof PersistentAccountStateMap.fromEntries>[1]>(entries));
type OgEntity = Parameters<typeof ogApplyJEvent>[0];
const ogBobAccount = (child: AccountReplica, active?: ActiveDispute): unknown => {
  const view = unwrap(committedView(child.state));
  const w = child.dispute.counterparty;
  return {
    state: {
      leftEntity: ALICE.toLowerCase(), rightEntity: BOB.toLowerCase(), domain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, jNonce: 0,
      deltas: PA("deltas", view.deltas), locks: PA("locks"), swapOffers: PA("swapOffers"), pulls: PA("pulls", view.pulls),
      requestedRebalance: PA("requestedRebalance"), requestedRebalanceFeeState: PA("requestedRebalanceFeeState"), rebalanceFeePolicies: PA("rebalanceFeePolicies"),
    },
    status: active === undefined ? "active" : "disputed", mempool: [], currentHeight: 0, proofHeader: { fromEntity: ALICE.toLowerCase(), toEntity: BOB, nextProofNonce: 1 },
    pendingWithdrawals: PA("pendingWithdrawals"), shadow: { rebalance: { policy: PA("rebalanceShadowPolicy"), submittedAtByToken: PA("rebalanceShadowSubmitted") } },
    ...(w === undefined ? {} : {
      counterpartyDisputeProofHanko: w.hanko, counterpartyDisputeProofNonce: w.proofNonce, counterpartyDisputeProofBodyHash: w.proofBodyHash,
      counterpartyDisputeProofProposerIsLeft: w.proposerIsLeft, counterpartyDisputeHash: w.hash,
    }),
    ...(active === undefined ? {} : { activeDispute: structuredClone(active) }),
  };
};
const ogRoutes = (routes: readonly CrossRoute[]): unknown => {
  const swaps = ensureEntityCollectionCandidate(undefined, asOg(cloneCrossJurisdictionRoute)) as Map<string, unknown>;
  for (const c of routes) swaps.set(c.orderId, cloneCrossJurisdictionRoute(asOg(structuredClone(c))));
  return swaps;
};
const ogEntity = (child: AccountReplica, routes: readonly CrossRoute[], jBatch: unknown, active?: ActiveDispute): OgEntity => asOg<OgEntity>({
  entityId: ALICE, timestamp: T0, height: 0, lastFinalizedJHeight: 0,
  config: { mode: "proposer-based", threshold: 1n, validators: [ALICE_SIGNER], shares: { [ALICE_SIGNER]: 1n }, jurisdiction: OG_J },
  reserves: new Map(), outDebtsByToken: new Map(), inDebtsByToken: new Map(),
  accounts: new EntityAccountCandidateMap(PersistentEntityAccountMap.fromEntries(asOg([[BOB, ogBobAccount(child, active)]]), ALICE, () => asOg(Z32))),
  crossJurisdictionSwaps: ogRoutes(routes), paybook: { entries: new Map(), feesEarned: 0n },
  ...(jBatch === undefined ? {} : { jBatchState: structuredClone(jBatch) }),
});
const OG_ENV = { quietRuntimeLogs: true, runtimeSeed: RUNTIME_SEED, state: { jReplicas: JREPLICAS } };
/** og's J-event bookkeeping slot: the paybook, as disputes-final drives it. */
const BOOK_SLOT = {
  getPaybookEntry: (s: { paybook: { entries: Map<string, unknown> } }, h: string) => s.paybook.entries.get(h),
  getPaybookEntryForWrite: (s: { paybook: { entries: Map<string, unknown> } }, h: string) => s.paybook.entries.get(h),
  addPaybookFees: (s: { paybook: { feesEarned: bigint } }, amount: bigint) => { s.paybook.feesEarned += amount; },
};

// ---- the frozen Account, BOB's signed newer proof, and a competing counter row ----
type Case = {
  readonly child: AccountReplica;
  readonly routes: readonly CrossRoute[];
  readonly bodyHash: string;
  readonly body: Binary;
  readonly witness: DisputeHanko | undefined;
};
const frozenCase = (n: number, claimed = false): Case => {
  const routes = Array.from({ length: 1 + ri(2) }, (_, k) => sourceRoute(n * 10 + k));
  const carried = routes.filter(() => rng() < 0.85);
  const base = genesisAB();
  const account = { ...base.state.account, deltas: new Map([[T1, { ...zeroDelta(T1), collateral: 50n, ondelta: 10n }]]) };
  const pulls = new Map(carried.map((c) => [c.sourcePull?.pullId ?? "", pullRowOf(c, claimed)] as const));
  const state = { ...base.state, account, pulls };
  const proof = unwrap(localProof(unwrap(committedView(state)), { ok: true, value: DT }));
  const view = { ...unwrap(committedView(state)), domain: TERMS.domain };
  const proofNonce = pick([1, 2, 3, 3, 4]);
  const proposerIsLeft = rng() < 0.5;
  const signedHash = unwrap(accountDisputeHash(view, proof.bodyHash, proofNonce, proposerIsLeft));
  const witness: DisputeHanko | undefined = rng() < 0.1 ? undefined : {
    hanko: pick(["0x1234", "0x1234", "0x"]), hash: rng() < 0.08 ? W("0e") : pick([signedHash, signedHash, ""]),
    proofBodyHash: rng() < 0.05 ? W("0f") : proof.bodyHash, proofNonce, proposerIsLeft,
  };
  const child = { ...base, state, dispute: { ...base.dispute, ...(witness === undefined ? {} : { counterparty: witness }) } } as AccountReplica;
  return { child, routes, bodyHash: proof.bodyHash, body: ogProofBody(proof.body), witness };
};
/** A draft jBatch: empty, behind a sent batch, full, or already holding a counter row for BOB that ours must raise. */
const draftJBatch = (c: Case, initialNonce: number): unknown => {
  const base = ogInitJBatch();
  const row = (counterNonce: number, proposerIsLeft: boolean, body: unknown, bound = rng() < 0.67) => ({
    counterentity: BOB.toLowerCase(), initialNonce: bound ? initialNonce : initialNonce + 1, initialProofbodyHash: c.bodyHash,
    counterNonce, proposerIsLeft, counterProofbody: body, sig: "0xaa",
  });
  const otherBody = ogProofBody(unwrap(localProof(unwrap(committedView(genesisAB().state)), { ok: true, value: DT })).body);
  const nonce = c.witness?.proofNonce ?? 1;
  const others = (k: number) => Array.from({ length: k }, (_, i) => ({ counterentity: W((20 + i).toString(16)), initialNonce: 1, initialProofbodyHash: Z32, counterNonce: 2, proposerIsLeft: true, counterProofbody: otherBody, sig: "0xbb" }));
  switch (ri(9)) {
    case 0: return undefined;
    case 1: return { ...base, sentBatch: { batch: ogInitJBatch().batch, batchHash: W("5b"), encodedBatch: "0x", entityNonce: 1, firstSubmittedAt: 0, lastSubmittedAt: 0, submitAttempts: 1 } };
    case 2: return { ...base, status: "accumulating", batch: { ...base.batch, counterDisputes: [row(nonce + pick([-1, 1]), rng() < 0.5, c.body)] } };
    case 3: return { ...base, status: "accumulating", batch: { ...base.batch, counterDisputes: [row(nonce, !(c.witness?.proposerIsLeft ?? true), c.body)] } };
    case 4: return { ...base, status: "accumulating", batch: { ...base.batch, counterDisputes: [row(nonce, c.witness?.proposerIsLeft ?? true, pick([c.body, otherBody]))] } };
    case 5: return { ...base, status: "accumulating", batch: { ...base.batch, counterDisputes: others(8) } };
    case 6: return { ...base, status: "accumulating", batch: { ...base.batch, counterDisputes: [row(nonce + 1, rng() < 0.5, c.body, true)] } };
    default: return base;
  }
};

const outputTxTypes = (t: EntityTx): string =>
  t.type === "runtimeOutput" ? t.data.entityTxs.map((x) => x.type).join("+") : t.type;
/** An output's tx types: an Entity input's txs, or the one Account-lane tx. */
const outputTypes = (o: EntityOutput): string => {
  if ("tx" in o) return o.tx.type;
  return o.input.kind === "txs" ? o.input.txs.map(outputTxTypes).join(",") : o.input.kind;
};
const reasonOf = (e: unknown): string => {
  const r = e as { readonly reason?: string; readonly _tag?: string };
  return r.reason ?? r._tag ?? "";
};

describe("coverage-disputes: DisputeStarted against a Source hub holding a newer Pull proof (og queueSelectedPullCounterProof)", () => {
  test("MATCH: 220 random DisputeStarted events -- same verdict, messages, counter row (or its conflict), deadline miss at T, Source claims, jBatch, activeDispute and outputs as og", async () => {
    const counts = new Map<string, number>();
    const bump = (k: string): void => { counts.set(k, (counts.get(k) ?? 0) + 1); };
    for (let n = 0; n < 220; n++) {
      const c = frozenCase(n);
      const initialNonce = pick([1, 2, 2, 3]);
      // T straddles the Entity clock (og: nowSec >= T misses it), and so does the left beneficiary window, which
      // closes R seconds before T (og: nowSec > start + window expires the Source claim)
      const toT = pick([-3600, -1, 0, 0, 1, 1, 1, 50, R - 1, R, R, R + 1, R + 1, 2 * R]);
      const start = NOW_SEC + toT - L - R;
      const jBatch = draftJBatch(c, initialNonce);
      const data = {
        sender: BOB, counterentity: ALICE, nonce: String(initialNonce), proposerIsLeft: rng() < 0.5, proofbodyHash: c.bodyHash, watchSeed: TERMS.watchSeed,
        starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: Z32, initialProofbody: c.body,
        disputeTimeout: start + L + R, disputeStartTimestamp: start, leftResponseSeconds: L, rightResponseSeconds: R,
      };
      const og = ogEntity(c.child, c.routes, jBatch);
      const range = aliceRange(asOg<OgState>(og), [{ type: "DisputeStarted", data }]);
      const ogRun = await ogApplyJEvent(og, asOg(range), asOg(OG_ENV), asOg({}), [], true, asOg(BOOK_SLOT))
        .then((out) => ({ ok: true as const, out }), (e: unknown) => ({ ok: false as const, message: String((e as Error).message) }));
      const committed = jBatch === undefined ? {} : { jBatchState: asOg<Binary>(structuredClone(jBatch)) };
      const created = unwrap(createEntity({
        id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]),
        jurisdictionConfig: { name: "j", entityProviderAddress: JEP }, committed,
      })).state;
      const rwState: EntityState = { ...created, crossJurisdictionSwaps: new Map(c.routes.map((r) => [r.orderId, r] as const)) };
      const rw = foldTx(rwState, new Map([[BOB, c.child]]), asOg({ type: "j_event", data: range }), {
        verify: verifiers.verify, timestamp: BigInt(T0), jReplicas: JREPLICAS, runtimeSeed: RUNTIME_SEED,
      });
      same(tag(n, "verdict"), rw.ok ? "ok" : reasonOf(rw.error), ogRun.ok ? "ok" : ogRun.message);
      if (!ogRun.ok || !rw.ok) { bump(`refused:${(ogRun.ok ? "" : ogRun.message).split(":")[0]}`); continue; }
      const d = rw.value;
      const next = ogRun.out.newState;
      const messages = readEntityFrameEvents(next).map((e) => e.message);
      same(tag(n, "messages"), (d.events ?? []).map((e) => e.message), messages);
      same(tag(n, "jBatch"), d.state.committed["jBatchState"] ?? null, next.jBatchState ?? null);
      same(tag(n, "routes"), [...(d.state.crossJurisdictionSwaps ?? new Map()).values()].map((r) => [r.orderId, r.pendingSourceRegistryReveal ?? null]),
        [...(next.crossJurisdictionSwaps?.values() ?? [])].map((r) => [r.orderId, r.pendingSourceRegistryReveal ?? null]));
      const child = d.accountReplicas.get(BOB) as (AccountReplica & { readonly active?: unknown }) | undefined;
      same(tag(n, "activeDispute"), child?.active ?? null, next.accounts.get(BOB)?.activeDispute ?? null);
      // the rewrite wraps a cross-Entity output as one runtimeOutput carrying og's entityTxs
      const rwOut = d.outputs.map((o) => [o.to, outputTypes(o)]);
      const ogOut = ogRun.out.outputs.map((o) => [o.entityId, (o.entityTxs ?? []).map((t) => t.type).join(o.entityId === ALICE ? "," : "+")]);
      same(tag(n, "outputs"), rwOut, ogOut);
      for (const m of messages) bump(m.slice(0, 12));
    }
    const summary = `seed=${SEED} ${JSON.stringify([...counts])}`;
    for (const k of ["🛡️ Locked n", "❌ Pull coun", "🌉 Cross-j c", "refused:J_COUNTER_DISPUTE_INITIAL_BINDING_CONFLICT", "refused:J_COUNTER_DISPUTE_NONCE_REGRESSION",
      "refused:DISPUTE_COUNTER_FINALIZE_HASH_MISMATCH", "refused:J_BATCH_LIMIT_EXCEEDED"]) {
      same(`${summary} ${k}`, [...counts.keys()].some((x) => x.startsWith(k)), true);
    }
  }, 120_000);
});

// ---- DisputeFinalized: every live route with a leg on the finalized Account settles or ends ----
const finalityRoute = (n: number): CrossRoute => {
  const route = rng() < 0.2 ? intentRoute(n) : sourceRoute(n);
  return { ...route, expiresAt: pick([T0 + 60_000, T0 - 1, T0]), status: rng() < 0.15 ? "intent" : route.status };
};
const activeOf = (c: Case, startedByLeft: boolean): ActiveDispute => ({
  startedByLeft, initialProofbodyHash: c.bodyHash, initialNonce: 1, initialProposerIsLeft: rng() < 0.5,
  disputeTimeout: NOW_SEC - 5 + L + R, disputeStartTimestamp: NOW_SEC - 5 - pick([0, 0, 0, L]), jNonce: 1,
  starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: Z32,
  observedOnChain: true, observedBlockNumber: 1, finalizeQueued: false,
});

describe("coverage-disputes: DisputeFinalized settles the cross-j routes on the Account (og terminalizeCrossJurisdictionRoutesOnFinality)", () => {
  test("MATCH: 160 random DisputeFinalized events over Accounts carrying Source pulls -- same verdict, messages, route statuses and settled times, jBatch and outputs as og", async () => {
    const counts = new Map<string, number>();
    const bump = (k: string): void => { counts.set(k, (counts.get(k) ?? 0) + 1); };
    for (let n = 0; n < 160; n++) {
      const c0 = frozenCase(n, rng() < 0.7);
      const routes = [...c0.routes, ...Array.from({ length: ri(3) }, (_, k) => finalityRoute(n * 10 + 5 + k))];
      const c: Case = { ...c0, routes };
      const sender = pick([ALICE, BOB]);
      const active = activeOf(c, sender === ALICE);
      const data = {
        sender, counterentity: sender === ALICE ? BOB : ALICE, initialNonce: "1", initialProofbodyHash: c.bodyHash,
        finalProofbodyHash: rng() < 0.05 ? W("0d") : c.bodyHash, finalizationEvidenceHash: word(), finalProofbody: c.body,
      };
      const og = ogEntity(c.child, c.routes, undefined, active);
      const range = aliceRange(asOg<OgState>(og), [{ type: "DisputeFinalized", data }]);
      const ogRun = await ogApplyJEvent(og, asOg(range), asOg(OG_ENV), asOg({}), [], true, asOg(BOOK_SLOT))
        .then((out) => ({ ok: true as const, out }), (e: unknown) => ({ ok: false as const, message: String((e as Error).message) }));
      const created = unwrap(createEntity({
        id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]),
        jurisdictionConfig: { name: "j", entityProviderAddress: JEP },
      })).state;
      const rwState: EntityState = { ...created, crossJurisdictionSwaps: new Map(c.routes.map((r) => [r.orderId, r] as const)) };
      const disputed = asOg<AccountReplica>({ ...c.child, _tag: "disputed", mempool: [], active });
      const rw = foldTx(rwState, new Map([[BOB, disputed]]), asOg({ type: "j_event", data: range }), {
        verify: verifiers.verify, timestamp: BigInt(T0), jReplicas: JREPLICAS, runtimeSeed: RUNTIME_SEED,
      });
      same(tag(n, "verdict"), rw.ok ? "ok" : reasonOf(rw.error), ogRun.ok ? "ok" : ogRun.message);
      if (!ogRun.ok || !rw.ok) { bump(`refused:${(ogRun.ok ? "" : ogRun.message).split(":")[0]}`); continue; }
      const d = rw.value;
      const next = ogRun.out.newState;
      const messages = readEntityFrameEvents(next).map((e) => e.message);
      same(tag(n, "messages"), (d.events ?? []).map((e) => e.message), messages);
      same(tag(n, "jBatch"), d.state.committed["jBatchState"] ?? null, next.jBatchState ?? null);
      const ended = (r: { orderId: string; status: string; settledAt?: number | undefined }) => [r.orderId, r.status, r.settledAt ?? null];
      same(tag(n, "routes"), [...(d.state.crossJurisdictionSwaps ?? new Map()).values()].map(ended),
        [...(next.crossJurisdictionSwaps?.values() ?? [])].map(ended));
      const rwOut = d.outputs.map((o) => [o.to, outputTypes(o)]);
      const ogOut = ogRun.out.outputs.map((o) => [o.entityId, (o.entityTxs ?? []).map((t) => t.type).join(o.entityId === ALICE ? "," : "+")]);
      same(tag(n, "outputs"), rwOut, ogOut);
      for (const m of messages) bump(m.startsWith("🌉 Cross-j route") ? m.replace(/C\d+/, "C") : m.slice(0, 12));
    }
    const summary = `seed=${SEED} ${JSON.stringify([...counts])}`;
    for (const k of ["🌉 Cross-j route C terminal after dispute finality: settled", "🌉 Cross-j route C terminal after dispute finality: cancelled",
      "🌉 Cross-j route C terminal after dispute finality: expired", "🌉 Cross-j route C cancelled before Pull lock on Account finality",
      // pins the full og refusal text (start, timeout and both windows), which the rewrite used to drop
      "refused:CROSS_J_FINAL_CLOCK_MISMATCH"]) {
      same(`${summary} ${k}`, counts.has(k), true);
    }
  }, 120_000);
});
