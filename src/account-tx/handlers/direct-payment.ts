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
      leftAllowence: 0n,
      rightAllowence: 0n,
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

  // Canonical delta: always relative to left entity (Channel.ts reference)
  let canonicalDelta: bigint;
  if (paymentFromEntity === leftEntity && paymentToEntity === rightEntity) {
    canonicalDelta = amount; // left paying right
  } else if (paymentFromEntity === rightEntity && paymentToEntity === leftEntity) {
    canonicalDelta = -amount; // right paying left
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

  const isLeftEntity = accountMachine.proofHeader.fromEntity < accountMachine.proofHeader.toEntity;

  // Check capacity using deriveDelta (perspective-aware)
  const derived = deriveDelta(delta, isLeftEntity);
  if (isOurFrame && amount > derived.outCapacity) {
    return {
      success: false,
      error: `Insufficient capacity: need ${amount.toString()}, available ${derived.outCapacity.toString()}`,
      events,
    };
  }

  // Check global credit limits for the USD-denominated token (token 2)
  const newDelta = delta.ondelta + delta.offdelta + canonicalDelta;
  if (isOurFrame && tokenId === 2 && newDelta > accountMachine.globalCreditLimits.peerLimit) {
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
  if (route && route.length > 1 && !isOutgoing) {
    // We received the payment, but it's not for us - forward to next hop
    const nextHop = route[0];
    const finalTarget = route[route.length - 1];
    if (!finalTarget) {
      console.error(`❌ Empty route in payment - invalid payment routing`);
      return { success: false, error: 'Invalid payment route', events };
    }

    if (accountMachine.counterpartyEntityId === nextHop) {
      // This is wrong - we received from the entity we should forward to
      console.error(`❌ Routing error: received from ${nextHop} but should forward to them`);
    } else {
      // Add forwarding event
      events.push(
        `↪️ Forwarding payment to ${finalTarget.slice(-4)} via ${route.length} more hops`
      );

      // Store forwarding info for entity-consensus to create next hop transaction
      accountMachine.pendingForward = {
        tokenId,
        amount,
        route: route.slice(1), // Remove current hop
        ...(description ? { description } : {}),
      };
    }
  }

  return { success: true, events };
}
