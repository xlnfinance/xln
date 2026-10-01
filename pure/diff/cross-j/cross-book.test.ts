// Cross-jurisdiction hub order book: og extensions/cross-j/orderbook.ts (admissions, USD caps, market offer, instructions),
// entity/tx/handlers/account/orderbook/cross/* (the cross pass inside processOrderbookSwaps) and cancels.ts (cross branch). Every MATCH runs live og.
import { describe, expect, test } from "bun:test";
import { seedOf, seedTag } from "../seed.ts";
import * as ogOB from "../../../core/extensions/cross-j/orderbook.ts";
import * as ogCrossIndex from "../../../core/extensions/cross-j/index.ts";
import { createEmptyEntityCollectionCandidate, entityCollectionCommitment as ogCollectionCommitment } from "../../../core/entity/state/persistent-collection-map.ts";
import { getSwapPairOrientation } from "../../../core/account/utils.ts";
import * as ogBook from "../../../core/orderbook/core.ts";
import { computeBookCommitmentHash } from "../../../core/orderbook/commitment.ts";
import { rebuildOrderbookPairIndex } from "../../../core/orderbook/order-index.ts";
import { getSwapExactQuoteLotMultipleAtPriceForDimensions } from "../../../core/orderbook/types.ts";
import { markWorkingOrderbookOffer, normalizeSwapOfferForOrderbook } from "../../../core/orderbook/swap-execution.ts";
import { processOrderbookSwaps as ogProcessSwaps } from "../../../core/entity/tx/handlers/account/orderbook/index.ts";
import { processOrderbookCancels as ogProcessCancels } from "../../../core/entity/tx/handlers/account/orderbook/cancels.ts";
import { buildCrossMarketOfferFromBookOrder } from "../../../core/entity/tx/handlers/account/orderbook/helpers.ts";
import { commitBookOverlay } from "../../../core/orderbook/book-overlay.ts";
import {
  applyBookCommand, applyCrossFill, createBook, crossMarket, bookAdmissionError, bookAdmissionFailure, bookAdmissionKey, bookCommitmentHash, bookOrders, crossCancelInstruction, crossExecutionAmounts, crossExecutionPrice,
  crossFillInstruction, crossLegUsdMicros, crossLocalUsdCapError, crossMarketOffer, crossRemaining, entityCollectionCommitment, markAdmissionClosed, markAdmissionResolving, mergeBookAdmission,
  prepareCrossRoute, processOrderbookCancels, processOrderbookSwaps, stableJson, tradesMatched,
  type Binary, type Book, type BookAdmission, type BookAdmissions, type BookOfferInput, type CrossBookOffer, type CrossMarketOffer, type CrossRoute, type Domain, type EntityError, type EntityId, type Hub,
  type HubAccount, type OrderbookExt, type Result, type SwapOffer,
} from "../../xln.ts";
import { unwrap } from "../../xln_run.ts";

const rng = (base: number) => { let seed = seedOf(base); return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
type Rand = () => number;
const int = (r: Rand, n: number): number => Math.floor(r() * n);
const pick = <T,>(r: Rand, xs: readonly T[]): T => xs[int(r, xs.length)] as T;
type Out<T> = { ok: true; value: T } | { ok: false; message: string };
const ogRun = <T,>(f: () => T): Out<T> => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, message: (e as Error).message }; } };
const rwRun = <T,>(r: Result<T, EntityError>): Out<T> => (r.ok ? { ok: true, value: r.value } : { ok: false, message: r.error._tag === "entity_invariant" ? r.error.reason : r.error._tag });
const same = (label: string, og: Out<unknown>, rw: Out<unknown>): void => { expect(`${label}:${stableJson(rw)}`).toBe(`${label}:${stableJson(og)}`); };

const J1: Domain = { chainId: 1, depositoryAddress: "0x" + "11".repeat(20) }, J2: Domain = { chainId: 31337, depositoryAddress: "0x" + "ab".repeat(20) };
const S1 = `stack:1:${J1.depositoryAddress}`, S2 = `stack:31337:${J2.depositoryAddress}`;
const W = (b: string) => ("0x" + b.repeat(32)) as EntityId;
const U1 = W("01"), H1 = W("02"), H2 = W("03"), U2 = W("04");
const T0 = 1_700_000_050_000, CLOCK60 = { leftResponseSeconds: 60, rightResponseSeconds: 60 }, RUNTIME_SEED = "0x" + "5e".repeat(32);
const ogJur = (d: Domain) => ({ name: "J", chainId: d.chainId, depositoryAddress: d.depositoryAddress });

const routeOf = (r: Rand, o: Partial<CrossRoute> & { sourceToken?: number; targetToken?: number; sourceAmount?: bigint; targetAmount?: bigint } = {}): CrossRoute => {
  const { sourceToken, targetToken, sourceAmount, targetAmount, ...rest } = o;
  return {
    orderId: `order-${int(r, 1e6)}`, makerEntityId: U1, hubEntityId: H1,
    source: { jurisdiction: S1, entityId: U1, counterpartyEntityId: H1, tokenId: sourceToken ?? pick(r, [1, 1, 3, 2]), amount: sourceAmount ?? pick(r, [10n ** 6n, 5n * 10n ** 9n, 7n * 10n ** 12n, BigInt(1 + int(r, 1e9))]) },
    target: { jurisdiction: S2, entityId: H2, counterpartyEntityId: U2, tokenId: targetToken ?? pick(r, [1, 2, 3, 4]), amount: targetAmount ?? pick(r, [10n ** 6n, 10n ** 18n, 7n * 10n ** 12n, BigInt(1 + int(r, 1e9))]) },
    sourceDisputeConfig: CLOCK60, targetDisputeConfig: CLOCK60, status: "intent", createdAt: T0 - 1000, updatedAt: T0 - 1000, expiresAt: T0 + 60_000,
    sourceSignerId: "0x" + "a1".repeat(20), sourceHubSignerId: "0x" + "a2".repeat(20), targetHubSignerId: "0x" + "a3".repeat(20), targetSignerId: "0x" + "a4".repeat(20),
    ...rest,
  };
};
/** A prepared route (both pulls, canonical hash) optionally progressed by one or two exact fills. */
const progressed = (r: Rand, route: CrossRoute, status: CrossRoute["status"] = "resting"): CrossRoute => {
  let c = unwrap(prepareCrossRoute(route, { runtimeSeed: RUNTIME_SEED, now: T0 - 500 }));
  c = { ...c, status };
  for (let k = int(r, 3); k > 0; k--) {
    const num = BigInt(1 + int(r, 999)), den = 1000n, next = applyCrossFill(c, { cumulativeFillRatio: Number((num * 65_535n) / den), fillNumerator: num, fillDenominator: den }, T0 - 100);
    if (next.ok && next.value.status !== "clear_requested") c = { ...next.value, status: pick(r, ["partially_filled", "partially_filled", "resting"] as const) };
  }
  return c;
};

// ============ og USD risk caps (crossJurisdictionLegUsdMicros / getCrossJurisdictionLocalUsdCapError), priced through orderbookExt ============
describe(seedTag("cross-book: USD caps"), () => {
  const extOf = (r: Rand): { rw: OrderbookExt; og: unknown } | undefined => {
    if (int(r, 5) === 0) return undefined;
    const referenceTokenId = pick(r, [1, 1, 3, 4, 2, 5]);
    const books = new Map<string, { lastAcceptedUsdAskPriceTicks: bigint }>();
    for (const t of [1, 2, 3, 4, 5]) if (t !== referenceTokenId && int(r, 3) > 0) books.set(getSwapPairOrientation(t, referenceTokenId).pairId, { lastAcceptedUsdAskPriceTicks: pick(r, [0n, 1n, 10_000n, 25_000_000n, BigInt(int(r, 1e9))]) });
    const hubProfile = { referenceTokenId };
    return { rw: { books, hubProfile } as unknown as OrderbookExt, og: { books, hubProfile } };
  };
  test("MATCH: 600 random (ext, token, amount): og crossJurisdictionLegUsdMicros value / halt equals the rewrite's", () => {
    const r = rng(0xc0ffee), seen = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const ext = extOf(r), tokenId = pick(r, [1, 2, 3, 4, 5, 99, 0]), amount = pick(r, [0n, 1n, 10n ** 6n, 10n ** 18n, BigInt(int(r, 1e12)), -5n]);
      const og = ogRun(() => ogOB.crossJurisdictionLegUsdMicros({ orderbookExt: ext?.og } as never, tokenId, amount)), rw = rwRun(crossLegUsdMicros(ext?.rw, tokenId, amount));
      same(`${i}`, og, rw);
      seen.add(og.ok ? "ok" : og.message.split(":")[0]!);
    }
    // an unknown token never reaches getTokenInfo: it has no reference-pair ask, so it is unpriced first
    expect([...seen].sort()).toEqual(["CROSS_J_BOOK_USD_AMOUNT_INVALID", "CROSS_J_BOOK_USD_REFERENCE_INVALID", "CROSS_J_USD_PRICE_UNAVAILABLE", "ok"]);
  });
  test("MATCH: 600 random routes and hub views: og getCrossJurisdictionLocalUsdCapError (leg selection, $6.5m cap, unpriced is permissionless) equals the rewrite's", () => {
    const r = rng(0xca9), seen = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const ext = extOf(r), route = routeOf(r, { sourceAmount: pick(r, [10n ** 6n, 6_500_000n * 10n ** 6n, 6_500_000n * 10n ** 6n + 1n, 10n ** 13n, 10n ** 24n, BigInt(1 + int(r, 1e12))]),
        targetAmount: pick(r, [10n ** 6n, 6_500_000n * 10n ** 6n, 6_500_000n * 10n ** 6n + 1n, 10n ** 25n, BigInt(1 + int(r, 1e12))]) });
      const who = pick(r, [H1, H1, H2, H2, U1, U2]), dom = pick(r, [J1, J2, who === H1 ? J1 : J2]);
      const fixed = int(r, 6) === 0 ? { ...route, target: { ...route.target, entityId: H1, jurisdiction: S1 } } : route;
      const og = ogRun(() => ogOB.getCrossJurisdictionLocalUsdCapError({ entityId: who, config: { jurisdiction: ogJur(dom) }, orderbookExt: ext?.og } as never, fixed as never));
      const rw = rwRun(crossLocalUsdCapError({ id: who, jurisdiction: dom, ext: ext?.rw }, fixed));
      same(`${i}`, og, rw);
      seen.add(!og.ok ? `halt:${og.message.split(":")[0]}` : og.value === null ? "null" : og.value.split(":")[0]!);
    }
    for (const k of ["null", "CROSS_J_BOOK_USD_CAP_EXCEEDED", "CROSS_J_BOOK_USD_VALIDATOR_LEG_INVALID"]) expect([k, seen.has(k)]).toEqual([k, true]);
  });
});

// ============ og book admissions: merge / resolving / closed / admission error, collection roots ============
describe(seedTag("cross-book: admissions"), () => {
  const rwRoot = (m: BookAdmissions | undefined) => (m === undefined ? null : unwrap(entityCollectionCommitment(new Map([...m].map(([k, v]) => [k, v as unknown as Binary])))));
  const entries = (m: ReadonlyMap<string, unknown> | undefined) => (m === undefined ? null : [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  test("MATCH: 60 random admission streams (merge, resolving, closed, error, typed failure): same entries, collection roots and errors as og", () => {
    const r = rng(0xad1), kinds = new Map<string, number>();
    for (let s = 0; s < 60; s++) {
      const ogState: any = { entityId: pick(r, [H1, H1, H2]) };
      let rw: BookAdmissions | undefined;
      const routes: CrossRoute[] = [];
      for (let k = 0; k < 14; k++) {
        const now = T0 + k, op = int(r, 6);
        const base = routes.length > 0 && int(r, 3) > 0 ? pick(r, routes) : progressed(r, routeOf(r, { sourceToken: 1, targetToken: 2, sourceAmount: 10n ** 9n, targetAmount: 10n ** 21n }), pick(r, ["resting", "target_prepared", "intent"] as const));
        const route: CrossRoute = int(r, 6) === 0 ? { ...base, status: pick(r, ["partially_filled", "resting", "clear_requested"] as const), updatedAt: now }
          : int(r, 10) === 0 ? { ...base, bookOwnerEntityId: H2 } : int(r, 12) === 0 ? { ...base, expiresAt: T0 - 1 } : int(r, 12) === 0 ? { ...base, routeHash: "0x" + "77".repeat(32) } : base;
        if (!routes.includes(base)) routes.push(base);
        const label = `${s}/${k}/${op}`;
        if (op <= 1) {
          const og = ogRun(() => ogOB.mergeCrossJurisdictionBookAdmission(ogState, route as never, now)), res = rwRun(mergeBookAdmission(rw, route, now));
          same(label, og, res.ok ? { ok: true, value: res.value.admission } : res);
          if (res.ok) rw = res.value.admissions;
        } else if (op === 2) {
          const og = ogRun(() => ogOB.markCrossJurisdictionBookAdmissionResolving(ogState, route as never, now)), res = rwRun(markAdmissionResolving(rw, route, now));
          same(label, og.ok ? { ok: true, value: null } : og, res.ok ? { ok: true, value: null } : res);
          if (res.ok) rw = res.value;
        } else if (op === 3) {
          const reason = pick(r, ["filled", "cancelled", ""]), source = pick(r, [route.source.entityId, route.source.entityId.toUpperCase().replace("0X", "0x"), U2]);
          ogOB.markCrossJurisdictionBookAdmissionClosed(ogState, source, route.orderId, now, reason);
          rw = unwrap(markAdmissionClosed(rw, source, route.orderId, now, reason));
        } else {
          const og = ogRun(() => ogOB.getCrossJurisdictionBookAdmissionError(ogState, route as never, now)), res = rwRun(bookAdmissionError(ogState.entityId, rw, route, now));
          same(label, og, res);
          const typed = rwRun(bookAdmissionFailure(ogState.entityId, rw, route, now));
          if (og.ok) {
            kinds.set(og.value === null ? "admissible" : og.value.split(":")[0]!, (kinds.get(og.value === null ? "admissible" : og.value.split(":")[0]!) ?? 0) + 1);
            const kind = og.value === null ? null : ogOB.isCrossJurisdictionBookAdmissionPending(og.value) ? "pending" : ogOB.isCrossJurisdictionBookRiskRejection(og.value) ? "risk_reject" : "invalid";
            expect([label, typed.ok && (typed.value?.kind ?? null)]).toEqual([label, kind]);
          }
        }
        expect([label, stableJson(entries(rw))]).toEqual([label, stableJson(entries(ogState.crossJurisdictionBookAdmissions))]);
        // og's candidate caches its projection until the frame seals, so the og root is taken over a fresh copy of its entries
        expect([label, rwRoot(rw)]).toEqual([label, ogState.crossJurisdictionBookAdmissions === undefined ? null : ogCollectionCommitment(new Map(ogState.crossJurisdictionBookAdmissions))]);
      }
    }
    for (const k of ["admissible", "CROSS_J_BOOK_ADMISSION_PENDING", "CROSS_J_BOOK_ADMISSION_CLOSED", "CROSS_J_BOOK_ADMISSION_RESOLVING", "CROSS_J_ORDER_WRONG_BOOK_OWNER"]) expect([k, (kinds.get(k) ?? 0) > 0]).toEqual([k, true]);
  }, 50_000);
});

// ============ og buildCrossJurisdictionMarketOffer, remaining amounts, execution price / amounts, fill and cancel instructions ============
describe(seedTag("cross-book: market offer and instructions"), () => {
  const offerOf = (route: CrossRoute, accountId: string): CrossBookOffer => ({
    offerId: route.orderId, accountId, makerIsLeft: true, fromEntity: route.source.entityId, toEntity: route.source.counterpartyEntityId, createdHeight: 1,
    giveTokenId: Number(route.source.tokenId), giveTokenDecimals: 6, giveAmount: BigInt(route.source.amount), wantTokenId: Number(route.target.tokenId), wantTokenDecimals: 18, wantAmount: BigInt(route.target.amount),
    maxFee: 0n, minNetReceive: BigInt(route.target.amount), priceTicks: 1n, timeInForce: 0, crossJurisdiction: route,
  });
  test("MATCH: 500 random progressed routes: og remaining amounts, market offer, execution price and amounts, fill and cancel instructions", () => {
    const r = rng(0x1417), seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const route = progressed(r, routeOf(r, { sourceToken: pick(r, [1, 2, 3]), targetToken: pick(r, [1, 2, 4]) }), pick(r, ["resting", "partially_filled", "resting", "target_prepared"] as const));
      const withOwner = int(r, 8) === 0 ? { ...route, bookOwnerEntityId: pick(r, [H1, H2]) } : route;
      const offer = offerOf(withOwner, U1), hub = pick(r, [H1, H1, H2]);
      same(`${i}:remaining`, ogRun(() => ogOB.getCrossJurisdictionRouteRemainingAmounts(withOwner as never)), rwRun(crossRemaining(withOwner)));
      const og = ogRun(() => ogOB.buildCrossJurisdictionMarketOffer(offer as never, hub)), rw = rwRun(crossMarketOffer(offer, hub));
      same(`${i}:market`, og, rw);
      seen.add(!og.ok ? "halt" : og.value === null ? "null" : "offer");
      if (!og.ok || og.value === null || !rw.ok || rw.value === null) continue;
      const meta = rw.value, ogMeta = og.value;
      const fill = { filledLots: BigInt(int(r, 3) === 0 ? 0 : 1 + int(r, 5000)), weightedCost: BigInt(int(r, 1e9)), ...(int(r, 3) === 0 ? { cancelRemainder: true } : {}) };
      same(`${i}:exec`, ogRun(() => ogOB.crossJurisdictionExecutionAmounts(ogMeta, fill)), rwRun(crossExecutionAmounts(meta, fill)));
      const ogFill = ogRun(() => ogOB.buildCrossJurisdictionFillInstruction(U1, route.orderId, `${U1}:${route.orderId}`, ogMeta, fill));
      same(`${i}:fill`, ogFill, rwRun(crossFillInstruction(U1, route.orderId, `${U1}:${route.orderId}`, meta, fill)));
      seen.add(!ogFill.ok ? "fill-halt" : ogFill.value === null ? "fill-null" : "fill");
      same(`${i}:cancel`, ogRun(() => ogOB.buildCrossJurisdictionCancelInstruction(U1, route.orderId, `${U1}:${route.orderId}`, withOwner as never)), rwRun(crossCancelInstruction(U1, route.orderId, `${U1}:${route.orderId}`, withOwner)));
      const other: CrossMarketOffer = { ...meta, side: pick(r, [0, 1, meta.side === 1 ? 0 : 1] as const), priceTicks: pick(r, [meta.priceTicks, meta.priceTicks + 1n, meta.priceTicks - 1n, 0n]), pairId: int(r, 10) === 0 ? "x" : meta.pairId };
      same(`${i}:price`, ogRun(() => ogOB.resolveCrossJurisdictionExecutionPriceTicks(ogMeta, other as never)), rwRun(crossExecutionPrice(meta, other)));
    }
    for (const k of ["null", "offer", "fill", "fill-null"]) expect([k, seen.has(k)]).toEqual([k, true]);
  }, 30_000);
});

// ============ og cross pass inside processOrderbookSwaps and the cross branch of processOrderbookCancels ============
describe(seedTag("cross-book: hub cross matcher"), () => {
  const HUB = H1, LOCAL = [W("0b"), W("01"), W("cc")] as EntityId[], REMOTE = [W("e1"), W("e2"), W("0e")] as EntityId[];
  const DEC: Readonly<Record<number, number>> = { 1: 6, 2: 18, 3: 6, 4: 6 };
  const lotOf = (d: number) => 10n ** BigInt(Math.max(0, d - 6));
  const leftOf = (u: string) => (u < HUB ? u : HUB), rightOf = (u: string) => (u < HUB ? HUB : u);
  /** Route amounts for `lots` base lots at `price` on the route's canonical venue (exact-quote aligned unless `skew`). */
  const sized = (route: CrossRoute, price: bigint, k: bigint, skew: boolean): CrossRoute => {
    const m = unwrap(crossMarket(route)), baseTok = Number(m.sourceIsBase ? route.source.tokenId : route.target.tokenId), quoteTok = Number(m.sourceIsBase ? route.target.tokenId : route.source.tokenId);
    const bd = DEC[baseTok]!, qd = DEC[quoteTok]!, multiple = getSwapExactQuoteLotMultipleAtPriceForDimensions(bd, qd, price);
    const base = (k * multiple + (skew ? 1n : 0n)) * lotOf(bd), quote = (base * price * 10n ** BigInt(qd)) / (10_000n * 10n ** BigInt(bd));
    return { ...route, source: { ...route.source, amount: m.sourceIsBase ? base : quote }, target: { ...route.target, amount: m.sourceIsBase ? quote : base } };
  };
  const toOgTx = (tx: { type: string }) => { const { type, ...data } = tx; return { type, data }; };
  test("MATCH: 200 random hub states (local and remote admitted rows, incoming cross offers, cancels): same fills, cancel instructions, resolves, books and halts as og", () => {
    const r = rng(0xc2055), kinds = new Map<string, number>();
    const bump = (k: string) => kinds.set(k, (kinds.get(k) ?? 0) + 1);
    for (let s = 0; s < 200; s++) {
      const [ta, tb] = pick(r, [[1, 2], [1, 3], [2, 4]] as const), mid = pick(r, [20_000n, 12_345n, 3_000_000n]);
      const hubProfile = { entityId: HUB, name: "hub", spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 }, referenceTokenId: 1, usdQuoteAuthorityEntityId: W("99"), minTradeSize: 0n, supportedPairs: [] };
      const ogExt: any = { books: new Map(), orderPairs: new Map(), pairDimensions: new Map(), referrals: new Map(), hubProfile };
      const offers = new Map<string, Map<string, SwapOffer>>(LOCAL.map((u) => [u, new Map()])), mempool = new Map<string, { type: string; offerId: string }[]>(LOCAL.map((u) => [u, []]));
      const active = new Map(LOCAL.map((u) => [u, int(r, 15) > 0])), admissions = new Map<string, BookAdmission>(), mirror = new Map<string, CrossRoute>();
      const incoming: BookOfferInput[] = [], rows: { orderId: string; accountId: string; skewQty: boolean }[] = [];
      const price = () => (mid * BigInt(10_000 + int(r, 800) - 400)) / 10_000n;
      const localRoute = (u: EntityId, n: number) => sized(progressedMaybe(routeOf(r, { orderId: `L${s}-${n}`, makerEntityId: u, source: { jurisdiction: S1, entityId: u, counterpartyEntityId: HUB, tokenId: ta, amount: 1n },
        target: { jurisdiction: S2, entityId: H2, counterpartyEntityId: pick(r, REMOTE), tokenId: tb, amount: 1n } })), price(), BigInt(1 + int(r, 6)), int(r, 25) === 0);
      const progressedMaybe = (x: CrossRoute) => { const c = unwrap(prepareCrossRoute(x, { runtimeSeed: RUNTIME_SEED, now: T0 - 500 })); return { ...c, status: "resting" as const }; };
      const addLocal = (u: EntityId, route: CrossRoute, resting: boolean) => {
        const giveTok = Number(route.source.tokenId), wantTok = Number(route.target.tokenId), tf = pick(r, [0, 0, 0, 1, 2] as const);
        const status = int(r, 20) === 0 ? pick(r, ["intent", "clear_requested", "cancelled"] as const) : route.status;
        const rt: CrossRoute = { ...route, status, ...(int(r, 25) === 0 ? { expiresAt: T0 - 1 } : {}) };
        const offer: SwapOffer = { offerId: rt.orderId, giveTokenId: String(giveTok) as never, giveTokenDecimals: DEC[giveTok]!, giveAmount: BigInt(rt.source.amount), wantTokenId: String(wantTok) as never, wantTokenDecimals: DEC[wantTok]!,
          wantAmount: BigInt(rt.target.amount), maxFee: 0n, minNetReceive: BigInt(rt.target.amount), priceTicks: 1n, timeInForce: tf, makerIsLeft: u < HUB, createdHeight: resting ? 1 : 2 + int(r, 2), quantizedGive: BigInt(rt.source.amount), quantizedWant: BigInt(rt.target.amount), crossJurisdiction: rt };
        offers.get(u)!.set(offer.offerId, offer);
        if (int(r, 12) === 0) mempool.get(u)!.push({ type: "swap_resolve", offerId: offer.offerId });
        if (int(r, 10) === 0) mirror.set(offer.offerId, { ...rt, status: pick(r, ["resting", "partially_filled", "clear_requested"] as const) });
        if (int(r, 10) === 0) admissions.set(bookAdmissionKey(u, rt.orderId), { orderId: rt.orderId, routeHash: rt.routeHash ?? "", sourceEntityId: u, bookOwnerEntityId: HUB, status: pick(r, ["admitted", "resolving", "closed"] as const), route: rt, updatedAt: T0 - 10 });
        if (resting) rows.push({ orderId: `${u}:${rt.orderId}`, accountId: u, skewQty: int(r, 30) === 0 });
        else incoming.push({ offerId: offer.offerId, accountId: u, makerIsLeft: offer.makerIsLeft, fromEntity: leftOf(u), toEntity: rightOf(u), createdHeight: offer.createdHeight, giveTokenId: giveTok, giveTokenDecimals: offer.giveTokenDecimals,
          giveAmount: offer.giveAmount, wantTokenId: wantTok, wantTokenDecimals: offer.wantTokenDecimals, wantAmount: offer.wantAmount, maxFee: 0n, minNetReceive: offer.minNetReceive, priceTicks: 1n, timeInForce: tf, crossJurisdiction: rt });
      };
      let n = 0;
      for (let k = int(r, 3); k > 0; k--) { const u = pick(r, LOCAL); addLocal(u, localRoute(u, ++n), true); }
      for (let k = 1 + int(r, 4); k > 0; k--) { const u = pick(r, LOCAL); addLocal(u, localRoute(u, ++n), false); }
      for (let k = int(r, 5); k > 0; k--) {
        const ru = pick(r, REMOTE), orderId = `R${s}-${++n}`;
        const route = sized(progressedMaybe(routeOf(r, { orderId, makerEntityId: ru, hubEntityId: H2, bookOwnerEntityId: HUB, source: { jurisdiction: S2, entityId: ru, counterpartyEntityId: H2, tokenId: tb, amount: 1n },
          target: { jurisdiction: S1, entityId: HUB, counterpartyEntityId: pick(r, LOCAL), tokenId: ta, amount: 1n } })), price(), BigInt(1 + int(r, 6)), false);
        const rt = int(r, 20) === 0 ? { ...route, expiresAt: T0 - 1 } : route;
        admissions.set(bookAdmissionKey(ru, orderId), { orderId, routeHash: rt.routeHash ?? "", sourceEntityId: ru, bookOwnerEntityId: HUB, status: int(r, 12) === 0 ? pick(r, ["resolving", "closed"] as const) : "admitted", route: rt, updatedAt: T0 - 10 });
        rows.push({ orderId: bookAdmissionKey(ru, orderId), accountId: ru, skewQty: int(r, 40) === 0 });
      }
      const ogAccounts = () => new Map(LOCAL.map((u) => [u, { status: active.get(u) ? "active" : "disputed", mempool: mempool.get(u)!.map(toOgTx),
        state: { leftEntity: leftOf(u), rightEntity: rightOf(u), swapOffers: new Map([...offers.get(u)!].map(([id, o]) => [id, { ...o, giveTokenId: Number(o.giveTokenId), wantTokenId: Number(o.wantTokenId) }])) } }]));
      const ogHub = (): any => ({ entityId: HUB, timestamp: T0, hubRebalanceConfig: { swapTakerFeeBps: 0 }, orderbookExt: ogExt, accounts: ogAccounts(), crossJurisdictionBookAdmissions: new Map(admissions), ...(mirror.size > 0 ? { crossJurisdictionSwaps: new Map(mirror) } : {}) });
      // resting rows: placed from og's own book-order metadata on both books
      const rwBooks = new Map<string, Book>();
      let placedOk = true;
      for (const row of rows) {
        const meta = ogRun(() => buildCrossMarketOfferFromBookOrder({ ...ogHub(), accounts: ogAccounts() }, row.orderId));
        if (!meta.ok || meta.value === null) continue;
        const mv = meta.value, qty = BigInt(mv.baseAmount) / lotOf(DEC[mv.baseTokenId]!) + (row.skewQty ? 1n : 0n);
        if (qty <= 0n) continue;
        const cmd = { kind: 0 as const, ownerId: mv.makerId, orderId: row.orderId, side: mv.side, tif: 0 as const, postOnly: false, priceTicks: mv.priceTicks, qtyLots: qty };
        const params = { bucketWidthTicks: 10n, maxOrders: 10_000, stpPolicy: 1 as const };
        const ogB = ogExt.books.get(mv.pairId) ?? ogBook.createBook(params), rwB = rwBooks.get(mv.pairId) ?? unwrap(createBook(params));
        const ogStep = ogBook.applyCommand(ogB, cmd), rwStep = applyBookCommand(rwB, cmd);
        if (!rwStep.ok) { placedOk = false; break; }
        ogExt.books.set(mv.pairId, commitBookOverlay(ogStep.state)); rwBooks.set(mv.pairId, rwStep.value.state);
      }
      if (!placedOk) continue;
      rebuildOrderbookPairIndex(ogExt);
      for (const [pairId, b] of rwBooks) expect([s, pairId, bookCommitmentHash(b)]).toEqual([s, pairId, computeBookCommitmentHash(ogExt.books.get(pairId))]);
      const rwExt: OrderbookExt = { books: rwBooks, pairDimensions: new Map(), referrals: new Map(), hubProfile };
      const hub: Hub = { id: HUB, ext: rwExt, takerFeeBps: 0, timestamp: T0, crossSwaps: mirror.size > 0 ? mirror : undefined, crossAdmissions: admissions,
        accounts: new Map(LOCAL.map((u): [string, HubAccount] => [u, { active: active.get(u)!, left: leftOf(u), right: rightOf(u), offers: offers.get(u)!, queued: mempool.get(u)! as never }])) };
      // cancels over local cross offers
      const requests = LOCAL.flatMap((u) => [...offers.get(u)!.keys()].filter(() => int(r, 4) === 0).map((offerId) => ({ offerId, accountId: u })));
      const ogCancel = ogRun(() => ogProcessCancels(ogHub(), requests)), rwCancel = rwRun(processOrderbookCancels(hub, requests));
      same(`${s}:cancel`, ogCancel.ok ? { ok: true, value: { txs: ogCancel.value.accountTxs, fills: ogCancel.value.crossJurisdictionFills, books: ogCancel.value.bookUpdates.map((b: any) => b.pairId) } } : ogCancel,
        rwCancel.ok ? { ok: true, value: { txs: rwCancel.value.accountTxs.map(({ accountId, tx }) => ({ accountId, tx: toOgTx(tx) })), fills: rwCancel.value.crossFills, books: [...rwCancel.value.books.keys()] } } : rwCancel);
      if (ogCancel.ok && ogCancel.value.crossJurisdictionFills.length > 0) bump("cancel-request");
      // the cross pass
      const ogOffers = incoming.map((o) => markWorkingOrderbookOffer(normalizeSwapOfferForOrderbook({ ...o, accountOutputVerified: true } as never, o.accountId)));
      const og = ogRun(() => ogProcessSwaps(ogHub(), ogOffers)), rw = rwRun(processOrderbookSwaps(hub, incoming));
      same(`${s}:match`, og.ok ? { ok: true, value: { txs: og.value.accountTxs, fills: og.value.crossJurisdictionFills, books: og.value.bookUpdates.map((b: any) => [b.pairId, computeBookCommitmentHash(b.book)]) } } : og,
        rw.ok ? { ok: true, value: { txs: rw.value.accountTxs.map(({ accountId, tx }) => ({ accountId, tx: toOgTx(tx) })), fills: rw.value.crossFills, books: [...rw.value.books].map(([p, b]) => [p, bookCommitmentHash(b)]) } } : rw);
      if (!og.ok) { bump(`halt:${og.message.split(/[:=]/)[0]}`); continue; }
      for (const f of og.value.crossJurisdictionFills) bump(f.executionSourceAmount > 0n ? (f.cancelRemainder ? "fill-cancel" : "fill") : "cancel");
      if (og.value.bookUpdates.length > 0) bump("book-update");
      // og commitOrderbookMatchResult: the frame's SwapMatched count is the sum of trade-count deltas over og's bookUpdates (cross pairs included)
      const ogPrev = new Map<string, number>();
      let ogMatched = 0;
      for (const u of og.value.bookUpdates as any[]) { const prev = ogPrev.get(u.pairId) ?? ogExt.books.get(u.pairId)?.tradeCount ?? 0; ogMatched += u.book.tradeCount - prev; ogPrev.set(u.pairId, u.book.tradeCount); }
      if (rw.ok) expect([s, "SwapMatched", unwrap(tradesMatched(rwExt, rw.value.books))]).toEqual([s, "SwapMatched", ogMatched]);
      if (ogMatched > 0 && og.value.crossJurisdictionFills.length > 0) bump("swap-matched-cross");
      for (const [pairId, b] of rw.ok ? rw.value.books : []) expect(bookOrders(b).map((o) => [o.orderId, o.qtyLots])).toEqual(ogBook.getBookOrders(og.value.bookUpdates.find((u: any) => u.pairId === pairId)!.book).map((o: any) => [o.orderId, o.qtyLots]));
    }
    for (const k of ["fill", "cancel", "book-update", "cancel-request", "swap-matched-cross", "halt:ORDERBOOK_LIVE_PROJECTION_REJECT"]) expect([k, (kinds.get(k) ?? 0) > 0, [...kinds].join(",")]).toEqual([k, true, [...kinds].join(",")]);
  }, 40_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Book lifecycle Entity txs: og entity/tx/handlers/cross-j/book-order.ts, fill.ts, account-cross-j-followups.ts (fill progress), auth/authorization.ts
import * as ogBookOrder from "../../../core/entity/tx/handlers/cross-j/book-order.ts";
import { handleCrossJurisdictionFillNoticeEntityTx } from "../../../core/entity/tx/handlers/cross-j/fill.ts";
import { applyCrossJurisdictionOrderbookFill } from "../../../core/entity/tx/handlers/account-cross-j-followups.ts";
import { readEntityFrameEvents } from "../../../core/entity/frame-events.ts";
import { ensureEntityCollectionCandidate, getEntityCollectionValueForWrite } from "../../../core/entity/state/persistent-collection-map.ts";
import { crossJurisdictionBookQtyLots } from "../../../core/orderbook/cross-j/quantity.ts";
import { assertRuntimeOutputAuthorization } from "../../../core/entity/auth/authorization.ts";
import { handleCrossJurisdictionBookOrderRemovedEntityTx as ogRemovedAck } from "../../../core/entity/tx/handlers/cross-j/book-removal-ack.ts";
import { routeRemoteCrossJurisdictionBookCancels as ogProcessRoute } from "../../../core/entity/tx/handlers/account/orderbook/cancels.ts";
import {
  admitBookOrder, bookFillToState, bookOrderRemoved, committedCrossOfferEvent, createEntity, crossFillNotice, orderbookFill, removeCrossBookOrder, routeRemoteCancels, runtimeOutputAuthError,
  type Address, type BookHost, type BookHostStep, type CrossFillInstruction, type CrossProgress, type EntityState, type EntityTx,
} from "../../xln.ts";
import { TERMS } from "../../xln_run.ts";

describe(seedTag("cross-book: book lifecycle Entity txs"), () => {
  const SIG: Readonly<Record<string, string>> = { [U1]: "0x" + "a1".repeat(20), [H1]: "0x" + "a2".repeat(20), [H2]: "0x" + "a3".repeat(20), [U2]: "0x" + "a4".repeat(20) };
  const sig = (e: string): string => { const s = SIG[e]; if (s === undefined) throw new Error(`no signer for ${e}`); return s; };
  const hubProfile = { entityId: H1, name: "hub", spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 }, referenceTokenId: 1, usdQuoteAuthorityEntityId: W("99"), minTradeSize: 0n, supportedPairs: [] };
  const ogEnv = { state: { timestamp: T0 }, runtimeSeed: RUNTIME_SEED } as never;
  const MUT = { mutableFrameState: true, storageChanges: [] } as never;
  const entries = (m: ReadonlyMap<string, unknown> | undefined) => (m === undefined || m.size === 0 ? null : [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  const params = { bucketWidthTicks: 10n, maxOrders: 10_000, stpPolicy: 1 as const };
  const ogColl = (m: ReadonlyMap<string, CrossRoute>) => {
    const c = ensureEntityCollectionCandidate(undefined, ogCrossIndex.cloneCrossJurisdictionRoute) as Map<string, unknown>;
    for (const [k, v] of m) c.set(k, ogCrossIndex.cloneCrossJurisdictionRoute(v as never));
    return c;
  };
  /** A local-source route (this hub is the source hub and the book owner) or a remote-source one whose book this hub owns / does not own. */
  const lifeRoute = (r: Rand, n: number, shape: "local" | "remote" | "foreign"): CrossRoute => {
    const base = shape === "local" ? routeOf(r, { orderId: `B${n}`, sourceToken: pick(r, [1, 3]), targetToken: 2 })
      : routeOf(r, {
        orderId: `B${n}`, makerEntityId: U2, hubEntityId: H2, bookOwnerEntityId: shape === "remote" ? H1 : H2,
        source: { jurisdiction: S2, entityId: U2, counterpartyEntityId: H2, tokenId: 2, amount: 1n }, target: { jurisdiction: S1, entityId: H1, counterpartyEntityId: U1, tokenId: pick(r, [1, 3]), amount: 1n },
        sourceSignerId: sig(U2), sourceHubSignerId: sig(H2), targetHubSignerId: sig(H1), targetSignerId: sig(U1),
      });
    const sized: CrossRoute = shape === "local"
      ? { ...base, source: { ...base.source, amount: pick(r, [10n ** 9n, 7n * 10n ** 6n, BigInt(1 + int(r, 1e9))]) }, target: { ...base.target, amount: pick(r, [10n ** 21n, 3n * 10n ** 18n, 10n ** 12n * BigInt(1 + int(r, 1e6))]) } }
      : { ...base, source: { ...base.source, amount: pick(r, [10n ** 21n, 3n * 10n ** 18n]) }, target: { ...base.target, amount: pick(r, [10n ** 9n, 7n * 10n ** 6n]) } };
    return progressed(r, sized, pick(r, ["resting", "resting", "partially_filled", "target_prepared", "clear_requested"] as const));
  };
  type World = { readonly rw: BookHost; readonly og: any; readonly route: CrossRoute };
  /** The same book-owner / source-hub state on both sides: a stored mirror, an admission at some stage, and a book row at the committed remainder. */
  const worldOf = (r: Rand, n: number, self: EntityId = H1, shape: "local" | "remote" | "foreign" = pick(r, ["local", "local", "remote", "foreign"] as const)): World => {
    const route = lifeRoute(r, n, shape), now = T0 - 50;
    const ogExt: any = { books: new Map(), orderPairs: new Map(), pairDimensions: new Map(), referrals: new Map(), hubProfile };
    const rwBooks = new Map<string, Book>();
    const og: any = {
      entityId: self, timestamp: T0, accounts: new Map(), orderbookExt: ogExt,
      config: { mode: "proposer-based", threshold: 1n, validators: [sig(self)], shares: { [sig(self)]: 1n }, jurisdiction: ogJur(J1) },
    };
    let swaps: Map<string, CrossRoute> | undefined;
    const mirror = int(r, 6);
    if (mirror > 0) {
      const stored: CrossRoute = mirror === 1 ? { ...route, status: pick(r, ["cancelled", "clear_requested", "resting"] as const) } : mirror === 2 ? { ...route, routeHash: "0x" + "dd".repeat(32) } : route;
      swaps = new Map([[route.orderId, stored]]);
      og.crossJurisdictionSwaps = ogColl(swaps);
    }
    let admissions: BookAdmissions | undefined;
    const stage = pick(r, ["none", "merged", "admitted", "admitted", "admitted", "resolving", "closed"] as const);
    if (stage !== "none" && shape !== "foreign") {
      const admRoute: CrossRoute = int(r, 12) === 0 ? (({ routeHash: _, ...rest }) => ({ ...rest, memo: "v2" }) as CrossRoute)(route) : route;
      ogOB.mergeCrossJurisdictionBookAdmission(og, admRoute as never, now);
      admissions = unwrap(mergeBookAdmission(admissions, admRoute, now)).admissions;
      const key = bookAdmissionKey(route.source.entityId, route.orderId);
      if (stage === "admitted") {
        const a = getEntityCollectionValueForWrite(og.crossJurisdictionBookAdmissions, key) as any;
        a.status = "admitted"; a.admittedAt = now;
        admissions = new Map(admissions).set(key, { ...admissions.get(key)!, status: "admitted", admittedAt: now });
      } else if (stage === "resolving") {
        ogOB.markCrossJurisdictionBookAdmissionResolving(og, admRoute as never, now);
        admissions = unwrap(markAdmissionResolving(admissions, admRoute, now));
      } else if (stage === "closed") {
        ogOB.markCrossJurisdictionBookAdmissionClosed(og, route.source.entityId, route.orderId, now, "x");
        admissions = unwrap(markAdmissionClosed(admissions, route.source.entityId, route.orderId, now, "x"));
      }
    }
    const rw0: BookHost = { id: self, timestamp: T0, validators: [sig(self)], ext: { books: rwBooks, pairDimensions: new Map(), referrals: new Map(), hubProfile }, swaps, admissions, accounts: new Map() };
    const row = pick(r, ["none", "book", "row", "row", "skew"] as const), event = committedCrossOfferEvent(rw0, route);
    if (row !== "none" && event.ok) {
      const meta = ogRun(() => ogOB.buildCrossJurisdictionMarketOffer(normalizeSwapOfferForOrderbook(event.value as never, event.value.accountId) as never, self) as any);
      if (meta.ok && meta.value !== null) {
        const m = meta.value, ogB = ogBook.createBook(params), rwB = unwrap(createBook(params));
        if (row === "book") { ogExt.books.set(m.pairId, ogB); rwBooks.set(m.pairId, rwB); }
        else {
          const qty = crossJurisdictionBookQtyLots(m.baseTokenId, m.baseAmount) + (row === "skew" ? BigInt(1 + int(r, 5)) : 0n);
          const cmd = { kind: 0 as const, ownerId: m.makerId, orderId: `${route.source.entityId.toLowerCase()}:${route.orderId}`, side: m.side, tif: 0 as const, postOnly: false, priceTicks: m.priceTicks, qtyLots: qty };
          if (qty > 0n) {
            const ogStep = ogBook.applyCommand(ogB, cmd), rwStep = unwrap(applyBookCommand(rwB, cmd));
            ogExt.books.set(m.pairId, ogStep.state); rwBooks.set(m.pairId, rwStep.state);
          }
        }
        rebuildOrderbookPairIndex(ogExt);
      }
    }
    return { rw: rw0, og, route };
  };
  type Snap = { admissions: unknown; swaps: unknown; books: unknown; messages: unknown; outputs: unknown; created: unknown; extra: unknown };
  const ogSnap = (s: any, outputs: readonly any[], created: readonly unknown[], extra: unknown = null): Snap => ({
    admissions: entries(s.crossJurisdictionBookAdmissions === undefined ? undefined : new Map(s.crossJurisdictionBookAdmissions)), swaps: entries(s.crossJurisdictionSwaps === undefined ? undefined : new Map(s.crossJurisdictionSwaps)),
    books: [...(s.orderbookExt?.books ?? new Map())].map(([p, b]: [string, any]) => [p, computeBookCommitmentHash(b), ogBook.getBookOrders(b).map((o: any) => [o.orderId, o.qtyLots])]).sort(),
    messages: readEntityFrameEvents(s).map((e: any) => e.message), outputs: outputs.map((o) => ({ entityId: o.entityId, signerId: o.signerId, txs: o.entityTxs })), created, extra,
  });
  const rwSnap = (h: BookHost, messages: readonly string[], outputs: readonly unknown[], created: readonly unknown[], extra: unknown = null): Snap => ({
    admissions: entries(h.admissions), swaps: entries(h.swaps), books: [...(h.ext?.books ?? new Map())].map(([p, b]) => [p, bookCommitmentHash(b), bookOrders(b).map((o) => [o.orderId, o.qtyLots])]).sort(),
    messages, outputs, created, extra,
  });
  const stepSnap = (s: BookHostStep, extra: unknown = null) => rwSnap(s.host, s.messages, s.outputs, s.created, extra);
  const bump = (kinds: Map<string, number>, k: string) => kinds.set(k, (kinds.get(k) ?? 0) + 1);
  const kindOf = (o: Out<Snap>): string => (o.ok ? "ok" : o.message.split(":")[0]!);

  test("MATCH: admitCrossJurisdictionBookOrder on 400 random book owners (owner, stored mirror, admission stage, route drift): same admissions, mirror, messages, created offer and halts as og", () => {
    const r = rng(0xad2), kinds = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const w = worldOf(r, i, pick(r, [H1, H1, H1, H2]));
      const k = int(r, 8), route: CrossRoute = k === 0 ? { ...w.route, routeHash: "0x" + "ee".repeat(32) } : k === 1 ? { ...w.route, status: pick(r, ["resting", "partially_filled", "intent"] as const) } : k === 2 ? { ...w.route, expiresAt: T0 - 1 } : w.route;
      const reason = int(r, 3) === 0 ? "committed pulls" : undefined, tx = { type: "admitCrossJurisdictionBookOrder", data: { route, ...(reason ? { reason } : {}) } };
      const og = ogRun(() => { const res = ogBookOrder.handleAdmitCrossJurisdictionBookOrderEntityTx(ogEnv, w.og, tx as never, MUT); return ogSnap(res.newState, res.outputs, res.swapOffersCreated); });
      const res = admitBookOrder(w.rw, { route, reason }), rw: Out<Snap> = res.ok ? { ok: true, value: stepSnap(res.value) } : rwRun(res);
      same(`admit ${i}`, og, rw);
      const msg = og.ok ? String((og.value.messages as string[]).at(-1) ?? "") : "";
      bump(kinds, og.ok ? (og.value.created as unknown[]).length > 0 ? "admitted" : msg.includes("duplicate") ? "duplicate" : msg.includes("pending") ? "pending" : msg.includes("reject") ? "reject" : "other" : kindOf(og));
    }
    for (const k of ["admitted", "duplicate", "CROSS_J_BOOK_ADMIT_WRONG_OWNER", "CROSS_J_BOOK_ADMIT_ROUTE_INVALID"]) expect([k, (kinds.get(k) ?? 0) > 0, [...kinds].join(",")]).toEqual([k, true, [...kinds].join(",")]);
  }, 30_000);

  test("MATCH: book-owner fill progress on 500 random worlds (direct progress and matcher instructions; seq, ratio, cancel, stale, resize, re-materialize, remove): same state, outputs and halts as og", () => {
    const r = rng(0xf111), kinds = new Map<string, number>();
    for (let i = 0; i < 500; i++) {
      const w = worldOf(r, i, H1, pick(r, ["local", "local", "remote"] as const)), route = w.route;
      const seq = Math.floor(Number(route.fillSeq ?? 0)), cur = ogCrossIndex.getCrossJurisdictionCommittedProofRatio(route);
      if (int(r, 2) === 0) {
        // og applyCrossJurisdictionBookFillToState
        const data: CrossProgress = {
          orderId: int(r, 20) === 0 ? "other" : route.orderId, fillSeq: pick(r, [seq, seq + 1, seq + 1, seq + 2, 0]), cumulativeFillRatio: pick(r, [cur, Math.min(65_535, cur + 1 + int(r, 20_000)), 65_535, int(r, 65_536), Math.max(0, cur - 1)]),
          ...(int(r, 3) === 0 ? { cancelRemainder: true } : {}),
        };
        const source = int(r, 20) === 0 ? U2 : route.source.entityId;
        const og = ogRun(() => { const changed = ogBookOrder.applyCrossJurisdictionBookFillToState(ogEnv, w.og, source, data as never, []); return ogSnap(w.og, [], [], changed); });
        const res = bookFillToState(w.rw, source, data), rw: Out<Snap> = res.ok ? { ok: true, value: rwSnap(res.value.host, [], [], [], res.value.changed) } : rwRun(res);
        same(`progress ${i}`, og.ok ? og : { ok: false, message: og.message.split(" ")[0]! }, rw.ok ? rw : { ok: false, message: rw.message.split(" ")[0]! });
        bump(kinds, og.ok ? `progress:${og.value.extra}` : kindOf(og));
      } else {
        // og applyCrossJurisdictionOrderbookFill: the matcher's instruction, then the source hub's half (local) or a fill notice (remote)
        const offer = committedCrossOfferEvent(w.rw, route);
        if (!offer.ok) continue;
        const meta = rwRun(crossMarketOffer(offer.value as never, H1));
        if (!meta.ok || meta.value === null) continue;
        const fill = { filledLots: BigInt(int(r, 4) === 0 ? 0 : 1 + int(r, 3000)), weightedCost: BigInt(int(r, 1e9)), ...(int(r, 3) === 0 ? { cancelRemainder: true } : {}) };
        const instr = rwRun(crossFillInstruction(route.source.entityId, route.orderId, `${route.source.entityId.toLowerCase()}:${route.orderId}`, meta.value, fill));
        if (!instr.ok || instr.value === null) continue;
        const ins = instr.value as CrossFillInstruction;
        const og = ogRun(() => { const outputs: any[] = []; applyCrossJurisdictionOrderbookFill(ogEnv, w.og, ins as never, outputs, []); return ogSnap(w.og, outputs, []); });
        const res = orderbookFill(w.rw, ins), rw: Out<Snap> = res.ok ? { ok: true, value: rwSnap(res.value.host, [], res.value.outputs, []) } : rwRun(res);
        same(`fill ${i}`, og.ok ? og : { ok: false, message: og.message.split(" ")[0]! }, rw.ok ? rw : { ok: false, message: rw.message.split(" ")[0]! });
        bump(kinds, og.ok ? `fill:${(og.value.outputs as unknown[]).length}` : kindOf(og));
      }
    }
    for (const k of ["progress:true", "progress:false", "fill:0", "fill:1", "CROSS_J_BOOK_PROGRESS_ADMISSION_MISSING", "CROSS_J_BOOK_PROGRESS_ADMISSION_NOT_ADMITTED", "CROSS_J_BOOK_PROGRESS_STALE", "CROSS_J_BOOK_PROGRESS_ORDER_MISSING"]) expect([k, (kinds.get(k) ?? 0) > 0, [...kinds].join(",")]).toEqual([k, true, [...kinds].join(",")]);
  }, 30_000);

  test("MATCH: removeCrossJurisdictionBookOrder on 400 random book owners (route drift, missing route, source, ack account, admission hash): same state, ack output and halts as og", () => {
    const r = rng(0x2e30), kinds = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const w = worldOf(r, i, H1, pick(r, ["local", "remote", "remote", "foreign"] as const)), route = w.route;
      const k = int(r, 10), sent: CrossRoute | undefined = k === 0 ? undefined : k === 1 ? { ...route, orderId: "other" } : k === 2 ? { ...route, routeHash: "0x" + "ee".repeat(32) } : k === 3 ? { ...route, status: "resting" } : route;
      const data = {
        orderId: int(r, 20) === 0 ? "other" : route.orderId, sourceEntityId: int(r, 15) === 0 ? U1 : int(r, 10) === 0 ? route.source.entityId.toUpperCase().replace("0X", "0x") : route.source.entityId,
        ...(int(r, 4) > 0 ? { sourceAccountId: pick(r, [route.source.entityId, route.source.entityId, U1]) } : {}), ...(sent === undefined ? {} : { route: sent }), ...(int(r, 3) === 0 ? { reason: "cancel_request" } : {}),
      };
      const og = ogRun(() => { const res = ogBookOrder.handleRemoveCrossJurisdictionBookOrderEntityTx(ogEnv, w.og, { type: "removeCrossJurisdictionBookOrder", data } as never, MUT); return ogSnap(res.newState, res.outputs, []); });
      const res = removeCrossBookOrder(w.rw, data), rw: Out<Snap> = res.ok ? { ok: true, value: stepSnap(res.value) } : rwRun(res);
      same(`remove ${i}`, og, rw);
      bump(kinds, og.ok ? `ok:${(og.value.outputs as unknown[]).length}:${String((og.value.messages as string[]).at(-1)).endsWith("removed")}` : kindOf(og));
    }
    for (const k of ["ok:1:true", "ok:0:false", "ok:1:false", "CROSS_J_BOOK_REMOVAL_ROUTE_MISMATCH", "CROSS_J_BOOK_REMOVAL_ROUTE_MISSING"]) expect([k, (kinds.get(k) ?? 0) > 0, [...kinds].join(",")]).toEqual([k, true, [...kinds].join(",")]);
  }, 30_000);

  test("MATCH: crossJurisdictionFillNotice at the source hub on 400 random mirrors (duplicate, stale conflict, clear requested, terminal -> clear request, local book removal): same state, outputs and halts as og", () => {
    const r = rng(0xf2ce), kinds = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const w = worldOf(r, i, H1, "local"), route = w.route;
      const seq = Math.floor(Number(route.fillSeq ?? 0)), cur = ogCrossIndex.getCrossJurisdictionCommittedProofRatio(route);
      const data: CrossProgress = {
        orderId: int(r, 20) === 0 ? "other" : route.orderId, ...(int(r, 3) === 0 ? { routeHash: int(r, 4) === 0 ? "0x" + "ee".repeat(32) : route.routeHash } : {}),
        fillSeq: pick(r, [seq, seq + 1, seq + 1, seq + 2, 0]), cumulativeFillRatio: pick(r, [cur, Math.min(65_535, cur + 1 + int(r, 20_000)), 65_535, 65_535, int(r, 65_536)]), ...(int(r, 3) === 0 ? { cancelRemainder: true } : {}),
      };
      const og = ogRun(() => { const res = handleCrossJurisdictionFillNoticeEntityTx(ogEnv, w.og, { type: "crossJurisdictionFillNotice", data } as never, [], true); return ogSnap(res.newState, res.outputs, []); });
      const res = crossFillNotice(w.rw, data), rw: Out<Snap> = res.ok ? { ok: true, value: stepSnap(res.value) } : rwRun(res);
      same(`notice ${i}`, og.ok ? og : { ok: false, message: og.message.split(" ")[0]! }, rw.ok ? rw : { ok: false, message: rw.message.split(" ")[0]! });
      bump(kinds, og.ok ? `ok:${(og.value.outputs as unknown[]).length}:${String((og.value.messages as string[]).at(-1)).includes("applied")}` : kindOf(og));
    }
    for (const k of ["ok:0:true", "ok:1:true", "ok:0:false", "CROSS_J_FILL_ROUTE_MISSING"]) expect([k, (kinds.get(k) ?? 0) > 0, [...kinds].join(",")]).toEqual([k, true, [...kinds].join(",")]);
  }, 30_000);

  test("MATCH: crossJurisdictionBookOrderRemoved at the source hub on 300 random acks (carried progress ahead or behind, terminal mirror, missing offer, hash drift, wrong hub): same state, clear request and halts as og", async () => {
    const r = rng(0x4e3d), kinds = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const w = worldOf(r, i, int(r, 15) === 0 ? H2 : H1, "local"), route = w.route;
      if (int(r, 6) > 0) {
        const offer = { offerId: route.orderId, giveTokenId: "1", giveTokenDecimals: 6, giveAmount: 1n, wantTokenId: "2", wantTokenDecimals: 18, wantAmount: 1n, maxFee: 0n, minNetReceive: 1n, priceTicks: 1n, makerIsLeft: true, createdHeight: 1, quantizedGive: 1n, quantizedWant: 1n, ...(int(r, 8) > 0 ? { crossJurisdiction: route } : {}) } as unknown as SwapOffer;
        w.og.accounts = new Map([[U1, { status: "active", state: { swapOffers: new Map([[route.orderId, offer]]) } }]]);
        (w as { rw: BookHost }).rw = { ...w.rw, accounts: new Map([[U1, { active: true, left: U1, right: H1, offers: new Map([[route.orderId, offer]]), queued: [] }]]) };
      }
      const k = int(r, 6), ahead = k === 0 ? applyCrossFill(route, { fillSeq: Math.floor(Number(route.fillSeq ?? 0)) + 1, cumulativeFillRatio: 65_000, fillNumerator: 65_000n, fillDenominator: 65_535n }, T0 - 20) : undefined;
      const carried: CrossRoute = ahead?.ok ? { ...ahead.value, status: "partially_filled" } : k === 1 ? { ...route, routeHash: "0x" + "ee".repeat(32) } : route;
      const data = { orderId: route.orderId, sourceEntityId: route.source.entityId, sourceAccountId: int(r, 12) === 0 ? U2 : U1, route: carried, removedAt: T0 - 5, ...(int(r, 3) === 0 ? { reason: "cancel_request" } : {}) };
      let og: Out<Snap>;
      try { const res = await ogRemovedAck(ogEnv, w.og, { type: "crossJurisdictionBookOrderRemoved", data } as never, MUT); og = { ok: true, value: ogSnap(res.newState, res.outputs, []) }; } catch (e) { og = { ok: false, message: (e as Error).message }; }
      const res = bookOrderRemoved(w.rw, data), rw: Out<Snap> = res.ok ? { ok: true, value: stepSnap(res.value) } : rwRun(res);
      same(`removed ${i}`, og.ok ? og : { ok: false, message: og.message.split(" ")[0]! }, rw.ok ? rw : { ok: false, message: rw.message.split(" ")[0]! });
      bump(kinds, og.ok ? `ok:${(og.value.outputs as unknown[]).length}` : og.message.split(":")[0]!);
    }
    for (const k of ["ok:0", "ok:1", "CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING", "CROSS_J_BOOK_REMOVAL_ACK_SOURCE_HUB_REQUIRED"]) expect([k, (kinds.get(k) ?? 0) > 0, [...kinds].join(",")]).toEqual([k, true, [...kinds].join(",")]);
  }, 30_000);

  test("MATCH: routeRemoteCrossJurisdictionBookCancels on 300 random source hubs (sibling book owner, local book, no mirror, plain offers, wrong hub): same local cancels, removal requests, resolving admissions and halts as og", () => {
    const r = rng(0x7c4c), kinds = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const self = int(r, 15) === 0 ? H2 : H1, offers = new Map<string, SwapOffer>(), swaps = new Map<string, CrossRoute>(), og: any = { entityId: self, timestamp: T0 };
      let admissions: BookAdmissions | undefined;
      for (let k = 1 + int(r, 4); k > 0; k--) {
        const base = lifeRoute(r, i * 10 + k, "local"), route: CrossRoute = int(r, 2) === 0 ? ogCrossIndex.withCanonicalCrossJurisdictionRouteHash({ ...base, bookOwnerEntityId: pick(r, [H2, H2, H1]), routeHash: undefined } as never) as unknown as CrossRoute : base;
        const cross = int(r, 6) > 0, offer = { offerId: route.orderId, giveTokenId: "1", giveTokenDecimals: 6, giveAmount: 1n, wantTokenId: "2", wantTokenDecimals: 18, wantAmount: 1n, maxFee: 0n, minNetReceive: 1n, priceTicks: 1n, makerIsLeft: true, createdHeight: 1, quantizedGive: 1n, quantizedWant: 1n, ...(cross ? { crossJurisdiction: route } : {}) } as unknown as SwapOffer;
        offers.set(route.orderId, offer);
        if (int(r, 5) > 0) swaps.set(route.orderId, route);
        if (int(r, 3) === 0) { ogOB.mergeCrossJurisdictionBookAdmission(og, route as never, T0 - 50); admissions = unwrap(mergeBookAdmission(admissions, route, T0 - 50)).admissions; }
      }
      if (swaps.size > 0) og.crossJurisdictionSwaps = ogColl(swaps);
      og.accounts = new Map([[U1, { state: { swapOffers: new Map(offers) } }]]);
      const account: HubAccount = { active: true, left: U1, right: H1, offers, queued: [] };
      const host: BookHost = { id: self, timestamp: T0, validators: [sig(self)], swaps: swaps.size > 0 ? swaps : undefined, admissions, accounts: new Map([[U1, account]]) };
      const cancels = [...offers.keys(), "missing"].filter(() => int(r, 3) > 0).map((offerId) => ({ offerId, accountId: int(r, 12) === 0 ? U2 : U1 }));
      const ogOut = ogRun(() => { const res = ogProcessRoute(ogEnv, og, cancels as never); return { local: res.localBookCancels, admissions: entries(og.crossJurisdictionBookAdmissions === undefined ? undefined : new Map(og.crossJurisdictionBookAdmissions)), outputs: res.outputs.map((o: any) => ({ entityId: o.entityId, signerId: o.signerId, txs: o.entityTxs })) }; });
      const res = routeRemoteCancels(host, cancels), rw: Out<unknown> = res.ok ? { ok: true, value: { local: res.value.local, admissions: entries(res.value.host.admissions), outputs: res.value.outputs } } : rwRun(res);
      same(`route ${i}`, ogOut, rw);
      bump(kinds, ogOut.ok ? `ok:${(ogOut.value.outputs as unknown[]).length > 0}:${(ogOut.value.local as unknown[]).length > 0}` : ogOut.message.split(":")[0]!);
    }
    for (const k of ["ok:true:true", "ok:false:true", "CROSS_J_CANCEL_SOURCE_HUB_REQUIRED"]) expect([k, (kinds.get(k) ?? 0) > 0, [...kinds].join(",")]).toEqual([k, true, [...kinds].join(",")]);
  }, 30_000);

  test("MATCH: assertRuntimeOutputAuthorization for the book lifecycle txs on 600 random envelopes (stored vs supplied route, sibling source, signer, target, self continuation)", () => {
    const r = rng(0xa071), outcomes = new Map<string, number>(), ids = [U1, H1, H2, U2, W("09")];
    for (let i = 0; i < 600; i++) {
      const route = lifeRoute(r, i, pick(r, ["local", "remote", "foreign"] as const));
      const target = pick(r, [H1, H1, H2, U1]), source = int(r, 5) === 0 ? target : pick(r, ids);
      const signer = int(r, 10) < 7 ? (SIG[source] ?? "0x" + "55".repeat(20)) : pick(r, ["0x" + "55".repeat(20), "", sig(H1)]);
      const drift: CrossRoute = int(r, 6) === 0 ? { ...route, routeHash: "0x" + "ee".repeat(32) } : route;
      const oid = int(r, 12) === 0 ? "other" : route.orderId, src = int(r, 10) === 0 ? U1 : route.source.entityId;
      const txOf = (): EntityTx => {
        switch (int(r, 5)) {
          case 0: return { type: "admitCrossJurisdictionBookOrder", data: { route: drift } } as EntityTx;
          case 1: return { type: "crossJurisdictionFillNotice", data: { orderId: oid, fillSeq: 1, cumulativeFillRatio: 100 } } as EntityTx;
          case 2: return { type: "removeCrossJurisdictionBookOrder", data: { orderId: oid, sourceEntityId: src, ...(int(r, 3) > 0 ? { route: drift } : {}) } } as EntityTx;
          case 3: return { type: "crossJurisdictionBookOrderRemoved", data: { orderId: oid, sourceEntityId: src, sourceAccountId: int(r, 8) === 0 ? U1 : route.source.entityId, route: drift, removedAt: T0 } } as EntityTx;
          default: return { type: "requestCrossJurisdictionClear", data: { orderId: oid, ...(int(r, 3) > 0 ? { route: drift } : {}) } } as EntityTx;
        }
      };
      const txs = int(r, 8) === 0 ? [txOf(), txOf()] : [txOf()];
      const stored = int(r, 4) > 0 ? new Map([[route.orderId, route]]) : undefined, validators = [SIG[target] ?? "0x" + "56".repeat(20)];
      const ogState = { entityId: target, config: { mode: "proposer-based", threshold: 1n, validators, shares: { [validators[0]!]: 1n } }, ...(stored ? { crossJurisdictionSwaps: ogColl(stored) } : {}) };
      const rwState = { id: target, quorum: unwrap(createEntity({ id: target, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[validators[0] as Address, { shares: 1n }]]) })).state.quorum, ...(stored ? { crossJurisdictionSwaps: stored } : {}) } as unknown as EntityState;
      const data = { protocol: "cross-j" as const, sourceEntityId: source, sourceSignerId: signer, targetEntityId: target, entityTxs: txs };
      const og = (() => { try { assertRuntimeOutputAuthorization(source, signer, target, txs as never, ogState as never); return null; } catch (e) { return (e as Error).message; } })();
      expect(`${i}:${runtimeOutputAuthError(rwState, data)}`).toBe(`${i}:${og}`);
      bump(outcomes, og === null ? "ok" : og.replace(/:.*/, ""));
    }
    expect([...outcomes.keys()].includes("ok")).toBe(true);
    expect(outcomes.size).toBeGreaterThan(6);
  }, 30_000);
});
