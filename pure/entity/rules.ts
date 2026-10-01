// The rules an Entity judges its Account's frames by: the Account's own, and one more fault that is the Entity's
// (R-COSIGN-FREEZE, both ways). While the node's signature on a settlement or a collateral-to-reserve is out, every
// frame its peer proposes is refused with the fault `frozen`, which can pass (the operation lands, is superseded or
// lapses), so the proposer takes the frame back and tries again. The Account's code is unchanged: it is handed
// these rules.
import { err } from "../kernel/core/result.ts";
import { accountRules } from "../account/frame/account.ts";
import type { Rules } from "../account/frame/frame.ts";
import type { AccountState, Side } from "../account/model.ts";
import type { SigningContext } from "../account/proof/signing.ts";
import type { AccountTx, Judge } from "../account/tx.ts";
import type { PeerFault } from "./model.ts";

export type EntityRules = Rules<AccountTx, AccountState, PeerFault>;

/** The tag a refusal carries when the receiver's signature is out. */
const FROZEN = "frozen";

/** `self` is the side of the replica that judges; `frozen` is whether its node's signature is out on this Account. */
export type Standing = Readonly<{ self: Side; frozen: boolean }>;

export const entityRules = (judge: Judge, signing: SigningContext, { self, frozen }: Standing): EntityRules => {
  const base = accountRules(judge, signing);
  return {
    apply: (state, author, tx) => (frozen && author !== self ? err({ _tag: FROZEN }) : base.apply(state, author, tx)),
    name: base.name,
    seal: base.seal,
    tag: (fault) => fault._tag,
    retryable: (tag) => tag === FROZEN || base.retryable(tag),
  };
};
