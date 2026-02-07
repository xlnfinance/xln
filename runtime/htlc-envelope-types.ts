/**
 * HTLC Onion Envelope Types
 * Privacy-preserving routing: each node only knows previous/next hop
 *
 * Reference:
 * - 2024 Channel.ts onion routing
 * - 2019 encrypted envelope pattern
 *
 * Design:
 * - Alice creates layered envelopes (innermost = Bob, outermost = Hub1)
 * - Each hop unwraps one layer, forwards innerEnvelope to next hop
 * - Final recipient sees finalRecipient=true, extracts secret
 *
 * PHASE 2 (Current): RSA-OAEP encryption via Web Crypto API
 * - Each innerEnvelope encrypted with recipient's public key
 * - Zero dependencies, native browser/Bun support
 * - Prevents route/secret tampering by intermediaries
 * PHASE 3 (Future): Upgrade to post-quantum (Kyber) when available
 */

import type { CryptoProvider } from './crypto-provider';
import { safeStringify } from './serialization-utils';

export interface HtlcEnvelope {
  nextHop?: string;           // Next entity to forward to (undefined if final)
  finalRecipient?: boolean;   // Is this the last hop?
  secret?: string;            // Only in final recipient's envelope
  innerEnvelope?: string;     // Encoded envelope for next hop (encrypted or JSON)
}

export interface HtlcRoutingContext {
  route: string[];            // Full route (used by sender to create envelopes)
  currentHopIndex: number;    // Which hop we're at (for debugging)
}

/**
 * Create layered onion envelopes from route
 *
 * Example (encrypted):
 *   route = [alice, hub1, hub2, bob]
 *   secret = "my_secret_preimage"
 *
 * Returns envelope for hub1 (first hop after Alice):
 * {
 *   nextHop: hub2,
 *   innerEnvelope: "base64_encrypted_payload_for_hub2"
 * }
 *
 * Build order (innermost to outermost):
 * 1. Bob's envelope: {finalRecipient: true, secret}
 * 2. Encrypt for Bob, wrap in Hub2's layer
 * 3. Encrypt for Hub2, wrap in Hub1's layer
 *
 * @param route - Full path [sender, hop1, hop2, ..., recipient]
 * @param secret - Preimage for final recipient
 * @param entityPubKeys - Optional public keys for encryption
 * @param crypto - Optional crypto provider (if undefined, uses cleartext)
 * @returns Outermost envelope (for first hop)
 */
export async function createOnionEnvelopes(
  route: string[],
  secret: string,
  entityPubKeys?: Map<string, string>,
  crypto?: CryptoProvider
): Promise<HtlcEnvelope> {
  if (route.length < 2) {
    throw new Error('Route must have at least sender and recipient');
  }

  // MEDIUM-8: Enforce MAX_HOPS (prevent oversized payloads)
  const MAX_HOPS = 20; // From constants.ts
  const numHops = route.length - 1; // Exclude sender

  if (numHops > MAX_HOPS) {
    throw new Error(`Route too long: ${numHops} hops > MAX_HOPS (${MAX_HOPS})`);
  }

  // MEDIUM-8: Detect loops (duplicate entities in route)
  // Allow exactly one special case for privacy routes:
  // - sender === recipient (self-pay), with unique intermediate hops.
  const uniqueEntities = new Set(route);
  const isSelfRoute = route[0] === route[route.length - 1];
  if (isSelfRoute) {
    const intermediates = route.slice(1, -1);
    const uniqueIntermediates = new Set(intermediates);
    const expectedUnique = route.length - 1; // all unique except sender repeated at end
    const hasOnlyAllowedRepeat = uniqueEntities.size === expectedUnique;
    const hasDuplicateIntermediates = uniqueIntermediates.size !== intermediates.length;
    if (!hasOnlyAllowedRepeat || hasDuplicateIntermediates) {
      throw new Error(`Route contains invalid self-loop duplicates`);
    }
  } else if (uniqueEntities.size !== route.length) {
    throw new Error(`Route contains loops: ${route.length} entities but only ${uniqueEntities.size} unique`);
  }

  // Build onion layers (2024 User.ts pattern: encrypt innermost first, wrap outward)
  // Step 1: Encrypt final payload FOR final recipient
  const finalRecipient = route[route.length - 1];
  if (!finalRecipient) {
    throw new Error('Route must have at least one recipient');
  }
  let encryptedBlob = '';

  if (crypto && entityPubKeys) {
    const finalRecipientKey = entityPubKeys.get(finalRecipient);
    if (finalRecipientKey) {
      const finalPayload = safeStringify({finalRecipient: true, secret});
      encryptedBlob = await crypto.encrypt(finalPayload, finalRecipientKey);
    }
  }

  if (!encryptedBlob) {
    // Fallback: no encryption available, use cleartext
    encryptedBlob = safeStringify({finalRecipient: true, secret});
  }

  // Step 2: Wrap each hop's layer (from final backwards to first)
  // Each hop encrypts: {nextHop: X, encryptedBlob: Y} FOR themselves
  // Route [Alice, Hub1, Hub2, Bob]:
  // - i=2 (Hub2): encrypt {nextHop: Bob, innerEnvelope: <enc for Bob>} FOR Hub2
  // - i=1 (Hub1): encrypt {nextHop: Hub2, innerEnvelope: <enc for Hub2>} FOR Hub1
  for (let i = route.length - 2; i >= 1; i--) {
    const currentHop = route[i];
    const nextHop = route[i + 1];

    if (!currentHop || !nextHop) {
      throw new Error(`Invalid route segment at index ${i}`);
    }

    const layerPayload = safeStringify({
      nextHop,
      innerEnvelope: encryptedBlob
    });

    if (crypto && entityPubKeys) {
      const currentHopKey = entityPubKeys.get(currentHop);
      if (currentHopKey) {
        encryptedBlob = await crypto.encrypt(layerPayload, currentHopKey);
      }
    } else {
      encryptedBlob = layerPayload;
    }
  }

  // Step 3: Build final envelope for first hop (cleartext wrapper)
  const firstHop = route[1];
  if (!firstHop) {
    throw new Error('Route must have at least one hop');
  }
  const envelope: HtlcEnvelope = {
    nextHop: firstHop,
    innerEnvelope: encryptedBlob
  };

  return envelope;
}

/**
 * Unwrap one layer of onion envelope
 *
 * @param encoded - JSON-encoded envelope string
 * @returns Parsed envelope
 */
export function unwrapEnvelope(encoded: string): HtlcEnvelope {
  try {
    return JSON.parse(encoded);
  } catch (e) {
    throw new Error(`Failed to unwrap envelope: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Validate envelope structure
 *
 * @param envelope - Envelope to validate
 * @returns true if valid, throws if invalid
 */
export function validateEnvelope(envelope: HtlcEnvelope): boolean {
  if (envelope.finalRecipient) {
    if (!envelope.secret) {
      throw new Error('Final recipient envelope must have secret');
    }
    if (envelope.nextHop || envelope.innerEnvelope) {
      throw new Error('Final recipient envelope must not have nextHop or innerEnvelope');
    }
  } else {
    if (!envelope.nextHop) {
      throw new Error('Intermediary envelope must have nextHop');
    }
    if (!envelope.innerEnvelope) {
      throw new Error('Intermediary envelope must have innerEnvelope');
    }
    if (envelope.secret) {
      throw new Error('Intermediary envelope must not have secret (privacy leak!)');
    }
  }
  return true;
}
