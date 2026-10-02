// Who signed a head (R-SIGNED-HEADS-ON-THE-WIRE). A head is the digest the two signers of a frame sign: the dispute
// proof of the state after it, at its nonce, naming chain, Depository, Account and epoch (R-FRAME-SIGNATURE-NAMES-ACCOUNT).
// What the Entity keeps of its peer is that signature over that head, because it is what a dispute starts with: the
// chain reads the same digest. A signature is the Hanko of the signer's own Entity; the check recovers its signer and
// asks that the Entity it speaks for is the peer's.
import { verifyHankoSignature } from "../../chain/hanko/hanko-verify.ts";
import { ok } from "../../kernel/core/result.ts";
import type { EntityId } from "../model.ts";

/** Whether `sig` is `peer`'s signature over `head`. */
export type Check = (peer: EntityId, head: string, sig: string) => boolean;

/**
 * A lazy Entity, one signer and nothing registered: a board that is not its own hash has no authority here, so a
 * Hanko that claims one is refused. A Hanko that speaks for another Entity than `peer` is refused too.
 */
export const lazyCheck: Check = (peer, head, sig) => {
  const verdict = verifyHankoSignature(sig, head, () => ok(false));
  return verdict.ok && verdict.value.entityId === peer;
};
