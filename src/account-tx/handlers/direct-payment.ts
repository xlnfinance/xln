/**
 * Direct Payment Handler
 * Processes direct payment with capacity checking and multi-hop routing
 * Reference: Channel.ts DirectPayment transition (2024_src/app/Transition.ts:321-344)
 */

import { AccountMachine, AccountTx } from '../../types';
import { deriveDelta, getDefaultCreditLimit } from '../../account-utils';
import { safeStringify } from '../../serialization-utils';

export function handleDirectPayment(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'direct_payment' }>,
  isOurFrame: boolean = true
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, amount, route, description } = accountTx.data;
  const events: string[] = [];

  // Get or create delta
  let delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    const defaultCreditLimit = getDefaultCreditLimit(tokenId);
    delta = {
      tokenId,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: defaultCreditLimit,
      rightCreditLimit: defaultCreditLimit,
      leftAllowance: 0n,
      rightAllowance: 0n,
    };
    accountMachine.deltas.set(tokenId, delta);
  }

  // Determine canonical direction relative to left/right entities
  const leftEntity = accountMachine.proofHeader.fromEntity < accountMachine.proofHeader.toEntity
    ? accountMachine.proofHeader.fromEntity
    : accountMachine.proofHeader.toEntity;
  const rightEntity = leftEntity === accountMachine.proofHeader.fromEntity
    ? accountMachine.proofHeader.toEntity
    : accountMachine.proofHeader.fromEntity;

  // CRITICAL: Payment direction MUST be explicit - NO HEURISTICS (Channel.ts pattern)
  const paymentFromEntity = accountTx.data.fromEntityId;
  const paymentToEntity = accountTx.data.toEntityId;

  if (!paymentFromEntity || !paymentToEntity) {
    console.error(`❌ CONSENSUS-FAILURE: Missing explicit payment direction`);
    console.error(`  AccountTx:`, safeStringify(accountTx));
    return {
      success: false,
      error: 'FATAL: Payment must have explicit fromEntityId/toEntityId',
      events,
    };
  }

  // Canonical delta: always relative to left entity
  // CRITICAL: "Payment" = pulling value, increases receiver's allocation (they lend to you)
  // When A pays B: B's red area (lending to A) increases
  let canonicalDelta: bigint;
  if (paymentFromEntity === leftEntity && paymentToEntity === rightEntity) {
    // Left requests value from right - right lends to left - delta DECREASES
    canonicalDelta = -amount;
  } else if (paymentFromEntity === rightEntity && paymentToEntity === leftEntity) {
    // Right requests value from left - left lends to right - delta INCREASES
    canonicalDelta = amount;
  } else {
    console.error(`❌ CONSENSUS-FAILURE: Payment entities don't match account`);
    console.error(`  Account: ${leftEntity.slice(-4)} ↔ ${rightEntity.slice(-4)}`);
    console.error(`  Payment: ${paymentFromEntity.slice(-4)} → ${paymentToEntity.slice(-4)}`);
    return {
      success: false,
      error: 'FATAL: Payment entities must match account entities (no cross-account routing)',
      events,
    };
  }

  // CRITICAL: ALWAYS check capacity from SENDER's perspective (both on creation and verification)
  // Determine if sender is left entity
  const senderIsLeft = paymentFromEntity === leftEntity;

  // Derive capacity from sender's perspective
  const senderDerived = deriveDelta(delta, senderIsLeft);

  if (amount > senderDerived.outCapacity) {
    return {
      success: false,
      error: `Insufficient capacity for sender ${paymentFromEntity.slice(-4)}: need ${amount.toString()}, available ${senderDerived.outCapacity.toString()}`,
      events,
    };
  }

  // CRITICAL: ALWAYS check global credit limits (not just for our frames)
  const newDelta = delta.ondelta + delta.offdelta + canonicalDelta;
  if (tokenId === 1 && newDelta > accountMachine.globalCreditLimits.peerLimit) {
    return {
      success: false,
      error: `Exceeds global credit limit: ${newDelta.toString()} > ${accountMachine.globalCreditLimits.peerLimit.toString()}`,
      events,
    };
  }

  // Apply canonical delta (identical on both sides)
  delta.offdelta += canonicalDelta;

  // Events differ by perspective but state is identical
  if (isOurFrame) {
    events.push(`💸 Sent ${amount.toString()} token ${tokenId} to Entity ${accountMachine.counterpartyEntityId.slice(-4)} ${description ? '(' + description + ')' : ''}`);
  } else {
    events.push(`💰 Received ${amount.toString()} token ${tokenId} from Entity ${paymentFromEntity.slice(-4)} ${description ? '(' + description + ')' : ''}`);
  }

  // Update current frame
  const tokenIndex = accountMachine.currentFrame.tokenIds.indexOf(tokenId);
  const totalDelta = delta.ondelta + delta.offdelta;

  if (tokenIndex >= 0) {
    accountMachine.currentFrame.deltas[tokenIndex] = totalDelta;
  } else {
    accountMachine.currentFrame.tokenIds.push(tokenId);
    accountMachine.currentFrame.deltas.push(totalDelta);
  }

  // Check if we need to forward the payment (multi-hop routing)
  const isOutgoing = paymentFromEntity === accountMachine.proofHeader.fromEntity;
  console.log(`🔍 FORWARD-CHECK: route=${route ? `[${route.map(r => r.slice(-4)).join(',')}]` : 'null'}`);
  console.log(`🔍 FORWARD-CHECK: isOutgoing=${isOutgoing}, paymentFrom=${paymentFromEntity.slice(-4)}, proofHeader.from=${accountMachine.proofHeader.fromEntity.slice(-4)}`);

  if (route && route.length > 0 && !isOutgoing) {
    console.log(`🔍 FORWARD-CHECK: Passed first check (route.length=${route.length}, isOutgoing=${isOutgoing})`);
    // Check if we're intermediate hop: route[0] should be current entity
    const currentEntityInRoute = route[0];
    const finalTarget = route[route.length - 1];

    if (!currentEntityInRoute || !finalTarget) {
      console.error(`❌ Empty route in payment - invalid payment routing`);
      return { success: false, error: 'Invalid payment route', events };
    }

    console.log(`🔍 FORWARD-CHECK: currentInRoute=${currentEntityInRoute.slice(-4)}, proofHeader.from=${accountMachine.proofHeader.fromEntity.slice(-4)}, final=${finalTarget.slice(-4)}`);
    console.log(`🔍 FORWARD-CHECK: Check result: ${currentEntityInRoute === accountMachine.proofHeader.fromEntity && currentEntityInRoute !== finalTarget}`);

    // If we're in the route but not the final destination, forward
    if (currentEntityInRoute === accountMachine.proofHeader.fromEntity && currentEntityInRoute !== finalTarget) {
      const nextHop = route[1]; // Next entity after us

      if (!nextHop) {
        console.error(`❌ No next hop in route for forwarding`);
        return { success: false, error: 'Invalid route: no next hop', events };
      }

      if (accountMachine.counterpartyEntityId === nextHop) {
        console.error(`❌ Routing error: received from ${nextHop} but should forward to them`);
      } else {
        // Add forwarding event
        events.push(
          `↪️ Forwarding payment to ${finalTarget.slice(-4)} via ${route.length - 1} more hops`
        );

        // Store forwarding info for entity-consensus to create next hop transaction
        accountMachine.pendingForward = {
          tokenId,
          amount,
          route: route.slice(1), // Remove current entity, keep rest of route
          ...(description ? { description } : {}),
        };
      }
    }
  }

  return { success: true, events };
}
