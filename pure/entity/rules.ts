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

/** The tag a refusal carries when an expiry would give back what the chain may have paid on. */
const UNRULED = "reveal_unknown";

/**
 * `self` is the side of the replica that judges; `frozen` is whether its node signs nothing new on this Account;
 * `unruled` is the hashlocks whose reveal on the chain the Entity cannot rule out (R-WATCH-STALL), and `blind` that it
 * cannot rule out any (R-WATCH-CALLDATA): an expiry of such a hold is refused, to be tried again when it can.
 */
export type Standing = Readonly<{ self: Side; frozen: boolean; unruled: ReadonlySet<string>; blind: boolean }>;

/** An expiry of a hold whose secret may be on the chain unseen. */
const unknown = (state: AccountState, { unruled, blind }: Standing, tx: AccountTx): boolean => {
  if (tx._tag !== "expire") return false;
  const hold = ledgerOf(state, tx.token).holds.find((h) => h.id === tx.id);
  return hold !== undefined && (blind || unruled.has(hold.hashlock));
};

export const entityRules = (judge: Judge, signing: SigningContext, standing: Standing): EntityRules => {
  const base = accountRules(judge, signing);
  const refusal = (state: AccountState, author: Side, tx: AccountTx): PeerFault | undefined => {
    if (standing.frozen && author !== standing.self) return { _tag: FROZEN };
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
