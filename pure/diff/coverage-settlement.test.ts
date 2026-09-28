// Coverage: the settlement execution success path (og entity/tx/handlers/payments/settle.ts handleSettleExecute,
// prepareSettlementExecution, verifySettlementExecutionHankos, queueSettlementExecution) against live og.
// Every workspace here is signed with real lazy-Entity Hankos, so both engines go past the refusal gates and queue
// the on-chain settlement row plus the Account submit.
import { describe, expect, test } from "bun:test";
import { buildSettlementHankoDraft, handleSettleExecute } from "../../core/entity/tx/handlers/payments/settle.ts";
import { addMessage as ogAddMessage, readEntityFrameEvents } from "../../core/entity/frame-events.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import { initJBatch as ogInitJBatch } from "../../core/jurisdiction/machine/batch/index.ts";
import {
  applyEntityInput, committedView, compileOps, createEntity, foldTxs, mapSet, nextSettlementNonce, settlementTargets,
  tokenId, workspaceHashOf, zeroDelta,
  type AccountBody, type AccountReplica, type Binary, type CommittedAccountState, type EntityId, type EntityState,
  type EntityTx, type OpenEntity, type SettlementOp, type SettlementWorkspace, type WireAccountTx,
} from "../xln.ts";
import {
  ALICE, BOB, CAROL, NOW, TERMS, TEST_CONTRACTS, TEST_JREPLICA, aliceAddr, hankoVerify, keyOf, signLazyAccountHanko,
  signedTxs, unwrap, verifiers,
} from "../xln_run.ts";

// ---- seeded randomness: SEEDX overrides the fixed seed, and every failure names the seed ----
const SEED = process.env["SEEDX"] ? Number(process.env["SEEDX"]) : 0x5e771e;
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

// ---- the og side: shells over the same data ----
type OgEntity = Parameters<typeof handleSettleExecute>[0];
type OgEnv = Parameters<typeof handleSettleExecute>[2];
type OgAccount = NonNullable<ReturnType<OgEntity["accounts"]["get"]>>;
/** og's typed shells are built from plain data; this is the one place a shell is given its og type. */
const asOg = <T,>(shell: unknown): T => shell as T;
/** The J replica both engines resolve the Entity's jurisdiction "j" through. */
const JREPLICAS = new Map([["j", { ...TEST_JREPLICA, name: "j" }]]);
const OG_JURISDICTION = {
  name: "j", chainId: TERMS.domain.chainId, depositoryAddress: TERMS.domain.depositoryAddress,
  entityProviderAddress: TEST_CONTRACTS.entityProvider,
};
const ogEnv = (): OgEnv => asOg<OgEnv>({
  state: { jReplicas: new Map(JREPLICAS), eReplicas: new Map(), timestamp: Number(NOW) },
  infrastructure: {},
});
const persistent = (namespace: string, m: ReadonlyMap<unknown, unknown>): unknown =>
  PersistentAccountStateMap.fromEntries(asOg(namespace), asOg<Parameters<typeof PersistentAccountStateMap.fromEntries>[1]>(m));
/** og AccountState from the rewrite's committed view (the fields buildAccountProofBody and the settle hashes read). */
const ogAccountState = (s: CommittedAccountState): Record<string, unknown> => ({
  domain: s.domain, leftEntity: s.leftEntity, rightEntity: s.rightEntity, watchSeed: s.watchSeed,
  disputeConfig: s.disputeConfig, jNonce: s.jNonce, lastFinalizedJHeight: s.lastFinalizedJHeight,
  leftPendingJClaims: s.leftPendingJClaims, rightPendingJClaims: s.rightPendingJClaims,
  deltas: persistent("deltas", s.deltas), locks: persistent("locks", s.locks), pulls: persistent("pulls", s.pulls),
  swapOffers: persistent("swapOffers", s.swapOffers), subcontracts: persistent("subcontracts", s.subcontracts),
  lendingIntents: persistent("lendingIntents", s.lendingIntents),
  requestedRebalance: persistent("requestedRebalance", s.requestedRebalance),
  requestedRebalanceFeeState: persistent("requestedRebalanceFeeState", s.requestedRebalanceFeeState),
  rebalanceFeePolicies: persistent("rebalanceFeePolicies", s.rebalanceFeePolicies),
  ...(s.settlementWorkspace === undefined ? {} : { settlementWorkspace: structuredClone(s.settlementWorkspace) }),
});
const ogAccountOf = (child: AccountReplica): OgAccount => asOg<OgAccount>({
  state: ogAccountState(unwrap(committedView(child.state))),
  mempool: [],
  status: "active",
  proofHeader: { fromEntity: ALICE, toEntity: child.state.account.id.left === ALICE ? child.state.account.id.right : child.state.account.id.left, nextProofNonce: child.dispute.nextProofNonce },
});
const ogEntityOf = (replicas: ReadonlyMap<EntityId, AccountReplica>, jBatch: unknown, withProvider: boolean): OgEntity =>
  asOg<OgEntity>({
    entityId: ALICE,
    timestamp: Number(NOW),
    config: {
      mode: "proposer-based", threshold: 1n, validators: [aliceAddr], shares: { [aliceAddr]: 1n },
      jurisdiction: withProvider ? OG_JURISDICTION : { ...OG_JURISDICTION, entityProviderAddress: "" },
    },
    accounts: new Map([...replicas].map(([peer, child]) => [peer, ogAccountOf(child)])),
    ...(jBatch === undefined ? {} : { jBatchState: structuredClone(jBatch) }),
  });

// ---- the rewrite side: ALICE (1-of-1) with idle, funded Accounts to BOB and CAROL ----
const T1 = unwrap(tokenId("1"));
const T2 = unwrap(tokenId("2"));
const openTo = (entity: OpenEntity, peer: EntityId): OpenEntity => {
  const open: EntityTx = {
    type: "openAccount",
    data: { targetEntityId: peer, accountDomain: TERMS.domain, watchSeed: TERMS.watchSeed, disputeConfig: TERMS.disputeConfig },
  };
  const next = unwrap(applyEntityInput(entity, { kind: "txs", timestamp: NOW, txs: [open] }, { ...verifiers, self: ALICE, signerId: aliceAddr })).replica;
  if (next._tag !== "open") throw new Error(`openAccount left ALICE ${next._tag}`);
  return next;
};
/** An idle Account (og: no pendingFrame) whose token rows hold collateral on both sides. */
const funded = (child: AccountReplica): AccountReplica => {
  const deltas = new Map([
    [T1, { ...zeroDelta(T1), collateral: 1_000n, ondelta: 400n }],
    [T2, { ...zeroDelta(T2), collateral: 300n, ondelta: 100n }],
  ]);
  const account = { ...child.state.account, deltas };
  return { _tag: "open", head: child.head, dispute: child.dispute, mempool: [], state: { ...child.state, account } } as AccountReplica;
};
const baseEntity = (withConfig: boolean): OpenEntity => {
  const created = unwrap(createEntity({
    id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]),
    jurisdictionConfig: { name: "j", entityProviderAddress: TEST_CONTRACTS.entityProvider },
  }));
  // og openAccount needs config.jurisdiction at admission; an Entity without one still holds the Accounts its peers
  // opened (og createInboundAccountState), so the unconfigured base drops the config once the Accounts exist
  const opened = openTo(openTo(created, BOB), CAROL);
  const replicas = new Map([...opened.accountReplicas].map(([peer, child]) => [peer, funded(child)] as const));
  const accounts = new Map([...replicas].map(([peer, child]) => [peer, child.state.account] as const));
  const { jurisdictionConfig: _dropped, ...unconfigured } = opened.state;
  return { ...opened, accountReplicas: replicas, state: { ...(withConfig ? opened.state : unconfigured), accounts } };
};
const BASE = baseEntity(true);
const BASE_NO_CONFIG = baseEntity(false);

// ---- signed workspaces ----
const randomOps = (): SettlementOp[] => {
  const one = (): SettlementOp => {
    const tk = pick([1, 1, 2]);
    const amount = pick([1n, 5n, 40n]);
    switch (ri(5)) {
      case 0: return { type: "forgive", tokenId: tk };
      case 1: return { type: "c2r", tokenId: tk, amount };
      case 2: return { type: "r2r", tokenId: tk, amount };
      default: return { type: "r2c", tokenId: tk, amount };
    }
  };
  // a lone C2R is og's pure-C2R shortcut candidate
  if (rng() < 0.3) return [{ type: "c2r", tokenId: pick([1, 2]), amount: pick([1n, 5n]) }];
  const ops = Array.from({ length: 1 + ri(2) }, one);
  return ops.filter((op, i) => ops.findIndex((o) => o.type === op.type && o.tokenId === op.tokenId) === i);
};
/** Which part of a ready workspace a case corrupts; "none" is the success path. */
type Defect =
  | "none" | "counterparty_hanko" | "left_post_hanko" | "right_post_hanko" | "compiled_diffs" | "compiled_length"
  | "nonce_missing" | "settlement_hash" | "not_ready" | "post_nonce" | "post_hash" | "post_hanko_missing";
const DEFECTS: readonly Defect[] = [
  "none", "none", "none", "none", "none", "none", "counterparty_hanko", "left_post_hanko", "right_post_hanko",
  "compiled_diffs", "compiled_length", "nonce_missing", "settlement_hash", "not_ready", "post_nonce", "post_hash",
  "post_hanko_missing",
];
const W = (b: string): string => `0x${b.repeat(32)}`;
const sign = (digest: string, entity: string): string => signLazyAccountHanko(digest, keyOf(entity as EntityId), entity);
/** A workspace both sides signed at the Account's next safe nonce: settlement Hankos and the exact N+1 proof. */
const readyWorkspace = (child: AccountReplica, ops: readonly SettlementOp[], byLeft: boolean, executorIsLeft: boolean): SettlementWorkspace => {
  const id = child.state.account.id;
  const body = { ops, lastModifiedByLeft: byLeft, status: "awaiting_counterparty" as const, revision: 1, createdAt: 1, lastUpdatedAt: 2, executorIsLeft };
  const unsigned: SettlementWorkspace = { ...body, workspaceHash: unwrap(workspaceHashOf(id, body)) };
  const nonce = nextSettlementNonce(child);
  const t = unwrap(settlementTargets(child.state, unsigned, nonce, byLeft, { ok: true, value: TEST_CONTRACTS.deltaTransformer }));
  const compiled = unwrap(compileOps(ops, byLeft));
  return {
    ...unsigned,
    status: "ready_to_submit",
    compiledDiffs: compiled.diffs,
    compiledForgiveTokenIds: compiled.forgive,
    nonceAtSign: nonce,
    settlementHash: t.settlementHash,
    leftHanko: sign(t.settlementHash, id.left),
    rightHanko: sign(t.settlementHash, id.right),
    postSettlementDisputeProof: {
      ...t.postProof,
      leftHanko: sign(t.postProof.disputeHash, id.left),
      rightHanko: sign(t.postProof.disputeHash, id.right),
    },
  };
};
const withDefect = (w: SettlementWorkspace, defect: Defect, aliceLeft: boolean): SettlementWorkspace => {
  const proof = w.postSettlementDisputeProof;
  if (proof === undefined) throw new Error("ready workspace without a post-settlement proof");
  const forged = sign(W("99"), aliceLeft ? BOB : ALICE);
  const diffs = w.compiledDiffs ?? [];
  switch (defect) {
    case "none": return w;
    case "counterparty_hanko": return aliceLeft ? { ...w, rightHanko: forged } : { ...w, leftHanko: forged };
    case "left_post_hanko": return { ...w, postSettlementDisputeProof: { ...proof, leftHanko: sign(W("98"), ALICE) } };
    case "right_post_hanko": return { ...w, postSettlementDisputeProof: { ...proof, rightHanko: sign(W("97"), ALICE) } };
    case "compiled_diffs": return { ...w, compiledDiffs: diffs.map((d, i) => (i === 0 ? { ...d, collateralDiff: d.collateralDiff + 1n } : d)) };
    case "compiled_length": return { ...w, compiledDiffs: [...diffs, ...diffs] };
    case "nonce_missing": return { ...w, nonceAtSign: undefined };
    case "settlement_hash": return { ...w, settlementHash: W("ab") };
    case "not_ready": return { ...w, status: "awaiting_counterparty" };
    case "post_nonce": return { ...w, postSettlementDisputeProof: { ...proof, nonce: proof.nonce + 1 } };
    case "post_hash": return { ...w, postSettlementDisputeProof: { ...proof, proofBodyHash: W("cd") } };
    case "post_hanko_missing": return { ...w, postSettlementDisputeProof: { ...proof, rightHanko: undefined } };
  }
};
/** A draft jBatch the execution joins: empty, holding an unrelated or a same-pair row, or behind a sent batch. */
const randomJBatch = (peer: EntityId, aliceLeft: boolean): unknown => {
  const [left, right] = aliceLeft ? [ALICE, peer] : [peer, ALICE];
  const conflicting = { leftEntity: left, rightEntity: right, diffs: [{ tokenId: 1, leftDiff: 1n, rightDiff: 0n, collateralDiff: -1n, ondeltaDiff: -1n }], forgiveDebtsInTokenIds: [], sig: "0xaa", nonce: 1 };
  const other = { toEntity: W("77"), tokenId: 1, amount: 3n };
  const base = ogInitJBatch();
  switch (ri(6)) {
    case 0: return { ...base, status: "accumulating", batch: { ...base.batch, settlements: [conflicting] } };
    case 1: return { ...base, status: "accumulating", batch: { ...base.batch, reserveToReserve: [other] } };
    case 2: return { ...base, status: "sent", sentBatch: ogSentBatch(ogInitJBatch().batch, W("5b"), 1) };
    case 3: return base;
    default: return undefined;
  }
};

const codeOf = (m: string): string => m.split(":")[0] ?? "";
/** og buildSettlementHankoDraft over the unsigned workspace pinned at the ready one's nonce. */
const ogHankoDraft = (child: AccountReplica, ready: SettlementWorkspace, base: OpenEntity, peer: EntityId) => {
  const pinnedOnly: SettlementWorkspace = {
    workspaceHash: ready.workspaceHash, ops: ready.ops, lastModifiedByLeft: ready.lastModifiedByLeft,
    status: "awaiting_counterparty", revision: ready.revision, createdAt: ready.createdAt,
    lastUpdatedAt: ready.lastUpdatedAt, executorIsLeft: ready.executorIsLeft, nonceAtSign: ready.nonceAtSign,
  };
  const account = ogAccountOf({ ...child, state: { ...child.state, settlement: pinnedOnly } } as AccountReplica);
  const draft = buildSettlementHankoDraft(account, ogEntityOf(base.accountReplicas, undefined, true), peer, ogEnv()).tx;
  if (draft.type !== "settle_transition" || draft.data.kind !== "hanko") throw new Error("og hanko draft missing");
  return draft.data;
};
const reasonOf = (e: unknown): string => {
  const r = e as { readonly reason?: string; readonly _tag?: string };
  return r.reason ?? r._tag ?? "";
};
/** The settle_transition txs the rewrite queued on this Account, admitted or already inside its proposed frame. */
type SettleWire = Extract<WireAccountTx, { readonly type: "settle_transition" }>;
const isSettleWire = (t: WireAccountTx): t is SettleWire => t.type === "settle_transition";
const queuedSettle = (child: AccountReplica | undefined): readonly SettleWire[] => {
  if (child === undefined) return [];
  const proposed = child._tag === "proposed" ? child.candidate.frame.txs : [];
  return [...child.mempool, ...proposed].filter(isSettleWire);
};

describe("coverage-settlement: settle_execute success path (og handleSettleExecute)", () => {
  test("MATCH: 160 ready, really signed workspaces -- og's post-proof and settlement hashes are the rewrite's; same refusal code, jBatch rows, C2R shortcut, Account submit and messages as og", async () => {
    const counts = new Map<string, number>();
    const bump = (k: string): void => { counts.set(k, (counts.get(k) ?? 0) + 1); };
    for (let n = 0; n < 160; n++) {
      const peer = pick([BOB, CAROL]);
      const noConfig = rng() < 0.05;
      const base = noConfig ? BASE_NO_CONFIG : BASE;
      const child = base.accountReplicas.get(peer);
      if (child === undefined) throw new Error("fixture Account missing");
      const aliceLeft = child.state.account.id.left === ALICE;
      const ops = randomOps();
      const byLeft = rng() < 0.5;
      const compiles = compileOps(ops, byLeft);
      if (!compiles.ok) { bump("uncompilable"); continue; }
      const ready = readyWorkspace(child, ops, byLeft, aliceLeft);
      const defect = pick(DEFECTS);
      const w = withDefect(ready, defect, aliceLeft);
      const jBatch = randomJBatch(peer, aliceLeft);
      const disable = rng() < 0.3;
      const replicas = mapSet(base.accountReplicas, peer, { ...child, state: { ...child.state, settlement: w } } as AccountReplica);

      // og derives the same hashes from its own Account: the fixture signs exactly what og would ask to sign
      const ogDraft = ogHankoDraft(child, ready, base, peer);
      const { leftHanko: _left, rightHanko: _right, ...pinned } = ready.postSettlementDisputeProof ?? {};
      same(tag(n, "og settlement hash"), ogDraft.settlementHash, ready.settlementHash);
      same(tag(n, "og post proof"), ogDraft.postProof, pinned);

      const og = ogEntityOf(replicas, jBatch, !noConfig);
      const data = { counterpartyEntityId: peer, ...(disable ? { disableC2RShortcut: true } : {}) };
      const ogRun = await handleSettleExecute(og, { type: "settle_execute", data }, ogEnv(), true)
        .then((out) => ({ ok: true as const, out }), (e: unknown) => ({ ok: false as const, message: String((e as Error).message) }));
      const state: EntityState = jBatch === undefined ? base.state : withOgJb(base.state, structuredClone(jBatch));
      const rw = foldTxs(state, replicas, signedTxs(state, aliceAddr, [{ type: "settle_execute", data } as EntityTx]), { verify: hankoVerify, timestamp: NOW + 1n, jReplicas: JREPLICAS });
      if (!ogRun.ok) {
        same(tag(n, defect), rw.ok ? "accepted" : reasonOf(rw.error), ogRun.message);
        bump(`refused:${codeOf(ogRun.message)}`);
        continue;
      }
      same(tag(n, defect), rw.ok ? "ok" : reasonOf(rw.error), "ok");
      if (!rw.ok) continue;
      const folded = rw.value;
      const d = folded.draft;
      const messages = (d.events ?? []).map((e) => e.message).filter((m) => !m.startsWith("🚀 Proposed frame "));
      same(tag(n, "messages"), messages, readEntityFrameEvents(og).map((e) => e.message));
      same(tag(n, "jBatch"), ogJb(d.state) ?? null, og.jBatchState ?? null);
      const submits = queuedSettle(d.accountReplicas.get(peer)).map((t) => ({ type: t.type, data: { kind: t.kind, revision: t.revision, workspaceHash: "workspaceHash" in t ? t.workspaceHash : undefined } }));
      same(tag(n, "submit"), submits, ogRun.out.accountTxs.map((a) => a.tx));
      const batch = og.jBatchState?.batch;
      bump(ogRun.out.accountTxs.length === 0 ? "skipped" : (batch?.collateralToReserve.length ?? 0) > 0 && (batch?.settlements.length ?? 0) === 0 ? "c2r_shortcut" : "settled");
    }
    const summary = `seed=${SEED} ${JSON.stringify([...counts])}`;
    same(summary, (counts.get("settled") ?? 0) > 15, true);
    same(summary, (counts.get("skipped") ?? 0) > 0, true);
    same(summary, (counts.get("c2r_shortcut") ?? 0) > 0, true);
    same(summary, [...counts.keys()].filter((k) => k.startsWith("refused:")).length > 6, true);
  }, 120_000);
});

// ---- settlement continuations: og settle_propose's pin, selectSettlementContinuation and its collective run ----
import { handleSettlePropose } from "../../core/entity/tx/handlers/payments/settle.ts";
import { selectSettlementContinuation } from "../../core/entity/consensus/account/settlement-continuation.ts";
import { applyEntityTx as ogApplyEntityTx } from "../../core/entity/tx/apply.ts";
import { type SettlementContinuationAction, type SettlementContinuationPlan } from "../xln.ts";
import { ogJb, ogSentBatch, withOg, withOgJb } from "./og-state.ts";

type OgTx = Parameters<typeof ogApplyEntityTx>[2];
const ENTITY_IDS = [W("77"), W("0c"), BOB] as const;
/** A continuation action, sometimes malformed the way og's assertSettlementContinuation names. */
const randomAction = (): SettlementContinuationAction => {
  const tokenId = pick([1, 1, 2, -1, 1.5]);
  const amount = pick<bigint>([3n, 3n, 7n, 0n, -2n]);
  const entity = pick<string>([...ENTITY_IDS, ...ENTITY_IDS, W("0C"), "0x12"]);
  switch (ri(3)) {
    case 0: return { type: "r2r", toEntityId: entity, tokenId, amount };
    case 1: return { type: "r2e", receivingEntity: entity, tokenId, amount };
    default: return { type: "r2c", counterpartyId: entity, ...(rng() < 0.3 ? { receivingEntityId: pick([W("0c"), "0xbad"]) } : {}), tokenId, amount };
  }
};
const randomPlan = (): SettlementContinuationPlan => ({
  actions: Array.from({ length: pick([0, 1, 1, 1, 2]) }, randomAction),
  broadcast: pick<boolean>([true, false, false]),
});
const continuationsOfOg = (og: OgEntity): unknown => [...(og.settlementContinuations?.entries() ?? [])];
const continuationsOfRw = (state: EntityState): unknown =>
  state.continuations._tag === "kept" ? [...state.continuations.entries.entries()] : [];

describe("coverage-settlement: continuations (og settle_propose pin + materializeSettlementContinuation)", () => {
  test("MATCH: 200 random settle_propose continuations -- same refusal (og assertSettlementContinuation order), same pinned workspace hash, actions and broadcast flag as og", async () => {
    const counts = new Map<string, number>();
    const bump = (k: string): void => { counts.set(k, (counts.get(k) ?? 0) + 1); };
    for (let n = 0; n < 200; n++) {
      const peer = pick([BOB, CAROL]);
      const child = BASE.accountReplicas.get(peer);
      if (child === undefined) throw new Error("fixture Account missing");
      const aliceLeft = child.state.account.id.left === ALICE;
      const plan = rng() < 0.08 ? { actions: asOg<SettlementContinuationAction[]>("x"), broadcast: true } : randomPlan();
      const continuation = rng() < 0.05 ? { ...plan, broadcast: asOg<boolean>(1) } : plan;
      const already = rng() < 0.1;
      const data = {
        counterpartyEntityId: peer, ops: [{ type: "r2c" as const, tokenId: 1, amount: 5n }], continuation,
        ...(rng() < 0.15 ? { executorIsLeft: !aliceLeft } : {}), ...(rng() < 0.3 ? { memo: "m" } : {}),
      };
      const pinned = new Map(already ? [[peer as string, { workspaceHash: W("01"), actions: [], broadcast: false }]] : []);
      const og = ogEntityOf(BASE.accountReplicas, undefined, true);
      const ogState = asOg<OgEntity>({ ...og, ...(already ? { settlementContinuations: new Map(pinned) } : {}) });
      const ogRun = await handleSettlePropose(ogState, asOg({ type: "settle_propose", data: structuredClone(data) }), ogEnv(), true)
        .then(() => null, (e: unknown) => String((e as Error).message));
      const state: EntityState = already ? withOg(BASE.state, { settlementContinuations: asOg<Binary>(pinned) }) : BASE.state;
      const rw = foldTxs(state, BASE.accountReplicas, signedTxs(state, aliceAddr, [asOg<EntityTx>({ type: "settle_propose", data })]), { verify: hankoVerify, timestamp: NOW + 1n, jReplicas: JREPLICAS });
      if (ogRun !== null) {
        same(tag(n, "refusal"), rw.ok ? "accepted" : reasonOf(rw.error), ogRun);
        bump(codeOf(ogRun));
        continue;
      }
      same(tag(n, "accepted"), rw.ok ? "ok" : reasonOf(rw.error), "ok");
      if (!rw.ok) continue;
      same(tag(n, "pinned"), continuationsOfRw(rw.value.draft.state), continuationsOfOg(ogState));
      bump("pinned");
    }
    const summary = `seed=${SEED} ${JSON.stringify([...counts])}`;
    for (const k of ["pinned", "SETTLEMENT_CONTINUATION_TOKEN_INVALID", "SETTLEMENT_CONTINUATION_AMOUNT_INVALID", "SETTLEMENT_CONTINUATION_ENTITY_INVALID",
      "SETTLEMENT_CONTINUATION_ACTION_LIMIT_EXCEEDED", "SETTLEMENT_CONTINUATION_ACTIONS_INVALID", "SETTLEMENT_CONTINUATION_REQUIRES_LOCAL_EXECUTOR", "SETTLEMENT_CONTINUATION_ALREADY_PENDING"]) {
      same(`${summary} ${k}`, (counts.get(k) ?? 0) > 0, true);
    }
  }, 60_000);

  test("MATCH: 80 pinned continuations over ready workspaces -- og selectSettlementContinuation's txs run collectively (settle_execute, the action, j_broadcast): same jBatch, reserves, messages and retired continuation as og", async () => {
    const counts = new Map<string, number>();
    const bump = (k: string): void => { counts.set(k, (counts.get(k) ?? 0) + 1); };
    for (let n = 0; n < 80; n++) {
      const peer = pick([BOB, CAROL]);
      const child = BASE.accountReplicas.get(peer);
      if (child === undefined) throw new Error("fixture Account missing");
      const aliceLeft = child.state.account.id.left === ALICE;
      const ops = pick<SettlementOp[]>([[{ type: "r2c", tokenId: 1, amount: 5n }], [{ type: "c2r", tokenId: 2, amount: 3n }], [{ type: "r2r", tokenId: 1, amount: 2n }]]);
      const ready = readyWorkspace(child, ops, aliceLeft, aliceLeft);
      const action = pick<SettlementContinuationAction>([
        { type: "r2r", toEntityId: W("77"), tokenId: 1, amount: 3n },
        { type: "r2e", receivingEntity: W("0c"), tokenId: 2, amount: 4n },
        { type: "r2c", counterpartyId: peer, tokenId: 1, amount: 2n },
        { type: "r2r", toEntityId: W("77"), tokenId: 1, amount: 900n },
      ]);
      const plan = { workspaceHash: rng() < 0.1 ? W("02") : ready.workspaceHash, actions: rng() < 0.2 ? [] : [action], broadcast: rng() < 0.4 };
      const reserves = new Map([[1, 500n], [2, 500n]]);
      const replicas = mapSet(BASE.accountReplicas, peer, { ...child, state: { ...child.state, settlement: ready } } as AccountReplica);
      const seeded = withOg(BASE.state, { reserves: asOg<Binary>(reserves), settlementContinuations: asOg<Binary>(new Map([[peer as string, plan]])) });
      const rw = foldTxs(seeded, replicas, [], { verify: hankoVerify, timestamp: NOW + 1n, jReplicas: JREPLICAS });

      const og = asOg<OgEntity>({ ...ogEntityOf(replicas, undefined, true), reserves: new Map(reserves), settlementContinuations: new Map([[peer, structuredClone(plan)]]) });
      const disposition = selectSettlementContinuation(og);
      const ogRun = await runOgDisposition(og, disposition);
      if (ogRun !== null) {
        same(tag(n, "refusal"), rw.ok ? "accepted" : reasonOf(rw.error), ogRun);
        bump(`refused:${codeOf(ogRun)}`);
        continue;
      }
      same(tag(n, "accepted"), rw.ok ? "ok" : reasonOf(rw.error), "ok");
      if (!rw.ok) continue;
      const d = rw.value.draft;
      const messages = (d.events ?? []).map((e) => e.message).filter((m) => !m.startsWith("🚀 Proposed frame "));
      same(tag(n, "messages"), messages, readEntityFrameEvents(og).map((e) => e.message));
      same(tag(n, "continuations"), continuationsOfRw(d.state), continuationsOfOg(og));
      same(tag(n, "reserves"), d.state.committed["reserves"] ?? null, og.reserves ?? null);
      same(tag(n, "jBatch"), sealedView(ogJb(d.state)), sealedView(og.jBatchState));
      bump(`${disposition.kind}${plan.broadcast ? "+broadcast" : ""}`);
    }
    const summary = `seed=${SEED} ${JSON.stringify([...counts])}`;
    for (const k of ["execute", "execute+broadcast", "discard"]) same(`${summary} ${k}`, [...counts.keys()].some((c) => c.startsWith(k)), true);
  }, 60_000);
});

/** og materializeSettlementContinuation for one disposition: the discard note, or the txs in order on the mutable state. */
const runOgDisposition = async (og: OgEntity, disposition: ReturnType<typeof selectSettlementContinuation>): Promise<string | null> => {
  if (disposition.kind === "none" || disposition.kind === "wait") return null;
  if (disposition.kind === "discard") {
    og.settlementContinuations?.delete(disposition.counterpartyId);
    ogAddMessage(og, `Settlement continuation cleared: ${disposition.reason.replaceAll("_", " ")}`);
    return null;
  }
  const env = ogEnv();
  const step = async (i: number): Promise<string | null> => {
    const tx = disposition.txs[i];
    if (tx === undefined) return null;
    const failed = await ogApplyEntityTx(env, og, tx as OgTx, { mutableFrameState: true })
      .then((r) => r.skippedError ?? null, (e: unknown) => String((e as Error).message));
    return failed ?? step(i + 1);
  };
  const failed = await step(0);
  if (failed === null) og.settlementContinuations?.delete(disposition.counterpartyId);
  return failed;
};
/** The jBatch fields a continuation decides (the sealed batch's timestamps are the frame's). */
const sealedView = (jb: unknown): unknown => {
  if (jb === undefined || jb === null) return null;
  const { lastBroadcast: _at, sentBatch, ...rest } = jb as { lastBroadcast?: unknown; sentBatch?: Record<string, unknown> };
  if (sentBatch === undefined) return rest;
  const { firstSubmittedAt: _first, lastSubmittedAt: _last, ...sent } = sentBatch;
  return { ...rest, sentBatch: sent };
};
