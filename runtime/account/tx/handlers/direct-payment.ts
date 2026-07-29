/**
 * Direct Payment Handler
 * Processes direct payment with capacity checking and multi-hop routing
 * Reference: Channel.ts DirectPayment transition (2024_src/app/Transition.ts:321-344)
 */

import type { AccountState, AccountTx } from '../../../types';
import { deriveDelta } from '../../utils';
import { deriveTransferOffdeltaChange } from '../../../protocol/delta-movement';
import { FINANCIAL } from '../../../constants';
import { isLeftEntity } from '../../../protocol/entity-id';
import { createStructuredLogger } from '../../../infra/logger';
import { getAccountPerspective } from '../../perspective';
import { ensureDelta } from '../delta-utils';

const directPaymentLog = createStructuredLogger('account.payment');

type DirectPaymentTx = Extract<AccountTx, { type: 'direct_payment' }>;
type DirectPaymentResult = { success: boolean; events: string[]; error?: string };

const validatePaymentEnvelope = (
  payment: DirectPaymentTx['data'],
  events: string[],
): DirectPaymentResult | undefined => {
  const { tokenId, amount, route, deliveryMode, trustedGatewayEntityId } = payment;
  if (amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    directPaymentLog.debug('invalid_amount', { tokenId, amount: amount.toString() });
    return {
      success: false,
      error: `Invalid payment amount: ${amount.toString()} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT.toString()}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT.toString()})`,
      events,
    };
  }
  if (route && route.length > FINANCIAL.MAX_ROUTE_HOPS) {
    directPaymentLog.debug('route_too_long', { hops: route.length, max: FINANCIAL.MAX_ROUTE_HOPS });
    return {
      success: false,
      error: `Route too long: ${route.length} hops (max ${FINANCIAL.MAX_ROUTE_HOPS})`,
      events,
    };
  }
  if (deliveryMode === 'trusted' && (!trustedGatewayEntityId || !route?.at(-1))) {
    return { success: false, error: 'Trusted payment requires a gateway and final recipient', events };
  }
  return undefined;
};

const resolvePaymentParties = (
  account: AccountState,
  payment: DirectPaymentTx['data'],
  byLeft: boolean,
  events: string[],
):
  | DirectPaymentResult
  | {
      leftEntity: string;
      paymentFromEntity: string;
      paymentToEntity: string;
    } => {
  const { fromEntity, toEntity } = account.proofHeader;
  const leftEntity = isLeftEntity(fromEntity, toEntity) ? fromEntity : toEntity;
  const rightEntity = leftEntity === fromEntity ? toEntity : fromEntity;
  const paymentFromEntity = byLeft ? leftEntity : rightEntity;
  const paymentToEntity = byLeft ? rightEntity : leftEntity;
  // The certified frame proposer is the payer. Wire-level entity ids are only
  // assertions; treating them as authority would let a signer spend its peer's
  // capacity by naming the opposite direction inside the transaction.
  const assertedFrom = payment.fromEntityId?.toLowerCase();
  const assertedTo = payment.toEntityId?.toLowerCase();
  if (
    (assertedFrom && assertedFrom !== paymentFromEntity.toLowerCase()) ||
    (assertedTo && assertedTo !== paymentToEntity.toLowerCase())
  ) {
    return {
      success: false,
      error: 'FATAL: Payment direction must match the frame proposer',
      events,
    };
  }
  return { leftEntity, paymentFromEntity, paymentToEntity };
};

const appendPaymentEvent = (
  account: AccountState,
  payment: DirectPaymentTx['data'],
  parties: { leftEntity: string; paymentFromEntity: string },
  byLeft: boolean,
  events: string[],
): string => {
  const { amount, tokenId, description } = payment;
  const { counterparty } = getAccountPerspective(account, account.proofHeader.fromEntity);
  const isOurFrame = byLeft === (account.proofHeader.fromEntity === parties.leftEntity);
  events.push(
    isOurFrame
      ? `💸 Sent ${amount.toString()} token ${tokenId} to Entity ${counterparty.slice(-4)} ${description ? `(${description})` : ''}`
      : `💰 Received ${amount.toString()} token ${tokenId} from Entity ${parties.paymentFromEntity.slice(-4)} ${description ? `(${description})` : ''}`,
  );
  return counterparty;
};

const queuePaymentForward = (
  account: AccountState,
  payment: DirectPaymentTx['data'],
  paymentFromEntity: string,
  counterparty: string,
  events: string[],
): DirectPaymentResult | undefined => {
  const { route, tokenId, amount, description, deliveryMode, trustedGatewayEntityId } = payment;
  const isOutgoing = paymentFromEntity === account.proofHeader.fromEntity;
  if (!route?.length || isOutgoing) return undefined;

  const [currentEntityInRoute, nextHop] = route;
  const finalTarget = route.at(-1);
  if (!currentEntityInRoute || !finalTarget) {
    directPaymentLog.debug('empty_route', { routeLength: route.length });
    return { success: false, error: 'Invalid payment route', events };
  }
  if (currentEntityInRoute !== account.proofHeader.fromEntity || currentEntityInRoute === finalTarget) {
    return undefined;
  }
  if (!nextHop) {
    directPaymentLog.debug('missing_next_hop', { routeLength: route.length });
    return { success: false, error: 'Invalid route: no next hop', events };
  }
  if (counterparty === nextHop) {
    directPaymentLog.debug('routing_loop', { nextHop: nextHop.slice(-4), counterparty: counterparty.slice(-4) });
    return undefined;
  }

  events.push(`↪️ Forwarding payment to ${finalTarget.slice(-4)} via ${route.length - 1} more hops`);
  const pendingForwards = account.pendingForwards ?? [];
  pendingForwards.push({
    tokenId,
    amount,
    route: [...route],
    ...(description ? { description } : {}),
    ...(deliveryMode ? { deliveryMode } : {}),
    ...(trustedGatewayEntityId ? { trustedGatewayEntityId } : {}),
  });
  account.pendingForwards = pendingForwards;
  return undefined;
};

export function handleDirectPayment(
  account: AccountState,
  accountTx: DirectPaymentTx,
  byLeft: boolean,
): DirectPaymentResult {
  const { tokenId, amount } = accountTx.data;
  const events: string[] = [];
  const envelopeError = validatePaymentEnvelope(accountTx.data, events);
  if (envelopeError) return envelopeError;
  const parties = resolvePaymentParties(account, accountTx.data, byLeft, events);
  if ('success' in parties) return parties;
  const delta = ensureDelta(account, tokenId);
  const senderIsLeft = parties.paymentFromEntity === parties.leftEntity;
  const senderDerived = deriveDelta(delta, senderIsLeft);
  if (amount > senderDerived.outCapacity) {
    return {
      success: false,
      error: `Insufficient capacity for sender ${parties.paymentFromEntity.slice(-4)}: need ${amount.toString()}, available ${senderDerived.outCapacity.toString()}`,
      events,
    };
  }
  delta.offdelta += deriveTransferOffdeltaChange(senderIsLeft, amount);
  const counterparty = appendPaymentEvent(account, accountTx.data, parties, byLeft, events);
  const forwardingError = queuePaymentForward(account, accountTx.data, parties.paymentFromEntity, counterparty, events);
  if (forwardingError) return forwardingError;
  return { success: true, events };
}
