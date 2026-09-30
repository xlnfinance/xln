// Behavioural diff: og hub rebalance (core/entity/scheduler/rebalance.ts behind the crontab hubRebalance task), og board Hanko refresh
// (entity/tx/state-effects/board-rotation-hanko-refresh.ts, scheduler/board-hanko-refresh-hook.ts, tx/j-events-board.ts) and og's
// lending_overdue deadline (scheduler/derived-deadlines.ts, tx/handlers/account/committed-lending-close.ts) vs pure/xln.ts.
// "MATCH:" tests run og live on the same inputs and assert the same accept / reject, outputs and state.
import { describe, expect, test } from "bun:test";
import { lcg31, seedOf, seedTag, untilCovered } from "../seed.ts";
import {
  accountId, createEntity, crontabTaskHasPendingWork, executeCrontab, genesisReplica, initCrontab, rebalanceAccountIds, tokenId, withCrontab, crontabOf, ZERO_WORD,
  applyBoardJEvent, counterpartyProposer, rearmBoardRefreshes, derivedDeadlines, entityId, quorumBoardHash, quorumHanko, scheduleHook,
  type AccountReplica, type Address, type Crontab, type DisputeHanko, type EntityError, type EntityId, type EntityState, type Hash, type JEvent, type RefreshMigration, type ScheduledHook, type SettlementWorkspace,
} from "../../xln.ts";
import { ALICE, BOB, CAROL, TERMS, aliceAddr, bobAddr, carolAddr, crypto, keyOf, signLazyAccountHanko, unwrap } from "../../xln_run.ts";
import { applyCertifiedBoardJEvent } from "../../../core/entity/tx/j-events-board.ts";
import { readEntityFrameEventMessages } from "../../../core/entity/frame-events.ts";
import { scheduleChangedAccountBoardHankoRefreshes } from "../../../core/entity/scheduler/board-hanko-refresh-hook.ts";
import { captureAccountBoardHankoRefreshEvidence } from "../../../core/entity/tx/state-effects/board-rotation-hanko-refresh.ts";
import { applyCertifiedBoardRegistryEvent } from "../../../core/jurisdiction/machine/board-registry/index.ts";
import { executeCrontab as ogExecuteCrontab, crontabTaskHasPendingWork as ogHasPendingWork } from "../../../core/entity/scheduler/index.ts";
import { getRebalanceAccountIds } from "../../../core/entity/consensus/account/work-index.ts";
import { collectDerivedDeadlines as ogCollectDerivedDeadlines } from "../../../core/entity/scheduler/derived-deadlines.ts";
import { initJBatch as ogInitJBatch } from "../../../core/jurisdiction/machine/batch/index.ts";
import { PersistentAccountStateMap } from "../../../core/account/state/persistent-state-map.ts";
import { EntityAccountCandidateMap, PersistentEntityAccountMap } from "../../../core/entity/state/persistent-account-map.ts";
import { createBookIntentProgram } from "../../../core/entity/books/book-intents.ts";
import { ogJb, ogOf, ogSentBatch } from "../og/og-state.ts";

let seed = seedOf(29);
const rng = (): number => { seed = lcg31(seed); return seed / 0x7fffffff; };
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <T>(xs: readonly T[]): T => xs[ri(xs.length)] as T;
const reasonOf = (e: EntityError): string => (e._tag === "entity_invariant" ? e.reason : e._tag);
const PA = (name: string, entries: readonly (readonly [unknown, unknown])[] = []) => (entries.length === 0 ? PersistentAccountStateMap.empty(name as never) : PersistentAccountStateMap.fromEntries(name as never, entries as never));
const JUR = TERMS.domain;
const ogConfigOf = (validators: readonly string[]): any => ({ mode: "proposer-based", threshold: 1n, validators: validators.map((v) => v.toLowerCase()), shares: Object.fromEntries(validators.map((v) => [v.toLowerCase(), 1n])) });
const U = 10n ** 6n; // tokens 1 and 3 carry 6 decimals; the default soft limit is 500 whole tokens

type Tok = { readonly tokenId: number; readonly collateral: bigint; readonly ondelta: bigint; readonly offdelta: bigint; readonly hold: bigint; readonly holdLeft: boolean;
  readonly requested: bigint; readonly fee?: { readonly feePaidUpfront: bigint; readonly policyVersion: number; readonly requestedAt: number; readonly refund: boolean } | undefined; readonly submittedAt: number };
type Acct = { readonly peer: EntityId; readonly toks: readonly Tok[]; readonly workspace?: SettlementWorkspace | undefined; readonly settlePending: boolean };

const rwAccount = (hub: EntityId, a: Acct): AccountReplica => {
  const base = unwrap(genesisReplica(unwrap(accountId(hub, a.peer)), TERMS));
  const tk = (n: number) => unwrap(tokenId(String(n)));
  const locks = new Map(a.toks.filter((t) => t.hold > 0n).map((t) => [`lock-${t.tokenId}`, { lockId: `lock-${t.tokenId}`, hashlock: `0x${"ab".repeat(32)}`, timelock: 10n ** 13n, revealBeforeHeight: 100n, amount: t.hold, tokenId: tk(t.tokenId), senderIsLeft: t.holdLeft, createdHeight: 1n, createdTimestamp: 1n }]));
  const state = {
    ...base.state,
    account: { ...base.state.account, deltas: new Map(a.toks.map((t) => [tk(t.tokenId), { tokenId: tk(t.tokenId), collateral: t.collateral, ondelta: t.ondelta, offdelta: t.offdelta, leftCreditLimit: 0n, rightCreditLimit: 0n }])) },
    locks, requested: new Map(a.toks.filter((t) => t.requested !== 0n).map((t) => [tk(t.tokenId), t.requested])),
    requestFees: new Map(a.toks.flatMap((t) => (t.fee === undefined ? [] : [[tk(t.tokenId), { requestId: `r${t.tokenId}`, feeTokenId: t.tokenId, feePaidUpfront: t.fee.feePaidUpfront, requestedAmount: t.requested, policyVersion: t.fee.policyVersion, requestedAt: t.fee.requestedAt, requestedByLeft: true, ...(t.fee.refund ? { refund: { reason: "manual", refundedAmount: 1n } } : {}) }] as const]))),
    submittedAt: new Map(a.toks.filter((t) => t.submittedAt > 0).map((t) => [t.tokenId, t.submittedAt])),
    ...(a.workspace === undefined ? {} : { settlement: a.workspace }),
  };
  return { ...base, state, mempool: a.settlePending ? [{ type: "settle_transition" } as never] : [] } as AccountReplica;
};
const ogAccount = (hub: EntityId, a: Acct): any => {
  const left = hub < a.peer ? hub : a.peer, right = hub < a.peer ? a.peer : hub;
  return {
    state: {
      leftEntity: left, rightEntity: right, domain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, jNonce: 0,
      deltas: PA("deltas", a.toks.map((t) => [t.tokenId, { tokenId: t.tokenId, collateral: t.collateral, ondelta: t.ondelta, offdelta: t.offdelta, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n,
        leftHold: t.holdLeft ? t.hold : 0n, rightHold: t.holdLeft ? 0n : t.hold }])),
      locks: PA("locks"), swapOffers: PA("swapOffers"), pulls: PA("pulls"),
      requestedRebalance: PA("requestedRebalance", a.toks.filter((t) => t.requested !== 0n).map((t) => [t.tokenId, t.requested])),
      requestedRebalanceFeeState: PA("requestedRebalanceFeeState", a.toks.flatMap((t) => (t.fee === undefined ? [] : [[t.tokenId, { requestId: `r${t.tokenId}`, feeTokenId: t.tokenId, feePaidUpfront: t.fee.feePaidUpfront, requestedAmount: t.requested, policyVersion: t.fee.policyVersion, requestedAt: t.fee.requestedAt, requestedByLeft: true, ...(t.fee.refund ? { refund: { reason: "manual", refundedAmount: 1n } } : {}) }] as const]))),
      rebalanceFeePolicies: PA("rebalanceFeePolicies"),
      ...(a.workspace === undefined ? {} : { settlementWorkspace: structuredClone(a.workspace) }),
    },
    status: "active", mempool: a.settlePending ? [{ type: "settle_transition" }] : [], currentHeight: 1, proofHeader: { fromEntity: hub, toEntity: a.peer, nextProofNonce: 1 }, pendingWithdrawals: PA("pendingWithdrawals"),
    shadow: { rebalance: { policy: PA("rebalanceShadowPolicy"), submittedAtByToken: PA("rebalanceShadowSubmitted", a.toks.filter((t) => t.submittedAt > 0).map((t) => [t.tokenId, t.submittedAt])) } },
  };
};
const amountNear = (): bigint => pick([0n, 0n, 100n * U, 499n * U, 500n * U, 501n * U, 900n * U, 2_000n * U]);
const randomTok = (tokenId: number, hubIsLeft: boolean): Tok => {
  const requested = rng() < 0.6 ? pick([0n, 1n * U, 300n * U, 900n * U, 900n * U, -5n]) : 0n;
  const fee = requested > 0n && rng() < 0.985 ? { feePaidUpfront: pick([0n, 100_000n, 50n * U, 50n * U, 50n * U]), policyVersion: pick([1, 1, 1, 1, 2]), requestedAt: pick([0, 5, 9, 12]), refund: rng() < 0.08 } : undefined;
  return { tokenId, collateral: amountNear(), ondelta: pick([0n, 1n, -1n]) * amountNear(), offdelta: pick([0n, 1n, -1n]) * amountNear(), hold: rng() < 0.2 ? pick([10n * U, 600n * U]) : 0n, holdLeft: rng() < 0.5 ? hubIsLeft : !hubIsLeft,
    requested, fee, submittedAt: rng() < 0.1 ? 77 : 0 };
};
const readyWorkspace = (hubIsLeft: boolean): SettlementWorkspace => ({
  workspaceHash: `0x${"11".repeat(32)}`, ops: [{ type: pick(["c2r", "c2r", "r2c"] as const), tokenId: 1, amount: 5n * U }], lastModifiedByLeft: rng() < 0.85 ? hubIsLeft : !hubIsLeft, executorIsLeft: rng() < 0.85 ? hubIsLeft : !hubIsLeft,
  status: pick(["ready_to_submit", "ready_to_submit", "awaiting_counterparty"] as const), revision: 1, createdAt: 1, lastUpdatedAt: 1,
  ...(rng() < 0.85 ? (hubIsLeft ? { rightHanko: "0xbeef" } : { leftHanko: "0xbeef" }) : {}),
});

describe(seedTag("rebalance-refresh: hub rebalance (og scheduler/rebalance.ts hubRebalanceHandler via executeCrontab)"), () => {
  test("MATCH: 400 random hubs (R→C requests by strategy / policy / fee / reserve, submitted markers, C→R withdrawals and ready workspaces, sent-batch latch and staleness, manual broadcast, pair limits) -- og's outputs, J batch, markers, task and halts", async () => {
    const counts = new Map<string, number>();
    const wanted = ["settle_propose", "settle_execute", "j_broadcast", "j_abort_sent_batch", "r2c", "halt:REBALANCE_REQUEST_FEE_STATE_MISSING", "halt:HUB_REBALANCE_TOKENLESS_RAW_OVERRIDE_FORBIDDEN"];
    for (let i = 0, more = untilCovered(400, () => wanted.every((k) => (counts.get(k) ?? 0) > 3)); more(i); i++) {
      const hub = pick([ALICE, BOB, CAROL]), peers = [ALICE, BOB, CAROL].filter((p) => p !== hub) as EntityId[];
      const accts: Acct[] = peers.map((peer) => {
        const hubIsLeft = hub < peer, toks = [1, 3].filter(() => rng() < 0.8).map((t) => randomTok(t, hubIsLeft));
        return { peer, toks, ...(rng() < 0.2 ? { workspace: readyWorkspace(hubIsLeft) } : {}), settlePending: rng() < 0.05 };
      });
      const now = 1_000_000 + ri(1_000), runtimeNow = now + ri(3) * 100_000, manual = rng() < 0.15;
      const r2cRows = rng() < 0.2 ? [{ tokenId: 1, receivingEntity: hub, pairs: Array.from({ length: pick([1, 64, 256]) }, (_, n) => ({ entity: n === 0 ? peers[0] as string : `0x${(n + 9).toString(16).padStart(64, "0")}`, amount: 1n })) }] : [];
      // og consensus never records a submit time on the sent batch: its age is the last broadcast's
      const sent = rng() < 0.2 ? { status: "sent", sentBatch: ogSentBatch(ogInitJBatch().batch, ZERO_WORD, 2, 1), lastBroadcast: pick([0, runtimeNow - 500, runtimeNow - 1_000, runtimeNow - 200_000]) } : {};
      const jBatch = { ...ogInitJBatch(), ...(r2cRows.length > 0 ? { batch: { ...ogInitJBatch().batch, reserveToCollateral: r2cRows }, status: "accumulating" } : {}), ...sent };
      const config = { matchingStrategy: pick(["amount", "fee", "time", "bogus"]), policyVersion: pick([1, 1, 2, 0]), rebalanceLiquidityFeeBps: pick([0n, 1n, 100n]), disputeAutoFinalizeMode: "auto", ...(rng() < 0.03 ? { c2rWithdrawSoftLimit: 1n } : {}) };
      const reserves = new Map([[1, pick([0n, 100n * U, 5_000n * U, 5_000n * U])], [3, pick([0n, 400n * U, 5_000n * U])]]);
      const task = { method: "hubRebalance" as const, intervalMs: 1000, lastRun: now - 1000 - ri(2), enabled: true, params: {} };
      const crontab: Crontab = { ...initCrontab(), tasks: new Map([["hubRebalance", task]]) };
      const validators = [aliceAddr, bobAddr];
      const state = withCrontab(unwrap(createEntity({ id: hub, jurisdiction: JUR, threshold: 1n, members: new Map(validators.map((a) => [a as never, { shares: 1n }])), committed: { jBatchState: structuredClone(jBatch), hubRebalanceConfig: config, reserves } as never })).state, crontab);
      const replicas = new Map(accts.map((a) => [a.peer, rwAccount(hub, a)]));
      const og: any = { entityId: hub, timestamp: now, config: ogConfigOf(validators), accounts: new EntityAccountCandidateMap(PersistentEntityAccountMap.fromEntries(accts.map((a) => [a.peer, ogAccount(hub, a)]), hub, () => ZERO_WORD as never)),
        reserves: new Map(reserves), jBatchState: structuredClone(jBatch), hubRebalanceConfig: { ...config }, crontabState: { tasks: new Map([["hubRebalance", { ...task }]]), hooks: new Map() }, paybook: { entries: new Map(), feesEarned: 0n } };
      // og's ACCOUNT_WORK_REBALANCE index and crontabTaskHasPendingWork
      const rwIds = rebalanceAccountIds(state, replicas);
      expect(rwIds.ok ? [...rwIds.value] : reasonOf(rwIds.error)).toEqual([...getRebalanceAccountIds(og)].sort() as never);
      expect(crontabTaskHasPendingWork(state, replicas)).toBe(ogHasPendingWork(og, "hubRebalance"));
      const program = createBookIntentProgram();
      const ctx = { manualBroadcastInInput: manual, bookIntentSlot: program.openSlot(), hashesToSign: [], accountChanges: new Set<string>(), candidateEffects: [], accountTxs: [] };
      let ogOut: any[] | undefined, ogErr: string | undefined;
      try { ogOut = await ogExecuteCrontab({ quietRuntimeLogs: true, state: { timestamp: runtimeNow } } as never, { entityId: hub, state: og } as never, og.crontabState, ctx as never); } catch (e) { ogErr = String((e as Error).message); }
      const rw = executeCrontab(state, replicas, now, manual, runtimeNow);
      if (ogErr !== undefined) { counts.set(`halt:${ogErr.split(":")[0]}`, (counts.get(`halt:${ogErr.split(":")[0]}`) ?? 0) + 1); expect(rw.ok ? "ok" : reasonOf(rw.error)).toBe(ogErr); continue; }
      const run = unwrap(rw);
      expect(run.outputs).toEqual((ogOut ?? []).map((o) => ({ signerId: o.signerId, txs: o.entityTxs })));
      expect(ogJb(run.state)).toEqual(og.jBatchState);
      expect(crontabOf(run.state).tasks.get("hubRebalance")?.lastRun).toBe(og.crontabState.tasks.get("hubRebalance").lastRun);
      for (const a of accts) expect([...((run.accountReplicas.get(a.peer)?.state.submittedAt ?? new Map()) as ReadonlyMap<number, number>)].sort()).toEqual([...og.accounts.get(a.peer).shadow.rebalance.submittedAtByToken].sort() as never);
      for (const o of run.outputs) for (const tx of o.txs) counts.set(tx.type, (counts.get(tx.type) ?? 0) + 1);
      const r2c = (ogJb(run.state)!.batch.reserveToCollateral as readonly unknown[]).length > r2cRows.length || JSON.stringify(ogJb(run.state)!.batch.reserveToCollateral, (_, v) => (typeof v === "bigint" ? String(v) : v)) !== JSON.stringify(r2cRows, (_, v) => (typeof v === "bigint" ? String(v) : v));
      if (r2c) counts.set("r2c", (counts.get("r2c") ?? 0) + 1);
    }
    const seen = Object.fromEntries([...counts].map(([k, v]) => [k, v > 3]));
    expect(seen).toMatchObject(Object.fromEntries(wanted.map((k) => [k, true])));
    expect(counts.has("halt:J_BATCH_LIMIT_EXCEEDED")).toBe(true);
  }, 120_000);
});

// ---- board Hanko refresh: og processBoardHankoRefreshHook, applyCertifiedBoardJEvent's BoardActivated tail, scheduleChangedAccountBoardHankoRefreshes ----
const word = (n: bigint | number): string => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const rword = (): string => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[ri(16)]).join("")}`;
const RJ = { name: "j", chainId: 31337, depositoryAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3", entityProviderAddress: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" };
const RDOMAIN = { chainId: RJ.chainId, depositoryAddress: RJ.depositoryAddress };
const RJCONF = { entityProviderAddress: RJ.entityProviderAddress };
const meta = (block: number, log: number) => ({ blockNumber: block, blockHash: word(30 + block), transactionHash: word(4000 + block * 8 + log), logIndex: log });
const toOgEvent = (e: JEvent): any => {
  const { meta: m, type, ...data } = e as any;
  const text = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return { type, blockNumber: m.blockNumber, blockHash: m.blockHash, transactionHash: m.transactionHash, logIndex: m.logIndex, data: text };
};
const S = unwrap(entityId(word(80))), T = unwrap(entityId(word(81))), UE = unwrap(entityId(word(82)));
const filler = (n: number): EntityId => unwrap(entityId(word(300 + n)));
const one = new Map([[bobAddr, { shares: 1n }]]), three = new Map([aliceAddr, bobAddr, carolAddr].map((a) => [a, { shares: 1n }] as const));
const uAuthority = { _tag: "teaching" as const, threshold: 2n, members: three };
const BOARDS = new Map<string, string>([[S, quorumBoardHash({ _tag: "teaching", threshold: 1n, members: one })], [T, word(777)], [UE, quorumBoardHash(uAuthority)]]);
const REGISTRY_EVENTS: readonly JEvent[] = [
  { type: "FoundationBootstrapped", recipient: "0x" + "11".repeat(20), boardHash: word(900), controlTokenId: 1n, dividendTokenId: 2n, meta: meta(2, 0) },
  ...[S, T, UE].map((id, i): JEvent => ({ type: "EntityRegistered", entityId: id, entityNumber: BigInt(id), boardHash: BOARDS.get(id) as string, meta: meta(3, i) })),
];
const observeAs = (id: EntityId, threshold: bigint, members: ReadonlyMap<string, { shares: bigint }>) => {
  let state = unwrap(createEntity({ id, jurisdiction: RDOMAIN, threshold, members: members as never, jurisdictionConfig: RJCONF })).state, ogRegistry: any;
  const ogNodes = new Map<string, any>();
  for (const e of REGISTRY_EVENTS) {
    state = unwrap(applyBoardJEvent(state, e, e.meta?.blockNumber ?? 0)).state;
    const og = applyCertifiedBoardRegistryEvent(ogRegistry, ogNodes, RJ as any, toOgEvent(e));
    ogRegistry = og.state;
    for (const [h, n] of og.newNodes) ogNodes.set(h, n);
  }
  return { state, ogRegistry, ogNodes };
};
const observed = observeAs(S, 1n, one);
const uState = observeAs(UE, 2n, three).state;
const uHanko = (digest: string, signers: readonly Address[]): string => unwrap(quorumHanko(uState, digest, new Map(signers.map((a) => [a, unwrap(crypto.sign(digest as Hash, a))] as const))));

type Side = DisputeHanko;
type BoardSpec = { readonly peer: EntityId; readonly height: number; readonly frameHash: string; readonly own: string; readonly peerHanko: string; readonly current?: Side | undefined; readonly counterparty?: Side | undefined; readonly marker?: RefreshMigration | undefined };
const rwBoardAccount = (s: BoardSpec): AccountReplica => {
  const base = unwrap(genesisReplica(unwrap(accountId(S, s.peer)), TERMS)), selfLeft = S < s.peer;
  const head = s.height === 0 ? base.head : { _tag: "installed" as const, height: BigInt(s.height), prevFrameHash: s.frameHash, timestamp: 1n, certificate: { parent: word(1), left: selfLeft ? s.own : s.peerHanko, right: selfLeft ? s.peerHanko : s.own } };
  return { ...base, head, dispute: { nextProofNonce: 0, ...(s.current === undefined ? {} : { current: s.current }), ...(s.counterparty === undefined ? {} : { counterparty: s.counterparty }) }, ...(s.marker === undefined ? {} : { refreshMigration: { ...s.marker } }) } as AccountReplica;
};
const ogSide = (prefix: "current" | "counterparty", d: Side | undefined): any => (d === undefined ? {} : {
  [`${prefix}DisputeProofHanko`]: d.hanko, [`${prefix}DisputeHash`]: d.hash, [`${prefix}DisputeProofBodyHash`]: d.proofBodyHash, [`${prefix}DisputeProofNonce`]: d.proofNonce, [`${prefix}DisputeProofProposerIsLeft`]: d.proposerIsLeft,
});
const ogBoardAccount = (s: BoardSpec): any => ({
  state: { leftEntity: S < s.peer ? S : s.peer, rightEntity: S < s.peer ? s.peer : S, domain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, jNonce: 0, deltas: PA("deltas"), locks: PA("locks"), swapOffers: PA("swapOffers"), pulls: PA("pulls"), requestedRebalance: PA("requestedRebalance"), requestedRebalanceFeeState: PA("requestedRebalanceFeeState"), rebalanceFeePolicies: PA("rebalanceFeePolicies") }, pendingWithdrawals: PA("pendingWithdrawals"), shadow: { rebalance: { policy: PA("rebalanceShadowPolicy"), submittedAtByToken: PA("rebalanceShadowSubmitted") } },
  status: "active", mempool: [], currentHeight: s.height, currentFrame: { height: s.height, stateHash: s.height === 0 ? "" : s.frameHash }, proofHeader: { fromEntity: S, toEntity: s.peer, nextProofNonce: 1 },
  ...(s.height === 0 ? {} : { currentFrameHanko: s.own, counterpartyFrameHanko: s.peerHanko }), ...ogSide("current", s.current), ...ogSide("counterparty", s.counterparty),
  ...(s.marker === undefined ? {} : { boardHankoRefreshMigration: { ...s.marker } }),
});
const peerHankoFor = (peer: EntityId, frameHash: string): string =>
  frameHash.length !== 66 ? pick([signLazyAccountHanko(word(9), keyOf(ALICE), peer), ""]) : peer === UE ? pick([uHanko(frameHash, [aliceAddr, carolAddr]), uHanko(frameHash, [bobAddr, carolAddr]), uHanko(frameHash, [carolAddr, bobAddr]), uHanko(word(5), [aliceAddr, bobAddr]), ""])
    : pick([signLazyAccountHanko(frameHash, keyOf(ALICE), peer), signLazyAccountHanko(frameHash, keyOf(ALICE), peer), ""]);
const randomSide = (): Side => ({ hanko: `0xd1${rword().slice(2)}`, hash: rword(), proofBodyHash: rword(), proofNonce: ri(5), proposerIsLeft: rng() < 0.5 });
const randomDispute = (): { current?: Side; counterparty?: Side } => {
  const x = randomSide(), r = rng();
  if (r < 0.45) return {};
  if (r < 0.7) return { current: x, counterparty: { ...x, hanko: `0xd2${rword().slice(2)}` } };
  return pick([{ current: x }, { counterparty: x }, { current: x, counterparty: { ...x, proofNonce: x.proofNonce + 1 } }, { current: x, counterparty: { ...x, proposerIsLeft: !x.proposerIsLeft } },
    { current: { ...x, hash: "0x12" }, counterparty: { ...x, hash: "0x12" } }, { current: { ...x, proofNonce: -1 }, counterparty: { ...x, proofNonce: -1 } }, { current: { ...x, hanko: "" }, counterparty: x }]);
};
const randomMarker = (a: { jHeight: number; logIndex: number }, height: number, frameHash: string): RefreshMigration | undefined => {
  const at = { activationJHeight: a.jHeight, activationLogIndex: a.logIndex }, r = rng();
  if (r < 0.5) return { ...at, reason: "pending" };
  if (r < 0.6) return undefined;
  if (r < 0.7) return { ...at, reason: "issued", issuedFrameHeight: height, issuedFrameHash: frameHash };
  if (r < 0.8) return { ...at, reason: "issued", issuedFrameHeight: height - 1, issuedFrameHash: frameHash };
  if (r < 0.9) return { ...at, reason: pick(["output-route-unavailable", "bilateral-frame-uncertified", "bilateral-dispute-uncertified"] as const) };
  return { activationJHeight: a.jHeight + pick([-1, 1]), activationLogIndex: a.logIndex, reason: "pending" };
};
const ownFor = (height: number, frameHash: string): string => `0x0e${height.toString(16).padStart(4, "0")}${frameHash.slice(2)}`;
const randomSpec = (peer: EntityId, a: { jHeight: number; logIndex: number }, allowUnsigned = true): BoardSpec => {
  const height = pick([0, 1, 1, 2, 5]), frameHash = rng() < 0.06 ? "0x1234" : rword();
  return { peer, height, frameHash, own: allowUnsigned && rng() < 0.05 ? "" : ownFor(height, frameHash), peerHanko: peerHankoFor(peer, frameHash), ...randomDispute(), marker: randomMarker(a, height, frameHash) };
};
const ogBoardState = (specs: readonly BoardSpec[], now: number, hooks: readonly ScheduledHook[]): any => ({
  entityId: S, height: 1, timestamp: now, config: { ...ogConfigOf([bobAddr]), jurisdiction: RJ }, certifiedBoardState: observed.ogRegistry,
  accounts: new EntityAccountCandidateMap(PersistentEntityAccountMap.fromEntries(specs.map((s) => [s.peer, ogBoardAccount(s)]), S, () => ZERO_WORD as never)),
  crontabState: { tasks: new Map(), hooks: new Map(hooks.map((h) => [h.id, structuredClone(h)])) }, paybook: { entries: new Map(), feesEarned: 0n }, reserves: new Map(),
});
const rwBoardState = (hooks: readonly ScheduledHook[]): EntityState => withCrontab(observed.state, { tasks: new Map(), hooks: new Map(hooks.map((h) => [h.id, h])) } as Crontab);
const sortedHooks = (hooks: ReadonlyMap<string, unknown>): unknown[] => [...hooks.values()].map((h) => JSON.parse(JSON.stringify(h))).sort((x, y) => (x.id < y.id ? -1 : 1));
const ogError = (f: () => unknown): string | undefined => { try { f(); return undefined; } catch (e) { return (e as Error).message; } };

describe(seedTag("rebalance-refresh: board Hanko refresh (og board-rotation-hanko-refresh.ts, board-hanko-refresh-hook.ts, j-events-board.ts)"), () => {
  test("MATCH: 150 random board_hanko_refresh hooks (cursor, markers, frame / dispute certification, peer Hankos under the certified board, >32 Accounts) -- og's outputs and proposer, hashesToSign, markers and hooks", async () => {
    const seen = new Map<string, number>(), bump = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
    for (let i = 0; i < 150; i++) {
      const a = { jHeight: 5 + ri(3), logIndex: ri(3) }, now = 2_000_000 + ri(1000);
      const peers: EntityId[] = [T, UE, ...Array.from({ length: rng() < 0.25 ? 34 : ri(3) }, (_, n) => filler(n))];
      const specs = peers.map((p) => randomSpec(p, a)).map((s) => (peers.length > 32 && rng() < 0.8 ? { ...s, marker: { activationJHeight: a.jHeight, activationLogIndex: a.logIndex, reason: "pending" as const } } : s));
      const hook: ScheduledHook = { id: "board-hanko-refresh", triggerAt: now - ri(2), type: "board_hanko_refresh", data: { activationJHeight: a.jHeight, activationLogIndex: a.logIndex, afterCounterpartyId: pick(["", "", "", T, UE, filler(0)]) } };
      const og = ogBoardState(specs, now, [hook]);
      const env: any = { quietRuntimeLogs: true, state: { timestamp: now }, infrastructure: { certifiedBoardNodes: new Map(observed.ogNodes) } };
      const ctx = { manualBroadcastInInput: false, bookIntentSlot: createBookIntentProgram().openSlot(), hashesToSign: [] as unknown[], accountChanges: new Set<string>(), candidateEffects: [], accountTxs: [] };
      let ogOut: any[] = [], ogErr: string | undefined;
      try { ogOut = await ogExecuteCrontab(env, { entityId: S, state: og } as never, og.crontabState, ctx as never); } catch (e) { ogErr = (e as Error).message; }
      const replicas = new Map(specs.map((s) => [s.peer, rwBoardAccount(s)]));
      const state = rwBoardState([hook]), rw = executeCrontab(state, replicas, now);
      expect(rw.ok ? "ok" : reasonOf(rw.error)).toBe(ogErr ?? "ok");
      if (!rw.ok) continue;
      const run = rw.value;
      expect(run.outputs).toEqual([]);
      const mine = run.sent.map((o) => {
        if (!("tx" in o)) throw new Error("the crontab sent a consensus input, not an Account input");
        const d = o.tx.data as any, route = unwrap(counterpartyProposer(state, replicas.get(o.to as EntityId) as AccountReplica, o.to as EntityId));
        expect(typeof d.frameHanko).toBe("string");
        return { entityId: o.to, signerId: route, entityTxs: [{ type: o.tx.type, data: { kind: d.kind, fromEntityId: d.fromEntityId, toEntityId: d.toEntityId, domain: d.domain, disputeConfig: d.disputeConfig,
          boardHankoRefresh: { height: Number(d.height), frameHash: d.frameHash, boardActivationJHeight: d.boardActivationJHeight, boardActivationLogIndex: d.boardActivationLogIndex,
            ...(d.disputeHanko === undefined ? {} : { disputeHanko: { hash: d.disputeHanko.hash, proofBodyHash: d.disputeHanko.proofBodyHash, proofNonce: d.disputeHanko.proofNonce, proposerIsLeft: d.disputeHanko.proposerIsLeft } }) } } }] };
      });
      expect(mine).toEqual(ogOut);
      expect(run.hashes).toEqual(ctx.hashesToSign as never);
      for (const s of specs) expect(run.accountReplicas.get(s.peer)?.refreshMigration).toEqual(og.accounts.get(s.peer).boardHankoRefreshMigration);
      const hooks = sortedHooks(crontabOf(run.state).hooks);
      expect(hooks).toEqual(sortedHooks(og.crontabState.hooks) as never);
      for (const s of specs) { const m = run.accountReplicas.get(s.peer)?.refreshMigration; if (m !== undefined && m !== s.marker) bump(m.reason); }
      for (const o of ogOut) { bump(`signer:${o.signerId}`); if (o.entityTxs[0].data.boardHankoRefresh.disputeHanko !== undefined) bump("disputeHanko"); }
      for (const h of hooks as any[]) bump(h.data.afterCounterpartyId === "" ? "retry" : "hasMore");
    }
    for (const k of ["issued", "output-route-unavailable", "bilateral-frame-uncertified", "certified-frame-invalid", "bilateral-dispute-uncertified", "certified-dispute-invalid", "disputeHanko", "retry", "hasMore", `signer:${aliceAddr.toLowerCase()}`]) expect([k, (seen.get(k) ?? 0) > 0]).toEqual([k, true]);
  }, 180_000);

  test("MATCH: 120 random BoardActivated events (our own, a peer's, an unrelated Entity's) -- og's markers, refresh and 24h counterparty hooks, messages", () => {
    const seen = new Map<string, number>(), bump = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
    for (let i = 0; i < 120; i++) {
      const target = pick([S, S, S, UE, T]), block = 5 + ri(4), log = ri(3), now = 3_000_000 + ri(1000), old = { jHeight: 4, logIndex: 0 };
      const specs = rng() < 0.15 ? [] : [T, UE, ...Array.from({ length: ri(3) }, (_, n) => filler(n))].filter(() => rng() < 0.85).map((p) => randomSpec(p, old));
      const hooks: ScheduledHook[] = rng() < 0.4 ? [{ id: "board-hanko-refresh", triggerAt: now + 5, type: "board_hanko_refresh", data: { activationJHeight: 4, activationLogIndex: 0, afterCounterpartyId: "" } }] : [];
      const event: JEvent = { type: "BoardActivated", entityId: target, previousBoardHash: BOARDS.get(target) as string, newBoardHash: word(5000 + i), previousBoardValidUntil: 1_800_000_000n, meta: meta(block, log) };
      const og = ogBoardState(specs, now, hooks);
      const env: any = { quietRuntimeLogs: true, infrastructure: { certifiedBoardNodes: new Map(observed.ogNodes) } };
      const ogErr = ogError(() => applyCertifiedBoardJEvent({ newState: og, event: toOgEvent(event), env, blockNumber: block, dirtyAccounts: new Set() } as never));
      const rw = applyBoardJEvent(rwBoardState(hooks), event, block, new Map(specs.map((s) => [s.peer, rwBoardAccount(s)])), BigInt(now));
      expect(rw.ok ? "ok" : reasonOf(rw.error)).toBe(ogErr ?? "ok");
      if (!rw.ok) continue;
      expect(rw.value.events.map((e) => e.message)).toEqual(readEntityFrameEventMessages(og));
      for (const s of specs) expect(rw.value.accountReplicas.get(s.peer)?.refreshMigration).toEqual(og.accounts.get(s.peer).boardHankoRefreshMigration);
      const after = sortedHooks(crontabOf(rw.value.state).hooks);
      expect(after).toEqual(sortedHooks(og.crontabState.hooks) as never);
      bump(target === S ? (after.length === 0 ? "local:cancelled" : "local:armed") : after.length > hooks.length ? "peer:deadline" : "peer:none");
    }
    for (const k of ["local:cancelled", "local:armed", "peer:deadline", "peer:none"]) expect([k, (seen.get(k) ?? 0) > 0]).toEqual([k, true]);
  }, 50_000);

  test("MATCH: 300 random Entity frame ends (frame advance, peer Hanko, dispute witness and marker changes) -- og scheduleChangedAccountBoardHankoRefreshes re-arms the same hook", () => {
    const seen = new Map<string, number>(), bump = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
    for (let i = 0; i < 300; i++) {
      const a = { jHeight: 5 + ri(2), logIndex: ri(2) }, now = 4_000_000 + ri(1000);
      const before = [T, UE, filler(0), filler(1)].map((p) => randomSpec(p, a, false));
      const after = before.flatMap((s): BoardSpec[] => {
        if (rng() < 0.1) return [];
        let n: BoardSpec = s;
        if (rng() < 0.15) { const height = s.height + 1, frameHash = rword(); n = { ...n, height, frameHash, own: ownFor(height, frameHash), peerHanko: peerHankoFor(s.peer, frameHash) }; }
        if (rng() < 0.08) n = { ...n, peerHanko: rng() < 0.5 ? "" : peerHankoFor(s.peer, n.frameHash) };
        if (rng() < 0.1) { const { current: _c, counterparty: _p, ...rest } = n; n = { ...rest, ...randomDispute() }; }
        if (rng() < 0.3) n = { ...n, marker: randomMarker(a, n.height, n.frameHash) };
        return [n];
      });
      const beforeOg = { accounts: new Map(before.map((s) => [s.peer, ogBoardAccount(s)])) };
      const evidence = captureAccountBoardHankoRefreshEvidence(beforeOg as never, new Set(before.map((s) => s.peer)));
      const og: any = { accounts: new Map(after.map((s) => [s.peer, ogBoardAccount(s)])), crontabState: { tasks: new Map(), hooks: new Map() }, timestamp: now };
      scheduleChangedAccountBoardHankoRefreshes(og, evidence, new Set(after.map((s) => s.peer)));
      const d = { state: rwBoardState([]), accountReplicas: new Map(after.map((s) => [s.peer, rwBoardAccount(s)])) };
      const rw = unwrap(rearmBoardRefreshes(new Map(before.map((s) => [s.peer, rwBoardAccount(s)])), d, now));
      const hooks = sortedHooks(crontabOf(rw.state).hooks);
      expect(hooks).toEqual(sortedHooks(og.crontabState.hooks) as never);
      bump(hooks.length === 0 ? "quiet" : "rearmed");
    }
    expect([(seen.get("quiet") ?? 0) > 20, (seen.get("rearmed") ?? 0) > 20]).toEqual([true, true]);
  }, 180_000);
});

// ---- lending_overdue: og collectDerivedDeadlines (loans) and settleOverdueLendingLoan through executeCrontab ----
/** og keeps a lending book only on a hub, which setHubConfig gave a config; the overdue path never reads it. */
const LENDING_HUB = { matchingStrategy: "amount", policyVersion: 1, disputeAutoFinalizeMode: "auto" };
describe(seedTag("rebalance-refresh: lending_overdue (og derived-deadlines.ts, committed-lending-close.ts settleOverdueLendingLoan)"), () => {
  test("MATCH: 300 random hub lending books (active / repaid loans, due times, missing pools and Accounts, borrowed underflow, credit in the delta and queued in the mempool) -- og's derived deadlines, lending book and revokes", async () => {
    const seen = new Map<string, number>(), bump = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
    for (let i = 0; i < 300; i++) {
      const hub = pick([ALICE, BOB, CAROL]), peers = [ALICE, BOB, CAROL].filter((p) => p !== hub) as EntityId[], now = 5_000_000 + ri(1000);
      const lim = (): bigint => pick([0n, 50n, 100n, 1_000n]);
      const accts = peers.filter(() => rng() < 0.85).map((peer) => ({ peer, tokens: [1, 3].map((t) => ({ t, left: lim(), right: lim() })), queued: rng() < 0.3 ? { t: pick([1, 3]), limit: lim(), lending: rng() < 0.5 } : undefined }));
      const pools = new Map<string, any>(), loans = new Map<string, any>();
      for (let p = 0; p < 1 + ri(3); p++) pools.set(`lend-p${p}`, { positionId: `lend-p${p}`, hubEntityId: hub, lenderEntityId: peers[0], tokenId: pick([1, 3]), principalAmount: 500n, availableAmount: BigInt(ri(300)), borrowedAmount: pick([0n, 40n, 200n, 500n]), interestBps: 100, termId: "1d", termMs: 86_400_000, createdAt: 1, updatedAt: 1, status: "open" });
      for (let l = 0; l < ri(5); l++) {
        const loanId = `loan-${i}-${l}`;
        loans.set(loanId, { requestId: `borrow-${l}`, loanId, hubEntityId: hub, borrowerEntityId: pick([...peers, word(999)]), lenderEntityId: peers[0], positionId: pick([...pools.keys(), "lend-missing"]), tokenId: pick([1, 3]), principalAmount: pick([10n, 40n, 60n, 300n]),
          interestAmount: 1n, repaymentAmount: 11n, repaidAmount: 0n, interestBps: 100, termId: "1d", termMs: 86_400_000, openedAt: 1, dueAt: now + pick([-5_000, -1, 0, 0, 1, 7_000]), updatedAt: 1, status: pick(["active", "active", "active", "repaid", "opening"]) });
      }
      const replicas = new Map(accts.map((a) => {
        const base = unwrap(genesisReplica(unwrap(accountId(hub, a.peer)), TERMS)), tk = (n: number) => unwrap(tokenId(String(n)));
        const deltas = new Map(a.tokens.map((x) => [tk(x.t), { tokenId: tk(x.t), collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: x.left, rightCreditLimit: x.right }]));
        const mempool = a.queued === undefined ? [] : [a.queued.lending ? { type: "lending_credit", action: "grant", loanId: "loan-q", hubEntityId: hub, borrowerEntityId: a.peer, tokenId: tk(a.queued.t), creditLimit: a.queued.limit } : { type: "set_credit_limit", tokenId: tk(a.queued.t), limit: a.queued.limit }];
        return [a.peer, { ...base, state: { ...base.state, account: { ...base.state.account, deltas } }, mempool } as AccountReplica];
      }));
      const ogAccts = accts.map((a) => [a.peer, { ...ogAccount(hub, { peer: a.peer, toks: [], settlePending: false }), mempool: a.queued === undefined ? [] : [a.queued.lending ? { type: "lending_credit", data: { action: "grant", loanId: "loan-q", hubEntityId: hub, borrowerEntityId: a.peer, tokenId: a.queued.t, creditLimit: a.queued.limit } } : { type: "set_credit_limit", data: { tokenId: a.queued.t, amount: a.queued.limit } }] }] as const);
      for (const [peer, acc] of ogAccts) { const a = accts.find((x) => x.peer === peer)!; acc.state.deltas = PA("deltas", a.tokens.map((x) => [x.t, { tokenId: x.t, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: x.left, rightCreditLimit: x.right, leftAllowance: 0n, rightAllowance: 0n, leftHold: 0n, rightHold: 0n }])); }
      const og: any = { entityId: hub, timestamp: now, config: ogConfigOf([aliceAddr]), accounts: new EntityAccountCandidateMap(PersistentEntityAccountMap.fromEntries(ogAccts as never, hub, () => ZERO_WORD as never)),
        hubRebalanceConfig: { ...LENDING_HUB }, lending: { pools: new Map([...pools].map(([k, v]) => [k, { ...v }])), loans: new Map([...loans].map(([k, v]) => [k, { ...v }])) }, crontabState: { tasks: new Map(), hooks: new Map() }, paybook: { entries: new Map(), feesEarned: 0n }, reserves: new Map() };
      const state = withCrontab(unwrap(createEntity({ id: hub, jurisdiction: JUR, threshold: 1n, members: new Map([[aliceAddr as never, { shares: 1n }]]), committed: { hubRebalanceConfig: { ...LENDING_HUB }, lending: { pools: new Map([...pools].map(([k, v]) => [k, { ...v }])), loans: new Map([...loans].map(([k, v]) => [k, { ...v }])) } } as never })).state, { tasks: new Map(), hooks: new Map() } as Crontab);
      expect(derivedDeadlines(state, replicas)).toEqual(ogCollectDerivedDeadlines(og) as never);
      const ctx = { manualBroadcastInInput: false, bookIntentSlot: createBookIntentProgram().openSlot(), hashesToSign: [], accountChanges: new Set<string>(), candidateEffects: [], accountTxs: [] as any[] };
      await ogExecuteCrontab({ quietRuntimeLogs: true, state: { timestamp: now } } as never, { entityId: hub, state: og } as never, og.crontabState, ctx as never);
      const run = unwrap(executeCrontab(state, replicas, now));
      expect(ogOf(run.state)["lending"]).toEqual(og.lending);
      expect(run.accountTxs.map(({ accountId: id, tx }) => { const x = tx as any; return { accountId: id, tx: { type: x.type, data: { action: x.action, loanId: x.loanId, hubEntityId: x.hubEntityId, borrowerEntityId: x.borrowerEntityId, tokenId: Number(x.tokenId), creditLimit: x.creditLimit } } }; })).toEqual(ctx.accountTxs);
      expect(run.outputs).toEqual([]);
      for (const l of og.lending.loans.values()) if (l.status === "defaulted") bump("defaulted");
      for (const l of loans.values()) if (l.status === "active" && l.dueAt <= now && og.lending.loans.get(l.loanId).status === "active") bump("dropped");
      for (const t of ctx.accountTxs) bump(t.tx.data.creditLimit > 0n ? "revoke:partial" : "revoke:zero");
    }
    for (const k of ["defaulted", "dropped", "revoke:partial", "revoke:zero"]) expect([k, (seen.get(k) ?? 0) > 3]).toEqual([k, true]);
  });
});
