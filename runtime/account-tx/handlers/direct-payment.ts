/**
 * Direct Payment Handler
 * Processes direct payment with capacity checking and multi-hop routing
 * Reference: Channel.ts DirectPayment transition (2024_src/app/Transition.ts:321-344)
 */

import type { AccountMachine, AccountTx } from '../../types';
import { deriveDelta } from '../../account-utils';
import { FINANCIAL } from '../../constants';
import { isLeftEntity } from '../../entity-id-utils';
import { createStructuredLogger, shortId } from '../../logger';
import { getAccountPerspective } from '../../state-helpers';
import { decodeRebalancePolicyMemo } from '../../rebalance-policy';
import { ensureDelta } from '../delta-utils';

const directPaymentLog = createStructuredLogger('account.payment');

export function handleDirectPayment(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'direct_payment' }>,
  byLeft: boolean
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, amount, route, description } = accountTx.data;
  const events: string[] = [];

  if (amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    const error = `Invalid payment amount: ${amount.toString()} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT.toString()}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT.toString()})`;
    directPaymentLog.debug('invalid_amount', { tokenId, amount: amount.toString() });
    return { success: false, error, events };
  }

  // H18 FIX: Validate route length to prevent DOS via excessive hops
  if (route && route.length > FINANCIAL.MAX_ROUTE_HOPS) {
    const error = `Route too long: ${route.length} hops (max ${FINANCIAL.MAX_ROUTE_HOPS})`;
    directPaymentLog.debug('route_too_long', { hops: route.length, max: FINANCIAL.MAX_ROUTE_HOPS });
    return { success: false, error, events };
  }

  const delta = ensureDelta(accountMachine, tokenId);

  // Determine canonical direction relative to left/right entities
  const leftEntity = isLeftEntity(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity)
    ? accountMachine.proofHeader.fromEntity
    : accountMachine.proofHeader.toEntity;
  const rightEntity = leftEntity === accountMachine.proofHeader.fromEntity
    ? accountMachine.proofHeader.toEntity
    : accountMachine.proofHeader.fromEntity;

  // CRITICAL: Payment direction MUST be explicit - NO HEURISTICS (Channel.ts pattern)
  const paymentFromEntity = accountTx.data.fromEntityId;
  const paymentToEntity = accountTx.data.toEntityId;

  if (!paymentFromEntity || !paymentToEntity) {
    directPaymentLog.debug('missing_direction', { tokenId, amount: amount.toString() });
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

  // Canonical delta: always relative to left entity
  // delta > 0 = RIGHT owes LEFT (RIGHT holds LEFT's collateral OR borrowed LEFT's credit)
  // delta < 0 = LEFT owes RIGHT (LEFT holds RIGHT's collateral OR borrowed RIGHT's credit)
  let canonicalDelta: bigint;

  if (paymentFromEntity !== leftEntity && paymentFromEntity !== rightEntity) {
    directPaymentLog.debug('entity_mismatch', {
      accountLeft: shortId(leftEntity),
      accountRight: shortId(rightEntity),
      from: shortId(paymentFromEntity),
      to: shortId(paymentToEntity),
    });
    return {
      success: false,
      error: 'FATAL: Payment entities must match account entities (no cross-account routing)',
      events,
    };
  }

  // CANONICAL DELTA: Always moves TOWARD the payer (decreases their capacity)
  // LEFT pays → delta DECREASES (negative)
  // RIGHT pays → delta INCREASES (positive)
  if (senderIsLeft) {
    // LEFT sends → delta DECREASES (LEFT's outCapacity goes down)
    canonicalDelta = -amount;
  } else {
    // RIGHT sends → delta INCREASES (RIGHT's outCapacity goes down)
    canonicalDelta = amount;
  }

  if (amount > senderDerived.outCapacity) {
    return {
      success: false,
      error: `Insufficient capacity for sender ${paymentFromEntity.slice(-4)}: need ${amount.toString()}, available ${senderDerived.outCapacity.toString()}`,
      events,
    };
  }

  // Apply canonical delta (identical on both sides)
  delta.offdelta += canonicalDelta;

  const memoPolicy = decodeRebalancePolicyMemo(description);
  if (memoPolicy) {
    const existingPolicy = accountMachine.counterpartyRebalanceFeePolicy;
    if (!existingPolicy || memoPolicy.policyVersion >= existingPolicy.policyVersion) {
      accountMachine.counterpartyRebalanceFeePolicy = {
        policyVersion: memoPolicy.policyVersion,
        baseFee: memoPolicy.baseFee,
        liquidityFeeBps: memoPolicy.liquidityFeeBps,
        gasFee: memoPolicy.gasFee,
        updatedAt: accountMachine.currentFrame.timestamp || 0,
      };
      events.push(
        `📣 Hub policy update observed: v${memoPolicy.policyVersion} ` +
        `(base=${memoPolicy.baseFee},liqBps=${memoPolicy.liquidityFeeBps},gas=${memoPolicy.gasFee},reason=${memoPolicy.reason})`,
      );
    }

    // Clear local pending request when hub refunds prepaid fee.
    // Refund path is unilateral on hub side; requester must clear after refund payment commits.
    if (memoPolicy.reason === 'policy_mismatch' || memoPolicy.reason === 'timeout' || memoPolicy.reason === 'fee_too_low') {
      const candidates: Array<{
        requestTokenId: number;
        requestedAt: number;
        feePaidUpfront: bigint;
      }> = [];
      for (const [requestTokenId, feeState] of accountMachine.requestedRebalanceFeeState?.entries() || []) {
        const pendingRequestedAmount = accountMachine.requestedRebalance.get(requestTokenId) ?? 0n;
        if (pendingRequestedAmount <= 0n) continue;
        if (feeState.feeTokenId !== tokenId) continue;
        // Refund must come from counterparty to requester.
        if (senderIsLeft === feeState.requestedByLeft) continue;
        candidates.push({
          requestTokenId,
          requestedAt: feeState.requestedAt || 0,
          feePaidUpfront: feeState.feePaidUpfront || 0n,
        });
      }
      candidates.sort((a, b) => (a.requestedAt === b.requestedAt ? a.requestTokenId - b.requestTokenId : a.requestedAt - b.requestedAt));
      const match = candidates.find(c => c.feePaidUpfront <= 0n || amount <= c.feePaidUpfront) ?? candidates[0];
      if (match) {
        accountMachine.requestedRebalance.delete(match.requestTokenId);
        accountMachine.requestedRebalanceFeeState?.delete(match.requestTokenId);
        events.push(
          `↩️ Rebalance request cleared after hub refund (${memoPolicy.reason}, token=${match.requestTokenId}, amount=${amount})`,
        );
      }
    }
  }

  // Events differ by perspective but state is identical (derive from byLeft)
  const { counterparty: cpForEvent } = getAccountPerspective(accountMachine, accountMachine.proofHeader.fromEntity);
  const iAmLeft = accountMachine.proofHeader.fromEntity === leftEntity;
  const isOurFrame = (byLeft === iAmLeft);
  if (isOurFrame) {
    events.push(`💸 Sent ${amount.toString()} token ${tokenId} to Entity ${cpForEvent.slice(-4)} ${description ? '(' + description + ')' : ''}`);
  } else {
    events.push(`💰 Received ${amount.toString()} token ${tokenId} from Entity ${paymentFromEntity.slice(-4)} ${description ? '(' + description + ')' : ''}`);
  }

  // Update current frame
  const tokenIndex = accountMachine.currentFrame.deltas.findIndex((entry) => entry.tokenId === tokenId);

  if (tokenIndex >= 0) {
    accountMachine.currentFrame.deltas[tokenIndex] = { ...delta };
  } else {
    accountMachine.currentFrame.deltas.push({ ...delta });
  }
  accountMachine.currentFrame.deltas.sort((left, right) => left.tokenId - right.tokenId);

  // Check if we need to forward the payment (multi-hop routing)
  const isOutgoing = paymentFromEntity === accountMachine.proofHeader.fromEntity;

  if (route && route.length > 0 && !isOutgoing) {
    // Check if we're intermediate hop: route[0] should be current entity
    const currentEntityInRoute = route[0];
    const finalTarget = route[route.length - 1];

    if (!currentEntityInRoute || !finalTarget) {
      directPaymentLog.debug('empty_route', { routeLength: route.length });
      return { success: false, error: 'Invalid payment route', events };
    }

    // If we're in the route but not the final destination, forward
    if (currentEntityInRoute === accountMachine.proofHeader.fromEntity && currentEntityInRoute !== finalTarget) {
      const nextHop = route[1]; // Next entity after us

      if (!nextHop) {
        directPaymentLog.debug('missing_next_hop', { routeLength: route.length });
        return { success: false, error: 'Invalid route: no next hop', events };
      }

      if (cpForEvent === nextHop) {
        directPaymentLog.debug('routing_loop', { nextHop: shortId(nextHop), counterparty: shortId(cpForEvent) });
      } else {
        // Add forwarding event
        events.push(
          `↪️ Forwarding payment to ${finalTarget.slice(-4)} via ${route.length - 1} more hops`
        );

        // Store forwarding info for entity-consensus to create next hop transaction
        // NOTE: Route already sliced by entity-tx/apply (sender removed)
        // So route[0] = current entity, route[1] = next hop
        accountMachine.pendingForward = {
          tokenId,
          amount,
          route: [...route], // Copy to prevent mutation
          ...(description ? { description } : {}),
        };
      }
    }
  }

  return { success: true, events };
}
