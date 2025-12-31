/**
 * HTLC Payment Handler (Entity-level)
 * Creates conditional payment with hashlock, routes through network
 *
 * Pattern: Exactly like directPayment but creates htlc_lock instead of direct_payment
 * Reference: entity-tx/apply.ts:302-437 (directPayment handler)
 */

import { EntityState, EntityInput, AccountTx, Env } from '../../types';
import { cloneEntityState, canonicalAccountKey } from '../../state-helpers';
import { generateHashlock, generateLockId, calculateHopTimelock, calculateHopRevealHeight } from '../../htlc-utils';
import { HTLC } from '../../constants';

const formatEntityId = (id: string) => id.slice(-4);
const addMessage = (state: EntityState, message: string) => state.messages.push(message);
const logError = (context: string, message: string) => console.error(`[${context}] ${message}`);

export async function handleHtlcPayment(
  entityState: EntityState,
  entityTx: Extract<any, { type: 'htlcPayment' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
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

  // Extract payment details
  let { targetEntityId, tokenId, amount, route, description, secret, hashlock } = entityTx.data;

  // Generate secret/hashlock if not provided
  if (!secret || !hashlock) {
    const generated = generateHashlock();
    secret = generated.secret;
    hashlock = generated.hashlock;
    console.log(`🔒 Generated secret: ${secret.slice(0,16)}..., hash: ${hashlock.slice(0,16)}...`);
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
        const paths = networkGraph.findPaths(entityState.entityId, targetEntityId);

        if (paths.length > 0) {
          route = paths[0].path;
          console.log(`🔒 Found route: ${route.map((e: string) => formatEntityId(e)).join(' → ')}`);
        } else {
          logError("HTLC_PAYMENT", `❌ No route found to ${formatEntityId(targetEntityId)}`);
          addMessage(newState, `❌ HTLC payment failed: No route to ${formatEntityId(targetEntityId)}`);
          return { newState, outputs: [] };
        }
      } else {
        logError("HTLC_PAYMENT", `❌ Cannot find route: Gossip layer not available`);
        addMessage(newState, `❌ HTLC payment failed: Network routing unavailable`);
        return { newState, outputs: [] };
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
  const baseTimelock = BigInt(env.timestamp + HTLC.DEFAULT_EXPIRY_MS);
  const baseHeight = newState.lastFinalizedJHeight || 0;

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
      // Store cleartext routing for Phase 2 (no encryption yet)
      routingInfo: {
        nextHop: route[1],
        finalRecipient: targetEntityId,
        route: route.slice(1), // Pass along remaining route
        secret // Always include secret - intermediaries will pass it along
      }
    },
  };

  // Add to account machine mempool (use counterparty ID as key)
  const accountMachine = newState.accounts.get(nextHop);
  if (accountMachine) {
    accountMachine.mempool.push(accountTx);
    console.log(`🔒 Added HTLC lock to mempool for account with ${formatEntityId(nextHop)}`);
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

  return { newState, outputs };
}
