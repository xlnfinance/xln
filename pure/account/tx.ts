// The ten txs an Account's frames carry, and the one function that applies them: AccountState -> Result<AccountState,
// AccountFault>. Each is a token's Ledger transition (ledger.ts, clause/clause.ts) plus, for a lock, the Account's own
// caps (state.ts). Deposits and withdrawals are not txs: they are J events and settlements, not something a frame says.
import { err, flatMap, map, ok, type Result } from "../kernel/core/result.ts";
import type { Tagged } from "../kernel/core/tagged.ts";
import { match } from "../kernel/core/tagged.ts";
import { cancelClause, expireClause, lockClause, resolveClause } from "./clause/clause.ts";
import type { ClockParams, JView } from "./clause/clock.ts";
import { pay, setCredit } from "./ledger.ts";
import type { AccountFault, AccountState, Hold, HoldId, Ledger, Offer, Side, TokenId } from "./model.ts";
import { holderOf, ledgerOf, withinHoldCap, withLedger } from "./state.ts";
import { fill, lapse, offer, retract } from "./swap/swap.ts";

export type AccountTx =
  | Tagged<"pay", { token: TokenId; amount: bigint }>
  | Tagged<"set_credit", { token: TokenId; limit: bigint }>
  | Tagged<"lock", { token: TokenId; hold: Hold; route?: readonly string[] }>
  | Tagged<"resolve", { token: TokenId; id: HoldId; secret: Uint8Array }>
  | Tagged<"cancel", { token: TokenId; id: HoldId }>
  | Tagged<"expire", { token: TokenId; id: HoldId }>
  | Tagged<"offer", { offer: Offer }>
  | Tagged<"fill", { id: HoldId; ratio: number }>
  | Tagged<"retract", { id: HoldId }>
  | Tagged<"lapse", { id: HoldId }>;

/**
 * The most entity ids a lock's route may name: the hops after the lock's payee, in the text the Entity layer writes ids
 * in. The Account does not read them; they are in the frame's name, so both sides signed them, and not in a proof.
 */
export const MAX_ROUTE_HOPS = 16;

/** What a tx is judged against besides the state: the clock's parameters and the judging party's own view of J. */
export type Judge = Readonly<{ clock: ClockParams; view: JView }>;

type Step = Result<AccountState, AccountFault>;

const onLedger = (s: AccountState, token: TokenId, next: Result<Ledger, AccountFault>): Step =>
  map(next, (l) => withLedger(s, token, l));

/** The refusal the Account's own rules give a lock that its token's rules admitted, judged before the lock is in. */
const accountRefusal = (s: AccountState, next: AccountState, hold: Hold): AccountFault | undefined => {
  const open = holderOf(s, hold.hashlock);
  return withinHoldCap(next) ?? (open === undefined ? undefined : { _tag: "lock_exists", id: open.id });
};

/** The token's lock rules first, then the caps that only the whole Account can see. */
const locked = (s: AccountState, j: Judge, author: Side, tx: Extract<AccountTx, { _tag: "lock" }>): Step =>
  (tx.route !== undefined && tx.route.length > MAX_ROUTE_HOPS
    ? err({ _tag: "route_too_long", hops: tx.route.length, max: MAX_ROUTE_HOPS })
    : lockedOnLedger(s, j, author, tx));

const lockedOnLedger = (s: AccountState, j: Judge, author: Side, tx: Extract<AccountTx, { _tag: "lock" }>): Step =>
  flatMap(onLedger(s, tx.token, lockClause(ledgerOf(s, tx.token), j.clock, j.view, author, tx.hold)), (next) => {
    const refusal = accountRefusal(s, next, tx.hold);
    return refusal === undefined ? ok(next) : err(refusal);
  });

/** `author` is the side whose frame carries the tx: it pays, extends credit, locks its own funds, or is the payee. */
export const applyTx = (s: AccountState, j: Judge, author: Side, tx: AccountTx): Step =>
  match(tx, {
    pay: (t) => onLedger(s, t.token, pay(ledgerOf(s, t.token), author, t.amount)),
    set_credit: (t) => onLedger(s, t.token, setCredit(ledgerOf(s, t.token), author, t.limit)),
    lock: (t) => locked(s, j, author, t),
    resolve: (t) => onLedger(s, t.token, resolveClause(ledgerOf(s, t.token), j.view, author, t.id, t.secret)),
    cancel: (t) => onLedger(s, t.token, cancelClause(ledgerOf(s, t.token), author, t.id)),
    expire: (t) => onLedger(s, t.token, expireClause(ledgerOf(s, t.token), j.clock, j.view, t.id)),
    offer: (t) => offer(s, j.clock, j.view, author, t.offer),
    fill: (t) => fill(s, j.view, author, t.id, t.ratio),
    retract: (t) => retract(s, author, t.id),
    lapse: (t) => lapse(s, j.clock, j.view, t.id),
  });
