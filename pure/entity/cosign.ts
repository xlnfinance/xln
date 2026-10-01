// What an Entity co-signs about collateral (R-C2R-FOLD, R-COSIGN-FREEZE). A settlement and a collateral-to-reserve both
// advance the Account's epoch, which voids every proof of the old one; the settlement folds each token's offdelta into
// its ondelta so no payment is lost, the shortcut folds nothing. So the shortcut is only for an Account with no
// offdelta in any token, and the node co-signs nothing while an earlier signature of its own has not landed.
import { err, ok, type Result } from "../kernel/core/result.ts";
import { match } from "../kernel/core/tagged.ts";
import { MAX_AMOUNT } from "../account/ledger.ts";
import type { AccountState, TokenId } from "../account/model.ts";
import type { ChainFacts, CosignOp, EntityFault, EntityId, EntityReplica, Fold, JAction } from "./model.ts";

const byToken = (a: Fold, b: Fold): number => {
  if (a.token === b.token) return 0;
  return a.token < b.token ? -1 : 1;
};

/** The offdelta of every token that has one, tokens ascending: what a settlement has to fold. */
export const foldsOf = (state: AccountState): readonly Fold[] =>
  [...state.ledgers]
    .flatMap(([token, l]) => (l.offdelta === 0n ? [] : [{ token, offdelta: l.offdelta }]))
    .toSorted(byToken);

/** At most one operation at a time, and never over a frame still in flight: its ack may move the offdelta. */
export const cosignFault = (account: EntityReplica, facts: ChainFacts, amount: bigint): EntityFault | undefined => {
  if (facts.frozen) return { _tag: "already_cosigned" };
  if (account.pending !== undefined) return { _tag: "frame_in_flight" };
  if (amount >= 1n && amount <= MAX_AMOUNT) return undefined;
  return { _tag: "account_refused", fault: { _tag: "bad_amount", amount } };
};

const c2r = (peer: EntityId, token: TokenId, amount: bigint): JAction => ({ _tag: "c2r", peer, token, amount });

const settle = (peer: EntityId, token: TokenId, amount: bigint, folds: readonly Fold[]): JAction =>
  ({ _tag: "settle", peer, token, amount, folds });

/** The node's own withdrawal: the shortcut when there is nothing to fold, otherwise the settlement that folds it. */
export const withdrawalOf = (peer: EntityId, token: TokenId, amount: bigint, folds: readonly Fold[]): JAction =>
  (folds.length === 0 ? c2r(peer, token, amount) : settle(peer, token, amount, folds));

/** A peer's ask: the shortcut only while there is nothing to fold; a settlement folds what the node's state says. */
export const askedOf = (peer: EntityId, op: CosignOp, folds: readonly Fold[]): Result<JAction, EntityFault> =>
  match(op, {
    c2r: (o) => (folds.length === 0 ? ok(c2r(peer, o.token, o.amount)) : err({ _tag: "unfolded_c2r", folds })),
    settle: (o) => ok(settle(peer, o.token, o.amount, folds)),
  });
