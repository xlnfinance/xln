// Where an Entity signs one Account's frames (R-FRAME-SIGNATURE-NAMES-ACCOUNT): the deployment and terms are the
// Runtime's, the rest is the Account's and the epoch's, read off the chain facts the Entity holds for it.
import type { Deployment } from "../../chain/proof/deployment.ts";
import type { SigningContext } from "../../account/proof/signing.ts";
import type { ProofTerms } from "../../account/proof/body.ts";
import { firstNonce } from "../chain.ts";
import type { ChainFacts, EntityId } from "../model.ts";
import type { Check } from "./attest.ts";

/**
 * What every Account of a Runtime signs under: the chain and Depository it is on, the terms of its proofs, and how a
 * peer's signature over a head is checked.
 */
export type Anchor = Readonly<{ deployment: Deployment; terms: ProofTerms; check: Check }>;

/**
 * The key both sides name an Account by: the two entity ids, the smaller first, as the Depository reads them. An id is
 * a lowercase 32-byte word, so the order of the text is the order of the numbers.
 */
export const accountKeyOf = (self: EntityId, peer: EntityId): string =>
  `0x${(self < peer ? [self, peer] : [peer, self]).map((id) => id.slice(2)).join("")}`;

/**
 * The context the Account with `peer` signs in, in the epoch the Entity believes the chain is in: its own key, that
 * epoch, and the first nonce a signed frame of the epoch may take, the stored nonce plus 2 (R-IMPLICIT-BASELINE).
 */
export const signingOf = (anchor: Anchor, self: EntityId, peer: EntityId, facts: ChainFacts): SigningContext => ({
  deployment: anchor.deployment, terms: anchor.terms,
  accountKey: accountKeyOf(self, peer), ondeltaEpoch: facts.epoch, firstNonce: firstNonce(facts),
});
