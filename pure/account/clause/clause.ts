// The four clause transitions (lock, resolve, cancel, expire) on one token's Ledger. Each takes the deciding party's
// own view of the J height (clock.ts) and, where authority matters, the side that authored the tx. The money moves are
// the ledger's; this file decides whether the clause's own conditions allow them (spec: Arrival account/clock.scm,
// Quint account_core.qnt `applyTx`).
import { err, flatMap, ok, type Result } from "../../kernel/core/result.ts";
import { keccakHex } from "../../kernel/encoding/bytes.ts";
import { expire, lock, resolve } from "../ledger.ts";
import { other, type AccountFault, type Hold, type Ledger, type Side } from "../model.ts";
import { expirableAt, latestDeadline, liveAt, type ClockParams } from "./clock.ts";

type Step = Result<Ledger, AccountFault>;

const HASHLOCK = /^0x[0-9a-f]{64}$/;
const SECRET_BYTES = 32;

/** The open clause on a hashlock: the hold and, through it, its slot. */
const clauseOf = (l: Ledger, hashlock: string): Result<Hold, AccountFault> => {
  const hold = l.holds.find((h) => h.hashlock === hashlock);
  return hold === undefined ? err({ _tag: "no_such_lock" }) : ok(hold);
};

const asPayee = (hold: Hold, author: Side): Result<Hold, AccountFault> =>
  (other(hold.payer) === author ? ok(hold) : err({ _tag: "not_payee" }));

const opensAt = (p: ClockParams, view: bigint, hold: Hold): Result<Hold, AccountFault> => {
  if (hold.deadline <= view) return err({ _tag: "deadline_past", deadline: hold.deadline, view });
  const latest = latestDeadline(p, view);
  return hold.deadline > latest ? err({ _tag: "deadline_too_far", deadline: hold.deadline, latest }) : ok(hold);
};

/** The payer opens a clause: its own funds, a well-formed hashlock not open yet, a deadline inside the horizon. */
export const lockClause = (l: Ledger, p: ClockParams, view: bigint, author: Side, hold: Hold): Step => {
  if (hold.payer !== author) return err({ _tag: "not_own_funds" });
  if (!HASHLOCK.test(hold.hashlock)) return err({ _tag: "bad_hashlock" });
  const open = l.holds.find((h) => h.hashlock === hold.hashlock);
  if (open !== undefined) return err({ _tag: "lock_exists", id: open.id });
  return flatMap(opensAt(p, view, hold), (h) => lock(l, h));
};

const preimageMatches = (hold: Hold, secret: Uint8Array): Result<Hold, AccountFault> => {
  if (secret.length !== SECRET_BYTES) return err({ _tag: "bad_secret" });
  return keccakHex(secret) === hold.hashlock ? ok(hold) : err({ _tag: "wrong_secret" });
};

const inTime = (hold: Hold, view: bigint): Result<Hold, AccountFault> =>
  (liveAt(hold.deadline, view) ? ok(hold) : err({ _tag: "past_deadline", deadline: hold.deadline, view }));

/** The payee shows the preimage while the clause is live; the clause pays. */
export const resolveClause = (l: Ledger, view: bigint, author: Side, hashlock: string, secret: Uint8Array): Step =>
  flatMap(clauseOf(l, hashlock), (found) =>
    flatMap(asPayee(found, author), (hold) =>
      flatMap(preimageMatches(hold, secret), () =>
        flatMap(inTime(hold, view), (live) => resolve(l, live.id)))));

/** The payee gives the clause up at any time; the allocation stays. */
export const cancelClause = (l: Ledger, author: Side, hashlock: string): Step =>
  flatMap(clauseOf(l, hashlock), (found) => flatMap(asPayee(found, author), (payee) => expire(l, payee.id)));

/** Anyone expires a clause once the deciding party's view is strictly past the deadline plus the reserve. */
export const expireClause = (l: Ledger, p: ClockParams, view: bigint, hashlock: string): Step =>
  flatMap(clauseOf(l, hashlock), (hold) =>
    expirableAt(p, hold.deadline, view)
      ? expire(l, hold.id)
      : err({ _tag: "not_expired", deadline: hold.deadline, earliest: hold.deadline + p.reserve + 1n }));
