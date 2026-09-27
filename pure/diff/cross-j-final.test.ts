// Cross-j clear lifecycle: og entity/tx/handlers/cross-j/clear.ts (requestCrossJurisdictionClear, materializeCrossJurisdictionClear), payments/pull.ts
// (crossPullClose), cross-j/sweep.ts (orderbookSweepCrossJurisdiction), transition/cross-j-proposer-materialization.ts (the clear reveal) and the
// crossPullClose branch of auth/authorization.ts. Every MATCH runs live og (core/ at 566c850) on the same seeded random input.
import { describe, expect, test } from "bun:test";
import { seedOf, seedTag, untilCovered } from "./seed.ts";
import * as ogCrossIndex from "../../core/extensions/cross-j/index.ts";
import * as ogBook from "../../core/orderbook/core.ts";
import { rebuildOrderbookPairIndex } from "../../core/orderbook/order-index.ts";
import { ensureEntityCollectionCandidate } from "../../core/entity/state/persistent-collection-map.ts";
import { readEntityFrameEvents } from "../../core/entity/frame-events.ts";
import { handleRequestCrossJurisdictionClearEntityTx, handleMaterializeCrossJurisdictionClearEntityTx } from "../../core/entity/tx/handlers/cross-j/clear.ts";
import { handleCrossPullCloseEntityTx } from "../../core/entity/tx/handlers/payments/pull.ts";
import { handleOrderbookSweepCrossJurisdictionEntityTx } from "../../core/entity/tx/handlers/cross-j/sweep.ts";
import { appendDefaultProposerCrossJMaterializations } from "../../core/entity/transition/cross-j-proposer-materialization.ts";
import { assertRuntimeOutputAuthorization } from "../../core/entity/auth/authorization.ts";
import {
  applyBookCommand, applyCrossFill, bookOrders, buildCrossCloseProof, createBook, createEntity, crossClearReveals, crossPrivateSeed, crossPullCloseTx, crossPullReveal, crossSweep, materializeCrossClear,
  prepareCrossRoute, requestCrossClear, runtimeOutputAuthError, stableJson, withCloseProofProgress,
  type Address, type Book, type BookHost, type CrossCloseProof, type CrossHostStep, type CrossRoute, type Domain, type EntityError, type EntityId, type EntityState, type EntityTx, type HubAccount, type Result, type SwapOffer, type WireAccountTx,
} from "../xln.ts";
import { TERMS, unwrap } from "../xln_run.ts";

const rng = (base: number) => { let seed = seedOf(base); return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
type Rand = () => number;
const int = (r: Rand, n: number): number => Math.floor(r() * n);
const pick = <T,>(r: Rand, xs: readonly T[]): T => xs[int(r, xs.length)] as T;
type Out<T> = { ok: true; value: T } | { ok: false; message: string };
/** og throws: a MalformedEntityFrameInputError is a reject (its rejection text), anything else a halt; only the code prefix is compared (og formats detail its own way). */
const code = (m: string): string => m.split(/[: ]/)[0]!;
const ogRun = <T,>(f: () => T): Out<T> => { try { return { ok: true, value: f() }; } catch (e) { const x = e as { rejection?: string; message: string }; return { ok: false, message: code(x.rejection ?? x.message) }; } };
const rwRun = <T,>(r: Result<T, EntityError>): Out<T> => (r.ok ? { ok: true, value: r.value } : { ok: false, message: code(r.error._tag === "entity_invariant" || r.error._tag === "cross_j_entity" ? r.error.reason : r.error._tag) });
const same = (label: string, og: Out<unknown>, rw: Out<unknown>): void => { expect(`${label}:${stableJson(rw)}`).toBe(`${label}:${stableJson(og)}`); };
const bump = (kinds: Map<string, number>, k: string) => kinds.set(k, (kinds.get(k) ?? 0) + 1);
const hasKinds = (kinds: Map<string, number>, want: readonly string[]): boolean => want.every((k) => [...kinds.keys()].some((x) => x.startsWith(k)));
const expectKinds = (kinds: Map<string, number>, want: readonly string[]) => { for (const k of want) expect([k, [...kinds.keys()].some((x) => x.startsWith(k)), [...kinds].join(",")]).toEqual([k, true, [...kinds].join(",")]); };

const J1: Domain = { chainId: 1, depositoryAddress: "0x" + "11".repeat(20) }, J2: Domain = { chainId: 31337, depositoryAddress: "0x" + "ab".repeat(20) };
const S1 = `stack:1:${J1.depositoryAddress}`, S2 = `stack:31337:${J2.depositoryAddress}`;
const W = (b: string) => ("0x" + b.repeat(32)) as EntityId;
const U1 = W("01"), H1 = W("02"), H2 = W("03"), U2 = W("04");
const SIG: Readonly<Record<string, string>> = { [U1]: "0x" + "a1".repeat(20), [H1]: "0x" + "a2".repeat(20), [H2]: "0x" + "a3".repeat(20), [U2]: "0x" + "a4".repeat(20) };
const sig = (e: string): string => { const s = SIG[e]; if (s === undefined) throw new Error(`no signer for ${e}`); return s; };
const PEER: Readonly<Record<string, EntityId>> = { [U1]: H1, [H1]: U1, [H2]: U2, [U2]: H2 };
const T0 = 1_700_000_050_000, CLOCK60 = { leftResponseSeconds: 60, rightResponseSeconds: 60 }, RUNTIME_SEED = "0x" + "5e".repeat(32);
const ogEnv = { state: { timestamp: T0 }, runtimeSeed: RUNTIME_SEED } as never;
const hubProfile = { entityId: H1, name: "hub", spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 }, referenceTokenId: 1, usdQuoteAuthorityEntityId: W("99"), minTradeSize: 0n, supportedPairs: [] };
const params = { bucketWidthTicks: 10n, maxOrders: 10_000, stpPolicy: 1 as const };

const routeOf = (r: Rand, n: number): CrossRoute => ({
  orderId: `C${n}`, makerEntityId: U1, hubEntityId: H1,
  source: { jurisdiction: S1, entityId: U1, counterpartyEntityId: H1, tokenId: pick(r, [1, 3]), amount: pick(r, [10n ** 9n, 7n * 10n ** 6n, BigInt(1 + int(r, 1e9))]) },
  target: { jurisdiction: S2, entityId: H2, counterpartyEntityId: U2, tokenId: 2, amount: pick(r, [10n ** 21n, 3n * 10n ** 18n, BigInt(1 + int(r, 1e12))]) },
  sourceDisputeConfig: CLOCK60, targetDisputeConfig: CLOCK60, status: "intent", createdAt: T0 - 1000, updatedAt: T0 - 1000, expiresAt: pick(r, [T0 + 60_000, T0 + 60_000, T0 - 10, T0]),
  sourceSignerId: sig(U1), sourceHubSignerId: sig(H1), targetHubSignerId: sig(H2), targetSignerId: sig(U2),
});
/** A prepared route at a random status and committed fill (none, partial, full). */
const liveRoute = (r: Rand, n: number): CrossRoute => {
  const base = routeOf(r, n);
  if (int(r, 25) === 0) return base;
  let c = unwrap(prepareCrossRoute(base, { runtimeSeed: RUNTIME_SEED, now: T0 - 500 }));
  const fill = int(r, 4);
  if (fill === 1 || fill === 2) { const num = BigInt(1 + int(r, 999)), next = applyCrossFill(c, { cumulativeFillRatio: Number((num * 65_535n) / 1000n), fillNumerator: num, fillDenominator: 1000n }, T0 - 100); if (next.ok) c = next.value; }
  if (fill === 3) c = unwrap(applyCrossFill(c, { cumulativeFillRatio: 65_535, fillNumerator: 1n, fillDenominator: 1n }, T0 - 100));
  return { ...c, status: pick(r, ["resting", "partially_filled", "clear_requested", "clear_requested", "clearing", "target_prepared", "settled", "cancelled", "intent"] as const) };
};
const ogColl = (m: ReadonlyMap<string, CrossRoute>) => {
  const c = ensureEntityCollectionCandidate(undefined, ogCrossIndex.cloneCrossJurisdictionRoute) as Map<string, unknown>;
  for (const [k, v] of m) c.set(k, ogCrossIndex.cloneCrossJurisdictionRoute(v as never));
  return c;
};
const offerOf = (route: CrossRoute | undefined, id: string): SwapOffer => ({ offerId: id, giveTokenId: "1", giveTokenDecimals: 6, giveAmount: 1n, wantTokenId: "2", wantTokenDecimals: 18, wantAmount: 1n, maxFee: 0n, minNetReceive: 1n, priceTicks: 1n, makerIsLeft: true, createdHeight: 1, quantizedGive: 1n, quantizedWant: 1n, ...(route ? { crossJurisdiction: route } : {}) }) as unknown as SwapOffer;
const ogAccountTx = (tx: WireAccountTx): unknown => { const { type, ...data } = tx as { type: string; tokenId?: unknown }; return { type, data: type === "cross_pull_lock" ? { ...data, tokenId: Number(data.tokenId) } : data }; };
const flatAccountTx = (t: { accountId: string; tx: { type: string; data: object } }) => ({ accountId: t.accountId, tx: { type: t.tx.type, ...t.tx.data } });

type World = { rw: BookHost; og: any; routes: CrossRoute[] };
/** The same Entity on both sides: stored routes, one Account per route counterparty (offer, pulls, queued close), maybe a live book row. */
const worldOf = (r: Rand, n: number, self: EntityId, count = 1): World => {
  const routes = Array.from({ length: count }, (_, k) => liveRoute(r, n * 10 + k)), stored = new Map<string, CrossRoute>();
  const peer = PEER[self]!, offers = new Map<string, SwapOffer>(), pulls = new Map<string, unknown>(), queued: WireAccountTx[] = [];
  const ogExt: any = { books: new Map(), orderPairs: new Map(), pairDimensions: new Map(), referrals: new Map(), hubProfile };
  const rwBooks = new Map<string, Book>();
  for (const route of routes) {
    const k = int(r, 12);
    stored.set(route.orderId, k === 0 && route.routeHash ? { ...route, routeHash: "0x" + "dd".repeat(32) } : k === 1 ? { ...route, source: { ...route.source, counterpartyEntityId: W("09") } } : route);
    if (int(r, 5) > 0) offers.set(route.orderId, offerOf(int(r, 10) === 0 ? undefined : int(r, 12) === 0 ? { ...route, routeHash: "0x" + "ee".repeat(32) } : route, route.orderId));
    const pull = self === H2 || self === U2 ? route.targetPull : route.sourcePull;
    if (pull !== undefined && int(r, 5) > 0) pulls.set(pull.pullId, { pullId: pull.pullId });
    if (pull !== undefined && int(r, 6) === 0) queued.push({ type: "cross_pull_close", pullId: pull.pullId, binary: "0x", proof: {} as CrossCloseProof });
    if (int(r, 3) === 0) {
      const id = `${peer}:${route.orderId}`, pairId = pick(r, ["1/2", "2/3"]);
      const cmd = { kind: 0 as const, ownerId: peer, orderId: id, side: pick(r, [0, 1] as const), tif: 0 as const, postOnly: false, priceTicks: BigInt(100 + int(r, 50)), qtyLots: BigInt(1 + int(r, 20)) };
      const ogB = ogExt.books.get(pairId) ?? ogBook.createBook(params), rwB = rwBooks.get(pairId) ?? unwrap(createBook(params));
      ogExt.books.set(pairId, ogBook.applyCommand(ogB, cmd).state); rwBooks.set(pairId, unwrap(applyBookCommand(rwB, cmd)).state);
    }
  }
  rebuildOrderbookPairIndex(ogExt);
  const hasAccount = int(r, 10) > 0, validators = int(r, 20) === 0 ? [] : [sig(self)];
  const account: HubAccount = { active: true, left: self < peer ? self : peer, right: self < peer ? peer : self, offers, queued, pulls: pulls as never };
  const og = {
    entityId: self, timestamp: T0, config: { mode: "proposer-based", threshold: 1n, validators, shares: Object.fromEntries(validators.map((v) => [v, 1n])), jurisdiction: { name: "J", ...J1 } },
    accounts: new Map(hasAccount ? [[peer, { status: "active", mempool: queued.map(ogAccountTx), state: { swapOffers: new Map(offers), pulls: new Map(pulls) } }]] : []),
    orderbookExt: ogExt, crossJurisdictionSwaps: ogColl(stored),
  };
  const rw: BookHost = { id: self, timestamp: T0, validators, ext: { books: rwBooks, pairDimensions: new Map(), referrals: new Map(), hubProfile }, swaps: stored, admissions: undefined, accounts: new Map(hasAccount ? [[peer, account]] : []) };
  return { rw, og, routes };
};
type Snap = { swaps: unknown; books: unknown; messages: unknown; outputs: unknown; accountTxs: unknown };
const entries = (m: ReadonlyMap<string, unknown> | undefined) => (m === undefined || m.size === 0 ? null : [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
const ogSnap = (s: any, res: { outputs: any[]; accountTxs?: any[] }): Snap => ({
  swaps: entries(new Map(s.crossJurisdictionSwaps)), books: [...s.orderbookExt.books].map(([p, b]: [string, any]) => [p, ogBook.getBookOrders(b).map((o: any) => [o.orderId, o.qtyLots])]).sort(),
  messages: readEntityFrameEvents(s).map((e: any) => e.message), outputs: res.outputs.map((o) => ({ entityId: o.entityId, signerId: o.signerId, txs: o.entityTxs })), accountTxs: (res.accountTxs ?? []).map(flatAccountTx),
});
const rwSnap = (s: CrossHostStep): Snap => ({
  swaps: entries(s.host.swaps), books: [...(s.host.ext?.books ?? new Map())].map(([p, b]) => [p, bookOrders(b).map((o) => [o.orderId, o.qtyLots])]).sort(), messages: s.messages, outputs: s.outputs, accountTxs: s.accountTxs,
});
const outcome = (o: Out<Snap>): string => (o.ok ? `ok:${(o.value.accountTxs as unknown[]).length}:${String((o.value.messages as string[]).at(-1) ?? "").replace(/C\d+/g, "#").replace(/ 0x[0-9a-f]+/g, "")}` : o.message);

describe(seedTag("cross-j-final: clear lifecycle Entity txs"), () => {
  test("MATCH: requestCrossJurisdictionClear on 600 random source hubs, source users and strangers (terminal, snapshot drift, pure cancel, filled reveal, book row, queued close): same routes, books, messages, outputs, Account txs and halts as og", () => {
    const r = rng(0xc1ea), kinds = new Map<string, number>();
    const want = ["CROSS_J_CLEAR_ROUTE_MISSING", "CROSS_J_CLEAR_CORRUPT_ROUTE", "CROSS_J_CLEAR_SOURCE_OFFER_MISSING", "CROSS_J_CLEAR_ROUTE_HASH_MISMATCH", "CROSS_J_CLEAR_SOURCE_PARTICIPANT_REQUIRED",
      "ok:1:🌉 Cross-j clear # queued atomic Hub pure-can", "ok:0:🌉 Cross-j clear # awaiting proposer reveal", "ok:1:🌉 Cross-j clear # queued through source Ac", "ok:0:🌉 Cross-j clear # ignored: source pull clo", "ok:0:🌉 Cross-j clear # waiting for source close"];
    for (let i = 0, more = untilCovered(600, () => hasKinds(kinds, want)); more(i); i++) {
      const self = pick(r, [H1, H1, H1, H1, U1, U1, H2]), w = worldOf(r, i, self), route = w.routes[0]!;
      const data = { orderId: int(r, 25) === 0 ? "missing" : route.orderId, ...(int(r, 3) > 0 ? { cancelRemainder: r() < 0.6 } : {}) };
      const og = ogRun(() => { const res = handleRequestCrossJurisdictionClearEntityTx(ogEnv, w.og, { type: "requestCrossJurisdictionClear", data } as never, [], true); return ogSnap(res.newState, res); });
      const rw = rwRun(requestCrossClear(w.rw, data));
      same(`clear ${i}`, og, rw.ok ? { ok: true, value: rwSnap(rw.value) } : rw);
      bump(kinds, outcome(og));
    }
    expectKinds(kinds, want);
  }, 30_000);

  test("MATCH: materializeCrossJurisdictionClear on 400 random source hubs (proposer, intent, reveal ratio, tampered proof, missing or queued source pull, fork hash): same routes, outputs, Account txs, rejects and halts as og", () => {
    const r = rng(0x3a7e), kinds = new Map<string, number>();
    const want = ["ok:1:🌉 Cross-j clear # queued atomic Hub source+ta", "CROSS_J_CLEAR_MATERIALIZE_INTENT_MISSING", "CROSS_J_CLEAR_MATERIALIZE_PROPOSER_INVALID", "CROSS_J_CLEAR_MATERIALIZE_RATIO_MISMATCH",
      "CROSS_J_CLEAR_MATERIALIZE_BINARY_INVALID", "CROSS_J_CLEAR_MATERIALIZE_PROOF_MISMATCH", "CROSS_J_CLEAR_MATERIALIZE_SOURCE_PULL_MISSING", "CROSS_J_CLEAR_MATERIALIZE_FILL_MISSING"];
    for (let i = 0, more = untilCovered(400, () => hasKinds(kinds, want)); more(i); i++) {
      const w = worldOf(r, i, H1), route = w.routes[0]!;
      if (int(r, 5) > 0) { const next = new Map([...w.rw.swaps!].map(([k, v]) => [k, { ...v, status: "clear_requested" as const }])); w.rw = { ...w.rw, swaps: next }; w.og.crossJurisdictionSwaps = ogColl(next); }
      const ratio =(() => { const f = ogRun(() => ogCrossIndex.getCrossJurisdictionCommittedFillAmounts(route as never).fillRatio); return f.ok ? f.value : 0; })();
      const at = pick(r, [ratio, ratio, ratio, ratio, Math.max(1, ratio - 1), 65_535, 1 + int(r, 65_534)]);
      const binary = at > 0 && route.sourcePull ? unwrap(crossPullReveal(at, unwrap(crossPrivateSeed(pick(r, [RUNTIME_SEED, RUNTIME_SEED, RUNTIME_SEED, "0x" + "77".repeat(32)]), route)))).binary : pick(r, ["0x", "0x1234"]);
      const built = route.sourcePull && route.targetPull ? buildCrossCloseProof(route, binary) : undefined;
      const proof: CrossCloseProof = built?.ok ? (int(r, 8) === 0 ? { ...built.value, cumulativeSourceAmount: built.value.cumulativeSourceAmount + 1n } : built.value)
        : { orderId: route.orderId, routeHash: "0x", sourcePullId: "", targetPullId: "", fillRatio: 0, cumulativeSourceAmount: 0n, cumulativeTargetAmount: 0n, binaryHash: "0x", closeMode: "pure_cancel" };
      const data = { proposerSignerId: int(r, 12) === 0 ? "0x" + "55".repeat(20) : int(r, 12) === 0 ? sig(H1).toUpperCase().replace("0X", "0x") : sig(H1), orderId: route.orderId, binary, proof };
      const og = ogRun(() => { const res = handleMaterializeCrossJurisdictionClearEntityTx(ogEnv, w.og, { type: "materializeCrossJurisdictionClear", data } as never, true); return ogSnap(res.newState, res); });
      const rw = rwRun(materializeCrossClear(w.rw, data));
      same(`materialize ${i}`, og, rw.ok ? { ok: true, value: rwSnap(rw.value) } : rw);
      bump(kinds, outcome(og));
    }
    expectKinds(kinds, want);
  }, 30_000);

  test("MATCH: crossPullClose at the source hub and the target hub on 500 random routes (status fences, command route, proof drift, rollback, binary): same routes, messages, Account txs and halts as og", () => {
    const r = rng(0x9c10), kinds = new Map<string, number>();
    const want = ["source:ok:1:", "target:ok:1:", "source:CROSS_J_PULL_CLOSE_PROOF_INVALID", "target:CROSS_J_PULL_CLOSE_PROOF_INVALID", "target:CROSS_J_PULL_CLOSE_ACCOUNT_MISSING", "source:CROSS_J_PULL_CLOSE_ROUTE_MISSING"];
    for (let i = 0, more = untilCovered(500, () => hasKinds(kinds, want)); more(i); i++) {
      const self = pick(r, [H1, H2, H2]), w = worldOf(r, i, self), route = w.routes[0]!, leg = self === H1 ? "source" : "target";
      const pull = leg === "source" ? route.sourcePull : route.targetPull;
      const cur = (() => { const f = ogRun(() => ogCrossIndex.getCrossJurisdictionCommittedProofRatio(route)); return f.ok ? f.value : 0; })();
      const at = pick(r, [cur, cur, cur, 0, 65_535, Math.max(0, cur - 1), 1 + int(r, 65_534)]);
      const binary = at > 0 && pull ? unwrap(crossPullReveal(at, unwrap(crossPrivateSeed(RUNTIME_SEED, route)))).binary : "0x";
      const built = route.sourcePull && route.targetPull ? buildCrossCloseProof(withCloseProofProgress(route, { fillRatio: at, cumulativeSourceAmount: 0n, cumulativeTargetAmount: 0n } as CrossCloseProof, route.updatedAt), binary) : undefined;
      const exact = built?.ok ? { ...built.value, cumulativeSourceAmount: at >= 65_535 ? route.source.amount : (route.source.amount * BigInt(at)) / 65_535n, cumulativeTargetAmount: at >= 65_535 ? route.target.amount : (route.target.amount * BigInt(at)) / 65_535n } : undefined;
      const rebuilt = exact === undefined ? undefined : buildCrossCloseProof(withCloseProofProgress(route, exact, route.updatedAt), binary);
      const proof: CrossCloseProof = rebuilt?.ok ? (int(r, 10) === 0 ? { ...rebuilt.value, routeHash: "0x" + "ee".repeat(32) } : int(r, 10) === 0 ? { ...rebuilt.value, cumulativeTargetAmount: rebuilt.value.cumulativeTargetAmount + 1n } : rebuilt.value)
        : { orderId: route.orderId, routeHash: route.routeHash ?? "", sourcePullId: "", targetPullId: "", fillRatio: 0, cumulativeSourceAmount: 0n, cumulativeTargetAmount: 0n, binaryHash: "0x", closeMode: "pure_cancel" };
      // the target hub knows the source close proof from its mirror or from the command route
      const withSource = leg === "target" && int(r, 3) > 0;
      if (withSource) { const stored = w.rw.swaps!.get(route.orderId)!; const next = new Map(w.rw.swaps!).set(route.orderId, { ...stored, sourceCloseProof: proof }); w.rw = { ...w.rw, swaps: next }; w.og.crossJurisdictionSwaps = ogColl(next); }
      const command: CrossRoute | undefined = int(r, 2) === 0 ? undefined : { ...route, ...(leg === "target" && !withSource ? { sourceCloseProof: proof } : {}), ...(int(r, 12) === 0 ? { orderId: "other" } : {}) };
      const data = { counterpartyEntityId: int(r, 20) === 0 ? U1 : PEER[self]!, pullId: pull?.pullId ?? "none", binary, proof, ...(command ? { route: command } : {}) };
      const og = ogRun(() => { const res = handleCrossPullCloseEntityTx(ogEnv, w.og, { type: "crossPullClose", data } as never, { mutableFrameState: true } as never); return ogSnap(res.newState, res); });
      const rw = rwRun(crossPullCloseTx(w.rw, data));
      same(`close ${i}`, og, rw.ok ? { ok: true, value: rwSnap(rw.value) } : rw);
      bump(kinds, `${leg}:${outcome(og)}`);
    }
    expectKinds(kinds, want);
    expect([...kinds.keys()].some((k) => k.includes("blocked: route"))).toBe(true);
  }, 30_000);

  test("MATCH: orderbookSweepCrossJurisdiction on 300 random Entities holding 1-4 routes (expired, waiting, terminal, foreign source hub): same routes, books, message counts, outputs, Account txs and halts as og", () => {
    const r = rng(0x5eee), kinds = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const self = pick(r, [H1, H1, H1, H2]), w = worldOf(r, i, self, 1 + int(r, 4)), reason = pick(r, [undefined, "", "cross-j-expiry:x"]);
      const og = ogRun(() => { const res = handleOrderbookSweepCrossJurisdictionEntityTx(ogEnv, w.og, { type: "orderbookSweepCrossJurisdiction", data: reason === undefined ? {} : { reason } } as never, [], true); return ogSnap(res.newState, res); });
      const rw = rwRun(crossSweep(w.rw, reason));
      same(`sweep ${i}`, og, rw.ok ? { ok: true, value: rwSnap(rw.value) } : rw);
      bump(kinds, og.ok ? String((og.value.messages as string[]).at(-1)).replace(/^.*sweep(: \S+)? /, "") : og.message);
    }
    expect([...kinds.keys()].some((k) => /closedOffers=[1-9]/.test(k))).toBe(true);
    expect([...kinds.keys()].some((k) => /expired=[1-9].*closedOffers=0/.test(k))).toBe(true);
    expect([...kinds.keys()].some((k) => /waiting=[1-9]/.test(k))).toBe(true);
  }, 30_000);

  test("MATCH: the default proposer's clear reveal (appendDefaultProposerCrossJMaterializations clear branch) on 300 random source hubs: same materializeCrossJurisdictionClear txs and halts as og", () => {
    const r = rng(0x7e7e), kinds = new Map<string, number>();
    const want = ["ok:0", "ok:1"];
    for (let i = 0, more = untilCovered(300, () => hasKinds(kinds, want)); more(i); i++) {
      const w = worldOf(r, i, H1, 1 + int(r, 3));
      // og's setup branch materializes raw intents too; only prepared routes are compared here
      const keep = new Map([...w.rw.swaps!].filter(([, v]) => v.status !== "intent" || v.sourcePull !== undefined));
      w.rw = { ...w.rw, swaps: keep }; w.og.crossJurisdictionSwaps = ogColl(keep);
      const pendingIds = [...keep.keys()].filter(() => int(r, 8) === 0), mempool = pendingIds.map((orderId) => ({ type: "materializeCrossJurisdictionClear", data: { proposerSignerId: sig(H1), orderId, binary: "0x", proof: {} } }));
      const replica = { entityId: H1, signerId: sig(H1), state: w.og, mempool };
      const og = ogRun(() => appendDefaultProposerCrossJMaterializations(ogEnv, replica as never, []));
      // og: only the default proposer (validators[0]) materializes
      const rw = w.rw.validators[0] !== sig(H1) ? { ok: true as const, value: [] } : rwRun(crossClearReveals(w.rw, sig(H1), RUNTIME_SEED, new Set(pendingIds.map((id) => `clear:${id}`))));
      same(`reveal ${i}`, og, rw);
      bump(kinds, og.ok ? `ok:${og.value.length}` : og.message);
    }
    expectKinds(kinds, want);
  }, 30_000);

  test("MATCH: assertRuntimeOutputAuthorization for crossPullClose on 400 random envelopes (stored vs command route, source hub, target hub, counterparty)", () => {
    const r = rng(0xa0c1), outcomes = new Map<string, number>(), ids = [U1, H1, H2, U2];
    for (let i = 0; i < 400; i++) {
      const route = liveRoute(r, i), target = pick(r, [H2, H2, H1, U2]), source = pick(r, [H1, H1, ids[int(r, 4)]!]);
      const signer = int(r, 10) < 8 ? sig(source) : "0x" + "55".repeat(20), drift: CrossRoute = int(r, 6) === 0 ? { ...route, routeHash: "0x" + "ee".repeat(32) } : route;
      const proof = { orderId: int(r, 12) === 0 ? "other" : route.orderId, routeHash: route.routeHash ?? "", sourcePullId: "", targetPullId: "", fillRatio: 0, cumulativeSourceAmount: 0n, cumulativeTargetAmount: 0n, binaryHash: "0x", closeMode: "pure_cancel" as const };
      const tx = { type: "crossPullClose", data: { counterpartyEntityId: int(r, 8) === 0 ? U1 : U2, pullId: "p", binary: "0x", proof, ...(int(r, 4) > 0 ? { route: drift } : {}) } } as EntityTx;
      const stored = int(r, 3) > 0 ? new Map([[route.orderId, route]]) : undefined, validators = [sig(target)];
      const ogState = { entityId: target, config: { mode: "proposer-based", threshold: 1n, validators, shares: { [validators[0]!]: 1n } }, ...(stored ? { crossJurisdictionSwaps: ogColl(stored) } : {}) };
      const rwState = { id: target, quorum: unwrap(createEntity({ id: target, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[validators[0] as Address, { shares: 1n }]]) })).state.quorum, ...(stored ? { crossJurisdictionSwaps: stored } : {}) } as unknown as EntityState;
      const og = (() => { try { assertRuntimeOutputAuthorization(source, signer, target, [tx] as never, ogState as never); return null; } catch (e) { return (e as Error).message; } })();
      expect(`${i}:${runtimeOutputAuthError(rwState, { protocol: "cross-j", sourceEntityId: source, sourceSignerId: signer, targetEntityId: target, entityTxs: [tx] })}`).toBe(`${i}:${og}`);
      bump(outcomes, og === null ? "ok" : og.replace(/:.*/, ""));
    }
    expectKinds(outcomes, ["ok", "RUNTIME_OUTPUT_CROSS_PULL_COUNTERPARTY_MISMATCH", "RUNTIME_OUTPUT_SEMANTIC_SOURCE_MISMATCH", "RUNTIME_OUTPUT_ROUTE_HASH_MISMATCH"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// og account-cross-j-followups.ts applyCommittedCrossJurisdictionAccountTxFollowup: a committed cross_pull_lock / cross_pull_close on the Entity.
import { applyCommittedCrossJurisdictionAccountTxFollowup } from "../../core/entity/tx/handlers/account-cross-j-followups.ts";
import { committedCrossFollowup, crossPullBinding, type CommittedCrossHost, type CommittedCrossStep, type Crontab } from "../xln.ts";

describe(seedTag("cross-j-final: committed cross-j Account tx followups"), () => {
  type FWorld = { rw: CommittedCrossHost; og: any; route: CrossRoute };
  /** A mirror at `self` for one prepared route: stored route / authorization / crontab / book at random stages. */
  const fworld = (r: Rand, n: number, self: EntityId): FWorld => {
    const route = liveRoute(r, n), peer = PEER[self]!;
    const w = worldOf(r, n, self);
    const stored = int(r, 4) === 0 ? undefined : int(r, 10) === 0 && route.routeHash ? { ...route, routeHash: "0x" + "dd".repeat(32) } : route;
    const swaps = stored === undefined ? undefined : new Map([[route.orderId, stored]]);
    const auths = self === U1 || self === U2 ? (int(r, 5) === 0 ? undefined : new Map([[route.orderId, int(r, 10) === 0 ? { ...route, routeHash: "0x" + "ee".repeat(32) } : route]])) : undefined;
    const crontab: Crontab | undefined = int(r, 15) === 0 ? undefined : { tasks: new Map(), hooks: new Map(int(r, 2) === 0 ? [] : [[`cross-j-expiry:${route.orderId}`, { id: `cross-j-expiry:${route.orderId}`, triggerAt: T0 + 5, type: "cross_j_orderbook_sweep" as const, data: { reason: "x" } }]]) };
    const account = w.rw.accounts.get(peer);
    const offers = new Map([[route.orderId, offerOf(route, route.orderId)]]);
    const rwAccounts = new Map(account === undefined ? [] : [[peer, { ...account, offers }]]);
    const ogOffers = new Map([...offers].map(([k, o]) => [k, { ...o, giveTokenId: Number(o.giveTokenId), wantTokenId: Number(o.wantTokenId) }]));
    w.og.accounts = new Map(account === undefined ? [] : [[peer, { ...w.og.accounts.get(peer), state: { ...w.og.accounts.get(peer).state, leftEntity: account.left, rightEntity: account.right, swapOffers: ogOffers } }]]);
    if (swaps === undefined) delete w.og.crossJurisdictionSwaps; else w.og.crossJurisdictionSwaps = ogColl(swaps);
    if (auths !== undefined) w.og.crossJurisdictionAuthorizations = ogColl(auths);
    if (crontab !== undefined) w.og.crontabState = { tasks: new Map(), hooks: new Map(crontab.hooks) };
    return { rw: { ...w.rw, swaps, accounts: rwAccounts, ...(auths ? { auths } : {}), ...(crontab ? { crontab } : {}) }, og: w.og, route };
  };
  type FSnap = { swaps: unknown; auths: unknown; hooks: unknown; admissions: unknown; books: unknown; messages: unknown; outputs: unknown; created: unknown; handled: unknown };
  const ogF = (s: any, outputs: any[], created: unknown[], handled: boolean): FSnap => ({
    swaps: entries(s.crossJurisdictionSwaps && new Map(s.crossJurisdictionSwaps)), auths: entries(s.crossJurisdictionAuthorizations && new Map(s.crossJurisdictionAuthorizations)), hooks: entries(s.crontabState && new Map(s.crontabState.hooks)),
    admissions: entries(s.crossJurisdictionBookAdmissions && new Map(s.crossJurisdictionBookAdmissions)), books: [...s.orderbookExt.books].map(([p, b]: [string, any]) => [p, ogBook.getBookOrders(b).map((o: any) => [o.orderId, o.qtyLots])]).sort(),
    messages: readEntityFrameEvents(s).map((e: any) => e.message), outputs: outputs.map((o) => ({ entityId: o.entityId, signerId: o.signerId, txs: o.entityTxs })), created, handled,
  });
  const rwF = (s: CommittedCrossStep): FSnap => ({
    swaps: entries(s.host.swaps), auths: entries(s.host.auths), hooks: entries(s.host.crontab?.hooks), admissions: entries(s.host.admissions),
    books: [...(s.host.ext?.books ?? new Map())].map(([p, b]) => [p, bookOrders(b).map((o) => [o.orderId, o.qtyLots])]).sort(), messages: s.messages, outputs: s.outputs, created: s.created, handled: s.handled,
  });
  const runBoth = (w: FWorld, cp: string, tx: WireAccountTx, label: string, kinds: Map<string, number>) => {
    const og = ogRun(() => { const outputs: any[] = [], created: unknown[] = []; const handled = applyCommittedCrossJurisdictionAccountTxFollowup(ogEnv, w.og, cp, ogAccountTx(tx) as never, outputs, T0, created as never, []); return ogF(w.og, outputs, created, handled); });
    const rw = rwRun(committedCrossFollowup(w.rw, cp, tx, T0));
    same(label, og, rw.ok ? { ok: true, value: rwF(rw.value) } : rw);
    bump(kinds, og.ok ? `ok:${(og.value.outputs as unknown[]).length}:${(og.value.created as unknown[]).length}:${String((og.value.messages as string[]).at(-1) ?? "").slice(0, 20)}` : og.message);
  };

  test("MATCH: committed cross_pull_lock at all four route participants on 500 random mirrors (carried route, conflict, leg binding, authorization, expiry hook, local or sibling book admission): same mirror, authorizations, hooks, admissions, outputs, created offers and halts as og", () => {
    const r = rng(0x10c4), kinds = new Map<string, number>();
    const want = ["ok:0:0:", "CROSS_J_COMMITTED_PULL_AUTH_MISSING", "CROSS_J_COMMITTED_PULL_ROUTE_MISMATCH", "CROSS_J_COMMITTED_PULL_ROUTE_CONFLICT", "CROSS_J_EXPIRY_INVALID"];
    for (let i = 0, more = untilCovered(500, () => hasKinds(kinds, want)); more(i); i++) {
      const self = pick(r, [H1, H1, U1, H2, U2]), w = fworld(r, i, self), route = { ...w.route, status: pick(r, ["target_prepared", "target_prepared", "resting", "intent", "settled"] as const) };
      if (route.sourcePull === undefined || route.targetPull === undefined) continue;
      const leg = self === H1 || self === U1 ? "source" : "target", pull = leg === "source" ? route.sourcePull : route.targetPull, binding = unwrap(crossPullBinding(route, int(r, 15) === 0 ? (leg === "source" ? "target" : "source") : leg));
      const tx: WireAccountTx = { type: "cross_pull_lock", pullId: pull.pullId, tokenId: String(pull.tokenId) as never, amount: int(r, 15) === 0 ? pull.signedAmount + 1n : pull.signedAmount, fullHash: pull.fullHash, partialRoot: pull.partialRoot, crossJurisdiction: binding,
        crossJurisdictionRoute: int(r, 10) === 0 ? { ...route, expiresAt: T0 - 1 } : route };
      runBoth(w, int(r, 20) === 0 ? U2 : PEER[self]!, tx, `lock ${i}`, kinds);
    }
    expectKinds(kinds, want);
    expect([...kinds.keys()].some((k) => /^ok:0:1:/.test(k))).toBe(true);
  }, 30_000);

  test("MATCH: committed cross_pull_close at all four route participants on 500 random mirrors (terminal replay, economics, rollback, hub state fence, settle/cancel/expire, book removal or sibling removal request): same mirror, hooks, admissions, books, outputs and halts as og", () => {
    const r = rng(0xc105e), kinds = new Map<string, number>();
    const want = ["ok:0:0:", "CROSS_J_PULL_CLOSE_ROUTE_MISSING", "CROSS_J_PULL_CLOSE_ECONOMICS_MISMATCH", "CROSS_J_PULL_CLOSE_PROOF_MISMATCH", "CROSS_J_TERMINAL_PULL_REPLAY_MISMATCH"];
    for (let i = 0, more = untilCovered(500, () => hasKinds(kinds, want)); more(i); i++) {
      const self = pick(r, [H1, H1, U1, H2, U2]), w = fworld(r, i, self), route = w.route;
      if (route.sourcePull === undefined || route.targetPull === undefined) continue;
      const cur = (() => { const f = ogRun(() => ogCrossIndex.getCrossJurisdictionCommittedProofRatio(route)); return f.ok ? f.value : 0; })();
      const at = pick(r, [cur, cur, cur, 0, 65_535, Math.max(0, cur - 1), 1 + int(r, 65_534)]);
      const binary = at > 0 ? unwrap(crossPullReveal(at, unwrap(crossPrivateSeed(RUNTIME_SEED, route)))).binary : "0x";
      const project = (t: bigint) => (at >= 65_535 ? t : (t * BigInt(at)) / 65_535n);
      const built = buildCrossCloseProof(withCloseProofProgress(route, { fillRatio: at, cumulativeSourceAmount: project(route.source.amount), cumulativeTargetAmount: project(route.target.amount) } as CrossCloseProof, route.updatedAt), binary);
      if (!built.ok) continue;
      const proof: CrossCloseProof = int(r, 12) === 0 ? { ...built.value, cumulativeSourceAmount: built.value.cumulativeSourceAmount + 1n } : int(r, 15) === 0 ? { ...built.value, routeHash: "0x" + "ee".repeat(32) } : built.value;
      // a terminal mirror that already recorded exactly this close (a replay) or another one
      if (int(r, 4) === 0 && w.rw.swaps !== undefined) {
        const settled = unwrap(applyCrossFill(route, { fillSeq: Math.floor(Number(route.fillSeq ?? 0)), cumulativeFillRatio: at, fillNumerator: BigInt(at), fillDenominator: 65_535n }, T0).ok ? { ok: true as const, value: route } : { ok: true as const, value: route });
        const replayed: CrossRoute = { ...withCloseProofProgress(settled, built.value, T0 - 1), sourceCloseProof: int(r, 5) === 0 ? { ...built.value, binaryHash: "0x" + "00".repeat(32) } : built.value, status: pick(r, ["settled", "cancelled"] as const) };
        const next = new Map([[route.orderId, replayed]]); w.rw = { ...w.rw, swaps: next }; w.og.crossJurisdictionSwaps = ogColl(next);
      }
      const tx: WireAccountTx = { type: "cross_pull_close", pullId: int(r, 20) === 0 ? "none" : (self === H1 || self === U1 ? route.sourcePull.pullId : route.targetPull.pullId), binary, proof };
      runBoth(w, PEER[self]!, tx, `close ${i}`, kinds);
    }
    expectKinds(kinds, want);
  }, 40_000);
});
