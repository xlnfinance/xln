// Order book draws: same-j swaps, and the cross-j book and swap kinds. Owner: the "order book" area thread.
// The hub opens one same-jurisdiction market and the spokes
// trade on it through their hub Accounts. Each draw reads og's committed state and offers only what og's own guards
// let a UI send; og's rejections that drop a tx without halting are drawn on purpose.
//
// og guards, by kind (ast-grep `throw $E` and `accountTxValidationRejected($M, $$$)` over the files named):
//   initOrderbookExt (entity/tx/handlers/system/basic.ts handleInitOrderbookExtEntityTx)
//     - an Entity that already has a book: no-op
//     - spread bps that do not validate: no-op
//     - usdQuoteAuthorityEntityId not a 32-byte hex id: ORDERBOOK_USD_QUOTE_AUTHORITY_INVALID, a halt
//   placeSwapOffer (payments/swap-requests.ts, then account/tx/handlers/swap/offer/*)
//     - no Account with the counterparty: SWAP_REQUEST_ACCOUNT_MISSING, a halt
//     - Account admission, all rejections that drop the tx: colon in offerId, duplicate offerId, 50 open offers,
//       32 same-j offers, 32 per side per market, decimals outside 0..255, amounts below 1, maxFee >= want or
//       minNetReceive <= 0, same token both legs, base below one lot, explicit priceTicks off step or drifting,
//       quantized amounts out of range, give above the maker's out capacity
//     - on the hub (entity/consensus/account/orderbook-admission.ts, orderbook/same/*): zero amounts, quote below
//       minTradeSize, misaligned base or quote lots, price outside the 30% band, a full book all cancel the offer
//       with a zero fill (swap_resolve); a hub with no book never matches the offer
//     - a fill the hub cannot pay (want above the hub's out capacity) fails its swap_resolve proposal:
//       SWAP_RESOLVE_PROPOSAL_FAILED, a halt (account/consensus/proposal/transactions.ts:220). og holds the give leg
//       when the offer commits but checks the want leg only at fill time (swap/resolve/settlement.ts:14), so one
//       taker can fill several of a maker's offers past what the hub can pay: see `hubCanPay`. Core payments from
//       other areas that shrink the hub's side under a resting offer are not guarded here.
//   proposeCancelSwap (payments/swap-requests.ts, account/tx/handlers/swap/lifecycle/cancel.ts)
//     - no Account: SWAP_REQUEST_ACCOUNT_MISSING, a halt
//     - no such offer, or the caller is not its maker: rejected, dropped
//     - a committed cancel request on a hub with no book: ORDERBOOK_EXTENSION_REQUIRED_FOR_CANCEL, a halt
//       (orderbook/cancels.ts processOrderbookCancels)
import { deriveDelta } from "../../../core/account/utils.ts";
import { tokenId, type EntityTx, type TokenId } from "../../xln.ts";
import { unwrap } from "../../xln_run.ts";
import { HUB, SPOKES, type World } from "../world.ts";
import { arises, drawn, type Moves, type Step, type WorldMoves } from "./areas.ts";
import { active, isLeft, pick, replica, type OgAccountReplica } from "./world-view.ts";

// ---- the market ----

/** USDC and USDT: both 6 decimals, so one lot is one unit, and og's static policy anchors the pair at 1.0000. */
const BASE = unwrap(tokenId("1"));
const QUOTE = unwrap(tokenId("3"));
const DECIMALS = 6;
const PRICE_SCALE = 10_000n;
/**
 * Limit prices in og's ticks (quote per base, scale 10 000). Every in-band price here divides its quote exactly at
 * any multiple of LOT_STEP lots; 14 000 sits outside og's 30% band, so the hub cancels it with a zero fill.
 */
const IN_BAND = [9_000n, 9_500n, 10_000n, 10_500n, 11_000n] as const;
const OUT_OF_BAND = 14_000n;
const LOT_STEP = 20n;
/** Credit lines the hub and its spokes open on both legs when the market opens. */
const MARKET_CREDIT = 1_000_000n;

type Side = "sell" | "buy";
/** One limit order on the market, in base lots at a price: what a trader types into og's swap form. */
type Order = { readonly side: Side; readonly lots: bigint; readonly priceTicks: bigint };
type Leg = { readonly tokenId: TokenId; readonly amount: bigint };
/** The two Account legs of an order: the maker gives one token and wants the other. */
type Terms = { readonly give: Leg; readonly want: Leg };

const quoteOf = (o: Order): bigint => (o.lots * o.priceTicks) / PRICE_SCALE;
const termsOf = (o: Order): Terms => {
  switch (o.side) {
    case "sell":
      return { give: { tokenId: BASE, amount: o.lots }, want: { tokenId: QUOTE, amount: quoteOf(o) } };
    case "buy":
      return { give: { tokenId: QUOTE, amount: quoteOf(o) }, want: { tokenId: BASE, amount: o.lots } };
  }
};

// ---- og's committed state, as draws read it ----

type OgSwapOffer = {
  readonly offerId: string;
  readonly makerIsLeft: boolean;
  readonly wantTokenId: number;
  readonly wantAmount: bigint;
};
type OgSwapOfferTx = { readonly type: "swap_offer"; readonly data: Omit<OgSwapOffer, "makerIsLeft"> };
type OgSwapState = {
  readonly deltas?: ReadonlyMap<number, Parameters<typeof deriveDelta>[0]>;
  readonly swapOffers?: ReadonlyMap<string, OgSwapOffer>;
};

const swapState = (w: World, x: number, y: number): OgSwapState | undefined => replica(w, x, y)?.state as never;
const hasBook = (w: World): boolean => (w.ogState(HUB) as { orderbookExt?: unknown } | undefined)?.orderbookExt != null;
/** Spokes trading with the hub: both replicas of their hub Account are active. */
const traders = (w: World): readonly number[] => SPOKES.filter((s) => active(w, s, HUB) && active(w, HUB, s));

type Capacity = { readonly out: bigint; readonly in: bigint };
/** og deriveDelta from the maker's side of its hub Account; a token with no delta has no capacity. */
const capacity = (w: World, maker: number, token: TokenId): Capacity => {
  const delta = swapState(w, maker, HUB)?.deltas?.get(Number(token));
  if (delta === undefined) return { out: 0n, in: 0n };
  const derived = deriveDelta(delta, isLeft(w, maker, HUB));
  return { out: derived.outCapacity, in: derived.inCapacity };
};
/** The maker's own resting offers on its hub Account. */
const restingOffers = (w: World, maker: number): readonly OgSwapOffer[] => {
  const offers = [...(swapState(w, maker, HUB)?.swapOffers?.values() ?? [])];
  return offers.filter((o) => o.makerIsLeft === isLeft(w, maker, HUB));
};
/** The maker's swap_offer txs not committed yet: in its Account mempool or in the frame it has in flight. */
const inFlightOffers = (w: World, maker: number): readonly OgSwapOfferTx["data"][] => {
  const r: OgAccountReplica | undefined = replica(w, maker, HUB);
  const txs = [...(r?.mempool ?? []), ...(r?.pendingFrame?.accountTxs ?? [])] as readonly { type: string }[];
  return txs.filter((t): t is OgSwapOfferTx => t.type === "swap_offer").map((t) => t.data);
};
/** Everything the hub may owe the maker in `token` once its offers fill, at their own limit prices. */
const wantsOn = (w: World, maker: number, token: TokenId): bigint =>
  [...restingOffers(w, maker), ...inFlightOffers(w, maker)]
    .filter((o) => o.wantTokenId === Number(token))
    .reduce((sum, o) => sum + o.wantAmount, 0n);

/**
 * How far a fill can pay past an offer's own limit. og executes a same-j match at the resting maker's price
 * (orderbook/core.ts:243), so an offer that crosses as the taker receives up to the other limit: a sell at the lowest
 * in-band price filled by a buy at the highest gets want * max / min. Every limit og keeps on the book is in IN_BAND:
 * the hub cancels OUT_OF_BAND at its price band (entity/tx/handlers/account/orderbook/helpers.ts:345) and the off-lot
 * order at the quote-lot check (helpers.ts:288).
 */
const IMPROVEMENT = { max: IN_BAND[IN_BAND.length - 1]!, min: IN_BAND[0] } as const;

/**
 * The maker can give its leg now, and the hub can pay every fill of the maker's offers on the wanted token, this one
 * included, at the best price improvement: og's matcher does not check the hub's capacity before it fills.
 */
const affordable = (w: World, maker: number, t: Terms): boolean => {
  const canGive = t.give.amount <= capacity(w, maker, t.give.tokenId).out;
  const owed = wantsOn(w, maker, t.want.tokenId) + t.want.amount;
  const hubCanPay = owed * IMPROVEMENT.max <= capacity(w, maker, t.want.tokenId).in * IMPROVEMENT.min;
  return canGive && hubCanPay;
};

// ---- draws ----

/** An extendCredit to `to`, authored by whichever Entity the step hands it to. */
const credit = (w: World, to: number, token: TokenId): EntityTx => ({
  type: "extendCredit",
  data: { counterpartyEntityId: w.ids[to]!, tokenId: token, amount: MARKET_CREDIT },
});

/** og's default (every tick of improvement to the taker), a split one, and one whose bps do not sum to 10 000. */
const SPREADS = [
  { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
  { makerBps: 4_000, takerBps: 4_000, hubBps: 2_000, makerReferrerBps: 0, takerReferrerBps: 0 },
  { makerBps: 9_000, takerBps: 9_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
] as const;

/**
 * The hub opens its book over the pair, and credit on both legs of every spoke Account, the way og's hub bootstrap
 * does (orchestrator/hub-node.ts). Invalid spread bps are drawn too: og keeps the Entity as it was.
 */
const openMarket = (w: World): Step => {
  const spread = pick(w, SPREADS);
  const book: EntityTx = {
    type: "initOrderbookExt",
    data: {
      name: `book ${w.ri(100)}`,
      spreadDistribution: spread,
      referenceTokenId: Number(BASE),
      usdQuoteAuthorityEntityId: w.ids[HUB]!,
      minTradeSize: BigInt(w.ri(3)) * 10n,
      supportedPairs: [`${BASE}/${QUOTE}`],
    },
  };
  const lines = traders(w).flatMap((s) => [credit(w, s, BASE), credit(w, s, QUOTE)]);
  const backs = traders(w).map((s) => w.user(s, [credit(w, HUB, QUOTE)]));
  return { runtimeTxs: [], users: [w.user(HUB, [book, ...lines]), ...backs] };
};

/** Mostly an in-band order on the lot grid; now and then one og cancels on the hub (band, lots) or drops (price). */
const drawOrder = (w: World): Order => {
  const side: Side = pick(w, ["sell", "buy"] as const);
  const lots = LOT_STEP * BigInt(1 + w.ri(50));
  switch (w.ri(10)) {
    case 0:
      return { side, lots, priceTicks: OUT_OF_BAND };
    case 1:
      return { side, lots: lots + 1n, priceTicks: 10_500n };
    default:
      return { side, lots, priceTicks: pick(w, IN_BAND) };
  }
};

const offer = (w: World, o: Order): EntityTx => {
  const t = termsOf(o);
  const maxFee = t.want.amount / 1_000n;
  const timeInForce = pick(w, [undefined, 0, 1, 2] as const);
  return {
    type: "placeSwapOffer",
    data: {
      counterpartyEntityId: w.ids[HUB]!,
      offerId: `o${w.ri(1 << 30).toString(36)}`,
      giveTokenId: t.give.tokenId,
      giveTokenDecimals: DECIMALS,
      giveAmount: t.give.amount,
      wantTokenId: t.want.tokenId,
      wantTokenDecimals: DECIMALS,
      wantAmount: t.want.amount,
      maxFee,
      minNetReceive: t.want.amount - maxFee,
      ...(w.ri(2) === 0 ? { priceTicks: o.priceTicks } : {}),
      ...(timeInForce === undefined ? {} : { timeInForce }),
    },
  };
};

/** The smallest order on the grid: a maker who cannot afford it on either side has no order to place. */
const smallest = (side: Side): Order => ({ side, lots: LOT_STEP, priceTicks: PRICE_SCALE });
const sidesFor = (w: World, maker: number): readonly Side[] =>
  (["sell", "buy"] as const).filter((side) => affordable(w, maker, termsOf(smallest(side))));
const makers = (w: World): readonly number[] => traders(w).filter((s) => sidesFor(w, s).length > 0);

/** A spoke places a drawn order on a side it can afford, or the smallest order there when the drawn one is too big. */
const placeOffer = (w: World): Step => {
  const maker = pick(w, makers(w));
  const side = pick(w, sidesFor(w, maker));
  const drawn = { ...drawOrder(w), side };
  const order = affordable(w, maker, termsOf(drawn)) ? drawn : smallest(side);
  return { runtimeTxs: [], users: [w.user(maker, [offer(w, order)])] };
};

/**
 * Makers with a resting offer. A cancel reads nothing og can halt on once the Account exists: a fill that removes the
 * offer first makes og reject the request (swap/lifecycle/cancel.ts:37) and skip it on the hub (orderbook/cancels.ts:132).
 */
const cancellers = (w: World): readonly number[] => traders(w).filter((s) => restingOffers(w, s).length > 0);

const cancelOffer = (w: World): Step => {
  const maker = pick(w, cancellers(w));
  const target = pick(w, restingOffers(w, maker));
  const cancel: EntityTx = {
    type: "proposeCancelSwap",
    data: { counterpartyEntityId: w.ids[HUB]!, offerId: target.offerId },
  };
  return { runtimeTxs: [], users: [w.user(maker, [cancel])] };
};

export const ORDERBOOK: Moves<"orderbook"> = {
  initOrderbookExt: drawn((w) => traders(w).length > 0, openMarket),
  placeSwapOffer: drawn((w) => hasBook(w) && makers(w).length > 0, placeOffer),
  proposeCancelSwap: drawn((w) => hasBook(w) && cancellers(w).length > 0, cancelOffer),
  prepareCrossJurisdictionSwap: arises("scenario-cross-j.test.ts (two Runtimes)"),
  requestCrossJurisdictionClear: arises("scenario-cross-j.test.ts (two Runtimes)"),
  registerCrossJurisdictionSwap: arises("cross-j swap routing"),
  materializeCrossJurisdictionSwap: arises("cross-j swap routing"),
  materializeCrossJurisdictionClear: arises("cross-j clear routing"),
  admitCrossJurisdictionBookOrder: arises("cross-j book routing"),
  removeCrossJurisdictionBookOrder: arises("cross-j book routing"),
  crossJurisdictionBookOrderRemoved: arises("cross-j book routing"),
  crossJurisdictionFillNotice: arises("cross-j fills"),
  crossPullClose: arises("cross-j pull settlement"),
  orderbookSweepCrossJurisdiction: arises("the hub's cross-j book sweep"),
};

/** World moves: none yet. */
export const ORDERBOOK_WORLD: WorldMoves = {};
