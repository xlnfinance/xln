// What a replica signs when a frame commits (R-FRAME-HASH-SIGNED): the dispute-proof message of the Account's state
// after the frame, at the nonce its slot gives it, authored by the frame's author. The digest of that message
// is what the Depository checks a signature against, so it is also the name a committed frame has: the head both
// replicas hold, the parent of the next frame, the hash an ack carries. Nothing in it comes from the wire.
import { err, flatMap, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import type { Deployment } from "../../chain/proof/deployment.ts";
import { accountMessageHash } from "../../chain/proof/payload.ts";
import { proofBodyHash } from "../../chain/proof/proof.ts";
import type { AccountState, Side } from "../model.ts";
import { proofBodyOf, type ProofFault, type ProofTerms } from "./body.ts";

/**
 * Where the Account's frames are signed: its deployment, its key, its ondelta epoch, the first nonce a signed frame may
 * take (the stored nonce plus 2, R-IMPLICIT-BASELINE: the one before it is the unsigned baseline's) and its terms.
 */
export type SigningContext = Readonly<{
  deployment: Deployment; accountKey: string; ondeltaEpoch: bigint; firstNonce: bigint; terms: ProofTerms;
}>;

export type SigningFault = ProofFault | Tagged<"height_not_signed", { height: number }>;

/** What the contract takes as a live nonce: below the largest exact JavaScript integer (`JS_SAFE_NONCE_MAX`). */
const NONCE_CEILING = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The digest of the frame at nonce slot `slot` (the first is 1, signed at `firstNonce`): `author` proposed it and
 * `after` is the state it made. A slot is the frames committed before it, the nonces their refused attempts burned and
 * the frame's own attempt, so a retried frame is signed at a nonce of its own (R-RETRY-NEW-NONCE): the contract takes
 * any nonce above the stored one, and the peer, holding the refused attempt's signature, never holds two proofs of one
 * nonce to choose between. A slot whose nonce the contract would refuse (not below `NONCE_CEILING`) has no digest.
 */
export const frameDigest = (
  c: SigningContext, slot: number, author: Side, after: AccountState,
): Result<string, SigningFault> => {
  if (!Number.isSafeInteger(slot) || slot < 1 || c.firstNonce + BigInt(slot - 1) >= NONCE_CEILING) {
    return err({ _tag: "height_not_signed", height: slot });
  }
  return flatMap(proofBodyOf(c.terms, after), (body) => flatMap(proofBodyHash(body), (bodyHash) =>
    accountMessageHash(c.deployment, {
      accountKey: c.accountKey, ondeltaEpoch: c.ondeltaEpoch, nonce: c.firstNonce + BigInt(slot - 1),
    }, {
      _tag: "dispute_proof", proposerIsLeft: author === "left", proofBodyHash: bodyHash, watchSeed: c.terms.watchSeed,
    })));
};
