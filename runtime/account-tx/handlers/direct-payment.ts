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

  // CRITICAL: ALWAYS check capacity from SENDER's perspective FIRST
  // Determine if sender is left entity
  const senderIsLeft = paymentFromEntity === leftEntity;

  // Derive capacity from sender's perspective
  const senderDerived = deriveDelta(delta, senderIsLeft);

  // Check if sender has collateral (PUSH model) or uses peer's credit (PULL model)
  const senderHasCollateral = senderDerived.collateral > 0n;

  // Canonical delta: always relative to left entity
  // delta > 0 = RIGHT owes LEFT (RIGHT holds LEFT's collateral OR borrowed LEFT's credit)
  // delta < 0 = LEFT owes RIGHT (LEFT holds RIGHT's collateral OR borrowed RIGHT's credit)
  let canonicalDelta: bigint;

  if (paymentFromEntity !== leftEntity && paymentFromEntity !== rightEntity) {
    console.error(`❌ CONSENSUS-FAILURE: Payment entities don't match account`);
    console.error(`  Account: ${leftEntity.slice(-4)} ↔ ${rightEntity.slice(-4)}`);
    console.error(`  Payment: ${paymentFromEntity.slice(-4)} → ${paymentToEntity.slice(-4)}`);
    return {
      success: false,
      error: 'FATAL: Payment entities must match account entities (no cross-account routing)',
      events,
    };
  }

  if (senderHasCollateral) {
    // PUSH model: Sender has collateral, value moves TO receiver
    // Receiver now holds sender's collateral = receiver OWES sender
    if (senderIsLeft) {
      // LEFT sends → RIGHT holds LEFT's collateral → delta INCREASES (RIGHT owes LEFT)
      canonicalDelta = amount;
    } else {
      // RIGHT sends → LEFT holds RIGHT's collateral → delta DECREASES (LEFT owes RIGHT)
      canonicalDelta = -amount;
    }
  } else {
    // PULL model: Sender uses receiver's credit (borrows)
    // Sender now owes receiver
    if (senderIsLeft) {
      // LEFT borrows from RIGHT's credit → delta DECREASES (LEFT owes RIGHT)
      canonicalDelta = -amount;
    } else {
      // RIGHT borrows from LEFT's credit → delta INCREASES (RIGHT owes LEFT)
      canonicalDelta = amount;
    }
  }

  if (amount > senderDerived.outCapacity) {
    return {
      success: false,
      error: `Insufficient capacity for sender ${paymentFromEntity.slice(-4)}: need ${amount.toString()}, available ${senderDerived.outCapacity.toString()}`,
      events,
    };
  }

  // CRITICAL: Check collateral limits for PUSH model, credit limits for PULL model
  const newDelta = delta.ondelta + delta.offdelta + canonicalDelta;

  if (senderHasCollateral) {
    // PUSH model: Sender uses their own collateral
    // Delta direction: positive if sender is LEFT, negative if sender is RIGHT
    // Check that we don't exceed sender's collateral
    // (already checked via outCapacity above, but double-check total delta vs collateral)
    const maxCollateralDelta = senderIsLeft ? senderDerived.collateral : -senderDerived.collateral;
    const absNewDelta = newDelta < 0n ? -newDelta : newDelta;
    const absMaxDelta = maxCollateralDelta < 0n ? -maxCollateralDelta : maxCollateralDelta;
    if (absNewDelta > absMaxDelta) {
      return {
        success: false,
        error: `Exceeds collateral: ${absNewDelta.toString()} > ${absMaxDelta.toString()}`,
        events,
      };
    }
  } else {
    // PULL model: Sender borrows from peer's credit
    // Use delta-level credit limits (set via set_credit_limit from extendCredit)
    // leftCreditLimit = credit LEFT extends to RIGHT (how much RIGHT can owe LEFT)
    // rightCreditLimit = credit RIGHT extends to LEFT (how much LEFT can owe RIGHT)
    if (senderIsLeft) {
      // LEFT borrows → delta goes negative → LEFT owes RIGHT
      // Check against rightCreditLimit (RIGHT's credit extension to LEFT)
      const peerCreditLimit = delta.rightCreditLimit;
      if (-newDelta > peerCreditLimit) {
        return {
          success: false,
          error: `Exceeds credit limit from peer: ${(-newDelta).toString()} > ${peerCreditLimit.toString()}`,
          events,
        };
      }
    } else {
      // RIGHT borrows → delta goes positive → RIGHT owes LEFT
      // Check against leftCreditLimit (LEFT's credit extension to RIGHT)
      const peerCreditLimit = delta.leftCreditLimit;
      if (newDelta > peerCreditLimit) {
        return {
          success: false,
          error: `Exceeds credit limit to peer: ${newDelta.toString()} > ${peerCreditLimit.toString()}`,
          events,
        };
      }
    }
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
