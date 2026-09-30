// The four clause transitions (lock, resolve, cancel, expire) on one token's Ledger. Each takes the deciding party's
// own view of the J height (clock.ts) and, where authority matters, the side that authored the tx. The money moves are
// the ledger's; this file decides whether the clause's own conditions allow them (spec: Arrival account/clock.scm,
// Quint account_core.qnt `applyTx`).
import { err, flatMap, map, ok, type Result } from "../../kernel/core/result.ts";
import { keccakHex } from "../../kernel/encoding/bytes.ts";
import { expire, lock, resolve } from "../ledger.ts";
import { other, type AccountFault, type ClauseHold, type Hold, type HoldId, type Ledger, type Side } from "../model.ts";
import { expirableAt, latestDeadline, liveAt, type ClockParams, type JView } from "./clock.ts";

type Step = Result<Ledger, AccountFault>;

/** Runs the checks in order on the clause; the first refusal is the answer. */
const through = (
  start: Result<Hold, AccountFault>, ...checks: readonly ((hold: Hold) => Result<Hold, AccountFault>)[]
): Result<Hold, AccountFault> => checks.reduce((r, check) => flatMap(r, check), start);

const HASHLOCK = /^0x[0-9a-f]{64}$/;
const SECRET_BYTES = 32;

/** The open clause in a slot: a clause is addressed by its slot, as the money rules address a hold. */
const clauseOf = (l: Ledger, id: HoldId): Result<Hold, AccountFault> => {
  const hold = l.holds.find((h) => h.id === id);
  return hold === undefined ? err({ _tag: "no_such_lock" }) : ok(hold);
};

const asPayee = (hold: Hold, author: Side): Result<Hold, AccountFault> =>
  (other(hold.payer) === author ? ok(hold) : err({ _tag: "not_payee" }));

const ownFunds = (hold: Hold, author: Side): Result<Hold, AccountFault> =>
  (hold.payer === author ? ok(hold) : err({ _tag: "not_own_funds" }));

const wellFormed = (hold: Hold): Result<Hold, AccountFault> =>
  (HASHLOCK.test(hold.hashlock) ? ok(hold) : err({ _tag: "bad_hashlock" }));

/** R-ONE-LOCK-PER-HASH: one open clause per hashlock in a ledger; the refusal names the slot that holds it. */
const hashlockFree = (l: Ledger, hold: Hold): Result<Hold, AccountFault> => {
  const open = l.holds.find((h) => h.hashlock === hold.hashlock);
  return open === undefined ? ok(hold) : err({ _tag: "lock_exists", id: open.id });
};

const opensAt = (p: ClockParams, view: JView, hold: Hold): Result<Hold, AccountFault> => {
  if (hold.deadline <= view) return err({ _tag: "deadline_past", deadline: hold.deadline, view });
  const latest = latestDeadline(p, view);
  return hold.deadline > latest ? err({ _tag: "deadline_too_far", deadline: hold.deadline, latest }) : ok(hold);
};

/** The checks on a new clause, in order: its own funds, a well-formed hashlock not open yet, a deadline in range. */
const admittedLock = (
  l: Ledger, p: ClockParams, view: JView, author: Side, hold: Hold,
): Result<ClauseHold, AccountFault> =>
  map(
    through(ok(hold), (h) => ownFunds(h, author), wellFormed, (h) => hashlockFree(l, h), (h) => opensAt(p, view, h)),
    (admitted) => admitted as ClauseHold,
  );

/** The one way a clause opens: the money rules take only a hold these checks have passed (`ClauseHold`). */
export const lockClause = (l: Ledger, p: ClockParams, view: JView, author: Side, hold: Hold): Step =>
  flatMap(admittedLock(l, p, view, author, hold), (admitted) => lock(l, admitted));

const preimageMatches = (hold: Hold, secret: Uint8Array): Result<Hold, AccountFault> => {
  if (secret.length !== SECRET_BYTES) return err({ _tag: "bad_secret" });
  return keccakHex(secret) === hold.hashlock ? ok(hold) : err({ _tag: "wrong_secret" });
};

const inTime = (hold: Hold, view: JView): Result<Hold, AccountFault> =>
  (liveAt(hold.deadline, view) ? ok(hold) : err({ _tag: "past_deadline", deadline: hold.deadline, view }));

/** The checks on a resolve, in order: the clause is open, its payee shows the preimage, it is still live. */
const admittedResolve = (
  l: Ledger, view: JView, author: Side, id: HoldId, secret: Uint8Array,
): Result<Hold, AccountFault> =>
  through(clauseOf(l, id), (h) => asPayee(h, author), (h) => preimageMatches(h, secret), (h) => inTime(h, view));

/** The payee shows the preimage while the clause is live; the clause pays. */
export const resolveClause = (l: Ledger, view: JView, author: Side, id: HoldId, secret: Uint8Array): Step =>
  flatMap(admittedResolve(l, view, author, id, secret), (hold) => resolve(l, hold.id));

/** The payee gives the clause up at any time; the allocation stays. */
export const cancelClause = (l: Ledger, author: Side, id: HoldId): Step =>
  flatMap(through(clauseOf(l, id), (h) => asPayee(h, author)), (hold) => expire(l, hold.id));

const expirable = (p: ClockParams, view: JView, hold: Hold): Result<Hold, AccountFault> =>
  (expirableAt(p, hold.deadline, view)
    ? ok(hold)
    : err({ _tag: "not_expired", deadline: hold.deadline, earliest: hold.deadline + p.reserve + 1n }));

/** Anyone expires a clause once the deciding party's view is strictly past the deadline plus the reserve. */
export const expireClause = (l: Ledger, p: ClockParams, view: JView, id: HoldId): Step =>
  flatMap(through(clauseOf(l, id), (h) => expirable(p, view, h)), (hold) => expire(l, hold.id));
