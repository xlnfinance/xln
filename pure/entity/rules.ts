// The rules an Entity judges its Account's frames by: the Account's own, and one more fault that is the Entity's
// (R-COSIGN-FREEZE, R-DISPUTE-FREEZE, both ways). While the node's signature on a settlement or a collateral-to-reserve
// is out, or a dispute is open on the Account, every frame its peer proposes is refused with the fault `frozen`, which
// can pass (the operation lands, is superseded, lapses, or the dispute ends), so the proposer takes the frame back and
// tries again. The Account's code is unchanged: it is handed these rules.
import { err } from "../kernel/core/result.ts";
import { accountRules } from "../account/frame/account.ts";
import type { Rules } from "../account/frame/frame.ts";
import type { AccountState, Side } from "../account/model.ts";
import type { SigningContext } from "../account/proof/signing.ts";
import type { AccountTx, Judge } from "../account/tx.ts";
import { ledgerOf } from "../account/state.ts";
import type { PeerFault } from "./model.ts";

export type EntityRules = Rules<AccountTx, AccountState, PeerFault>;

/** The tag a refusal carries when the receiver's signature is out. */
const FROZEN = "frozen";

/** The refusal for an expiry of a hold the chain paid: no wait helps, the payee's way is a dispute. */
const REVEALED = "revealed_on_chain";

/** The tag a refusal carries when an expiry would give back what the chain may have paid on. */
const UNRULED = "reveal_unknown";

/**
 * `self` is the side of the replica that judges; `frozen` is whether its node signs nothing new on this Account;
 * `unruled` is the hashlocks whose reveal on the chain the Entity cannot rule out (R-WATCH-STALL), and `blind` that it
 * cannot rule out any (R-WATCH-CALLDATA): an expiry of such a hold is refused, to be tried again when it can.
 * `shown` is the lowest J height the chain showed a hashlock's secret at.
 */
export type Standing = Readonly<{
  self: Side; frozen: boolean; unruled: ReadonlySet<string>; blind: boolean; shown: ReadonlyMap<string, bigint>;
}>;

/** An expiry of a hold whose secret may be on the chain unseen. */
const unknown = (state: AccountState, { unruled, blind }: Standing, tx: AccountTx): boolean => {
  if (tx._tag !== "expire") return false;
  const hold = ledgerOf(state, tx.token).holds.find((h) => h.id === tx.id);
  return hold !== undefined && (blind || unruled.has(hold.hashlock));
};

/**
 * R-REVEAL-BACKSTOP: the chain counts a secret shown at a height up to the deadline (its slack covers the drift), so an
 * expiry of that hold, by either side, would pay the payer what the chain paid the payee. Events come before the
 * height that passes the deadline plus the reserve (R-HEIGHT-ORDER), so the Entity knows by the time an expiry is due.
 */
const paidByChain = (state: AccountState, { shown }: Standing, tx: AccountTx): boolean => {
  if (tx._tag !== "expire") return false;
  const hold = ledgerOf(state, tx.token).holds.find((h) => h.id === tx.id);
  const at = hold === undefined ? undefined : shown.get(hold.hashlock);
  return hold !== undefined && at !== undefined && at <= hold.deadline;
};

export const entityRules = (judge: Judge, signing: SigningContext, standing: Standing): EntityRules => {
  const base = accountRules(judge, signing);
  const refusal = (state: AccountState, author: Side, tx: AccountTx): PeerFault | undefined => {
    if (standing.frozen && author !== standing.self) return { _tag: FROZEN };
    if (paidByChain(state, standing, tx)) return { _tag: REVEALED };
    return unknown(state, standing, tx) ? { _tag: UNRULED } : undefined;
  };
  return {
    epoch: base.epoch,
    firstNonce: base.firstNonce,
    apply: (state, author, tx) => {
      const refused = refusal(state, author, tx);
      return refused === undefined ? base.apply(state, author, tx) : err(refused);
    },
    name: base.name,
    seal: base.seal,
    tag: (fault) => fault._tag,
    retryable: (tag) => tag === FROZEN || tag === UNRULED || base.retryable(tag),
  };
};
