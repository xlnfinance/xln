/**
 * HTLC Payment Handler (Entity-level)
 * Creates conditional payment with hashlock, routes through network
 *
 * Pattern: Exactly like directPayment but creates htlc_lock instead of direct_payment
 * Reference: entity-tx/apply.ts:302-437 (directPayment handler)
 */

import type { EntityState, EntityInput, AccountTx, Env } from '../../types';
import type { Profile } from '../../networking/gossip';
import { cloneEntityState, canonicalAccountKey } from '../../state-helpers';
import { generateHashlock, generateLockId, calculateHopTimelock, calculateHopRevealHeight, hashHtlcSecret } from '../../htlc-utils';
import { calculateRequiredInboundForDesiredForward } from '../../htlc-utils';
import { HTLC } from '../../constants';
import { calculateDirectionalFeePPM, sanitizeBaseFee, sanitizeFeePPM } from '../../routing/fees';
import { getTokenCapacity } from '../../routing/capacity';
import { deriveDelta } from '../../account-utils';

const formatEntityId = (id: string) => id.slice(-4);
const addMessage = (state: EntityState, message: string) => state.messages.push(message);
const logError = (context: string, message: string) => console.error(`[${context}] ${message}`);

export async function handleHtlcPayment(
  entityState: EntityState,
  entityTx: Extract<any, { type: 'htlcPayment' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[]; mempoolOps?: Array<{ accountId: string; tx: any }> }> {
  console.log(`🔒 HTLC-PAYMENT HANDLER: ${entityState.entityId.slice(-4)} → ${entityTx.data.targetEntityId.slice(-4)}`);
  console.log(`   Amount: ${entityTx.data.amount}, Route: ${entityTx.data.route?.map((r: string) => r.slice(-4)).join('→') || 'none'}`);

  // Emit HTLC initiation event
  env.emit('HtlcPaymentInitiated', {
    fromEntity: entityState.entityId,
    toEntity: entityTx.data.targetEntityId,
    tokenId: entityTx.data.tokenId,
    amount: entityTx.data.amount.toString(),
    route: entityTx.data.route,
  });

  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: Array<{ accountId: string; tx: any }> = [];

  // Extract payment details
  let { targetEntityId, tokenId, amount, route, description, secret, hashlock } = entityTx.data;
  const desiredRecipientAmount = amount;

  // Validate secret/hashlock - MUST be provided in tx (determinism requirement)
  if (!secret && !hashlock) {
    // CRITICAL: Cannot generate in consensus - would cause validator divergence!
    logError("HTLC_PAYMENT", `❌ secret/hashlock REQUIRED in tx.data (determinism)`);
    addMessage(newState, `❌ HTLC payment failed: secret/hashlock must be provided`);
    return { newState, outputs: [], mempoolOps: [] };
  } else if (secret && !hashlock) {
    try {
      hashlock = hashHtlcSecret(secret);
      console.log(`🔒 Derived hashlock from provided secret: ${hashlock.slice(0,16)}...`);
    } catch (error) {
      logError("HTLC_PAYMENT", `❌ Invalid secret format: ${error instanceof Error ? error.message : String(error)}`);
      addMessage(newState, `❌ HTLC payment failed: invalid secret`);
      return { newState, outputs: [], mempoolOps: [] };
    }
  } else if (!secret && hashlock) {
    logError("HTLC_PAYMENT", `❌ Provided hashlock without secret`);
    addMessage(newState, `❌ HTLC payment failed: missing secret`);
    return { newState, outputs: [], mempoolOps: [] };
  } else if (secret && hashlock) {
    try {
      const computed = hashHtlcSecret(secret);
      if (computed !== hashlock) {
        logError("HTLC_PAYMENT", `❌ Secret/hashlock mismatch: computed ${computed.slice(0,16)}..., expected ${hashlock.slice(0,16)}...`);
        addMessage(newState, `❌ HTLC payment failed: secret/hash mismatch`);
        return { newState, outputs: [], mempoolOps: [] };
      }
    } catch (error) {
      logError("HTLC_PAYMENT", `❌ Invalid secret format: ${error instanceof Error ? error.message : String(error)}`);
      addMessage(newState, `❌ HTLC payment failed: invalid secret`);
      return { newState, outputs: [], mempoolOps: [] };
    }
  }

  // If no route provided, check for direct account or calculate route
  if (!route || route.length === 0) {
    // Account keyed by counterparty ID (no canonical helper needed)
    if (newState.accounts.has(targetEntityId)) {
      console.log(`🔒 Direct account exists with ${formatEntityId(targetEntityId)}`);
      route = [entityState.entityId, targetEntityId];
    } else {
      // Find route through network using gossip
      if (env.gossip) {
        const networkGraph = env.gossip.getNetworkGraph();
        const paths = await networkGraph.findPaths(entityState.entityId, targetEntityId, amount, tokenId);

        if (paths.length > 0) {
          route = paths[0].path;
          console.log(`🔒 Found route: ${route.map((e: string) => formatEntityId(e)).join(' → ')}`);
        } else {
          logError("HTLC_PAYMENT", `❌ No route found to ${formatEntityId(targetEntityId)}`);
          addMessage(newState, `❌ HTLC payment failed: No route to ${formatEntityId(targetEntityId)}`);
          return { newState, outputs: [], mempoolOps: [] };
        }
      } else {
        logError("HTLC_PAYMENT", `❌ Cannot find route: Gossip layer not available`);
        addMessage(newState, `❌ HTLC payment failed: Network routing unavailable`);
        return { newState, outputs: [], mempoolOps: [] };
      }
    }
  }

  // Validate route starts with current entity
  if (route.length < 1 || route[0] !== entityState.entityId) {
    logError("HTLC_PAYMENT", `❌ Invalid route: doesn't start with current entity`);
    return { newState: entityState, outputs: [] };
  }

  // Validate route ends with targetEntityId
  if (route[route.length - 1] !== targetEntityId) {
    logError("HTLC_PAYMENT", `❌ Invalid route: end doesn't match targetEntityId`);
    return { newState: entityState, outputs: [] };
  }

  // Check if we're the final destination
  if (route.length === 1 && route[0] === targetEntityId) {
    addMessage(newState, `💰 Received HTLC payment of ${amount} (token ${tokenId})`);
    return { newState, outputs: [] };
  }

  // Determine next hop
  const nextHop = route[1];
  if (!nextHop) {
    logError("HTLC_PAYMENT", `❌ Invalid route: no next hop`);
    return { newState, outputs: [] };
  }

  // Check if we have an account with next hop
  // Accounts keyed by counterparty ID (simpler than canonical)
  if (!newState.accounts.has(nextHop)) {
    logError("HTLC_PAYMENT", `❌ No account with next hop: ${nextHop.slice(-4)}`);
    addMessage(newState, `❌ HTLC payment failed: No account with ${formatEntityId(nextHop)}`);
    return { newState, outputs: [] };
  }

  const preparedSenderLockRaw = entityTx.data.preparedSenderLockAmount;
  const preparedEnvelopeRaw = entityTx.data.preparedEnvelope;
  let senderLockAmount: bigint | null = null;
  let totalFee: bigint | null = null;
  const hopForwardAmounts = new Map<string, bigint>();

  // Recipient-exact semantics:
  // tx.data.amount is what final recipient should receive.
  // Compute sender lock amount by inverting per-intermediary fee schedule.
  // On replay, prefer persisted prepared payload to avoid non-deterministic
  // re-encryption and route-dependent drift.
  const feeConfigForHop = (
    fromEntityId: string,
    toEntityId: string,
    tokId: number
  ): { feePpm: number; baseFee: bigint } => {
    const fromNorm = String(fromEntityId || '').toLowerCase();
    const toNorm = String(toEntityId || '').toLowerCase();
    const profile = (env.gossip?.getProfiles?.() as Profile[] | undefined)
      ?.find((p) => String(p?.entityId || '').toLowerCase() === fromNorm);
    const basePpm = sanitizeFeePPM(profile?.metadata?.routingFeePPM ?? 10, 10);
    const baseFee = sanitizeBaseFee(profile?.metadata?.baseFee ?? 0n);

    const account = Array.isArray(profile?.accounts)
      ? profile.accounts.find((a) => String(a?.counterpartyId || '').toLowerCase() === toNorm)
      : null;
    const tokenCap = getTokenCapacity(account?.tokenCapacities, tokId);
    const outCap = tokenCap?.outCapacity ?? 0n;
    const inCap = tokenCap?.inCapacity ?? 0n;
    const feePpm = calculateDirectionalFeePPM(basePpm, outCap, inCap);
    return { feePpm, baseFee };
  };
  if (preparedSenderLockRaw !== undefined && preparedEnvelopeRaw !== undefined) {
    try {
      senderLockAmount = typeof preparedSenderLockRaw === 'bigint'
        ? preparedSenderLockRaw
        : BigInt(String(preparedSenderLockRaw));
      totalFee = senderLockAmount - desiredRecipientAmount;
      if (senderLockAmount <= 0n || totalFee < 0n) {
        throw new Error(`invalid prepared amounts senderLock=${senderLockAmount} totalFee=${totalFee}`);
      }
      console.log(
        `🔒 HTLC using prepared payload: recipient=${desiredRecipientAmount}, senderLock=${senderLockAmount}, totalFee=${totalFee}`
      );
    } catch (error) {
      logError('HTLC_PAYMENT', `❌ Invalid prepared sender lock amount: ${error instanceof Error ? error.message : String(error)}`);
      addMessage(newState, '❌ HTLC payment failed: invalid prepared payload');
      return { newState, outputs: [], mempoolOps: [] };
    }
  } else {
    senderLockAmount = desiredRecipientAmount;
    for (let i = route.length - 2; i >= 1; i -= 1) {
      const intermediary = route[i]!;
      const nextHop = route[i + 1]!;
      const { feePpm, baseFee } = feeConfigForHop(intermediary, nextHop, tokenId);
      const forwardAmount = senderLockAmount;
      hopForwardAmounts.set(intermediary, forwardAmount);
      senderLockAmount = calculateRequiredInboundForDesiredForward(forwardAmount, feePpm, baseFee);
    }
    if (senderLockAmount < desiredRecipientAmount) {
      logError('HTLC_PAYMENT', '❌ Sender lock amount underflow after fee inversion');
      addMessage(newState, '❌ HTLC payment failed: fee inversion underflow');
      return { newState, outputs: [], mempoolOps: [] };
    }
    totalFee = senderLockAmount - desiredRecipientAmount;
    console.log(`🔒 HTLC recipient-exact quote: recipient=${desiredRecipientAmount}, senderLock=${senderLockAmount}, totalFee=${totalFee}`);
  }

  // Fail-fast sender-side capacity gate:
  // reject overspend before queuing any account mempool operation.
  const nextHopDelta = newState.accounts.get(nextHop)?.deltas?.get(tokenId);
  if (!nextHopDelta) {
    logError("HTLC_PAYMENT", `❌ No delta state for next hop ${formatEntityId(nextHop)} token ${tokenId}`);
    addMessage(newState, `❌ HTLC payment failed: missing account state`);
    return { newState, outputs: [], mempoolOps: [] };
  }
  const senderIsLeftOnNextAccount = newState.accounts.get(nextHop)?.leftEntity === entityState.entityId;
  const nextHopCapacity = deriveDelta(nextHopDelta, senderIsLeftOnNextAccount).outCapacity;
  if (senderLockAmount > nextHopCapacity) {
    logError(
      "HTLC_PAYMENT",
      `❌ Insufficient outbound capacity to ${formatEntityId(nextHop)}: required=${senderLockAmount} available=${nextHopCapacity}`
    );
    addMessage(newState, `❌ HTLC payment failed: insufficient capacity`);
    return { newState, outputs: [], mempoolOps: [] };
  }

  // Calculate timelocks and reveal heights (Alice gets most time)
  const totalHops = route.length - 1; // Minus sender
  const hopIndex = 0; // We're always hop 0 (sender) in this handler
  const minExpiryMs = totalHops * HTLC.MIN_TIMELOCK_DELTA_MS + HTLC.MIN_FORWARD_TIMELOCK_MS;
  // Use much longer expiry for test scenarios (100+ frames × 100ms = 10s+ elapsed)
  const expiryMs = Math.max(120_000, minExpiryMs);
  const baseTimelock = BigInt(newState.timestamp + expiryMs);
  // Add safety buffer for long-running test scenarios (prevent immediate expiry)
  const baseHeight = (newState.lastFinalizedJHeight || 0) + 50;

  const timelock = calculateHopTimelock(baseTimelock, hopIndex, totalHops);
  const revealBeforeHeight = calculateHopRevealHeight(baseHeight, hopIndex, totalHops);

  // Generate deterministic lockId
  const lockId = generateLockId(hashlock, newState.height, 0, newState.timestamp);

  // Store routing info (like 2024 hashlockMap)
  newState.htlcRoutes.set(hashlock, {
    hashlock,
    outboundEntity: nextHop,
    outboundLockId: lockId,
    createdTimestamp: newState.timestamp
  });

  // Create encrypted onion envelope (privacy-preserving routing)
  let envelope;
  if (preparedEnvelopeRaw !== undefined) {
    envelope = preparedEnvelopeRaw;
  } else try {
    const { createOnionEnvelopes } = await import('../../htlc-envelope-types');
    const normalizeX25519Hex = (raw: unknown): string | null => {
      if (typeof raw !== 'string') return null;
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
      return /^0x[0-9a-fA-F]{64}$/.test(prefixed) ? prefixed.toLowerCase() : null;
    };
    const normalizeX25519Base64 = (raw: unknown): string | null => {
      if (typeof raw !== 'string') return null;
      const trimmed = raw.trim();
      if (!trimmed) return null;
      // Strict base64 gate to avoid decoding arbitrary hex/signature strings.
      if (trimmed.length % 4 !== 0) return null;
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
      try {
        const bytes = typeof atob === 'function'
          ? Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0))
          : new Uint8Array(Buffer.from(trimmed, 'base64'));
        return bytes.length === 32 ? trimmed : null;
      } catch {
        return null;
      }
    };
    type ResolvedKey = { key: string; source: string };
    const resolveEntityEncryptionKey = (entityId: string): ResolvedKey | null => {
      // Prefer gossip-advertised key first: it is the network source-of-truth for remote delivery.
      // Local mirrored replicas can be stale/mixed across runtime switches.
      if (env.gossip) {
        const profiles = typeof env.gossip.getProfiles === 'function' ? env.gossip.getProfiles() : [];
        const matches = profiles.filter((p: any) => p?.entityId === entityId);
        for (const profile of matches) {
          const candidates: Array<{ value: unknown; source: string }> = [
            { value: profile?.metadata?.cryptoPublicKey, source: 'gossip.metadata.cryptoPublicKey' },
          ];
          for (const candidate of candidates) {
            const key = normalizeX25519Hex(candidate.value) ?? normalizeX25519Base64(candidate.value);
            if (key) return { key, source: candidate.source };
          }
        }
      }

      // Fallback: local replica key for same-rt scenarios or when gossip is stale.
      const replica = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
      const localCandidates: Array<{ value: unknown; source: string }> = [
        { value: replica?.[1]?.state?.cryptoPublicKey, source: 'localReplica.state.cryptoPublicKey' },
      ];
      for (const candidate of localCandidates) {
        const key = normalizeX25519Hex(candidate.value) ?? normalizeX25519Base64(candidate.value);
        if (key) return { key, source: candidate.source };
      }

      return null;
    };

    // Gather public keys for each HOP (all route entities EXCEPT sender at [0])
    // Sender never encrypts to self — only to intermediaries and recipient
    const entityPubKeys = new Map<string, string>();
    const keySources = new Map<string, string>();
    const hops = route.slice(1); // Everyone except sender
    const missingKeys: string[] = [];
    for (const entityId of hops) {
      const resolved = resolveEntityEncryptionKey(entityId);
      if (resolved) {
        entityPubKeys.set(entityId, resolved.key);
        keySources.set(entityId, resolved.source);
        continue;
      }
      missingKeys.push(entityId);
    }

    const { NobleCryptoProvider } = await import('../../crypto-noble');
    if (missingKeys.length > 0) {
      const missingList = missingKeys.map(e => formatEntityId(e)).join(', ');
      const availableList = [...entityPubKeys.keys()].map(e => formatEntityId(e)).join(', ');
      const msg = `❌ HTLC rejected: missing encryption keys for route hops [${missingList}]`;
      logError("HTLC_PAYMENT", `${msg} route=${route.map(formatEntityId).join('→')} available=[${availableList}]`);
      addMessage(newState, `${msg}. Refresh gossip and retry.`);
      console.warn(`⚠️ HTLC: Available keys: ${availableList}`);
      return { newState, outputs: [], mempoolOps: [] };
    }
    const keyDebug = hops.map((entityId) => {
      const key = entityPubKeys.get(entityId) || '';
      const isHex = /^0x[0-9a-f]{64}$/i.test(key);
      const source = keySources.get(entityId) || 'unknown';
      return `${formatEntityId(entityId)}:${isHex ? 'hex32' : 'b64'}:len=${key.length}:src=${source}`;
    }).join(' | ');
    console.log(`🧅 HTLC-KEYS: ${keyDebug}`);
    const crypto = new NobleCryptoProvider();

    envelope = await createOnionEnvelopes(route, secret, entityPubKeys, crypto, hopForwardAmounts);
    console.log(`🧅 ENVELOPE: ${crypto ? 'ENCRYPTED' : 'CLEARTEXT'} | hops=${hops.length} keys=${entityPubKeys.size} missing=[${missingKeys.map(e => formatEntityId(e))}]`);

    // Persist deterministic payload for WAL replay.
    entityTx.data.preparedEnvelope = envelope;
    entityTx.data.preparedSenderLockAmount = senderLockAmount.toString();
    entityTx.data.preparedTotalFee = totalFee.toString();
  } catch (e) {
    logError("HTLC_PAYMENT", `❌ Envelope creation failed: ${e instanceof Error ? e.message : String(e)}`);
    addMessage(newState, `❌ HTLC payment failed: Invalid route`);
    return { newState, outputs: [], mempoolOps: [] };
  }

  // Create htlc_lock AccountTx
  const accountTx: AccountTx = {
    type: 'htlc_lock',
    data: {
      lockId,
      hashlock,
      timelock,
      revealBeforeHeight,
      amount: senderLockAmount,
      tokenId,
      envelope  // Onion envelope (cleartext JSON in Phase 2)
    },
  };

  // Queue mempool operation (entity-consensus will apply + mark account proposable)
  const accountMachine = newState.accounts.get(nextHop);
  if (accountMachine) {
    mempoolOps.push({ accountId: nextHop, tx: accountTx });
    console.log(`🔒 Queued HTLC lock for mempool (account ${formatEntityId(nextHop)})`);
    console.log(`🔒 Lock ID: ${lockId.slice(0,16)}..., expires block ${revealBeforeHeight}`);

    // Add to lockBook (E-Machine aggregated view)
    newState.lockBook.set(lockId, {
      lockId,
      accountId: nextHop, // Use counterparty ID as key (simpler than canonical)
      tokenId,
      amount: senderLockAmount,
      hashlock,
      timelock,
      direction: 'outgoing',
      createdAt: BigInt(newState.timestamp),
    });

    addMessage(newState,
      `🔒 HTLC: Recipient ${desiredRecipientAmount}, sender lock ${senderLockAmount} (fee ${totalFee}) to ${formatEntityId(targetEntityId)} via ${route.length - 1} hops`
    );

    // Trigger processing
    const firstValidator = entityState.config.validators[0];
    if (firstValidator) {
      outputs.push({
        entityId: entityState.entityId,
        signerId: firstValidator,
        entityTxs: []
      });
    }
  }

  return { newState, outputs, mempoolOps };
}
