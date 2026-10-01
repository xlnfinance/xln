// What spans tokens in one Account. A Ledger is one token's money; the Account's own rules are the ones a single
// Ledger cannot see: how many holds are open in all, and which hashlocks are open anywhere. A proof body carries the
// transformers of every token (Account.sol MAX_DISPUTE_TRANSFORMERS), so the count that must stay at or below 32 is
// the Account's, and one secret opens one clause in the whole Account (R-ONE-LOCK-PER-HASH).
import { mapSet } from "../kernel/core/collections.ts";
import { emptyLedger, MAX_HOLDS } from "./ledger.ts";
import type { AccountFault, AccountState, Hold, Ledger, TokenId } from "./model.ts";

export const emptyAccount: AccountState = { ledgers: new Map() };

export const ledgerOf = (s: AccountState, token: TokenId): Ledger => s.ledgers.get(token) ?? emptyLedger;

export const withLedger = (s: AccountState, token: TokenId, l: Ledger): AccountState =>
  ({ ledgers: mapSet(s.ledgers, token, l) });

/** Every open hold of the Account, whatever its token, in token order of first use. */
export const openHolds = (s: AccountState): readonly Hold[] => [...s.ledgers.values()].flatMap((l) => l.holds);

/** The Account's hold cap, checked on a state a lock has just produced: no more than MAX_HOLDS open in all tokens. */
export const withinHoldCap = (s: AccountState): AccountFault | undefined =>
  openHolds(s).length > MAX_HOLDS ? { _tag: "too_many_holds", max: MAX_HOLDS } : undefined;

/** The open clause that holds `hashlock`, in whatever token (R-ONE-LOCK-PER-HASH). */
export const holderOf = (s: AccountState, hashlock: string): Hold | undefined =>
  openHolds(s).find((h) => h.hashlock === hashlock);
