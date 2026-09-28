// Lending draws (owner: the "lending" area thread). A spoke funds a pool on the hub's book, borrows from it, repays
// the loan, and closes its idle pool. Each draw reads og's committed state and offers only what og accepts, because
// a lending throw anywhere on the path halts og's Runtime:
//   - the Entity handler (og entity/tx/handlers/payments/lending.ts) throws on a missing hub Account, a malformed
//     intent id, a non-positive amount, an unknown term, interest outside 0..10000 bps, a token the Account lacks;
//   - the Account handler (og account/tx/handlers/balance/lending.ts) throws on a replayed intent id;
//   - the hub's committed-frame followup (og committed-lending-followup.ts, committed-lending-close.ts) throws when
//     the book no longer admits the tx: no pool for the borrow, a repay that is not the exact remainder of an
//     active loan, a close of a pool with loans out or more cash than the hub can pay back.
// The followup checks the book when the hub commits, a frame or two after the draw, so a draw must not race a tx that
// changes what it reads. Borrow and close contend for a pool's cash: each waits until no borrow or close request is in
// flight (two borrows could each see the same liquidity). Close also checks the hub's capacity to pay the lender, which
// only a frame the hub commits on the lender's Account first can lower. The lender's Account is idle, so such a frame
// needs a tx in flight elsewhere that the hub turns into one on the lender's Account when it commits: a lock or a
// routed payment it forwards, or an offer it fills against the lender's. Close waits until no hub Account carries one.
// Offer and repay touch only their own pool or loan, and wait only for their own Account.
// Refusal the walk does draw: a pool funded beyond the lender's own balance, which the Account handler rejects
// (LENDING_FUND_OWNED_BALANCE_INSUFFICIENT) without a throw.
import { deriveDelta } from "../../../core/account/utils.ts";
import { getAccountOutCapacity } from "../../../core/extensions/lending.ts";
import { HUB, SPOKES, TOKEN, type World } from "../world.ts";
import type { EntityTx } from "../../xln.ts";
import { drawn, type Moves, type Step, type WorldMoves } from "./areas.ts";
import { one, pick, quiet } from "./world-view.ts";

// ---- the lending book as og's hub commits it ----

type Term = "1h" | "1d" | "1m";
type Pool = {
  readonly positionId: string;
  readonly lenderEntityId: string;
  readonly tokenId: number;
  readonly availableAmount: bigint;
  readonly borrowedAmount: bigint;
  readonly interestBps: number;
  readonly termId: Term;
  readonly status: "open" | "closing" | "closed";
};
type Loan = {
  readonly loanId: string;
  readonly borrowerEntityId: string;
  readonly tokenId: number;
  readonly repaymentAmount: bigint;
  readonly repaidAmount: bigint;
  readonly status: "opening" | "active" | "closing" | "repaid" | "defaulted";
};
type Book = { readonly pools: ReadonlyMap<string, Pool>; readonly loans: ReadonlyMap<string, Loan> };
type Delta = Parameters<typeof deriveDelta>[0];
type AccountTxRef = { readonly type: string };
type HubAccount = {
  readonly status?: string;
  readonly mempool?: readonly AccountTxRef[];
  readonly pendingFrame?: { readonly accountTxs: readonly AccountTxRef[] } | null;
  readonly state?: { readonly deltas?: ReadonlyMap<number, Delta>; readonly settlementWorkspace?: unknown };
};
type HubState = { readonly profile?: { readonly isHub?: boolean }; readonly lending?: Book };

/** og's token id for TOKEN: og keys deltas and pools by number. */
const OG_TOKEN = 1;
const TERMS: readonly Term[] = ["1h", "1d", "1m"];
const MAX_BPS = 10_000;

// ---- reading og ----

const hubState = (w: World): HubState | undefined => w.ogState(HUB) as HubState | undefined;
const book = (w: World): Book | undefined => hubState(w)?.lending;
const pools = (w: World): readonly Pool[] => [...(book(w)?.pools.values() ?? [])];
const loans = (w: World): readonly Loan[] => [...(book(w)?.loans.values() ?? [])];
/** og setHubConfig marks the hub; the lending followup runs only on a hub (committed-lending-followup.ts:235). */
const hubOpen = (w: World): boolean => hubState(w)?.profile?.isHub === true;

const hubAccount = (w: World, x: number, y: number): HubAccount | undefined =>
  w.ogAccount(x, y) as HubAccount | undefined;
/** The spoke's hub Account as each side holds it. */
const sides = (w: World, spoke: number): readonly (HubAccount | undefined)[] =>
  [hubAccount(w, spoke, HUB), hubAccount(w, HUB, spoke)];
const inFlight = (account: HubAccount | undefined): readonly AccountTxRef[] => [
  ...(account?.mempool ?? []),
  ...(account?.pendingFrame?.accountTxs ?? []),
];
/** The txs that move a pool's cash when the hub commits them. */
const contendsForCash = (tx: AccountTxRef): boolean =>
  tx.type === "lending_borrow_request" || tx.type === "lending_close_request";
/** No borrow or close request is queued or proposed on any hub Account, from either side. */
const cashSettled = (w: World): boolean =>
  SPOKES.every((s) => sides(w, s).every((a) => !inFlight(a).some(contendsForCash)));
/**
 * The txs whose commit makes the hub queue a tx on another of its Accounts that can take from its side: og forwards a
 * lock (committed-htlc-followups.ts:147) and a routed payment (:229) to the next hop, and fills a maker's offer with a
 * swap_resolve on the maker's Account (orderbook/queue.ts:59). A resolve travels back to the payer and only pays the hub.
 */
const routesToOthers = (tx: AccountTxRef): boolean =>
  tx.type === "htlc_lock" || tx.type === "direct_payment" || tx.type === "swap_offer";
/** No hub Account carries a tx the hub could turn into one on another Account, so its capacities hold until it commits. */
const nothingRouted = (w: World): boolean =>
  SPOKES.every((s) => sides(w, s).every((a) => !inFlight(a).some(routesToOthers)));
/**
 * A spoke that trades with the hub: both sides hold the Account, neither is frozen by a dispute, and no settlement
 * workspace is open on it. og freezes an Account's ordinary txs once its workspace is signed
 * (getSignedSettlementWorkspaceTxError, SETTLEMENT_SIGNED_ACCOUNT_FROZEN), so a lending tx queued beside a workspace
 * can wait there for the rest of the run, and a queued borrow or close would keep the other off with it.
 */
const trading = (w: World, spoke: number): boolean =>
  sides(w, spoke).every((a) =>
    a !== undefined && (a.status ?? "active") === "active" && a.state?.settlementWorkspace === undefined);
const tradingSpokes = (w: World): readonly number[] => SPOKES.filter((s) => trading(w, s));
const idleSpokes = (w: World): readonly number[] => SPOKES.filter((s) => trading(w, s) && quiet(w, s, HUB));
const spokeOf = (w: World, entityId: string): number => w.ids.findIndex((id) => id === entityId.toLowerCase());

/**
 * What the spoke owns on its hub Account, as og's lending_fund admits it: the out-capacity minus the credit it has
 * not yet borrowed, so a pool is never backed by new debt.
 */
const ownFunds = (w: World, spoke: number): bigint => {
  const delta = hubAccount(w, spoke, HUB)?.state?.deltas?.get(OG_TOKEN);
  const own = delta === undefined ? undefined : deriveDelta(delta, w.ids[spoke]! < w.ids[HUB]!);
  return own === undefined ? 0n : own.outCapacity - own.outOwnCredit;
};
/** og applyLendingCloseRequest: the hub pays the pool's cash back over the lender's Account. */
const hubCanPayOut = (w: World, pool: Pool): boolean => {
  const state = hubAccount(w, HUB, spokeOf(w, pool.lenderEntityId))?.state;
  const capacity = state === undefined ? 0n : getAccountOutCapacity(state as never, w.ids[HUB]!, pool.tokenId);
  return pool.availableAmount === 0n || capacity >= pool.availableAmount;
};

const lendable = (w: World): readonly Pool[] =>
  pools(w).filter((p) => p.status === "open" && p.tokenId === OG_TOKEN && p.availableAmount > 0n);
/** The party's hub Account is idle, so the tx it signs is the next frame on it. */
const idle = (w: World, entityId: string): boolean => idleSpokes(w).includes(spokeOf(w, entityId));
const repayable = (w: World): readonly Loan[] =>
  loans(w).filter((l) => l.status === "active" && l.tokenId === OG_TOKEN && idle(w, l.borrowerEntityId));
const closable = (w: World): readonly Pool[] =>
  pools(w).filter((p) => p.status === "open" && p.borrowedAmount === 0n)
    .filter((p) => idle(w, p.lenderEntityId) && hubCanPayOut(w, p));

// ---- building txs ----

/** A uniform amount in 1..max. */
const upTo = (w: World, max: bigint): bigint => 1n + (max * BigInt(w.ri(1_000))) / 1_000n;
/** og INTENT_ID_RE: the prefix and 16 hex digits, fresh each draw so no intent replays. */
const intentId = (w: World, prefix: "lend" | "borrow"): string => {
  const word = (): string => w.ri(2 ** 32).toString(16).padStart(8, "0");
  return `${prefix}-${word()}${word()}`;
};
const step = (w: World, entity: number, tx: EntityTx): Step => one(w, entity, [tx]);
const hubId = (w: World): string => w.ids[HUB]!;

/** Mostly within the lender's own funds; one draw in ten asks for more, which og refuses without a halt. */
const fundAmount = (w: World, own: bigint): bigint => (w.ri(10) === 0 ? own + upTo(w, own) : upTo(w, own));

const offer = (w: World): Step => {
  const lender = pick(w, idleSpokes(w).filter((s) => ownFunds(w, s) > 0n));
  return step(w, lender, {
    type: "lendingOffer",
    data: {
      positionId: intentId(w, "lend"),
      hubEntityId: hubId(w),
      tokenId: TOKEN,
      amount: fundAmount(w, ownFunds(w, lender)),
      termId: pick(w, TERMS),
      interestBps: pick(w, [0, w.ri(MAX_BPS + 1)]),
    },
  });
};

/** A borrow the chosen pool can fill; og's hub then fills it from the cheapest pool that can. */
const borrow = (w: World): Step => {
  const pool = pick(w, lendable(w));
  const cap = pool.interestBps + w.ri(MAX_BPS - pool.interestBps + 1);
  return step(w, pick(w, tradingSpokes(w)), {
    type: "lendingBorrow",
    data: {
      requestId: intentId(w, "borrow"),
      hubEntityId: hubId(w),
      tokenId: TOKEN,
      amount: upTo(w, pool.availableAmount),
      termId: pool.termId,
      ...(w.ri(4) === 0 ? {} : { maxInterestBps: cap }),
    },
  });
};

/** og applyLendingRepay accepts exactly the loan's remainder. */
const repay = (w: World): Step => {
  const loan = pick(w, repayable(w));
  const remainder = loan.repaymentAmount - loan.repaidAmount;
  return step(w, spokeOf(w, loan.borrowerEntityId), {
    type: "lendingRepay",
    data: { hubEntityId: hubId(w), loanId: loan.loanId, tokenId: TOKEN, amount: remainder },
  });
};

const close = (w: World): Step => {
  const pool = pick(w, closable(w));
  return step(w, spokeOf(w, pool.lenderEntityId), {
    type: "lendingClosePosition",
    data: { hubEntityId: hubId(w), positionId: pool.positionId },
  });
};

/** Every draw needs a hub. */
const when = (ready: (w: World) => boolean) => (w: World): boolean => hubOpen(w) && ready(w);

export const LENDING: Moves<"lending"> = {
  lendingOffer: drawn(when((w) => idleSpokes(w).some((s) => ownFunds(w, s) > 0n)), offer),
  lendingBorrow: drawn(when((w) => cashSettled(w) && lendable(w).length > 0 && tradingSpokes(w).length > 0), borrow),
  lendingRepay: drawn(when((w) => repayable(w).length > 0), repay),
  lendingClosePosition: drawn(when((w) => cashSettled(w) && nothingRouted(w) && closable(w).length > 0), close),
};

/** World moves: none; the lending book is built from Entity txs alone. */
export const LENDING_WORLD: WorldMoves = {};
