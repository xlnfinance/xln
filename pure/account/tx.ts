// The six txs an Account's frames carry, and the one function that applies them: AccountState -> Result<AccountState,
// AccountFault>. Each is a token's Ledger transition (ledger.ts, clause/clause.ts) plus, for a lock, the Account's own
// caps (state.ts). Deposits and withdrawals are not txs: they are J events and settlements, not something a frame says.
import { err, flatMap, map, ok, type Result } from "../kernel/core/result.ts";
import type { Tagged } from "../kernel/core/tagged.ts";
import { match } from "../kernel/core/tagged.ts";
import { cancelClause, expireClause, lockClause, resolveClause } from "./clause/clause.ts";
import type { ClockParams, JView } from "./clause/clock.ts";
import { pay, setCredit } from "./ledger.ts";
import type { AccountFault, AccountState, Hold, HoldId, Ledger, Side, TokenId } from "./model.ts";
import { ledgerOf, withinAccountCaps, withLedger } from "./state.ts";

export type AccountTx =
  | Tagged<"pay", { token: TokenId; amount: bigint }>
  | Tagged<"set_credit", { token: TokenId; limit: bigint }>
  | Tagged<"lock", { token: TokenId; hold: Hold }>
  | Tagged<"resolve", { token: TokenId; id: HoldId; secret: Uint8Array }>
  | Tagged<"cancel", { token: TokenId; id: HoldId }>
  | Tagged<"expire", { token: TokenId; id: HoldId }>;

/** What a tx is judged against besides the state: the clock's parameters and the judging party's own view of J. */
export type Judge = Readonly<{ clock: ClockParams; view: JView }>;

type Step = Result<AccountState, AccountFault>;

const onLedger = (s: AccountState, token: TokenId, next: Result<Ledger, AccountFault>): Step =>
  map(next, (l) => withLedger(s, token, l));

/** The token's lock rules first, then the caps that only the whole Account can see. */
const locked = (s: AccountState, j: Judge, author: Side, tx: Extract<AccountTx, { _tag: "lock" }>): Step =>
  flatMap(onLedger(s, tx.token, lockClause(ledgerOf(s, tx.token), j.clock, j.view, author, tx.hold)), (next) => {
    const refusal = withinAccountCaps(next);
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
  });
