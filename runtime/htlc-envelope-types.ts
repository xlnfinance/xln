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
 * PHASE 2 (Current): JSON cleartext - functional but NOT privacy-preserving
 * PHASE 3 (TODO - HIGH-5): Add per-hop encryption/MAC using:
 *   - ECIES (Elliptic Curve Integrated Encryption Scheme), OR
 *   - HMAC derived from hashlock + hop index
 *   - Prevents route/secret tampering by intermediaries
 *   - Codex requirement for production-grade privacy
 */

export interface HtlcEnvelope {
  nextHop?: string;           // Next entity to forward to (undefined if final)
  finalRecipient?: boolean;   // Is this the last hop?
  secret?: string;            // Only in final recipient's envelope
  innerEnvelope?: string;     // Encoded envelope for next hop (JSON string)
}

export interface HtlcRoutingContext {
  route: string[];            // Full route (used by sender to create envelopes)
  currentHopIndex: number;    // Which hop we're at (for debugging)
}

/**
 * Create layered onion envelopes from route
 *
 * Example:
 *   route = [alice, hub1, hub2, bob]
 *   secret = "my_secret_preimage"
 *
 * Returns envelope for hub1 (first hop after Alice):
 * {
 *   nextHop: hub2,
 *   innerEnvelope: "{\"nextHop\":\"bob\",\"innerEnvelope\":\"{\\\"finalRecipient\\\":true,\\\"secret\\\":\\\"my_secret_preimage\\\"}\"}"
 * }
 *
 * Build order:
 * 1. Innermost (Bob): {finalRecipient: true, secret}
 * 2. Hub2 layer: {nextHop: bob, innerEnvelope: JSON(Bob's envelope)}
 * 3. Hub1 layer: {nextHop: hub2, innerEnvelope: JSON(Hub2's envelope)}
 *
 * @param route - Full path [sender, hop1, hop2, ..., recipient]
 * @param secret - Preimage for final recipient
 * @returns Outermost envelope (for first hop)
 */
export function createOnionEnvelopes(
  route: string[],  // [alice, hub1, hub2, bob]
  secret: string    // Final recipient's secret
): HtlcEnvelope {
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
  const uniqueEntities = new Set(route);
  if (uniqueEntities.size !== route.length) {
    throw new Error(`Route contains loops: ${route.length} entities but only ${uniqueEntities.size} unique`);
  }

  // Build from innermost (final) to outermost (first hop)
  let envelope: HtlcEnvelope = {
    finalRecipient: true,
    secret
  };

  // Wrap each layer (reverse order, skip sender [0] and final recipient [length-1])
  // For route [alice, hub1, hub2, bob]:
  // - i=2: wrap bob's envelope for hub2 -> {nextHop: bob, innerEnvelope: {...}}
  // - i=1: wrap hub2's envelope for hub1 -> {nextHop: hub2, innerEnvelope: {...}}
  for (let i = route.length - 2; i >= 1; i--) {
    const nextHop = route[i + 1];
    if (!nextHop) {
      throw new Error(`Invalid route: missing hop at index ${i + 1}`);
    }
    envelope = {
      nextHop,
      innerEnvelope: JSON.stringify(envelope)
    };
  }

  return envelope;  // Outermost envelope (for first hop)
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
