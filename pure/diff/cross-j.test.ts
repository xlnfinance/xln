// Differential tests: og cross-jurisdiction extension (core/extensions/cross-j/**, core/protocol/htlc/hash-ladder.ts)
// vs the pure rewrite's cross-j kernel (pure/xln.ts). "MATCH:" tests assert equivalence against live og.
import { describe, expect, test } from "bun:test";
import { seedOf, seedTag, untilCovered } from "./seed.ts";
import * as ogLadder from "../../core/protocol/htlc/hash-ladder.ts";
import * as ogCross from "../../core/extensions/cross-j/index.ts";
import * as ogMarket from "../../core/extensions/cross-j/market.ts";
import { exactFillRatioToUint16 } from "../../core/orderbook/swap-execution.ts";
import { handlePullLock, handleCrossPullClose } from "../../core/account/tx/handlers/settlement/pull.ts";
import { handleSwapOffer } from "../../core/account/tx/handlers/swap/offer/index.ts";
import { handleSwapResolve } from "../../core/account/tx/handlers/swap/resolve/index.ts";
import { handleSwapCancelRequest } from "../../core/account/tx/handlers/swap/lifecycle/cancel.ts";
import { beginAccountTransition, accountTransitionView, commitAccountTransition, discardAccountTransition } from "../../core/account/state/candidate-overlay.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import { ethers } from "ethers";
import { handleHtlcLock } from "../../core/account/tx/handlers/htlc/lock.ts";
import { applyAccountTxMutation } from "../../core/account/tx/mutation.ts";
import { applyFinalizedAccountJEventsOnView } from "../../core/account/tx/handlers/j-events/finality.ts";
import { findExactSignedProofBodyPull, resolveFinalizedPullFillRatio, resolveFinalizedCrossJurisdictionRouteLeg } from "../../core/account/pull-registry-settlement.ts";
import { BATCH_ABI } from "../../core/protocol/dispute/proof-body.ts";
import { assertOpaqueHtlcCiphertext, hashOpaqueHtlcCiphertext } from "../../core/protocol/htlc/multi-recipient.ts";
import {
  buildHashLadderProof,
  revealHashLadder,
  decodeHashLadderBinary,
  verifyHashLadderBinary,
  crossRouteHash,
  canonicalCrossRoute,
  crossMarket,
  crossBookOwner,
  crossPullId,
  crossPrivateSeed,
  crossSignedAmount,
  cloneCrossRoute,
  crossPullBinding,
  crossFillAmounts,
  crossFillProgress,
  applyCrossFill,
  buildCrossCloseProof,
  prepareCrossRoute,
  crossPullReveal,
  transitionCrossStatus,
  crossTransitionAllowed,
  compareCrossStatus,
  CROSS_STATUSES,
  stableJson,
  accountId,
  accountTerms,
  applyAccountBody,
  committed,
  entityId,
  genesisAccount,
  genesisAccountBody,
  holds,
  htlcEnvelopeHash,
  setRebalanceSubmittedAt,
  submittedAtRoot,
  findSignedProofBodyPull,
  finalizedPullFillRatio,
  finalizedRouteLeg,
  type CrossPullLeg,
  type AccountBody,
  type CrossRoute,
} from "../xln.ts";

// Deterministic PRNG (mulberry32) so failures reproduce.
export const rng = (base: number) => {
  let seed = seedOf(base);
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
type Rand = () => number;
const pick = <T,>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const hex = (r: Rand, bytes: number): string => "0x" + Array.from({ length: bytes }, () => Math.floor(r() * 256).toString(16).padStart(2, "0")).join("");
const big = (r: Rand, max: bigint): bigint => (BigInt(Math.floor(r() * 2 ** 52)) * BigInt(Math.floor(r() * 2 ** 20) + 1)) % max;

/** Outcome of an og call: thrown => reject. */
export const ogTry = <T,>(f: () => T): { ok: true; value: T } | { ok: false } => {
  try { return { ok: true, value: f() }; } catch { return { ok: false }; }
};
const same = (a: unknown, b: unknown) => expect(stableJson(a)).toBe(stableJson(b));
const agree = <T,>(og: { ok: true; value: T } | { ok: false }, rw: { ok: true; value: unknown } | { ok: false; error: unknown }) => {
  expect(rw.ok).toBe(og.ok);
  if (og.ok && rw.ok) same(rw.value, og.value);
};

export const STACKS = ["stack:1:0x" + "11".repeat(20), "stack:31337:0x" + "aB".repeat(20), "stack:8453:0x" + "cd".repeat(20)] as const;
export const ENTS = ["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32), "0x" + "fe".repeat(32)] as const;

export const randomRoute = (r: Rand): CrossRoute => {
  const sj = pick(r, STACKS), tj = r() < 0.2 ? sj : pick(r, STACKS);
  const [maker, hub] = [pick(r, ENTS), pick(r, ENTS)];
  const route: CrossRoute = {
    orderId: `order-${Math.floor(r() * 1e6)}`,
    makerEntityId: maker,
    hubEntityId: hub,
    source: { jurisdiction: r() < 0.03 ? "bogus" : sj, entityId: maker, counterpartyEntityId: hub, tokenId: pick(r, [1, 2, 3, 4]), amount: big(r, 10n ** 24n) + 1n },
    target: { jurisdiction: tj, entityId: hub, counterpartyEntityId: maker, tokenId: pick(r, [1, 2, 3, 4]), amount: big(r, 10n ** 24n) + 1n },
    sourceDisputeConfig: { leftResponseSeconds: pick(r, [0, 60, 3600, 86_400]), rightResponseSeconds: pick(r, [0, 60, 3600]) },
    targetDisputeConfig: { leftResponseSeconds: pick(r, [60, 7200]), rightResponseSeconds: pick(r, [60, 7200, 2 ** 33]) },
    status: pick(r, ["intent", "resting", "target_prepared"] as const),
    createdAt: 1_700_000_000_000 + Math.floor(r() * 1e6),
    updatedAt: 1_700_000_000_000 + Math.floor(r() * 1e6),
    ...(r() < 0.5 ? { expiresAt: 1_700_000_100_000 + Math.floor(r() * 1e7) } : {}),
    ...(r() < 0.3 ? { memo: `memo ${Math.floor(r() * 99)}` } : {}),
    ...(r() < 0.3 ? { priceTicks: big(r, 10n ** 12n) } : {}),
    ...(r() < 0.3 ? { clearingPolicy: pick(r, ["manual", "full_fill", "cancel_and_clear"] as const) } : {}),
    ...(r() < 0.3 ? { riskMode: pick(r, ["fully_collateralized", "credit_line"] as const) } : {}),
    ...(r() < 0.2 ? { sourceSignerId: "0x" + "aa".repeat(20), bookHubSignerId: "signer-" + Math.floor(r() * 9) } : {}),
  };
  return route;
};

describe(seedTag("cross-j: hash ladder (core/protocol/htlc/hash-ladder.ts)"), () => {
  test("MATCH: build/reveal/decode/verify agree with og across random seeds and ratios", () => {
    const r = rng(7);
    for (let i = 0; i < 40; i++) {
      const seed = hex(r, 32);
      const og = ogLadder.buildHashLadderProof(seed), rw = buildHashLadderProof(seed);
      same(rw, og);
      for (const ratio of [0, 1, 15, 16, 255, 4096, 65_534, 65_535, Math.floor(r() * 65_536)]) {
        const ogr = ogLadder.revealHashLadder(og, ratio), rwr = revealHashLadder(rw, ratio);
        same(rwr, ogr);
        agree(ogTry(() => ogLadder.decodeHashLadderBinary(ogr.binary)), decodeHashLadderBinary(rwr.binary));
        agree(ogTry(() => ogLadder.verifyHashLadderBinary(og, ogr.binary)), verifyHashLadderBinary(rw, rwr.binary));
        // Tamper one byte: both must reject (or both accept if tamper was a no-op).
        const bad = ogr.binary.slice(0, -2) + (ogr.binary.endsWith("00") ? "01" : "00");
        agree(ogTry(() => ogLadder.verifyHashLadderBinary(og, bad)), verifyHashLadderBinary(rw, bad));
      }
    }
  });
  test("MATCH: malformed binaries are rejected identically", () => {
    for (const b of [undefined, "", "0x", "0x00", "0x" + "00".repeat(33), "0x" + "00".repeat(34), "0xzz", "0x" + "11".repeat(130), "0x" + "ff".repeat(2) + "00".repeat(128)]) {
      agree(ogTry(() => ogLadder.decodeHashLadderBinary(b)), decodeHashLadderBinary(b));
    }
  });
});

describe(seedTag("cross-j: route kernel (core/extensions/cross-j/index.ts, market.ts)"), () => {
  test("MATCH: routeHash, canonical route, clone, market, book owner, pull ids, seeds agree with og", () => {
    const r = rng(11);
    for (let i = 0; i < 150; i++) {
      const route = randomRoute(r);
      const ogRoute = route as never;
      agree(ogTry(() => ogCross.deriveCrossJurisdictionRouteHash(ogRoute)), crossRouteHash(route));
      agree(ogTry(() => ogCross.withCanonicalCrossJurisdictionRouteHash(ogRoute)), canonicalCrossRoute(route));
      agree(ogTry(() => ogCross.cloneCrossJurisdictionRoute(ogRoute)), cloneCrossRoute(route));
      agree(ogTry(() => ogMarket.deriveCanonicalCrossJurisdictionMarket(ogRoute)), crossMarket(route));
      agree(ogTry(() => ogMarket.deriveCanonicalCrossJurisdictionBookOwner(ogRoute)), crossBookOwner(route));
      for (const leg of ["source", "target"] as const) {
        agree(ogTry(() => ogCross.deriveCrossJurisdictionPullId(ogRoute, leg)), crossPullId(route, leg));
        agree(ogTry(() => ogCross.buildCrossJurisdictionPullBinding(ogRoute, leg)), crossPullBinding(route, leg));
      }
      const seed = r() < 0.1 ? undefined : hex(r, 32);
      agree(ogTry(() => ogCross.deriveCrossJurisdictionPrivateSeed(seed, ogRoute)), crossPrivateSeed(seed, route));
      expect(crossSignedAmount(route.source.entityId, route.source.counterpartyEntityId, 5n)).toBe(ogCross.signedCrossJurisdictionAmountForBeneficiary(route.source.entityId, route.source.counterpartyEntityId, 5n));
    }
  });

  test("MATCH: prepared route, close proof, pull reveal agree with og", () => {
    const r = rng(23);
    for (let i = 0; i < 80; i++) {
      const route = randomRoute(r), seed = r() < 0.05 ? undefined : hex(r, 32);
      const now = r() < 0.05 ? 0 : 1_700_000_050_000 + Math.floor(r() * 1e5);
      const og = ogTry(() => ogCross.buildPreparedCrossJurisdictionRoute(route as never, { runtimeSeed: seed, now }));
      const rw = prepareCrossRoute(route, { runtimeSeed: seed, now });
      agree(og, rw);
      if (!og.ok || !rw.ok) continue;
      const binary = hex(r, Math.floor(r() * 40));
      agree(ogTry(() => ogCross.buildCrossJurisdictionCloseProof(og.value, binary)), buildCrossCloseProof(rw.value, binary));
      const ratio = Math.floor(r() * 65_536);
      if (seed !== undefined) {
        const s = ogCross.deriveCrossJurisdictionPrivateSeed(seed, og.value);
        agree(ogTry(() => ogCross.buildCrossJurisdictionPullReveal(og.value, ratio, s)), crossPullReveal(ratio, s));
      }
    }
  });

  test("MATCH: fill progress validation / apply / committed amounts agree with og", () => {
    const r = rng(31);
    let accepted = 0;
    for (let i = 0; i < 400; i++) {
      const base = randomRoute(r);
      const consistent = r() < 0.6;
      const d = 1000n, n1 = BigInt(Math.floor(r() * 600)), n2 = n1 + BigInt(Math.floor(r() * 500) - 50);
      const scale = (t: bigint, n: bigint) => (n >= d ? t : (t * n) / d);
      const route: CrossRoute = consistent
        ? { ...base, status: "partially_filled", fillSeq: 2, fillNumerator: n1, fillDenominator: d, cumulativeFillRatio: exactFillRatioToUint16({ numerator: n1, denominator: d }),
            filledSourceAmount: scale(base.source.amount, n1), ...(r() < 0.8 ? { filledTargetAmount: scale(base.target.amount, n1) } : {}) }
        : {
        ...base,
        status: pick(r, ["resting", "partially_filled", "clearing", "settled"] as const),
        ...(r() < 0.5 ? { cumulativeFillRatio: Math.floor(r() * 65_536), fillSeq: Math.floor(r() * 4) } : {}),
        ...(r() < 0.3 ? { fillNumerator: big(r, 1000n), fillDenominator: pick(r, [0n, 1n, 1000n, 7n]) } : {}),
        ...(r() < 0.3 ? { filledSourceAmount: big(r, base.source.amount + 1n), filledTargetAmount: big(r, base.target.amount + 1n) } : {}),
      };
      agree(ogTry(() => ogCross.getCrossJurisdictionCommittedFillAmounts(route as never)), crossFillAmounts(route));
      const input = consistent && n2 > 0n && n2 <= d
        ? { fillSeq: r() < 0.9 ? 3 : 2, cumulativeFillRatio: exactFillRatioToUint16({ numerator: n2, denominator: d }) + (r() < 0.1 ? 1 : 0), fillNumerator: n2, fillDenominator: d,
            ...(r() < 0.5 ? { cumulativeSourceAmount: scale(base.source.amount, n2) + (r() < 0.1 ? 1n : 0n), incrementalTargetAmount: scale(base.target.amount, n2) - scale(base.target.amount, n1) } : {}) }
        : {
        fillSeq: r() < 0.9 ? (route.fillSeq ?? 0) + 1 : Math.floor(r() * 3),
        cumulativeFillRatio: Math.floor(r() * 65_536),
        ...(r() < 0.5 ? { fillNumerator: big(r, 100n), fillDenominator: pick(r, [1n, 100n, 3n]) } : {}),
        ...(r() < 0.5 ? { incrementalSourceAmount: big(r, base.source.amount), incrementalTargetAmount: big(r, base.target.amount) } : {}),
        ...(r() < 0.5 ? { cumulativeSourceAmount: big(r, base.source.amount + 1n), cumulativeTargetAmount: big(r, base.target.amount + 1n) } : {}),
      };
      // og returns {ok:false} for soft rejects and throws for hard ones; both are rejects.
      const ogv = ogTry(() => { const v = ogCross.validateCrossJurisdictionFillProgress(route as never, input as never); if (!v.ok) throw new Error(v.error); return v.value; });
      agree(ogv, crossFillProgress(route, input));
      if (ogv.ok) accepted++;
      agree(ogTry(() => ogCross.applyCrossJurisdictionFillProgress(route as never, input as never, 99, "X")), applyCrossFill(route, input, 99));
    }
    expect(accepted).toBeGreaterThan(10);
  });

  test("MATCH: status transitions agree with og", () => {
    for (const a of [undefined, ...CROSS_STATUSES]) for (const b of CROSS_STATUSES) {
      expect(crossTransitionAllowed(a, b)).toBe(ogCross.isCrossJurisdictionRouteTransitionAllowed(a, b));
      expect(compareCrossStatus(a, b)).toBe(ogCross.compareCrossJurisdictionRouteStatus(a, b));
      if (a === undefined) continue;
      const route = { ...randomRoute(rng(1)), status: a };
      agree(ogTry(() => ogCross.transitionCrossJurisdictionRouteStatus(route as never, b, 5)), transitionCrossStatus(route, b, 5));
    }
  });
});

// ---------- account txs: cross_pull_lock / cross_pull_close / cross-j swap_offer (og handlers/settlement/pull.ts, swap/offer) ----------
const W = (byte: string): string => `0x${byte.repeat(32)}`;
const LEFT = W("11"), RIGHT = W("22");
const DEP = `0x${"ab".repeat(20)}`, HERE = `stack:1:${DEP}`, THERE = `stack:7:0x${"cd".repeat(20)}`;
const unwrapR = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(`unwrap: ${stableJson(r.error)}`); return r.value; };
const openAccount = (credit: bigint): AccountBody => {
  const terms = unwrapR(accountTerms({ domain: { chainId: 1, depositoryAddress: DEP }, watchSeed: W("44"), disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 } }) as never);
  let body = genesisAccountBody(genesisAccount(unwrapR(accountId(unwrapR(entityId(LEFT) as never), unwrapR(entityId(RIGHT) as never)) as never)), terms as never);
  for (const tokenId of ["1", "2", "3"]) for (const byLeft of [true, false])
    body = unwrapR(applyAccountBody(body, { type: "set_credit_limit", tokenId, limit: credit } as never, { byLeft, nowMs: 1n, jHeight: 0n, accountHeight: 1n }) as never as { ok: true; value: { state: AccountBody } }).state;
  return body;
};
const PA = (ns: string, m: ReadonlyMap<unknown, unknown> = new Map()) => PersistentAccountStateMap.fromEntries(ns as never, m as never);
/** og side of a lockstep: a persistent og replica seeded from the rewrite's committed view, driven through the real transition overlay. */
export const ogHarness = (body: AccountBody) => {
  const v: any = unwrapR(committed(body) as never as { ok: true; value: { view: unknown } }).view;
  const state: any = { domain: v.domain, leftEntity: v.leftEntity, rightEntity: v.rightEntity, watchSeed: v.watchSeed, disputeConfig: v.disputeConfig, jNonce: v.jNonce, lastFinalizedJHeight: v.lastFinalizedJHeight,
    leftPendingJClaims: v.leftPendingJClaims, rightPendingJClaims: v.rightPendingJClaims,
    ...Object.fromEntries(["deltas", "locks", "pulls", "swapOffers", "subcontracts", "lendingIntents", "requestedRebalance", "requestedRebalanceFeeState", "rebalanceFeePolicies"].map((n) => [n, PA(n, v[n])])) };
  let replica: any = { state, status: "active", currentHeight: 0, proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 }, currentFrame: { stateHash: "" }, pendingWithdrawals: PA("pendingWithdrawals"),
    shadow: { rebalance: { policy: PA("rebalanceShadowPolicy"), submittedAtByToken: PA("rebalanceShadowSubmitted", body.submittedAt ?? new Map()) } }, mempool: [] };
  const run = async (handler: (draft: any) => Promise<any> | any): Promise<{ ok: boolean; root?: string; error?: string; value?: any }> => {
    const overlay = beginAccountTransition(replica);
    let r: any;
    try { r = await handler(accountTransitionView(overlay)); } catch (e) { r = { ok: false, rejection: { message: String(e) } }; }
    if (!r.ok) { discardAccountTransition(overlay); return { ok: false, error: r.rejection?.message }; }
    const c = commitAccountTransition(overlay, "diff");
    replica = c.account;
    return { ok: true, root: c.accountStateRoot, value: r };
  };
  return { run, replica: () => replica };
};
const toOg = (tx: any): any => {
  const { type, ...data } = tx;
  for (const k of ["tokenId", "giveTokenId", "wantTokenId", "feeTokenId", "requestTokenId"]) if (typeof data[k] === "string") data[k] = Number(data[k]);
  return { type, data };
};
const lockstep = (start: AccountBody) => {
  const og = ogHarness(start);
  let body = start;
  const step = async (tx: any, byLeft: boolean, jh = 3, ts = 1000): Promise<boolean> => {
    const ogTx = toOg(tx);
    const o = await og.run((acc) => {
      switch (tx.type) {
        case "cross_pull_lock": return handlePullLock(acc.state, ogTx, byLeft, jh, ts);
        case "cross_pull_close": return handleCrossPullClose(acc.state, ogTx, byLeft, ts);
        case "swap_offer": return handleSwapOffer(acc, ogTx, byLeft, jh);
        case "swap_resolve": return handleSwapResolve(acc, ogTx, byLeft, jh);
        default: return handleSwapCancelRequest(acc, ogTx, byLeft, jh);
      }
    });
    const r = applyAccountBody(body, tx, { byLeft, nowMs: BigInt(ts), jHeight: BigInt(jh), accountHeight: 1n }) as any;
    if (r.ok !== o.ok) throw new Error(`accept mismatch og=${o.ok}(${o.error}) rw=${r.ok ? "ok" : stableJson(r.error)} tx=${stableJson(tx).slice(0, 400)}`);
    if (r.ok) { body = r.value.state; expect(unwrapR(committed(body) as never as { ok: true; value: { root: string } }).root).toBe(o.root!); }
    return r.ok;
  };
  return { step, body: () => body };
};

const SEED = W("5e");
/** A resting route with one leg on this Account (stack HERE) and the other on another stack: the source leg, or (targetHere) the target leg. */
const restingRoute = (r: Rand, makerIsLeft: boolean, targetHere: boolean): { route: CrossRoute; seed: string } => {
  const maker = makerIsLeft ? LEFT : RIGHT, hub = makerIsLeft ? RIGHT : LEFT;
  const sourceToken = pick(r, [1, 2]), targetToken = pick(r, [1, 2, 3]);
  const lot = 10n ** 12n; // 18-decimal base: lot 10^12
  const base: CrossRoute = {
    orderId: `o-${Math.floor(r() * 1e9)}`, makerEntityId: maker, hubEntityId: hub,
    source: { jurisdiction: targetHere ? THERE : HERE, entityId: maker, counterpartyEntityId: hub, tokenId: sourceToken, amount: lot * BigInt(1 + Math.floor(r() * 9)) },
    target: { jurisdiction: targetHere ? HERE : THERE, entityId: hub, counterpartyEntityId: maker, tokenId: targetToken, amount: lot * BigInt(1 + Math.floor(r() * 9)) },
    sourceDisputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 }, targetDisputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
    status: "intent", createdAt: 1_000, updatedAt: 1_000,
  };
  const prepared = unwrapR(prepareCrossRoute(base, { runtimeSeed: SEED, now: 2_000 }));
  const route = ogCross.withCanonicalCrossJurisdictionRouteHash({ ...prepared, status: "resting" } as never) as unknown as CrossRoute;
  return { route, seed: ogCross.deriveCrossJurisdictionPrivateSeed(SEED, route as never) };
};
const lockTx = (route: CrossRoute, leg: "source" | "target"): any => {
  const pull = leg === "source" ? route.sourcePull! : route.targetPull!;
  return { type: "cross_pull_lock", pullId: pull.pullId, tokenId: String(pull.tokenId), amount: pull.signedAmount, fullHash: pull.fullHash, partialRoot: pull.partialRoot,
    crossJurisdiction: unwrapR(crossPullBinding(route, leg)), crossJurisdictionRoute: route };
};
const offerTx = (route: CrossRoute, patch: Record<string, unknown> = {}): any => ({
  type: "swap_offer", offerId: route.orderId, giveTokenId: String(route.source.tokenId), giveTokenDecimals: 18, giveAmount: route.source.amount,
  wantTokenId: String(route.target.tokenId), wantTokenDecimals: 18, wantAmount: route.target.amount, maxFee: 0n, minNetReceive: route.target.amount, crossJurisdiction: route, ...patch,
});
const chainProp = (total: bigint, ratio: number): bigint => (ratio >= 65_535 ? total : (total * BigInt(ratio)) / 65_535n);
const closeTx = (route: CrossRoute, leg: "source" | "target", seed: string, ratio: number): any => {
  const reveal = revealHashLadder(buildHashLadderProof(seed), ratio);
  return { type: "cross_pull_close", pullId: (leg === "source" ? route.sourcePull! : route.targetPull!).pullId, binary: reveal.binary, proof: {
    orderId: route.orderId, routeHash: route.routeHash!, sourcePullId: route.sourcePull!.pullId, targetPullId: route.targetPull!.pullId, fillRatio: ratio,
    cumulativeSourceAmount: chainProp(route.source.amount, ratio), cumulativeTargetAmount: chainProp(route.target.amount, ratio), binaryHash: ethers.keccak256(reveal.binary),
    closeMode: ratio >= 65_535 ? "full" : ratio === 0 ? "pure_cancel" : "partial_cancel_remainder" } };
};
/** One random corruption of a tx (or none); both implementations must agree on the outcome. */
const mutate = (r: Rand, tx: any): any => {
  if (r() < 0.55) return tx;
  const t = structuredClone(tx);
  const which = Math.floor(r() * 10);
  if (t.type === "cross_pull_lock") {
    if (which === 0) t.amount = -t.amount;
    else if (which === 1) t.pullId = t.pullId + ":x";
    else if (which === 2) t.fullHash = W("99");
    else if (which === 3) t.crossJurisdiction = { ...t.crossJurisdiction, status: "partially_filled" };
    else if (which === 4) t.crossJurisdictionRoute = { ...t.crossJurisdictionRoute, memo: "x" };
    else if (which === 5) t.tokenId = "3";
    else if (which === 6) t.crossJurisdiction = { ...t.crossJurisdiction, leg: t.crossJurisdiction.leg === "source" ? "target" : "source" };
    else if (which === 7) t.crossJurisdictionRoute = { ...t.crossJurisdictionRoute, fillSeq: 1 };
    else t.partialRoot = t.partialRoot.toUpperCase().replace("0X", "0x");
  } else if (t.type === "cross_pull_close") {
    if (which === 0) t.proof.fillRatio = t.proof.fillRatio + 1;
    else if (which === 1) t.proof.cumulativeSourceAmount += 1n;
    else if (which === 2) t.proof.cumulativeTargetAmount += 1n;
    else if (which === 3) t.proof.binaryHash = W("00");
    else if (which === 4) t.proof.closeMode = "bogus";
    else if (which === 5) t.binary = t.binary.slice(0, -2) + "00";
    else if (which === 6) t.proof.routeHash = W("01");
    else if (which === 7) t.proof.orderId = "nope";
    else t.proof.binaryHash = t.proof.binaryHash.toUpperCase().replace("0X", "0x");
  } else if (t.type === "swap_offer") {
    if (which === 0) t.maxFee = 1n;
    else if (which === 1) t.giveAmount = t.giveAmount + 1n;
    else if (which === 2) t.crossJurisdiction = { ...t.crossJurisdiction, status: "partially_filled" };
    else if (which === 3) t.giveTokenDecimals = 6;
    else if (which === 4) t.minNetReceive = t.minNetReceive - 1n;
    else if (which === 5) t.wantTokenDecimals = 30;
    else if (which === 6) t.timeInForce = 1;
    else t.priceTicks = 12345n;
  }
  return t;
};

describe(seedTag("cross-j: account txs through the og transition overlay"), () => {
  test("MATCH: 60 random pull-lock / offer / resolve / close sequences agree on accept/reject and Account root", async () => {
    const r = rng(101);
    let locks = 0, offers = 0, closes = 0;
    for (let n = 0; n < 60; n++) {
      const credit = pick(r, [0n, 10n ** 13n, 10n ** 20n]);
      const ls = lockstep(openAccount(credit));
      const routes = Array.from({ length: 1 + Math.floor(r() * 3) }, () => restingRoute(r, r() < 0.5, r() < 0.6));
      const plan: Array<{ tx: any; byLeft: boolean }> = [];
      for (const { route, seed } of routes) {
        const makerIsLeft = route.makerEntityId === LEFT, hubIsLeft = !makerIsLeft, targetHere = route.target.jurisdiction === HERE;
        plan.push({ tx: lockTx(route, "source"), byLeft: r() < 0.5 });
        if (targetHere) plan.push({ tx: lockTx(route, "target"), byLeft: r() < 0.5 });
        plan.push({ tx: offerTx(route), byLeft: r() < 0.7 ? makerIsLeft : hubIsLeft });
        if (r() < 0.3) plan.push({ tx: { type: "swap_resolve", offerId: route.orderId, fillRatio: 0, cancelRemainder: true }, byLeft: hubIsLeft });
        if (r() < 0.2) plan.push({ tx: { type: "swap_cancel_request", offerId: route.orderId }, byLeft: makerIsLeft });
        const ratio = pick(r, [0, 1, 32_767, 65_534, 65_535, Math.floor(r() * 65_536)]);
        plan.push({ tx: closeTx(route, "source", seed, ratio), byLeft: r() < 0.85 ? hubIsLeft : makerIsLeft });
        if (targetHere) plan.push({ tx: closeTx(route, "target", seed, ratio), byLeft: r() < 0.85 ? hubIsLeft : makerIsLeft });
      }
      for (const { tx, byLeft } of plan) {
        const t = mutate(r, tx);
        const ok = await ls.step(t, byLeft);
        if (ok && t.type === "cross_pull_lock") locks++;
        if (ok && t.type === "swap_offer") offers++;
        if (ok && t.type === "cross_pull_close") closes++;
        if (ok && r() < 0.1) await ls.step(t, byLeft); // replay: refused identically
      }
    }
    expect(locks).toBeGreaterThan(20);
    expect(offers).toBeGreaterThan(5);
    expect(closes).toBeGreaterThan(10);
  });

  test("MATCH: a pull holds |amount| on the payer side; the source close releases it and retires the cross-j offer", async () => {
    const { route, seed } = restingRoute(rng(5), true, false);
    const ls = lockstep(openAccount(10n ** 20n));
    expect(await ls.step(lockTx(route, "source"), true)).toBe(true);
    const payerIsLeft = route.sourcePull!.signedAmount < 0n, tk = String(route.source.tokenId) as never;
    expect(holds(ls.body(), tk, payerIsLeft)).toBe(route.source.amount);
    expect(await ls.step(offerTx(route), true)).toBe(true);
    expect(holds(ls.body(), tk, payerIsLeft)).toBe(route.source.amount);
    expect(await ls.step(closeTx(route, "source", seed, 40_000), false)).toBe(true);
    expect(holds(ls.body(), tk, payerIsLeft)).toBe(0n);
    expect(ls.body().offers.size).toBe(0);
  });
});

// ---------- htlc_lock envelope (og handlers/htlc/lock.ts, protocol/htlc/multi-recipient.ts) ----------
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const randomEnvelope = (r: Rand): unknown => {
  const n = pick(r, [0, 1, 20, 47, 48, 49, 64, 100, 257]);
  const bytes = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
  const ct = b64(bytes);
  switch (Math.floor(r() * 12)) {
    case 0: return { version: "xln:htlc-opaque:aes-gcm", ciphertext: ct.replace(/=+$/, "") };
    case 1: return { version: "xln:htlc-opaque:v0", ciphertext: ct };
    case 2: return { version: "xln:htlc-opaque:aes-gcm", ciphertext: ct, extra: 1 };
    case 3: return { ciphertext: ct };
    case 4: return { version: "xln:htlc-opaque:aes-gcm", ciphertext: ` ${ct}` };
    case 5: return { version: "xln:htlc-opaque:aes-gcm", ciphertext: ct.length > 2 && ct.endsWith("=") ? ct.slice(0, -2) + "B=" : ct.replace(/.$/, "_") };
    case 6: return [ct];
    case 7: return null;
    case 8: return { version: "xln:htlc-opaque:aes-gcm", ciphertext: ct.replace(/\+/g, "-") };
    default: return { ciphertext: ct, version: "xln:htlc-opaque:aes-gcm" };
  }
};

describe(seedTag("cross-j: htlc_lock envelope and envelopeHash"), () => {
  test("MATCH: envelope validation and envelopeHash agree with og assertOpaqueHtlcCiphertext/hashOpaqueHtlcCiphertext on 600 random envelopes", () => {
    const r = rng(77);
    let valid = 0;
    for (let i = 0, more = untilCovered(600, () => valid > 100); more(i); i++) {
      const env = randomEnvelope(r);
      const og = ogTry(() => hashOpaqueHtlcCiphertext(assertOpaqueHtlcCiphertext(env)));
      const rw = htlcEnvelopeHash(env);
      expect(rw !== null).toBe(og.ok);
      if (og.ok) { expect(rw).toBe(og.value); valid++; }
    }
    expect(valid).toBeGreaterThan(100);
  });

  test("MATCH: 200 random htlc_lock txs with envelopes give the same accept/reject and Account root (envelopeHash committed on the lock)", async () => {
    const r = rng(78);
    let accepted = 0;
    for (let n = 0; n < 20; n++) {
      const start = openAccount(10n ** 6n);
      const og = ogHarness(start);
      let body = start;
      for (let i = 0; i < 10; i++) {
        const secret = hex(r, 32), byLeft = r() < 0.5, env = r() < 0.2 ? undefined : randomEnvelope(r);
        const hashlock = ethers.keccak256(secret);
        const tx: any = { type: "htlc_lock", lockId: hashlock, hashlock, timelock: 10n ** 15n, revealBeforeHeight: 50n, amount: BigInt(1 + Math.floor(r() * 1000)), tokenId: "1", ...(r() < 0.3 ? { deliveryMode: pick(r, ["instant", "async"]) } : {}), ...(env === undefined ? {} : { envelope: env }) };
        const ogTx = toOg(tx);
        ogTx.data.revealBeforeHeight = 50;
        const o = await og.run((acc) => handleHtlcLock(acc, ogTx, byLeft, { committedTimestamp: 7, enforcementTimestamp: 7, enforcementJHeight: 3 }));
        const rw = applyAccountBody(body, tx, { byLeft, nowMs: 7n, jHeight: 3n, accountHeight: 1n }) as any;
        expect(rw.ok).toBe(o.ok);
        if (rw.ok) { body = rw.value.state; accepted++; expect(unwrapR(committed(body) as never as { ok: true; value: { root: string } }).root).toBe(o.root!); }
      }
    }
    expect(accepted).toBeGreaterThan(40);
  });
});

// ---------- Account outputs: htlc_error, swap cancel, request_collateral_committed, directPaymentForward (og tx/mutation.ts, apply-result.ts) ----------
const FINAL = W("33");
/** The rewrite's perspective-free effects, as og's outcome/candidateEffects from the given local side (og proofHeader.fromEntity). */
const ogOutputsOf = (r: any, effects: any[]): unknown[] => {
  const out: unknown[] = [];
  if (r.outcome === "htlc_secret") out.push({ _tag: "forward_secret", hashlock: r.hashlock, secret: r.secret });
  if (r.outcome === "htlc_error") out.push({ _tag: "htlc_error", lockId: r.lockId, hashlock: r.hashlock, tokenId: Number(r.tokenId), amount: r.amount, ...(r.reason === undefined ? {} : { reason: r.reason }) });
  if (r.outcome === "swap_cancel_requested") out.push({ _tag: "swap_cancel_requested", offerId: r.swapOfferCancelRequested.offerId });
  if (r.outcome === "swap_cancelled") out.push({ _tag: "swap_cancelled", offerId: r.swapOfferCancelled.offerId, makerId: r.swapOfferCancelled.accountId });
  for (const e of [...effects, ...(r.candidateEffects ?? [])]) {
    if (e.kind === "runtimeEvent" && e.eventName === "request_collateral_committed")
      out.push({ _tag: "request_collateral_committed", tokenId: e.data.tokenId, requestedAmount: BigInt(e.data.requestedAmount), prepaidFee: BigInt(e.data.prepaidFee), requestedAt: e.data.requestedAt });
    if (e.kind === "directPaymentForward")
      out.push({ _tag: "direct_payment_forward", tokenId: e.tokenId, amount: e.amount, route: e.route, ...(e.description ? { description: e.description } : {}), trustedGatewayEntityId: e.trustedGatewayEntityId });
  }
  return out;
};
const ogMutationTx = (tx: any): any => {
  if (tx.type !== "payment") return toOg(tx);
  const { type: _t, ...data } = tx;
  return { type: "direct_payment", data: { ...data, tokenId: Number(data.tokenId) } };
};

describe(seedTag("cross-j: Account outputs through og applyAccountTxMutation"), () => {
  test("MATCH: 40 random sequences: accept/reject, Account root, and outputs (htlc_error, swap_cancel_requested, swap_cancelled, request_collateral_committed, directPaymentForward) agree", async () => {
    const r = rng(303);
    const seen = new Set<string>();
    for (let n = 0; n < 40; n++) {
      const start = openAccount(10n ** 22n);
      const og = ogHarness(start);
      let body = start;
      const secrets: string[] = [], offers: string[] = [];
      for (let i = 0; i < 14; i++) {
        const byLeft = r() < 0.5, me = byLeft ? LEFT : RIGHT, peer = byLeft ? RIGHT : LEFT, ts = 10 + i, jh = 1 + Math.floor(i / 3);
        let tx: any;
        const k = Math.floor(r() * 7);
        if (k === 0) tx = r() < 0.5
          ? { type: "payment", tokenId: "1", amount: 1n + BigInt(Math.floor(r() * 100)), route: [peer, FINAL], description: pick(r, ["", "memo"]), fromEntityId: me, toEntityId: peer, deliveryMode: "trusted", trustedGatewayEntityId: peer }
          : { type: "payment", tokenId: "1", amount: 1n + BigInt(Math.floor(r() * 100)), route: [peer], fromEntityId: me, toEntityId: peer, deliveryMode: "direct" };
        else if (k === 1) tx = { type: "request_collateral", tokenId: pick(r, ["1", "2"]), amount: BigInt(Math.floor(r() * 50)), ...(r() < 0.5 ? { feeTokenId: "2" } : {}), feeAmount: BigInt(Math.floor(r() * 10)), policyVersion: 1 };
        else if (k === 2) { const id = `off${i}`; offers.push(id); tx = { type: "swap_offer", offerId: id, giveTokenId: "1", giveTokenDecimals: 18, giveAmount: 10n ** 15n, wantTokenId: "2", wantTokenDecimals: 18, wantAmount: 2n * 10n ** 15n, maxFee: 0n, minNetReceive: 2n * 10n ** 15n }; }
        else if (k === 3 && offers.length > 0) tx = { type: "swap_cancel_request", offerId: pick(r, offers) };
        else if (k === 4 && offers.length > 0) tx = { type: "swap_resolve", offerId: pick(r, offers), fillRatio: 0, cancelRemainder: true };
        else if (k === 5) { const secret = hex(r, 32); secrets.push(secret); const h = ethers.keccak256(secret); tx = { type: "htlc_lock", lockId: h, hashlock: h, timelock: 10n ** 6n, revealBeforeHeight: 100n, amount: 5n, tokenId: "1" }; }
        else if (secrets.length > 0) { const secret = pick(r, secrets), h = ethers.keccak256(secret); tx = r() < 0.5 ? { type: "htlc_resolve", lockId: h, outcome: "secret", secret } : { type: "htlc_resolve", lockId: h, outcome: "error", ...(r() < 0.5 ? { reason: pick(r, ["no_route", "timeout"]) } : {}) }; }
        else continue;
        const ogTx = ogMutationTx(tx);
        if (tx.type === "htlc_lock") ogTx.data.revealBeforeHeight = 100;
        const effects: any[] = [];
        const o = await og.run((acc) => applyAccountTxMutation(acc, ogTx, byLeft, ts, jh, false, undefined, undefined, undefined, effects));
        const rw = applyAccountBody(body, tx, { byLeft, nowMs: BigInt(ts), jHeight: BigInt(jh), accountHeight: 1n }) as any;
        if (rw.ok !== o.ok) throw new Error(`accept mismatch og=${o.ok}(${o.error}) rw=${rw.ok ? "ok" : stableJson(rw.error)} tx=${stableJson(tx)}`);
        if (!rw.ok) continue;
        body = rw.value.state;
        expect(unwrapR(committed(body) as never as { ok: true; value: { root: string } }).root).toBe(o.root!);
        // og runs this Account from LEFT's side: a forward is emitted only where LEFT is the trusted gateway.
        // swap_offer_upsert is og's frame-boundary output (same-j-swap-output.ts), not an applyAccountTxMutation outcome; diff/book-admission.test.ts covers it.
        const mine = rw.value.effects.filter((e: any) => e._tag !== "swap_offer_upsert" && (e._tag !== "direct_payment_forward" || e.trustedGatewayEntityId === LEFT));
        expect(stableJson(mine)).toBe(stableJson(ogOutputsOf(o.value, effects)));
        for (const e of rw.value.effects) seen.add(e._tag);
      }
    }
    for (const tag of ["forward_secret", "htlc_error", "swap_cancel_requested", "swap_cancelled", "request_collateral_committed", "direct_payment_forward"]) expect(seen.has(tag)).toBe(true);
  });
});

// ---------- replica shadow: rebalance submittedAtByToken (og refund.ts, j-events/finality.ts, envelope/entity-update.ts) ----------
describe(seedTag("cross-j: submittedAtByToken shadow"), () => {
  const shadowRoot = (og: ReturnType<typeof ogHarness>): string => og.replica().shadow.rebalance.submittedAtByToken.rootHash();
  const requested = (body: AccountBody, byLeft: boolean, tokenId: string, fee: bigint): AccountBody =>
    unwrapR(applyAccountBody(body, { type: "request_collateral", tokenId, amount: 1000n, feeAmount: fee, policyVersion: 1 } as never, { byLeft, nowMs: 5n, jHeight: 1n, accountHeight: 2n }) as never as { ok: true; value: { state: AccountBody } }).state;

  test("MATCH: 120 random refunds clear the marker exactly when og does (full refund only), with the same shadow root", async () => {
    const r = rng(404);
    let cleared = 0;
    for (let n = 0, more = untilCovered(30, () => cleared > 5); more(n); n++) {
      const requesterIsLeft = r() < 0.5, fee = BigInt(2 + Math.floor(r() * 8));
      let body = requested(openAccount(10n ** 6n), requesterIsLeft, "1", fee);
      for (const tk of [1, 2, 3]) if (r() < 0.7) body = setRebalanceSubmittedAt(body, tk, 100 + tk);
      const og = ogHarness(body);
      expect(shadowRoot(og)).toBe(unwrapR(submittedAtRoot(body)));
      const requestId = body.requestFees.get("1" as never)!.requestId;
      for (let i = 0; i < 4; i++) {
        const tx: any = { type: "rebalance_refund", requestId: r() < 0.9 ? requestId : "other", requestTokenId: "1", amount: BigInt(1 + Math.floor(r() * Number(fee))), reason: r() < 0.9 ? "manual" : "timeout" };
        const byLeft = r() < 0.85 ? !requesterIsLeft : requesterIsLeft;
        const o = await og.run((acc) => applyAccountTxMutation(acc, toOg(tx), byLeft, 9, 1, false, undefined, undefined, undefined, []));
        const rw = applyAccountBody(body, tx, { byLeft, nowMs: 9n, jHeight: 1n, accountHeight: 3n }) as any;
        expect(rw.ok).toBe(o.ok);
        if (!rw.ok) continue;
        const had = body.submittedAt?.has(1) ?? false;
        body = rw.value.state;
        if (had && !(body.submittedAt?.has(1) ?? false)) cleared++;
        expect(unwrapR(committed(body) as never as { ok: true; value: { root: string } }).root).toBe(o.root!);
        expect(unwrapR(submittedAtRoot(body))).toBe(shadowRoot(og));
      }
    }
    expect(cleared).toBeGreaterThan(5);
  });

  test("MATCH: J finality that raises collateral against a pending request clears that token's marker (partial and full cover)", async () => {
    for (const cover of [400n, 1000n, 5000n, 0n]) for (const alsoOther of [false, true]) {
      let body = requested(openAccount(10n ** 6n), true, "1", 5n);
      body = setRebalanceSubmittedAt(setRebalanceSubmittedAt(body, 1, 77), 2, 88);
      const og = ogHarness(body);
      const tokens = [{ tokenId: 1n, leftReserve: 0n, rightReserve: 0n, collateral: cover, ondelta: 0n }, ...(alsoOther ? [{ tokenId: 2n, leftReserve: 0n, rightReserve: 0n, collateral: 50n, ondelta: 0n }] : [])];
      const claim: any = { type: "j_event_claim", jHeight: 10n, jBlockHash: W("0a"), observedAt: 1n, events: [{ left: LEFT, right: RIGHT, nonce: 1n, tokens }] };
      for (const byLeft of [true, false]) body = unwrapR(applyAccountBody(body, claim, { byLeft, nowMs: 9n, jHeight: 10n, accountHeight: 3n }) as never as { ok: true; value: { state: AccountBody } }).state;
      const ogEvents = tokens.map((t) => ({ type: "AccountSettled", data: { leftEntity: LEFT, rightEntity: RIGHT, tokenId: Number(t.tokenId), leftReserve: "0", rightReserve: "0", collateral: t.collateral.toString(), ondelta: "0", nonce: 1 } }));
      expect((await og.run((acc) => { applyFinalizedAccountJEventsOnView(acc, RIGHT, ogEvents as never, `0x${"de".repeat(20)}`); return { ok: true }; })).ok).toBe(true);
      expect(unwrapR(submittedAtRoot(body))).toBe(shadowRoot(og));
      expect(body.submittedAt?.has(1)).toBe(cover === 0n);
      expect(body.submittedAt?.has(2)).toBe(true);
    }
  });
});

// ---------- pull registry settlement (og account/pull-registry-settlement.ts) ----------
describe(seedTag("cross-j: pull registry settlement"), () => {
  const BATCH = ethers.ParamType.from(BATCH_ABI);
  const DT = `0x${"d7".repeat(20)}`;
  const encodeBatch = (pulls: Array<{ amount: bigint; claimedRatio: number; fullHash: string; partialRoot: string; targetRole: boolean }>, payments = 0): string =>
    ethers.AbiCoder.defaultAbiCoder().encode([BATCH], [{
      payment: Array.from({ length: payments }, (_, i) => ({ deltaIndex: i, amount: { negative: false, magnitude: 5n }, revealedUntilTimestamp: 1, hash: W("aa") })),
      swap: [],
      pull: pulls.map((p, i) => ({ deltaIndex: i, amount: { negative: p.amount < 0n, magnitude: p.amount < 0n ? -p.amount : p.amount }, claimedRatio: p.claimedRatio, fullHash: p.fullHash, partialRoot: p.partialRoot, targetRole: p.targetRole })),
    }]);
  const corrupt = (r: Rand, hexText: string): string => {
    const k = Math.floor(r() * 8), body = hexText.slice(2);
    if (k === 0) return hexText.slice(0, 2 + 2 * Math.floor(r() * (body.length / 2)));
    if (k === 1) return hexText + "0";
    if (k === 2) { const at = 64 * Math.floor(r() * Math.min(8, body.length / 64)) + 62; return `0x${body.slice(0, at)}${hex(r, 1).slice(2)}${body.slice(at + 2)}`; }
    if (k === 3) { const at = 64 * Math.floor(r() * Math.min(8, body.length / 64)); return `0x${body.slice(0, at)}${"ff".repeat(32)}${body.slice(at + 64)}`; }
    if (k === 4) { const at = 64 * Math.floor(r() * Math.min(8, body.length / 64)); return `0x${body.slice(0, at)}${"00".repeat(24)}${"ff".repeat(8)}${body.slice(at + 64)}`; }
    return hexText;
  };
  const leg = (r: Rand): CrossPullLeg => ({ pullId: W("01"), tokenId: 1, amount: 5n, signedAmount: pick(r, [5n, -5n, 7n]), fullHash: pick(r, [W("f1"), W("F2")]), partialRoot: pick(r, [W("e1"), W("e2")]) });

  test("MATCH: findExactSignedProofBodyPull over 500 random (and corrupted) DeltaTransformer batches", () => {
    const r = rng(505);
    let found = 0, rejected = 0;
    for (let i = 0, more = untilCovered(500, () => found > 3 && rejected > 20); more(i); i++) {
      const pulls = Array.from({ length: Math.floor(r() * 4) }, () => ({ amount: pick(r, [5n, -5n, 7n, 0n]), claimedRatio: Math.floor(r() * 65_536), fullHash: pick(r, [W("f1"), W("f2")]), partialRoot: pick(r, [W("e1"), W("e2")]), targetRole: r() < 0.5 }));
      const batch = corrupt(r, encodeBatch(pulls, Math.floor(r() * 2)));
      const clauses = [{ transformerAddress: pick(r, [DT, DT.toUpperCase().replace("0X", "0x"), `0x${"11".repeat(20)}`]), encodedBatch: batch, allowances: [] },
        ...(r() < 0.2 ? [{ transformerAddress: DT, encodedBatch: encodeBatch(pulls), allowances: [] }] : [])];
      const proofbody: any = { transformers: clauses, leftResponseSeconds: 10n, rightResponseSeconds: 20n };
      const addr = pick(r, [DT, DT, ethers.getAddress(DT), "0x1234", DT.slice(2)]);
      const expected = leg(r), targetRole = r() < 0.5;
      const og = ogTry(() => findExactSignedProofBodyPull(proofbody, expected as never, targetRole, addr));
      agree(og, findSignedProofBodyPull(proofbody, expected, targetRole, addr));
      if (og.ok && og.value !== undefined) found++;
      if (!og.ok) rejected++;
    }
    expect(found).toBeGreaterThan(3);
    expect(rejected).toBeGreaterThan(20);
  });

  test("MATCH: resolveFinalizedPullFillRatio (beneficiary window, late records, clock mismatch) and resolveFinalizedCrossJurisdictionRouteLeg", () => {
    const r = rng(606);
    for (let i = 0; i < 400; i++) {
      const expected = leg(r), targetRole = r() < 0.5, claimedRatio = Math.floor(r() * 1000);
      const batch = encodeBatch([{ amount: expected.signedAmount, claimedRatio, fullHash: expected.fullHash.toLowerCase(), partialRoot: expected.partialRoot.toLowerCase(), targetRole: r() < 0.8 ? targetRole : !targetRole }]);
      const left = pick(r, [10n, 60n]), right = pick(r, [20n, 90n]), start = 1_000 + Math.floor(r() * 10);
      const proofbody: any = { transformers: [{ transformerAddress: DT, encodedBatch: batch, allowances: [] }], leftResponseSeconds: left, rightResponseSeconds: right };
      const active = r() < 0.1 ? undefined : { disputeStartTimestamp: start, disputeTimeout: start + Number(left + right) + (r() < 0.1 ? 1 : 0) };
      const record = r() < 0.2 ? undefined : { fillRatio: pick(r, [0, 500, 999, 5000, 65_535, 70_000]), revealedAt: start + pick(r, [-1, 0, 5, 10, 20, 60, 90, 200]) };
      const og = ogTry(() => resolveFinalizedPullFillRatio({ account: { activeDispute: active } as never, proofbody, canonicalDeltaTransformerAddress: DT, expectedPull: expected as never, targetRole, ...(record ? { record } : {}) }));
      agree(og, finalizedPullFillRatio({ active, proofbody, transformerAddress: DT, expectedPull: expected, targetRole, record }));
      const route = randomRoute(r), self = pick(r, [...ENTS]), peer = pick(r, [...ENTS]), localStack = r() < 0.1 ? undefined : pick(r, [...STACKS, STACKS[0].toUpperCase()]);
      agree(ogTry(() => resolveFinalizedCrossJurisdictionRouteLeg({ route: route as never, self, counterparty: peer, ...(localStack ? { localStack } : {}) })), finalizedRouteLeg({ route, self, counterparty: peer, localStack }));
    }
  });
});
