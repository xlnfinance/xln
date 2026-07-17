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
 * Each layer uses one authenticated content ciphertext. The content key is
 * wrapped only for the receiving Entity's certified default proposer
 * (`board.validators[0]`). Other validators replay only the later signed
 * advance action; proposer loss follows the ordinary timeout/dispute path.
 */

import { keccak256 } from 'ethers';
import type { CryptoProvider } from '../crypto/provider';
import { HTLC, LIMITS } from '../../constants';
import { safeStringify } from '../serialization';
import { encryptBytesForValidatorManifest, type MultiRecipientCiphertext } from './multi-recipient';
import { decodeOnionLayer, encodeHtlcSecretOffer, encodeOnionLayer } from './onion-codec';
import type { CertifiedValidatorEncryptionManifest } from './validator-encryption';

const MAX_ENVELOPE_SERIALIZED_BYTES = LIMITS.MAX_FRAME_SIZE_BYTES;

export interface HtlcEnvelope {
  nextHop?: string;           // Next entity to forward to (undefined if final)
  finalRecipient?: boolean;   // Is this the last hop?
  secretOffer?: MultiRecipientCiphertext; // Opaque return offer for the payer proposer
  description?: string;       // Optional payment note (final recipient envelope only)
  startedAtMs?: number;       // Sender-side first lock timestamp
  innerEnvelope?: MultiRecipientCiphertext;
  forwardAmount?: string;     // Exact amount this hop must forward to next hop
}

export interface HtlcRoutingContext {
  route: string[];            // Full route (used by sender to create envelopes)
  currentHopIndex: number;    // Which hop we're at (for debugging)
}

export type HtlcEnvelopeBinding = Readonly<{
  rootLockId: string;
  hashlock: string;
  tokenId: number;
  senderLockAmount: bigint;
  timelock: bigint;
  revealBeforeHeight: number;
}>;

export type HtlcEnvelopeContext = Readonly<{
  entityId: string;
  lockId: string;
  hashlock: string;
  tokenId: number;
  amount: bigint;
  timelock: bigint;
  revealBeforeHeight: number;
}>;

export type HtlcSecretOfferContext = HtlcEnvelopeContext & Readonly<{
  payerEntityId: string;
  beneficiaryEntityId: string;
}>;

export const computeHtlcEnvelopeContextHash = (context: HtlcEnvelopeContext): string =>
  keccak256(new TextEncoder().encode(safeStringify({
    version: 'xln:htlc-envelope-context:v1',
    entityId: context.entityId.toLowerCase(),
    lockId: context.lockId,
    hashlock: context.hashlock.toLowerCase(),
    tokenId: context.tokenId,
    amount: context.amount,
    timelock: context.timelock,
    revealBeforeHeight: context.revealBeforeHeight,
  })));

export const computeHtlcSecretOfferContextHash = (context: HtlcSecretOfferContext): string =>
  keccak256(new TextEncoder().encode(safeStringify({
    version: 'xln:htlc-secret-offer-context:v1',
    payerEntityId: context.payerEntityId.toLowerCase(),
    beneficiaryEntityId: context.beneficiaryEntityId.toLowerCase(),
    lockId: context.lockId,
    hashlock: context.hashlock.toLowerCase(),
    tokenId: context.tokenId,
    amount: context.amount,
    timelock: context.timelock,
    revealBeforeHeight: context.revealBeforeHeight,
  })));

const inboundLockIdAt = (rootLockId: string, hopIndex: number): string =>
  `${rootLockId}${'-fwd'.repeat(Math.max(0, hopIndex - 1))}`;

const inboundAmountAt = (
  route: string[],
  hopIndex: number,
  senderLockAmount: bigint,
  hopForwardAmounts: Map<string, bigint>,
): bigint => {
  if (hopIndex === 1) return senderLockAmount;
  const previousHop = route[hopIndex - 1];
  const amount = previousHop ? hopForwardAmounts.get(previousHop) : undefined;
  if (amount === undefined) throw new Error(`Missing inbound amount for route hop ${hopIndex}`);
  return amount;
};

const contextAt = (
  route: string[],
  hopIndex: number,
  binding: HtlcEnvelopeBinding,
  hopForwardAmounts: Map<string, bigint>,
): HtlcEnvelopeContext => ({
  entityId: route[hopIndex]!,
  lockId: inboundLockIdAt(binding.rootLockId, hopIndex),
  hashlock: binding.hashlock,
  tokenId: binding.tokenId,
  amount: inboundAmountAt(route, hopIndex, binding.senderLockAmount, hopForwardAmounts),
  timelock: binding.timelock - BigInt(hopIndex - 1) * BigInt(HTLC.MIN_TIMELOCK_DELTA_MS),
  revealBeforeHeight: binding.revealBeforeHeight
    - (hopIndex - 1) * HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS,
});

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
 * @param entityManifests - Complete certified validator key manifest per receiving Entity
 * @param crypto - Content/wrapping crypto provider
 * @returns Outermost envelope (for first hop)
 */
export async function createOnionEnvelopes(
  route: string[],
  secret: string,
  entityManifests?: Map<string, CertifiedValidatorEncryptionManifest>,
  crypto?: CryptoProvider,
  hopForwardAmounts?: Map<string, bigint>,
  description?: string,
  startedAtMs?: number,
  binding?: HtlcEnvelopeBinding,
): Promise<HtlcEnvelope> {
  if (route.length < 2) {
    throw new Error('Route must have at least sender and recipient');
  }

  const numHops = route.length - 1; // Exclude sender

  if (numHops > HTLC.MAX_HOPS) {
    throw new Error(`Route too long: ${numHops} hops > MAX_HOPS (${HTLC.MAX_HOPS})`);
  }

  // MEDIUM-8: Detect loops (duplicate entities in route)
  // Allow exactly one special case for privacy routes:
  // - sender === recipient (self-pay), with unique intermediate hops.
  const uniqueEntities = new Set(route);
  const isSelfRoute = route[0] === route[route.length - 1];
  if (isSelfRoute) {
    const intermediates = route.slice(1, -1);
    if (intermediates.length < 2) {
      throw new Error('Self-pay route must include at least 2 intermediate entities');
    }
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
  if (!crypto || !entityManifests || !hopForwardAmounts || !binding) {
    throw new Error('Onion envelope encryption requires crypto, certified manifests, amounts, and lock binding');
  }

  // Build onion layers (2024 User.ts pattern: encrypt innermost first, wrap outward)
  // Only the final payer needs a private preimage offer. Once that exact
  // Account unlock is ACK-committed, the ordinary lockbook phase-2 propagation
  // may reveal the preimage upstream: every intermediary then already owns an
  // enforceable downstream claim. Building one encrypted offer per hop adds
  // latency without improving that invariant.
  const beneficiaryIndex = route.length - 1;
  const payerEntityId = route[beneficiaryIndex - 1]!;
  const beneficiaryEntityId = route[beneficiaryIndex]!;
  const payerManifest = entityManifests.get(payerEntityId);
  if (!payerManifest) throw new Error(`Missing validator encryption manifest for payer ${payerEntityId}`);
  const edge = contextAt(route, beneficiaryIndex, binding, hopForwardAmounts);
  const secretOffer = await encryptBytesForValidatorManifest(
    encodeHtlcSecretOffer({ secret }),
    payerManifest.manifest,
    payerManifest.profileCertification,
    computeHtlcSecretOfferContextHash({ ...edge, payerEntityId, beneficiaryEntityId }),
    crypto,
    payerManifest.recipientSignerId,
  );

  // Step 1: Encrypt final payload FOR final recipient. It contains no preimage;
  // the recipient can only commit the opaque offer to the payer's Account.
  const finalRecipient = route[route.length - 1];
  if (!finalRecipient) {
    throw new Error('Route must have at least one recipient');
  }
  const finalCertifiedManifest = entityManifests.get(finalRecipient);
  if (!finalCertifiedManifest) {
    throw new Error(`Missing validator encryption manifest for final recipient ${finalRecipient}`);
  }
  const finalPayload = encodeOnionLayer({
    finalRecipient: true,
    secretOffer,
    ...(description ? { description } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  });
  let encryptedBlob = await encryptBytesForValidatorManifest(
    finalPayload,
    finalCertifiedManifest.manifest,
    finalCertifiedManifest.profileCertification,
    computeHtlcEnvelopeContextHash(contextAt(route, route.length - 1, binding, hopForwardAmounts)),
    crypto,
    finalCertifiedManifest.recipientSignerId,
  );

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

    const forwardAmount = hopForwardAmounts.get(currentHop);
    if (forwardAmount === undefined) {
      throw new Error(`Missing forward amount for route hop ${currentHop}`);
    }
    const layerPayload = encodeOnionLayer({
      nextHop,
      innerEnvelope: encryptedBlob,
      forwardAmount: forwardAmount.toString(),
    });

    const currentHopManifest = entityManifests.get(currentHop);
    if (!currentHopManifest) {
      throw new Error(`Missing validator encryption manifest for hop ${currentHop}`);
    }
    encryptedBlob = await encryptBytesForValidatorManifest(
      layerPayload,
      currentHopManifest.manifest,
      currentHopManifest.profileCertification,
      computeHtlcEnvelopeContextHash(contextAt(route, i, binding, hopForwardAmounts)),
      crypto,
      currentHopManifest.recipientSignerId,
    );
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
 * @param encoded - canonical length-delimited binary layer
 * @returns Parsed envelope
 */
export function unwrapEnvelope(encoded: Uint8Array): HtlcEnvelope {
  try {
    return decodeOnionLayer(encoded);
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
  const serialized = safeStringify(envelope);
  if (new TextEncoder().encode(serialized).byteLength > MAX_ENVELOPE_SERIALIZED_BYTES) {
    throw new Error(`Envelope exceeds ${MAX_ENVELOPE_SERIALIZED_BYTES} bytes`);
  }
  if (envelope.description !== undefined && envelope.description.length > 256) {
    throw new Error('Envelope description exceeds 256 characters');
  }
  if (envelope.finalRecipient) {
    if (!envelope.secretOffer) {
      throw new Error('Final recipient envelope must have secret offer');
    }
    if (envelope.description !== undefined && typeof envelope.description !== 'string') {
      throw new Error('Final recipient envelope description must be string');
    }
    if (envelope.startedAtMs !== undefined) {
      if (!Number.isFinite(envelope.startedAtMs) || envelope.startedAtMs <= 0) {
        throw new Error('Final recipient envelope startedAtMs must be positive number');
      }
    }
    if (envelope.nextHop || envelope.innerEnvelope || 'secret' in envelope) {
      throw new Error('Final recipient envelope must not have nextHop or innerEnvelope');
    }
  } else {
    if (envelope.description !== undefined) {
      throw new Error('Intermediary envelope must not contain description');
    }
    if (envelope.startedAtMs !== undefined) {
      throw new Error('Intermediary envelope must not contain startedAtMs');
    }
    if (!envelope.nextHop) {
      throw new Error('Intermediary envelope must have nextHop');
    }
    if (!envelope.innerEnvelope) {
      throw new Error('Intermediary envelope must have innerEnvelope');
    }
    if (typeof envelope.forwardAmount !== 'string' || envelope.forwardAmount.length === 0) {
      throw new Error('Intermediary envelope must have forwardAmount');
    }
    try {
      const forwardAmount = BigInt(envelope.forwardAmount);
      if (forwardAmount <= 0n) {
        throw new Error('Intermediary envelope forwardAmount must be > 0');
      }
    } catch {
      throw new Error('Intermediary envelope forwardAmount must be a valid bigint string');
    }
    if ('secret' in envelope || envelope.secretOffer) {
      throw new Error('Intermediary envelope must not have secret (privacy leak!)');
    }
  }
  return true;
}
