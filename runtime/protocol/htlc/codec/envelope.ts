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
 * Each layer is encrypted once to the receiving Entity's shared public key.
 * Every validator replica holds the same Entity private key in BrainVault;
 * Account payment data contains no validator or board material.
 */

import { keccak256 } from 'ethers';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { HTLC, LIMITS } from '../../../config/constants';
import { safeStringify } from '../../serialization';
import { encryptOpaqueHtlcBytes, type OpaqueHtlcCiphertext } from '../multi-recipient';
import { decodeOnionLayer, encodeOnionLayer, type DecodedOnionLayer } from './onion';

const MAX_ENVELOPE_SERIALIZED_BYTES = LIMITS.MAX_FRAME_SIZE_BYTES;

export type HtlcEnvelopeBinding = Readonly<{
  rootLockId: string;
  hashlock: string;
  tokenId: number;
  senderLockAmount: bigint;
  timelock: bigint;
  revealBeforeHeight: number;
}>;

export type HtlcEphemeralDerivationContext = Readonly<{
  sourceEntityId: string;
  parentFrameHash: string;
  entityHeight: number;
  paymentTxHash: string;
}>;

export type HtlcEnvelopeContext = Readonly<{
  fromEntityId: string;
  toEntityId: string;
  domain: Readonly<{ chainId: number; depositoryAddress: string }>;
  lockId: string;
  hashlock: string;
  tokenId: number;
  amount: bigint;
  timelock: bigint;
  revealBeforeHeight: number;
}>;

export const computeHtlcEnvelopeContextHash = (context: HtlcEnvelopeContext): string =>
  keccak256(new TextEncoder().encode(safeStringify({
    version: 'xln:htlc-envelope-context:v1',
    fromEntityId: context.fromEntityId.toLowerCase(),
    toEntityId: context.toEntityId.toLowerCase(),
    domain: {
      chainId: context.domain.chainId,
      depositoryAddress: context.domain.depositoryAddress.toLowerCase(),
    },
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
  hopAccountDomains: readonly Readonly<{ chainId: number; depositoryAddress: string }>[],
): HtlcEnvelopeContext => ({
  fromEntityId: route[hopIndex - 1]!,
  toEntityId: route[hopIndex]!,
  domain: hopAccountDomains[hopIndex - 1] ?? (() => { throw new Error(`Missing Account domain for hop ${hopIndex}`); })(),
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
  entityEncryptionPublicKeys?: ReadonlyMap<string, string>,
  hopAccountDomains?: readonly Readonly<{ chainId: number; depositoryAddress: string }>[],
  sourceEntityEncryptionPrivateKey?: string,
  hopForwardAmounts?: Map<string, bigint>,
  description?: string,
  startedAtMs?: number,
  binding?: HtlcEnvelopeBinding,
  derivationContext?: HtlcEphemeralDerivationContext,
): Promise<OpaqueHtlcCiphertext> {
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
  if (!entityEncryptionPublicKeys || !hopAccountDomains || !sourceEntityEncryptionPrivateKey || !hopForwardAmounts || !binding || !derivationContext) {
    throw new Error('Onion envelope encryption requires Entity keys, aligned Account domains, amounts, and lock binding');
  }
  if (hopAccountDomains.length !== route.length - 1) throw new Error('HTLC_ACCOUNT_DOMAIN_COUNT_MISMATCH');
  const ephemeralKey = (purpose: string, hopIndex: number): string => {
    const normalizedSecret = sourceEntityEncryptionPrivateKey.startsWith('0x')
      ? sourceEntityEncryptionPrivateKey.slice(2)
      : sourceEntityEncryptionPrivateKey;
    if (!/^[0-9a-fA-F]{64}$/.test(normalizedSecret)) throw new Error('HTLC_SOURCE_ENTITY_PRIVATE_KEY_INVALID');
    const secretBytes = Uint8Array.from(normalizedSecret.match(/../g)!, value => Number.parseInt(value, 16));
    const publicInfo = new TextEncoder().encode(safeStringify({
      version: 'xln:htlc-ephemeral-key:v1',
      purpose,
      hopIndex,
      route,
      binding,
      derivationContext,
    }));
    const digest = hkdf(
      sha256,
      secretBytes,
      sha256(new TextEncoder().encode('xln:htlc-ephemeral-key:v1:salt')),
      publicInfo,
      32,
    );
    // RFC 7748 X25519 scalar clamping is explicit here so the deterministic
    // KDF output is itself the canonical private scalar on every platform.
    digest[0] = digest[0]! & 248;
    digest[31] = (digest[31]! & 127) | 64;
    return `0x${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  };

  // Build onion layers (2024 User.ts pattern: encrypt innermost first, wrap outward)
  // Encrypt the preimage only inside the final recipient's onion layer. No
  // intermediary can learn it before the recipient proposes the downstream
  // Account resolution; upstream propagation begins only after that resolution
  // is durably committed.
  const finalRecipient = route[route.length - 1];
  if (!finalRecipient) {
    throw new Error('Route must have at least one recipient');
  }
  const finalPublicKey = entityEncryptionPublicKeys.get(finalRecipient);
  if (!finalPublicKey) {
    throw new Error(`Missing Entity encryption key for final recipient ${finalRecipient}`);
  }
  const finalPayload = encodeOnionLayer({
    finalRecipient: true,
    secret,
    ...(description ? { description } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  });
  let encryptedBlob = encryptOpaqueHtlcBytes(
    finalPayload,
    finalPublicKey,
    computeHtlcEnvelopeContextHash(contextAt(route, route.length - 1, binding, hopForwardAmounts, hopAccountDomains)),
    ephemeralKey('onion-layer', route.length - 1),
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

    const currentHopPublicKey = entityEncryptionPublicKeys.get(currentHop);
    if (!currentHopPublicKey) {
      throw new Error(`Missing Entity encryption key for hop ${currentHop}`);
    }
    encryptedBlob = encryptOpaqueHtlcBytes(
      layerPayload,
      currentHopPublicKey,
      computeHtlcEnvelopeContextHash(contextAt(route, i, binding, hopForwardAmounts, hopAccountDomains)),
      ephemeralKey('onion-layer', i),
    );
  }

  return encryptedBlob;
}

/**
 * Unwrap one layer of onion envelope
 *
 * @param encoded - canonical length-delimited binary layer
 * @returns Parsed envelope
 */
export function unwrapEnvelope(encoded: Uint8Array): DecodedOnionLayer {
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
export function validateEnvelope(envelope: DecodedOnionLayer): boolean {
  const serialized = safeStringify(envelope);
  if (new TextEncoder().encode(serialized).byteLength > MAX_ENVELOPE_SERIALIZED_BYTES) {
    throw new Error(`Envelope exceeds ${MAX_ENVELOPE_SERIALIZED_BYTES} bytes`);
  }
  if ('finalRecipient' in envelope) {
    if (envelope.description !== undefined && envelope.description.length > 256) {
      throw new Error('Envelope description exceeds 256 characters');
    }
    if (!/^0x[0-9a-f]{64}$/.test(envelope.secret)) throw new Error('Final recipient envelope must have secret');
    if (envelope.description !== undefined && typeof envelope.description !== 'string') {
      throw new Error('Final recipient envelope description must be string');
    }
    if (envelope.startedAtMs !== undefined) {
      if (!Number.isFinite(envelope.startedAtMs) || envelope.startedAtMs <= 0) {
        throw new Error('Final recipient envelope startedAtMs must be positive number');
      }
    }
  } else {
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
    if ('secret' in envelope) {
      throw new Error('Intermediary envelope must not have secret (privacy leak!)');
    }
  }
  return true;
}
