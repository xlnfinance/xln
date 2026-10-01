// The two-party swap inside an Account (R-SWAP-*). A maker's `offer` is a quote: it reserves only the maker's own give
// and binds the taker to nothing, so it is no clause of the proof body and costs the taker no room (R-SWAP-CONSENT).
// The other side, the taker, accepts by its first fill: that fill takes a ratio of the quote, reserves the rest of the
// taker's want against the taker, and from then on the offer is a clause of its own, filled in whole or in parts at a
// ratio of the taker's choosing until the offer's deadline (off-chain only: the chain's clause has no expiry, so an
// expired offer is lapsed by a frame). The chain's rule is
// DeltaTransformer's `applySwap`: each leg is floor(amount * ratio / 65535) of the clause's amounts. A fill here is the
// same arithmetic on what remains, and it moves the offdeltas AND shrinks the offer in one step, so the state that is
// signed never carries a clause that could fill what the offdeltas already hold (R-SWAP-CLAUSE-WITH-FILL).
import { err, flatMap, map, ok, type Result } from "../../kernel/core/result.ts";
import { deadlineInRange } from "../clause/clause.ts";
import { expirableAt, liveAt, type ClockParams, type JView } from "../clause/clock.ts";
import { MAX_AMOUNT, payReserved, release, reserve } from "../ledger.ts";
import { other, type AccountFault, type AccountState, type HoldId, type Leg, type Offer, type Side } from "../model.ts";
import { ledgerOf, withinHoldCap, withLedger } from "../state.ts";

type Step = Result<AccountState, AccountFault>;

/** The transformer's ratio is a uint16 and 65535 is the whole of what is left. */
export const FULL_FILL = 65535;

/** The quotes one maker may leave open in an Account: each holds some of its room until withdrawn or lapsed. */
const MAX_QUOTES = 4;

/** What a fill at `ratio` takes of `amount`: WideMath.fill, which is floor(amount * ratio / 65535), each leg alone. */
export const fillOf = (amount: bigint, ratio: number): bigint => (amount * BigInt(ratio)) / BigInt(FULL_FILL);

const offerAt = (s: AccountState, id: HoldId): Result<Offer, AccountFault> => {
  const offer = s.quotes.find((o) => o.id === id) ?? s.offers.find((o) => o.id === id);
  return offer === undefined ? err({ _tag: "no_such_offer", id }) : ok(offer);
};

const legInRange = (leg: Leg): Result<Leg, AccountFault> =>
  (leg.amount >= 1n && leg.amount <= MAX_AMOUNT ? ok(leg) : err({ _tag: "bad_amount", amount: leg.amount }));

const admitted = (
  s: AccountState, p: ClockParams, view: JView, author: Side, o: Offer,
): Result<Offer, AccountFault> => {
  if (o.maker !== author) return err({ _tag: "not_own_funds" });
  if (o.give.token === o.want.token) return err({ _tag: "same_token", token: o.give.token });
  if (s.quotes.some((x) => x.id === o.id) || s.offers.some((x) => x.id === o.id)) {
    return err({ _tag: "offer_exists", id: o.id });
  }
  if (s.quotes.filter((x) => x.maker === author).length >= MAX_QUOTES) {
    return err({ _tag: "too_many_quotes", max: MAX_QUOTES });
  }
  return flatMap(legInRange(o.give), () => flatMap(legInRange(o.want), () =>
    map(deadlineInRange(p, view, o.deadline), () => o)));
};

/** Reserves the maker's give against the maker, only if its RCPAN still holds: the maker's own funds, no one else's. */
const reservedGive = (s: AccountState, o: Offer): Step =>
  map(reserve(ledgerOf(s, o.give.token), o.maker, o.give.amount), (give) => withLedger(s, o.give.token, give));

const capped = (s: AccountState): Step => {
  const refusal = withinHoldCap(s);
  return refusal === undefined ? ok(s) : err(refusal);
};

/** `author` quotes `o` on its own funds: a deadline in range, a free slot, a quote to spare, room for its give. */
export const offer = (s: AccountState, p: ClockParams, view: JView, author: Side, o: Offer): Step =>
  flatMap(admitted(s, p, view, author, o), () =>
    map(reservedGive(s, o), (next) => ({ ...next, quotes: [...next.quotes, o] })));

/** The offer gone, with what it reserved: a quote only its maker's give, an accepted offer the taker's want as well. */
const withoutOffer = (s: AccountState, o: Offer): AccountState => {
  const accepted = s.offers.includes(o);
  const give = release(ledgerOf(s, o.give.token), o.maker, o.give.amount);
  const gone = withLedger(s, o.give.token, give);
  const moved = accepted
    ? withLedger(gone, o.want.token, release(ledgerOf(gone, o.want.token), other(o.maker), o.want.amount))
    : gone;
  return { ...moved, quotes: s.quotes.filter((x) => x !== o), offers: s.offers.filter((x) => x !== o) };
};

const asTaker = (o: Offer, author: Side): Result<Offer, AccountFault> =>
  (other(o.maker) === author ? ok(o) : err({ _tag: "not_taker" }));

const ratioInRange = (ratio: number): Result<number, AccountFault> =>
  (Number.isInteger(ratio) && ratio >= 1 && ratio <= FULL_FILL ? ok(ratio) : err({ _tag: "bad_ratio", ratio }));

const stillOpen = (o: Offer, view: JView): Result<Offer, AccountFault> =>
  (liveAt(o.deadline, view) ? ok(o) : err({ _tag: "past_deadline", deadline: o.deadline, view }));

/** A fill that takes nothing of a leg is a gift of the other leg: refused, so every fill is a trade. */
const worthFilling = (give: bigint, want: bigint): Result<null, AccountFault> =>
  (give >= 1n && want >= 1n ? ok(null) : err({ _tag: "fill_too_small", give, want }));

/** The offer after a fill: the remainder of each leg; nothing left (the whole fill) drops it. */
const remainder = (o: Offer, give: bigint, want: bigint): readonly Offer[] =>
  (give === o.give.amount && want === o.want.amount
    ? []
    : [{ ...o, give: { ...o.give, amount: o.give.amount - give }, want: { ...o.want, amount: o.want.amount - want } }]);

/**
 * The taker's first fill is its acceptance: the quote becomes an offer, a clause of its own, and the taker's want is
 * reserved against the taker, only if its RCPAN still holds. An offer already accepted stays as it is.
 */
const accepted = (s: AccountState, o: Offer): Step =>
  (s.offers.includes(o)
    ? ok(s)
    : map(reserve(ledgerOf(s, o.want.token), other(o.maker), o.want.amount), (want) =>
      ({ ...withLedger(s, o.want.token, want), quotes: s.quotes.filter((x) => x !== o), offers: [...s.offers, o] })));

/**
 * The taker fills `ratio` of what remains while the offer is live: both legs move the offdeltas by the chain's own
 * arithmetic, both reservations shrink by the same amounts, and the offer becomes its remainder, all in one step.
 * A first fill is the acceptance of a quote (R-SWAP-CONSENT) and its remainder is a clause the Account has room for.
 */
export const fill = (s: AccountState, view: JView, author: Side, id: HoldId, ratio: number): Step =>
  flatMap(offerAt(s, id), (o) => flatMap(asTaker(o, author), () => flatMap(ratioInRange(ratio), () =>
    flatMap(stillOpen(o, view), () => {
      const give = fillOf(o.give.amount, ratio);
      const want = fillOf(o.want.amount, ratio);
      return flatMap(worthFilling(give, want), () => flatMap(accepted(s, o), (taken) => {
        const paidGive = payReserved(ledgerOf(taken, o.give.token), o.maker, give);
        const gave = withLedger(taken, o.give.token, paidGive);
        const paidWant = payReserved(ledgerOf(gave, o.want.token), other(o.maker), want);
        const paid = withLedger(gave, o.want.token, paidWant);
        return capped({ ...paid, offers: paid.offers.flatMap((x) => (x === o ? remainder(o, give, want) : [x])) });
      }));
    }))));

/** The maker withdraws what is left of its offer at any time; what was filled stays. */
export const retract = (s: AccountState, author: Side, id: HoldId): Step =>
  flatMap(offerAt(s, id), (o) => (o.maker === author ? ok(withoutOffer(s, o)) : err({ _tag: "not_maker" })));

/** Anyone lapses an offer once the deciding party's view is strictly past its deadline plus the reserve. */
export const lapse = (s: AccountState, p: ClockParams, view: JView, id: HoldId): Step =>
  flatMap(offerAt(s, id), (o) => (expirableAt(p, o.deadline, view)
    ? ok(withoutOffer(s, o))
    : err({ _tag: "not_expired", deadline: o.deadline, earliest: o.deadline + p.reserve + 1n })));

