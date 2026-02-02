/**
 * HTLC Payment Handler (Entity-level)
 * Creates conditional payment with hashlock, routes through network
 *
 * Pattern: Exactly like directPayment but creates htlc_lock instead of direct_payment
 * Reference: entity-tx/apply.ts:302-437 (directPayment handler)
 */

import type { EntityState, EntityInput, AccountTx, Env } from '../../types';
import { cloneEntityState, canonicalAccountKey } from '../../state-helpers';
import { generateHashlock, generateLockId, calculateHopTimelock, calculateHopRevealHeight, hashHtlcSecret } from '../../htlc-utils';
import { HTLC } from '../../constants';

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

  // Calculate timelocks and reveal heights (Alice gets most time)
  const totalHops = route.length - 1; // Minus sender
  const hopIndex = 0; // We're always hop 0 (sender) in this handler
  const minExpiryMs = totalHops * HTLC.MIN_TIMELOCK_DELTA_MS + HTLC.MIN_FORWARD_TIMELOCK_MS;
  // Use much longer expiry for test scenarios (100+ frames × 100ms = 10s+ elapsed)
  const expiryMs = Math.max(120_000, minExpiryMs);
  const baseTimelock = BigInt(env.timestamp + expiryMs);
  // Add safety buffer for long-running test scenarios (prevent immediate expiry)
  const baseHeight = (newState.lastFinalizedJHeight || 0) + 50;

  const timelock = calculateHopTimelock(baseTimelock, hopIndex, totalHops);
  const revealBeforeHeight = calculateHopRevealHeight(baseHeight, hopIndex, totalHops);

  // Generate deterministic lockId
  const lockId = generateLockId(hashlock, newState.height, 0, env.timestamp);

  // Store routing info (like 2024 hashlockMap)
  newState.htlcRoutes.set(hashlock, {
    hashlock,
    outboundEntity: nextHop,
    outboundLockId: lockId,
    createdTimestamp: env.timestamp
  });

  // Create encrypted onion envelope (privacy-preserving routing)
  const { createOnionEnvelopes } = await import('../../htlc-envelope-types');
  let envelope;
  try {
    // Gather public keys from route entities (for encryption)
    const entityPubKeys = new Map<string, string>();
    for (const entityId of route) {
      // Find entity replica in env
      const replica = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
      if (replica && replica[1].state.cryptoPublicKey) {
        entityPubKeys.set(entityId, replica[1].state.cryptoPublicKey);
      }
    }

    // Create envelope with encryption if keys available
    const { NobleCryptoProvider } = await import('../../crypto-noble');
    const crypto = entityPubKeys.size === route.length ? new NobleCryptoProvider() : undefined;

    envelope = await createOnionEnvelopes(route, secret, entityPubKeys, crypto);
    console.log(`🧅 ═════════════════════════════════════════════════════════════`);
    console.log(`🧅 ENVELOPE CREATED at ${formatEntityId(entityState.entityId)}`);
    console.log(`🧅 Route: ${route.map((r: string) => formatEntityId(r)).join(' → ')}`);
    console.log(`🧅 Encryption: ${crypto ? 'ENCRYPTED' : 'CLEARTEXT'}`);
    console.log(`🧅 Secret: ${secret.slice(0,16)}...`);
    console.log(`🧅 Hashlock: ${hashlock.slice(0,16)}...`);
    console.log(`🧅 Envelope structure: ${JSON.stringify(envelope, null, 2).slice(0, 300)}...`);
    console.log(`🧅 ═════════════════════════════════════════════════════════════`);
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
      amount,
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
      amount,
      hashlock,
      timelock,
      direction: 'outgoing',
      createdAt: BigInt(env.timestamp),
    });

    addMessage(newState,
      `🔒 HTLC: Locking ${amount} (token ${tokenId}) to ${formatEntityId(targetEntityId)} via ${route.length - 1} hops`
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
