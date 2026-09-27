// Behavioural diff: og Account admission timing (core/account/input/local-tx-admission.ts) and the hub order book inside
// entity consensus (core/entity/consensus/frame/application.ts) vs pure/xln.ts. Every test is MATCH and runs og live.
import { describe, expect, test } from "bun:test";
import { seedOf, seedTag, untilCovered } from "./seed.ts";

// ---- og ----
import { applyAccountEnqueue } from "../../core/account/input/local-tx-admission.ts";
import { computeAccountStateRoot } from "../../core/account/commitment/state-root.ts";
import { createEmptyAccountJClaimAccumulator } from "../../core/account/j-claims/j-claim-accumulator.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import { createEmptyEnv } from "../../core/runtime.ts";
import { createAccountConsensusContext } from "../../core/entity/account/account-consensus-context.ts";
import { assertProposeAccountsNowMatchesState } from "../../core/entity/consensus/account/propose-accounts-now-validation.ts";
import { handleProposeAccountsNowEntityTx } from "../../core/entity/tx/handlers/account/propose-accounts-now.ts";
import { handleInitOrderbookExtEntityTx } from "../../core/entity/tx/handlers/system/basic.ts";
import { computeCanonicalEntityConsensusStateHash, computeEntityAccountValueHash } from "../../core/entity/consensus/state-root.ts";
import { PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { PersistentEntityCollectionMap } from "../../core/entity/state/persistent-collection-map.ts";
import * as ogBook from "../../core/orderbook/core.ts";
import { computeBookCommitmentHash } from "../../core/orderbook/commitment.ts";
import { rebuildOrderbookPairIndex } from "../../core/orderbook/order-index.ts";
import { getSwapExactQuoteLotMultipleAtPriceForDimensions } from "../../core/orderbook/types.ts";
import { markWorkingOrderbookOffer, normalizeSwapOfferForOrderbook } from "../../core/orderbook/swap-execution.ts";
import { processOrderbookSwaps as ogProcessSwaps } from "../../core/entity/tx/handlers/account/orderbook/index.ts";
import { processOrderbookCancels as ogProcessCancels } from "../../core/entity/tx/handlers/account/orderbook/cancels.ts";
import { applyCommittedSwapCancelsToOrderbook } from "../../core/orderbook/cross-j/orderbook.ts";
import type { AccountReplica as OgReplica, AccountTx as OgTx } from "../../core/types/account.ts";

// ---- rewrite ----
import {
  admit, admitAt, applyBookCommand, applyCommittedSwapCancels, applyEntityInput, applyRuntime, bookCommitmentHash, bookOrders, convertOutput, createBook, createEntity, createRuntime, entityRootOf, offersForMatching, pendingAccountInput,
  processOrderbookCancels, processOrderbookSwaps, tradesMatched, foldTxs, replicaId, replicaKey, spawn, tokenId, wireOf, wireTx, type EntityInput, type EntityOutput, type EntityReplica, type AccountReplica, type Book, type BookTx, type Hub, type HubAccount, type OrderbookExt, type PairDimensions, type SwapOffer, type SwapOfferEvent, type SwapRef, type EntityId, type EntityTx, type WireAccountTx } from "../xln.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, aliceAddr, bobAddr, carolAddr, genesisAB, partyIn, unwrap, verifiers, withTestJurisdiction } from "../xln_run.ts";

const prng = (base: number) => { let seed = seedOf(base); return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const rng = prng(0xb00c_ad);
const ri = (n: number) => Math.floor(rng() * n);
const pick = <X,>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
const W = (b: string) => `0x${b.repeat(32)}`;
const T = (n: number) => unwrap(tokenId(String(n)));
const LEFT = partyIn(genesisAB(), ALICE).left ? ALICE : BOB, RIGHT = LEFT === ALICE ? BOB : ALICE;

// ============ og fixture (as diff/account-consensus.test.ts, with the rewrite's pair as its entities) ============
const ogDomain = { chainId: 31_337, depositoryAddress: `0x${"44".repeat(20)}` };
const ogAccount = (local: string, peer: string, lastFinalizedJHeight = 0): OgReplica => {
  const a = {
    state: {
      leftEntity: local < peer ? local : peer, rightEntity: local < peer ? peer : local, domain: { ...ogDomain }, watchSeed: W("33"),
      deltas: PersistentAccountStateMap.empty("deltas"), locks: PersistentAccountStateMap.empty("locks"), swapOffers: PersistentAccountStateMap.empty("swapOffers"),
      pulls: PersistentAccountStateMap.empty("pulls"), leftPendingJClaims: createEmptyAccountJClaimAccumulator(), rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight, disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 }, jNonce: 0,
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
const env = createEmptyEnv("book-admission");
env.quietRuntimeLogs = true;
const store = createAccountConsensusContext(env).jClaimNodeStore;
type OgRun = { readonly ok: true; readonly mempool: readonly unknown[] } | { readonly ok: false };
const ogEnqueue = (a: OgReplica, txs: readonly OgTx[]): OgRun => {
  try {
    const r = applyAccountEnqueue(a, { kind: "enqueue", txs: [...txs] }, store);
    return r.ok ? { ok: true, mempool: a.mempool } : { ok: false };
  } catch { return { ok: false }; }
};

// ============ random txs: rewrite shape, og wire via the rewrite's own og projection ============
const offer = (i: number): WireAccountTx => ({ type: "swap_offer", offerId: `o${i}`, giveTokenId: T(1), giveTokenDecimals: 18, giveAmount: BigInt(ri(5)) * 10n ** 15n, wantTokenId: T(pick([1, 2])), wantTokenDecimals: 18,
  wantAmount: BigInt(1 + ri(9)) * 10n ** 15n, maxFee: 0n, minNetReceive: BigInt(ri(3)), ...(ri(2) === 0 ? { priceTicks: BigInt(ri(99_999)) } : {}) }) as WireAccountTx;
const randomTx = (i: number): WireAccountTx => pick<() => WireAccountTx>([
  () => ({ type: "payment", tokenId: T(1 + ri(2)), amount: BigInt(ri(4)) * 10n ** 18n, route: [pick([LEFT, RIGHT])] }) as WireAccountTx,
  () => ({ type: "set_credit_limit", tokenId: T(1 + ri(2)), limit: BigInt(ri(3)) }) as WireAccountTx,
  () => ({ type: "add_delta", tokenId: T(1 + ri(3)) }) as WireAccountTx,
  () => offer(ri(3)),
  () => ({ type: "swap_cancel_request", offerId: `o${ri(3)}` }) as WireAccountTx,
  () => ({ type: "swap_resolve", offerId: `o${ri(3)}`, fillRatio: ri(70_000), cancelRemainder: ri(2) === 0 }) as WireAccountTx,
  () => ({ type: "htlc_lock", lockId: `l${ri(2)}`, hashlock: W("ab"), timelock: BigInt(ri(3)), revealBeforeHeight: BigInt(ri(3)), amount: BigInt(ri(3)), tokenId: T(1) }) as WireAccountTx,
  () => ({ type: "rebalance_policy", tokenId: T(1), policyVersion: pick([0, 1, 2, -1, 1.5]), baseFee: 0n, liquidityFeeBps: 0n, gasFee: 0n }) as WireAccountTx,
])();
const ogOf = (r: AccountReplica, self: EntityId, tx: WireAccountTx): OgTx => unwrap(wireTx(tx, replicaId(r), partyIn(r, self).left)) as unknown as OgTx;

describe(seedTag("book-admission: og applyAccountEnqueue timing (local-tx-admission.ts)"), () => {
  test("MATCH: 300 random batches (unfunded payments, malformed swaps, expired HTLCs, repeated lifecycle txs): og queues without validation, dedups lifecycle payloads against mempool, keeps payment multiplicity, refuses the whole batch only on policyVersion", () => {
    let refused = 0, deduped = 0;
    for (let n = 0; n < 300; n++) {
      const self = pick([ALICE, BOB]), peer = self === ALICE ? BOB : ALICE;
      const og = ogAccount(self, peer);
      let rw: AccountReplica = genesisAB();
      for (let b = 0; b < 3; b++) {
        const batch = Array.from({ length: 1 + ri(4) }, (_, i) => randomTx(i));
        const o = ogEnqueue(og, batch.map((tx) => ogOf(rw, self, tx)));
        const r = admit(rw, batch, self);
        expect(r.ok).toBe(o.ok);
        if (!o.ok || !r.ok) { refused++; continue; }
        if (r.value.mempool.length - rw.mempool.length < batch.length) deduped++;
        rw = r.value;
        expect(rw.mempool.map((tx) => ogOf(rw, self, tx))).toEqual(o.mempool as never);
      }
    }
    expect(refused).toBeGreaterThan(20);
    expect(deduped).toBeGreaterThan(20);
  });

  test("MATCH: the Entity lane (admitAt) queues the same bytes; a frozen Account silently takes nothing (og shouldSuppressReturnedAccountTx)", () => {
    for (let n = 0; n < 60; n++) {
      const batch = Array.from({ length: 1 + ri(3) }, (_, i) => randomTx(i)).filter((tx) => tx.type !== "rebalance_policy");
      const og = ogAccount(ALICE, BOB), rw = genesisAB();
      const o = ogEnqueue(og, batch.map((tx) => ogOf(rw, ALICE, tx)));
      const r = unwrap(admitAt(rw, batch, ALICE));
      expect(o.ok).toBe(true);
      if (o.ok) expect(r.mempool.map((tx) => ogOf(rw, ALICE, tx))).toEqual(o.mempool as never);
    }
    const frozen = { ...genesisAB(), _tag: "disputed" } as unknown as AccountReplica;
    expect(unwrap(admitAt(frozen, [randomTx(0)], ALICE))).toBe(frozen);
    expect(admitAt(genesisAB(), [randomTx(0)], CAROL).ok).toBe(false);
  });

  test("MATCH: j_event_claim admission (og planAccountJClaimLocalAdmission): at or below the finalized height is a duplicate, the same queued claim is a duplicate, a different queued claim at that height is a row conflict; malformed events refuse the batch", () => {
    const claimRw = (h: number, blk: string, nonce: number, tokens: readonly number[]): WireAccountTx => ({ type: "j_event_claim", jHeight: BigInt(h), jBlockHash: blk, observedAt: 1n, events: tokens.length === 0 ? [] : [{ left: LEFT, right: RIGHT, nonce: BigInt(nonce),
      tokens: tokens.map((t, i) => ({ tokenId: BigInt(t), leftReserve: 0n, rightReserve: 0n, collateral: BigInt(t * 3), ondelta: 1n, ...(tokens.length > 1 ? { eventIndex: tokens.length - 1 - i } : {}) })) }] }) as unknown as WireAccountTx;
    const claimOg = (h: number, blk: string, nonce: number, tokens: readonly number[]): OgTx => ({ type: "j_event_claim", data: { jHeight: h, jBlockHash: blk, events: tokens.map((t, i) => ({ ...(tokens.length > 1 ? { eventIndex: tokens.length - 1 - i } : {}), type: "AccountSettled",
      data: { leftEntity: LEFT, rightEntity: RIGHT, tokenId: t, leftReserve: "0", rightReserve: "0", collateral: String(t * 3), ondelta: "1", nonce } })) } }) as unknown as OgTx;
    let conflicts = 0, dups = 0, bad = 0;
    for (let n = 0; n < 200; n++) {
      const self = pick([ALICE, BOB]), peer = self === ALICE ? BOB : ALICE, fin = ri(2);
      const og = ogAccount(self, peer, fin);
      let rw: AccountReplica = genesisAB();
      rw = { ...rw, state: { ...rw.state, finalizedJHeight: BigInt(fin) } } as AccountReplica;
      for (let b = 0; b < 2; b++) {
        const cases = Array.from({ length: 1 + ri(3) }, () => ({ h: 1 + ri(3), blk: W(pick(["0a", "0b"])), nonce: ri(2), tokens: ri(12) === 0 ? [] : [1 + ri(2)] }));
        const o = ogEnqueue(og, cases.map((c) => claimOg(c.h, c.blk, c.nonce, c.tokens)));
        const r = admit(rw, cases.map((c) => claimRw(c.h, c.blk, c.nonce, c.tokens)), self);
        expect(r.ok).toBe(o.ok);
        if (!o.ok || !r.ok) { bad++; continue; }
        const added = r.value.mempool.length - rw.mempool.length;
        if (added < cases.length) (cases.some((c) => c.h <= fin) ? dups++ : conflicts++);
        rw = r.value;
        expect<unknown>(rw.mempool.map((tx) => (tx.type === "j_event_claim" ? [Number(tx.jHeight), tx.jBlockHash] : []))).toEqual(o.mempool.map((tx) => [(tx as { data: { jHeight: number } }).data.jHeight, (tx as { data: { jBlockHash: string } }).data.jBlockHash]));
      }
    }
    expect(conflicts).toBeGreaterThan(10);
    expect(dups).toBeGreaterThan(10);
    expect(bad).toBeGreaterThan(5);
  });
});

// ============ og proposeAccountsNow (entity/tx/handlers/account/propose-accounts-now.ts) ============
describe(seedTag("book-admission: proposeAccountsNow re-emits og pendingAccountInput bytes"), () => {
  const ctx = { ...verifiers, self: ALICE, signerId: aliceAddr };
  const ogState = (accounts: ReadonlyMap<string, unknown>) => ({ entityId: ALICE, height: 0, prevFrameHash: "", config: { validators: [aliceAddr], shares: { [aliceAddr]: 1n }, threshold: 1n, mode: "proposer-based" }, accounts }) as never;
  const marker = (data: object): EntityTx => ({ type: "proposeAccountsNow", data } as EntityTx);
  const alone = () => unwrap(createEntity({ id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]) }));
  test("MATCH: 300 random markers: og assertProposeAccountsNowMatchesState throws iff the rewrite refuses the whole input, with og's code", () => {
    const ids = [BOB, CAROL, W("0d"), W("0e")].map((x) => x.toLowerCase()).sort();
    const opened = unwrap(applyEntityInput(alone(), { kind: "txs", timestamp: NOW, txs: [] }, ctx)).replica;
    let refused = 0, accepted = 0;
    for (let i = 0; i < 300; i++) {
      const n = pick([0, 1, 2, 3, 1001]);
      let cps: unknown[] = n === 1001 ? Array.from({ length: 1001 }, (_, k) => `0x${k.toString(16).padStart(64, "0")}`) : Array.from({ length: n }, () => pick(ids));
      if (n < 1001 && ri(2) === 0) cps = [...new Set(cps as string[])].sort();
      if (ri(10) === 0) cps = cps.map((c) => (typeof c === "string" ? c.toUpperCase().replace("0X", "0x") : c));
      if (ri(15) === 0) cps = [...cps, 7];
      if (ri(15) === 0) cps = ["", ...cps];
      const data = { version: pick([1, 1, 1, 2]), proposerSignerId: pick([aliceAddr, aliceAddr.toUpperCase().replace("0X", "0x"), bobAddr]), counterparties: cps };
      let og: string | undefined;
      try { assertProposeAccountsNowMatchesState(ogState(new Map()), { type: "proposeAccountsNow", data } as never); } catch (e) { og = (e as Error).message; }
      const rw = applyEntityInput(opened, { kind: "txs", timestamp: NOW + 1n, txs: [marker(data)] }, ctx);
      if (og !== undefined) {
        refused++;
        expect(rw.ok).toBe(false);
        if (!rw.ok) expect(rw.error).toEqual({ _tag: "entity_invariant", reason: og } as never);
      } else {
        accepted++;
        expect(rw.ok).toBe(true);
        if (rw.ok) expect(rw.value.outputs).toEqual([]);
      }
    }
    expect(refused).toBeGreaterThan(50);
    expect(accepted).toBeGreaterThan(30);
  });

  test("MATCH: a proposed Account re-emits the exact ack_frame it sent (og cloneIsolatedAccountInput(pendingAccountInput)); an Account without one is owed nothing", () => {
    const openBob: EntityTx = { type: "openAccount", data: { targetEntityId: BOB, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig } } };
    const first = unwrap(applyEntityInput(alone(), { kind: "txs", timestamp: NOW, txs: [openBob] }, ctx));
    const sent = first.outputs.filter((o) => "tx" in o && o.tx.data.kind === "ack_frame");
    expect(sent.length).toBe(1);
    const child = first.replica.accountReplicas.get(BOB);
    expect(child?._tag).toBe("proposed");
    expect(pendingAccountInput(child as AccountReplica, ALICE)).toEqual((sent[0] as { tx: { data: unknown } }).tx.data as never);
    // og: the handler hands back a clone of the retained bytes for every listed counterparty holding one, in list order
    const ogPending = { kind: "ack_frame", fromEntityId: ALICE, toEntityId: BOB, domain: ogDomain, disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 }, watchSeed: W("33"),
      proposal: { frame: { height: 1, timestamp: 1, jHeight: 0, accountTxs: [], prevFrameHash: "genesis", accountStateRoot: W("01"), stateHash: W("02") } } };
    const listed = [BOB, CAROL].map((x) => x.toLowerCase()).sort();
    const og = handleProposeAccountsNowEntityTx(ogState(new Map([[BOB.toLowerCase(), { pendingAccountInput: ogPending }], [CAROL.toLowerCase(), {}]])), { type: "proposeAccountsNow", data: { version: 1, proposerSignerId: aliceAddr, counterparties: listed } } as never);
    expect<unknown>(og.accountInputWorks.map((w) => [w.accountId, w.force, w.response])).toEqual([[BOB.toLowerCase(), true, ogPending]]);
    const again = unwrap(applyEntityInput(first.replica, { kind: "txs", timestamp: NOW + 1n, txs: [marker({ version: 1, proposerSignerId: aliceAddr, counterparties: listed })] }, ctx));
    expect<readonly unknown[]>(again.outputs.filter((o) => "tx" in o)).toEqual(sent);
    expect(again.replica.accountReplicas.get(BOB)).toEqual(child);
  });
});

// ============ og initOrderbookExt (system/basic.ts) and the orderbookExt root section (state-root.ts) ============
describe(seedTag("book-admission: orderbookExt state, init and root projection"), () => {
  const ctx = { ...verifiers, self: ALICE, signerId: aliceAddr };
  const alone = () => unwrap(createEntity({ id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]) }));
  const spread = () => { const p = Array.from({ length: 5 }, () => ri(4000)); if (ri(3) > 0) p[4] = 10_000 - (p[0]! + p[1]! + p[2]! + p[3]!); return { makerBps: p[0]!, takerBps: p[1]!, hubBps: p[2]!, makerReferrerBps: p[3]!, takerReferrerBps: p[4]! }; };
  const initData = () => ({ name: `hub-${ri(99)}`, spreadDistribution: spread(), referenceTokenId: pick([1, 2, 3]), usdQuoteAuthorityEntityId: pick([W("ab"), W("AB").replace("0X", "0x"), "0x12", "", W("cd")]), minTradeSize: BigInt(ri(1e6)), supportedPairs: pick([[], ["1/2"], ["1/2", "1/3"]]) });
  test("MATCH: 200 random initOrderbookExt txs: og handleInitOrderbookExtEntityTx no-op / halt / hubProfile equals the rewrite's", () => {
    const base = unwrap(applyEntityInput(alone(), { kind: "txs", timestamp: NOW, txs: [] }, ctx)).replica;
    const kinds = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const data = initData(), tx = { type: "initOrderbookExt", data } as EntityTx;
      let og: ReturnType<typeof handleInitOrderbookExtEntityTx> | Error;
      try { og = handleInitOrderbookExtEntityTx({ entityId: ALICE } as never, { type: "initOrderbookExt", data } as never, true); } catch (e) { og = e as Error; }
      const rw = applyEntityInput(base, { kind: "txs", timestamp: NOW + 1n, txs: [tx] }, ctx);
      if (og instanceof Error) {
        kinds.add("halt");
        expect([i, og.message, rw.ok]).toEqual([i, og.message, false]);
        if (!rw.ok) expect([i, rw.error]).toEqual([i, { _tag: "entity_invariant", reason: og.message } as never]);
        continue;
      }
      expect([i, rw.ok]).toEqual([i, true]);
      if (!rw.ok) continue;
      const ext = rw.value.replica.state.orderbookExt;
      if (og.newState.orderbookExt === undefined) { kinds.add("noop"); expect(ext).toBeUndefined(); continue; }
      kinds.add("init");
      expect(ext?.hubProfile).toEqual(og.newState.orderbookExt.hubProfile as never);
      expect([ext?.books.size, ext?.pairDimensions.size, ext?.referrals.size]).toEqual([0, 0, 0]);
      // a second init is a no-op on both sides
      const again = unwrap(applyEntityInput(rw.value.replica, { kind: "txs", timestamp: NOW + 2n, txs: [{ type: "initOrderbookExt", data: initData() } as EntityTx] }, ctx));
      expect(again.replica.state.orderbookExt).toBe(ext);
      expect(handleInitOrderbookExtEntityTx(og.newState as never, { type: "initOrderbookExt", data: initData() } as never).newState).toBe(og.newState as never);
    }
    expect([...kinds].sort()).toEqual(["halt", "init", "noop"]);
  });

  test("MATCH: 40 random orderbookExt states (books driven by random commands, pairDimensions, hubProfile) == og computeCanonicalEntityConsensusStateHash", () => {
    const r = alone();
    const og0 = { entityId: r.state.id, height: 0, timestamp: Number(r.state.timestamp), config: { mode: "proposer-based", threshold: 1n, validators: [aliceAddr], shares: { [aliceAddr]: 1n } },
      accounts: PersistentEntityAccountMap.fromEntries([], r.state.id, computeEntityAccountValueHash), paybook: { entries: PersistentEntityCollectionMap.empty("paybookHashlock"), feesEarned: 0n } };
    expect(unwrap(entityRootOf(r.state, r.accountReplicas))).toBe(computeCanonicalEntityConsensusStateHash(og0 as never));
    const roots = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const hubProfile = { entityId: ALICE, name: `hub${i}`, spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 }, referenceTokenId: 1, usdQuoteAuthorityEntityId: W("ab"), minTradeSize: BigInt(ri(100)), supportedPairs: ["1/2"] };
      const ogBooks = new Map<string, unknown>(), rwBooks = new Map<string, Book>(), dims = new Map<string, PairDimensions>();
      for (const pair of ["1/2", "1/3", "4/1"].slice(0, ri(4))) {
        const params = { bucketWidthTicks: BigInt(pick([1, 10, 10_000])), maxOrders: 10_000, stpPolicy: 1 as const };
        let og = ogBook.createBook(params), rw = unwrap(createBook(params));
        for (let k = ri(12); k > 0; k--) {
          const cmd = { kind: 0 as const, ownerId: pick(["a", "b", "c"]), orderId: `o${i}-${k}`, side: ri(2) as 0 | 1, tif: 0 as const, postOnly: false, priceTicks: BigInt(95 + ri(10)), qtyLots: BigInt(1 + ri(9)) };
          og = ogBook.applyCommand(og, cmd).state; rw = unwrap(applyBookCommand(rw, cmd)).state;
        }
        ogBooks.set(pair, og); rwBooks.set(pair, rw);
        if (ri(2) === 0) dims.set(pair, { baseTokenDecimals: pick([6, 18]), quoteTokenDecimals: pick([6, 18]) });
      }
      const rwState = { ...r.state, orderbookExt: { books: rwBooks, pairDimensions: dims, referrals: new Map(), hubProfile } };
      const ogState = { ...og0, orderbookExt: { books: ogBooks, orderPairs: new Map(), pairDimensions: new Map(dims), referrals: new Map(), hubProfile } };
      const root = unwrap(entityRootOf(rwState, r.accountReplicas));
      expect([i, root]).toEqual([i, computeCanonicalEntityConsensusStateHash(ogState as never)]);
      roots.add(root);
    }
    expect(roots.size).toBeGreaterThan(30);
  });
});

// ============ og same-j hub matcher (entity/tx/handlers/account/orderbook/*, orderbook/cross-j/orderbook.ts) ============
describe(seedTag("book-admission: same-j hub matcher"), () => {
  const HUB = W("aa"), USERS = [W("0b"), W("cc"), W("0d"), W("ee")];
  const PAIRS = [{ base: 2, quote: 1, bd: 18, qd: 6, mid: 25_000_000n }, { base: 4, quote: 1, bd: 6, qd: 6, mid: 1_200n }, { base: 7, quote: 8, bd: 6, qd: 6, mid: 5_000n }];
  const lotOf = (d: number) => 10n ** BigInt(Math.max(0, d - 6));
  const quoteAt = (bd: number, qd: number, base: bigint, price: bigint) => (base * price * 10n ** BigInt(qd)) / (10_000n * 10n ** BigInt(bd));
  const toOgTx = (tx: WireAccountTx) => { const { type, ...data } = wireOf(tx) as { type: string }; return { type, data }; };
  const toOgOffer = (o: SwapOffer) => ({ ...o, giveTokenId: Number(o.giveTokenId), wantTokenId: Number(o.wantTokenId) });
  const run = <X,>(f: () => X): X | Error => { try { return f(); } catch (e) { return e as Error; } };
  const leftOf = (u: string) => (u < HUB ? u : HUB), rightOf = (u: string) => (u < HUB ? HUB : u);
  type Truth = { offers: Map<string, Map<string, SwapOffer>>; mempool: Map<string, WireAccountTx[]>; active: Map<string, boolean> };
  const rwHub = (t: Truth, ext: OrderbookExt, takerFeeBps: number): Hub => ({ id: HUB, ext, takerFeeBps, accounts: new Map(USERS.map((u): [string, HubAccount] => [u, { active: t.active.get(u)!, left: leftOf(u), right: rightOf(u), offers: t.offers.get(u)!, queued: t.mempool.get(u)! }])) });
  const ogHub = (t: Truth, ext: any, takerFeeBps: number): any => ({
    entityId: HUB, hubRebalanceConfig: { swapTakerFeeBps: takerFeeBps }, orderbookExt: ext,
    accounts: new Map(USERS.map((u) => [u, { status: t.active.get(u) ? "active" : "disputed", mempool: t.mempool.get(u)!.map(toOgTx), state: { leftEntity: leftOf(u), rightEntity: rightOf(u), swapOffers: new Map([...t.offers.get(u)!].map(([id, o]) => [id, toOgOffer(o)])) } }])),
  });
  const sameBooks = (i: string, rw: OrderbookExt, og: any) => {
    expect([i, [...rw.books.keys()].sort()]).toEqual([i, [...og.books.keys()].sort()]);
    for (const [pairId, book] of rw.books) {
      expect([i, pairId, bookCommitmentHash(book)]).toEqual([i, pairId, computeBookCommitmentHash(og.books.get(pairId))]);
      expect(bookOrders(book).map((o) => [o.orderId, o.qtyLots])).toEqual(ogBook.getBookOrders(og.books.get(pairId)).map((o: any) => [o.orderId, o.qtyLots]));
    }
    expect([i, [...rw.pairDimensions].sort()]).toEqual([i, [...og.pairDimensions].sort()]);
  };
  const sameTxs = (i: string, rw: readonly BookTx[], og: readonly { accountId: string; tx: unknown }[]) =>
    expect<unknown>([i, rw.map(({ accountId, tx }) => ({ accountId, tx: toOgTx(tx) }))]).toEqual([i, og.map(({ accountId, tx }) => ({ accountId, tx }))]);
  const sameHalt = (i: string, og: Error, rw: { ok: boolean; error?: unknown }) => expect([i, rw.ok ? "ok" : (rw.error as { reason: string }).reason]).toEqual([i, og.message]);

  test("MATCH: 40 random hub streams (offers, fills, STP, bands, fees, dimensions, cancels, committed removals, resume): same resolves, books and pair dimensions", () => {
    const comments = new Map<string, number>();
    let halts = 0, fills = 0, resumes = 0, cancelTxs = 0, matchedTrades = 0, streams = 0;
    const commentKinds = ["fill", "outside-anchor-band", "STP", "fee-authorization-exceeded", "quote-lot-misaligned", "pair-decimals-mismatch"];
    const covered = () => fills > 50 && matchedTrades > 20 && cancelTxs > 5 && resumes > 5 && commentKinds.every((c) => (comments.get(c) ?? 0) > 0);
    for (let s = 0, more = untilCovered(40, covered); more(s); s++) {
      streams++;
      const takerFeeBps = pick([0, 0, 5, 30, 10_000]);
      const hubProfile = { entityId: HUB, name: "hub", spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 }, referenceTokenId: 1, usdQuoteAuthorityEntityId: pick([...USERS, W("99")]), minTradeSize: pick([0n, 0n, 1_000n]), supportedPairs: [] };
      let rwExt: OrderbookExt = { books: new Map(), pairDimensions: new Map(), referrals: new Map(), hubProfile };
      const ogExt: any = { books: new Map(), orderPairs: new Map(), pairDimensions: new Map(), referrals: new Map(), hubProfile };
      const t: Truth = { offers: new Map(USERS.map((u) => [u, new Map()])), mempool: new Map(USERS.map((u) => [u, []])), active: new Map(USERS.map((u) => [u, ri(12) > 0])) };
      let n = 0;
      scenario: for (let pass = 0; pass < 8; pass++) {
        const tag = `${s}/${pass}`;
        // 1. committed removals: queued resolves commit (offer and resolve leave the Account), plus a few maker cancels
        const cancelled: SwapRef[] = [];
        for (const u of USERS) for (const [id] of [...t.offers.get(u)!]) {
          const resolving = t.mempool.get(u)!.some((tx) => tx.type === "swap_resolve" && tx.offerId === id);
          if ((resolving && ri(3) > 0) || ri(20) === 0) { t.offers.get(u)!.delete(id); cancelled.push({ offerId: id, accountId: u }); }
        }
        for (const u of USERS) t.mempool.set(u, t.mempool.get(u)!.filter((tx) => tx.type !== "swap_resolve" || t.offers.get(u)!.has(tx.offerId)));
        const ogResume = run(() => applyCommittedSwapCancelsToOrderbook(undefined as never, ogHub(t, ogExt, takerFeeBps), cancelled));
        const rwResume = applyCommittedSwapCancels(rwExt, cancelled);
        if (ogResume instanceof Error) { sameHalt(tag, ogResume, rwResume); halts++; break scenario; }
        expect([tag, rwResume.ok]).toEqual([tag, true]);
        if (!rwResume.ok) break;
        expect(rwResume.value.resumePairIds).toEqual(ogResume);
        rwExt = rwResume.value.ext;
        sameBooks(`${tag}:committed`, rwExt, ogExt);
        // 2. maker cancel requests on live offers
        const requests: SwapRef[] = USERS.flatMap((u) => [...t.offers.get(u)!.keys()].filter(() => ri(8) === 0).map((offerId) => ({ offerId, accountId: u })));
        const ogCancel = run(() => ogProcessCancels(ogHub(t, ogExt, takerFeeBps), requests));
        const rwCancel = processOrderbookCancels(rwHub(t, rwExt, takerFeeBps), requests);
        if (ogCancel instanceof Error) { sameHalt(tag, ogCancel, rwCancel); halts++; break scenario; }
        expect([tag, rwCancel.ok]).toEqual([tag, true]);
        if (!rwCancel.ok) break;
        sameTxs(`${tag}:cancel`, rwCancel.value.accountTxs, ogCancel.accountTxs);
        expect([...rwCancel.value.books.keys()]).toEqual(ogCancel.bookUpdates.map((b) => b.pairId));
        rwExt = { ...rwExt, books: new Map([...rwExt.books, ...rwCancel.value.books]) };
        for (const { pairId, book } of ogCancel.bookUpdates) ogExt.books.set(pairId, book);
        rebuildOrderbookPairIndex(ogExt);
        for (const { accountId, tx } of rwCancel.value.accountTxs) t.mempool.get(accountId)!.push(tx);
        cancelTxs += rwCancel.value.accountTxs.length;
        sameBooks(`${tag}:cancelled`, rwExt, ogExt);
        // 3. this frame's committed offers are matched
        const events: SwapOfferEvent[] = [];
        for (let k = ri(6); k > 0; k--) {
          const u = pick(USERS), pair = pick(PAIRS), bd = ri(12) === 0 ? 6 : pair.bd, qd = pair.qd, sell = ri(2) === 0;
          const spread = ri(8) === 0 ? 4_500 : 500, price = (pair.mid * BigInt(10_000 + ri(2 * spread) - spread)) / 10_000n || 1n;
          const multiple = getSwapExactQuoteLotMultipleAtPriceForDimensions(bd, qd, price);
          const qtyLots = BigInt(1 + ri(12)) * multiple + (ri(15) === 0 ? 1n : 0n), baseAmt = qtyLots * lotOf(bd) + (ri(20) === 0 && bd > 6 ? 1n : 0n), quoteAmt = quoteAt(bd, qd, baseAmt, price);
          const [give, want, gd, wd, ga, wa] = sell ? [pair.base, pair.quote, bd, qd, baseAmt, quoteAmt] : [pair.quote, pair.base, qd, bd, quoteAmt, baseAmt];
          const bps = BigInt(pick([0, 0, 10, 100])), maxFee = (wa * bps) / 10_000n, tf = pick([undefined, 0, 0, 1, 2] as const);
          const offer: SwapOffer = { offerId: `o${++n}`, giveTokenId: T(give), giveTokenDecimals: gd, giveAmount: ga, wantTokenId: T(want), wantTokenDecimals: wd, wantAmount: wa, maxFee, minNetReceive: wa - maxFee, priceTicks: price,
            ...(tf === undefined ? {} : { timeInForce: tf }), makerIsLeft: u < HUB, createdHeight: pass + ri(2), quantizedGive: ga, quantizedWant: wa };
          t.offers.get(u)!.set(offer.offerId, offer);
          events.push({ offerId: offer.offerId, accountId: u, makerIsLeft: offer.makerIsLeft, fromEntity: leftOf(u), toEntity: rightOf(u), createdHeight: offer.createdHeight, giveTokenId: give, giveTokenDecimals: gd, giveAmount: ga,
            wantTokenId: want, wantTokenDecimals: wd, wantAmount: wa, maxFee, minNetReceive: wa - maxFee, priceTicks: price, ...(tf === undefined ? {} : { timeInForce: tf }) });
        }
        const hub = rwHub(t, rwExt, takerFeeBps), offers = unwrap(offersForMatching(hub, events));
        expect(offers.map((o) => o.offerId)).toEqual(events.filter((e) => t.active.get(e.accountId)).map((e) => e.offerId));
        const ogOffers = offers.map((o) => markWorkingOrderbookOffer(normalizeSwapOfferForOrderbook({ ...o, accountOutputVerified: true } as never, o.accountId)));
        const resume = rwResume.value.resumePairIds;
        if (resume.length > 0) resumes++;
        const ogMatch = run(() => ogProcessSwaps(ogHub(t, ogExt, takerFeeBps), ogOffers, { resumeSamePairIds: resume }));
        const rwMatch = processOrderbookSwaps(hub, offers, resume);
        if (ogMatch instanceof Error) { sameHalt(tag, ogMatch, rwMatch); halts++; break scenario; }
        expect([tag, rwMatch.ok ? "ok" : (rwMatch.error as { reason: string }).reason]).toEqual([tag, "ok"]);
        if (!rwMatch.ok) break;
        sameTxs(`${tag}:match`, rwMatch.value.accountTxs, ogMatch.accountTxs);
        expect([tag, [...rwMatch.value.books.keys()]]).toEqual([tag, ogMatch.bookUpdates.map((b) => b.pairId)]);
        for (const { pairId, book } of ogMatch.bookUpdates) expect([tag, pairId, bookCommitmentHash(rwMatch.value.books.get(pairId)!)]).toEqual([tag, pairId, computeBookCommitmentHash(book)]);
        // og commitOrderbookMatchResult (module-private, transcribed over og's own bookUpdates): the SwapMatched runtime event's count
        const ogPrevious = new Map<string, number>();
        let ogMatched = 0;
        for (const { pairId, book } of ogMatch.bookUpdates) { const previous = ogPrevious.get(pairId) ?? ogExt.books.get(pairId)?.tradeCount ?? 0; ogMatched += book.tradeCount - previous; ogPrevious.set(pairId, book.tradeCount); }
        expect([tag, unwrap(tradesMatched(rwExt, rwMatch.value.books))]).toEqual([tag, ogMatched]);
        matchedTrades += ogMatched;
        rwExt = { ...rwExt, books: new Map([...rwExt.books, ...rwMatch.value.books]), pairDimensions: rwMatch.value.pairDimensions };
        for (const { pairId, book } of ogMatch.bookUpdates) ogExt.books.set(pairId, book);
        rebuildOrderbookPairIndex(ogExt);
        sameBooks(`${tag}:matched`, rwExt, ogExt);
        for (const { accountId, tx } of rwMatch.value.accountTxs) {
          t.mempool.get(accountId)!.push(tx);
          if (tx.type !== "swap_resolve") continue;
          if (tx.executionGiveAmount !== undefined) fills++;
          const c = String(tx.comment ?? "fill").split(":")[0]!;
          comments.set(c, (comments.get(c) ?? 0) + 1);
        }
      }
    }
    expect(fills).toBeGreaterThan(50);
    expect(matchedTrades).toBeGreaterThan(20);
    expect(cancelTxs).toBeGreaterThan(5);
    expect(resumes).toBeGreaterThan(5);
    for (const c of commentKinds) expect([c, (comments.get(c) ?? 0) > 0]).toEqual([c, true]);
    expect(halts).toBeLessThan(streams);
  });
});

// ============ the book inside entity consensus: peer swap frames reach the hub, the post-tx phase matches and settles ============
describe(seedTag("book-admission: hub order book inside entity consensus"), () => {
  const entityOf = (id: EntityId, signer: typeof aliceAddr) => unwrap(createEntity({ id, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[signer, { shares: 1n }]]) }));
  const signers = new Map<EntityId, typeof aliceAddr>([[ALICE, aliceAddr], [BOB, bobAddr], [CAROL, carolAddr]]);
  const world = () => {
    let rt = spawn(spawn(spawn(withTestJurisdiction(createRuntime()), entityOf(ALICE, aliceAddr)), entityOf(BOB, bobAddr)), entityOf(CAROL, carolAddr));
    let now = NOW;
    const log: { target: EntityId; before: EntityReplica; input: EntityInput }[] = [];
    const send = (entityId: EntityId, txs: readonly EntityTx[]) => {
      const queue: [EntityId, EntityOutput][] = [];
      const step = (target: EntityId, input: EntityInput) => {
        log.push({ target, before: rt.entities.get(replicaKey(target, signers.get(target)!))!, input });
        const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [{ entityId: target, signerId: signers.get(target)!, input }] }, verifiers));
        expect(out.rejected).toEqual([]);
        rt = out.runtime;
        for (const o of out.outbox) queue.push([target, o]);
      };
      now += 1n;
      step(entityId, { kind: "txs", timestamp: now, txs });
      for (let guard = 0; queue.length > 0; guard++) {
        if (guard > 400) throw new Error("no quiescence");
        const [from, o] = queue.shift()!;
        now += 1n;
        if ("input" in o) { if (o.input.kind === "txs") step(o.to, { ...o.input, timestamp: now }); continue; }
        const routed = unwrap(convertOutput(rt, o, from, now));
        step(routed.entityId, routed.input);
      }
    };
    const replica = (id: EntityId) => rt.entities.get(replicaKey(id, signers.get(id)!))!;
    return { send, replica, log };
  };
  const open = (target: EntityId): EntityTx => ({ type: "openAccount", data: { targetEntityId: target, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, creditAmount: 10n ** 30n, tokenId: T(2) } });
  const credit = (to: EntityId, token: number): EntityTx => ({ type: "extendCredit", data: { counterpartyEntityId: to, tokenId: T(token), amount: 10n ** 30n } });
  const offer = (offerId: string, sellWeth: boolean, priceUsdc: bigint, weth: bigint): EntityTx => {
    const base = weth * 10n ** 18n, quote = weth * priceUsdc * 10n ** 6n;
    return { type: "placeSwapOffer", data: { counterpartyEntityId: CAROL, offerId, giveTokenId: T(sellWeth ? 2 : 1), giveTokenDecimals: sellWeth ? 18 : 6, giveAmount: sellWeth ? base : quote,
      wantTokenId: T(sellWeth ? 1 : 2), wantTokenDecimals: sellWeth ? 6 : 18, wantAmount: sellWeth ? quote : base, maxFee: 0n, minNetReceive: sellWeth ? quote : base } };
  };
  test("MATCH (og applyPostEntityTxPhases): a maker rests, a crossing taker fills it, both resolves commit and the book empties; a cancel request removes a resting offer", () => {
    const { send, replica, log } = world();
    send(CAROL, [{ type: "initOrderbookExt", data: { name: "hub", spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 }, referenceTokenId: 1, usdQuoteAuthorityEntityId: W("99"), minTradeSize: 0n, supportedPairs: ["1/2"] } }]);
    send(ALICE, [open(CAROL)]);
    send(BOB, [open(CAROL)]);
    send(CAROL, [credit(ALICE, 1), credit(ALICE, 2), credit(BOB, 1), credit(BOB, 2)]);
    send(ALICE, [credit(CAROL, 1), credit(CAROL, 2)]);
    send(BOB, [credit(CAROL, 1), credit(CAROL, 2)]);
    for (const [who, peer] of [[ALICE, CAROL], [BOB, CAROL], [CAROL, ALICE], [CAROL, BOB]] as const) expect(replica(who).accountReplicas.get(peer)?._tag).toBe("open");
    // a maker's offer rests on the hub book
    send(ALICE, [offer("ask1", true, 2500n, 1n)]);
    const rested = replica(CAROL).state.orderbookExt!;
    expect([...rested.books.keys()]).toEqual(["1/2"]);
    expect(bookOrders(rested.books.get("1/2")!).map((o) => [o.orderId, o.ownerId, o.side, o.priceTicks])).toEqual([[`${ALICE}:ask1`, ALICE, 1, 25_000_000n]]);
    expect(rested.pairDimensions.get("1/2")).toEqual({ baseTokenDecimals: 18, quoteTokenDecimals: 6 });
    // a crossing taker: both offers are resolved in full and leave both Accounts
    send(BOB, [offer("bid1", false, 2600n, 1n)]);
    const traded = replica(CAROL).state.orderbookExt!.books.get("1/2")!;
    expect([traded.tradeCount, bookOrders(traded).length]).toEqual([1, 0]);
    // og commitOrderbookMatchResult: the hub frame that matched carries one SwapMatched runtime event with the new trade count (replayed through foldTxs)
    const matching = log.filter((e) => e.target === CAROL && e.input.kind === "txs" && (e.before.state.orderbookExt?.books.get("1/2")?.tradeCount ?? 0) === 0).map((e) => {
      const input = e.input as Extract<EntityInput, { kind: "txs" }>, r = foldTxs(e.before.state, e.before.accountReplicas, [...e.before.mempool, ...input.txs], { verify: verifiers.verify, timestamp: input.timestamp, jReplicas: withTestJurisdiction(createRuntime()).jReplicas });
      return r.ok ? (r.value.draft.runtimeEvents ?? []).filter((x) => x.eventName === "SwapMatched") : [];
    }).filter((x) => x.length > 0);
    expect(matching).toEqual([[{ eventName: "SwapMatched", data: { entityId: CAROL, count: 1 } }]]);
    for (const [who, peer] of [[ALICE, CAROL], [BOB, CAROL], [CAROL, ALICE], [CAROL, BOB]] as const) {
      const child = replica(who).accountReplicas.get(peer)!;
      expect([who, peer, child._tag, child.state.offers.size, child.mempool.length]).toEqual([who, peer, "open", 0, 0]);
    }
    // the maker sold 1 WETH for 2500 USDC at its resting price; the taker bought at that price (price improvement)
    const moved = (who: EntityId, token: number) => { const d = replica(who).accountReplicas.get(CAROL)!.state.account.deltas.get(T(token))!; return d.offdelta < 0n ? -d.offdelta : d.offdelta; };
    expect([moved(ALICE, 2), moved(ALICE, 1), moved(BOB, 2), moved(BOB, 1)]).toEqual([10n ** 18n, 2_500n * 10n ** 6n, 10n ** 18n, 2_500n * 10n ** 6n]);
    // the maker's cancel request queues the hub's zero-fill resolve and takes the row off the book
    send(ALICE, [offer("ask2", true, 2500n, 1n)]);
    expect(bookOrders(replica(CAROL).state.orderbookExt!.books.get("1/2")!).map((o) => o.orderId)).toEqual([`${ALICE}:ask2`]);
    send(ALICE, [{ type: "proposeCancelSwap", data: { counterpartyEntityId: CAROL, offerId: "ask2" } }]);
    expect(bookOrders(replica(CAROL).state.orderbookExt!.books.get("1/2")!)).toEqual([]);
    expect(replica(ALICE).accountReplicas.get(CAROL)!.state.offers.size).toBe(0);
    // the root commits the book section
    unwrap(entityRootOf(replica(CAROL).state, replica(CAROL).accountReplicas));
  });
});
