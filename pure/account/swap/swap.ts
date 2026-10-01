// The two-party swap inside an Account (R-SWAP-*). An offer is a clause of its own: `maker` gives `give` for `want`,
// and the other side, the taker, fills it in whole or in parts at a ratio of its choosing, until the offer's deadline
// (off-chain only: the chain's clause has no expiry, so an expired offer is lapsed by a frame). The chain's rule is
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

/** What a fill at `ratio` takes of `amount`: WideMath.fill, which is floor(amount * ratio / 65535), each leg alone. */
export const fillOf = (amount: bigint, ratio: number): bigint => (amount * BigInt(ratio)) / BigInt(FULL_FILL);

const offerAt = (s: AccountState, id: HoldId): Result<Offer, AccountFault> => {
  const offer = s.offers.find((o) => o.id === id);
  return offer === undefined ? err({ _tag: "no_such_offer", id }) : ok(offer);
};

const legInRange = (leg: Leg): Result<Leg, AccountFault> =>
  (leg.amount >= 1n && leg.amount <= MAX_AMOUNT ? ok(leg) : err({ _tag: "bad_amount", amount: leg.amount }));

const admitted = (
  s: AccountState, p: ClockParams, view: JView, author: Side, o: Offer,
): Result<Offer, AccountFault> => {
  if (o.maker !== author) return err({ _tag: "not_own_funds" });
  if (o.give.token === o.want.token) return err({ _tag: "same_token", token: o.give.token });
  if (s.offers.some((x) => x.id === o.id)) return err({ _tag: "offer_exists", id: o.id });
  return flatMap(legInRange(o.give), () => flatMap(legInRange(o.want), () =>
    map(deadlineInRange(p, view, o.deadline), () => o)));
};

/** Reserves the maker's give and the taker's want in their tokens, each only if its RCPAN still holds. */
const reserved = (s: AccountState, o: Offer): Step =>
  flatMap(reserve(ledgerOf(s, o.give.token), o.maker, o.give.amount), (give) =>
    map(reserve(ledgerOf(s, o.want.token), other(o.maker), o.want.amount), (want) =>
      withLedger(withLedger(s, o.give.token, give), o.want.token, want)));

const capped = (s: AccountState): Step => {
  const refusal = withinHoldCap(s);
  return refusal === undefined ? ok(s) : err(refusal);
};

/** `author` offers `o` as its own funds: a deadline in range, a free slot, room for both legs, a clause to spare. */
export const offer = (s: AccountState, p: ClockParams, view: JView, author: Side, o: Offer): Step =>
  flatMap(admitted(s, p, view, author, o), () =>
    flatMap(reserved(s, o), (next) => capped({ ...next, offers: [...next.offers, o] })));

const withoutOffer = (s: AccountState, o: Offer): AccountState => {
  const give = release(ledgerOf(s, o.give.token), o.maker, o.give.amount);
  const want = release(ledgerOf(s, o.want.token), other(o.maker), o.want.amount);
  const moved = withLedger(withLedger(s, o.give.token, give), o.want.token, want);
  return { ...moved, offers: s.offers.filter((x) => x !== o) };
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
 * The taker fills `ratio` of what remains while the offer is live: both legs move the offdeltas by the chain's own
 * arithmetic, both reservations shrink by the same amounts, and the offer becomes its remainder, all in one step.
 */
export const fill = (s: AccountState, view: JView, author: Side, id: HoldId, ratio: number): Step =>
  flatMap(offerAt(s, id), (o) => flatMap(asTaker(o, author), () => flatMap(ratioInRange(ratio), () =>
    flatMap(stillOpen(o, view), () => {
      const give = fillOf(o.give.amount, ratio);
      const want = fillOf(o.want.amount, ratio);
      return map(worthFilling(give, want), () => {
        const paidGive = payReserved(ledgerOf(s, o.give.token), o.maker, give);
        const paidWant = payReserved(ledgerOf(s, o.want.token), other(o.maker), want);
        return {
          ledgers: withLedger(withLedger(s, o.give.token, paidGive), o.want.token, paidWant).ledgers,
          offers: s.offers.flatMap((x) => (x === o ? remainder(o, give, want) : [x])),
        };
      });
    }))));

/** The maker withdraws what is left of its offer at any time; what was filled stays. */
export const retract = (s: AccountState, author: Side, id: HoldId): Step =>
  flatMap(offerAt(s, id), (o) => (o.maker === author ? ok(withoutOffer(s, o)) : err({ _tag: "not_maker" })));

/** Anyone lapses an offer once the deciding party's view is strictly past its deadline plus the reserve. */
export const lapse = (s: AccountState, p: ClockParams, view: JView, id: HoldId): Step =>
  flatMap(offerAt(s, id), (o) => (expirableAt(p, o.deadline, view)
    ? ok(withoutOffer(s, o))
    : err({ _tag: "not_expired", deadline: o.deadline, earliest: o.deadline + p.reserve + 1n })));

