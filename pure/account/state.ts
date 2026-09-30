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

/** The Account's caps, checked on a state a lock has just produced: nothing above the cap, no hashlock open twice. */
export const withinAccountCaps = (s: AccountState): AccountFault | undefined => {
  const holds = openHolds(s);
  if (holds.length > MAX_HOLDS) return { _tag: "too_many_holds", max: MAX_HOLDS };
  const holder = (h: Hold): Hold | undefined => holds.find((o) => o.hashlock === h.hashlock);
  const twice = holds.find((h) => holder(h) !== h);
  return twice === undefined ? undefined : { _tag: "lock_exists", id: holder(twice)?.id ?? twice.id };
};
