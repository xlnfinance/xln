/**
 * Direct Payment Handler
 * Processes one bilateral payment leg and, only for trusted delivery, queues
 * the gateway's single committed forward to the final recipient.
 * Reference: Channel.ts DirectPayment transition (2024_src/app/Transition.ts:321-344)
 */

import type { AccountReplica, AccountTx } from '../../../../types/account';
import { deriveDelta } from '../../../utils';
import { deriveTransferOffdeltaChange } from '../../../../protocol/delta-movement';
import { FINANCIAL } from '../../../../config/constants';
import { isLeftEntity } from '../../../../protocol/entity-id';
import { createStructuredLogger } from '../../../../infra/logger';
import { getAccountPerspective } from '../../../state/perspective';
import { ensureDelta } from '../../delta-utils';

const directPaymentLog = createStructuredLogger('account.payment');

type DirectPaymentTx = Extract<AccountTx, { type: 'direct_payment' }>;
type DirectPaymentResult = { success: boolean; events: string[]; error?: string };
type PendingPaymentForward = NonNullable<AccountReplica['pendingForwards']>[number];

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
  if (route.length === 0 || route.length > FINANCIAL.MAX_ROUTE_HOPS) {
    directPaymentLog.debug('route_too_long', { hops: route.length, max: FINANCIAL.MAX_ROUTE_HOPS });
    return {
      success: false,
      error: `Route too long: ${route.length} hops (max ${FINANCIAL.MAX_ROUTE_HOPS})`,
      events,
    };
  }
  if (deliveryMode !== 'direct' && deliveryMode !== 'trusted') {
    return { success: false, error: 'Payment delivery mode must be direct or trusted', events };
  }
  if (deliveryMode === 'direct' && trustedGatewayEntityId !== undefined) {
    return { success: false, error: 'Direct payment forbids a trusted gateway', events };
  }
  if (deliveryMode === 'trusted' && !trustedGatewayEntityId) {
    return { success: false, error: 'Trusted payment requires one declared gateway', events };
  }
  return undefined;
};

const resolvePaymentParties = (
  account: AccountReplica,
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

const sameEntity = (left: string | undefined, right: string): boolean =>
  String(left || '').toLowerCase() === right.toLowerCase();

const validatePaymentRoute = (
  payment: DirectPaymentTx['data'],
  parties: { paymentFromEntity: string; paymentToEntity: string },
  events: string[],
): DirectPaymentResult | undefined => {
  const { deliveryMode, route, trustedGatewayEntityId } = payment;
  if (deliveryMode === 'direct') {
    return route.length === 1 && sameEntity(route[0], parties.paymentToEntity)
      ? undefined
      : { success: false, error: 'Direct payment route must contain only the bilateral recipient', events };
  }

  const gateway = String(trustedGatewayEntityId).toLowerCase();
  const from = parties.paymentFromEntity.toLowerCase();
  const to = parties.paymentToEntity.toLowerCase();
  if (from === gateway) {
    return route.length === 1 && sameEntity(route[0], parties.paymentToEntity)
      ? undefined
      : { success: false, error: 'Trusted gateway final leg must contain only the recipient', events };
  }
  const finalTarget = String(route[1] || '').toLowerCase();
  if (
    to === gateway
    && route.length === 2
    && sameEntity(route[0], parties.paymentToEntity)
    && finalTarget !== ''
    && finalTarget !== gateway
    && finalTarget !== from
  ) {
    return undefined;
  }
  return { success: false, error: 'Trusted payment must be source → declared gateway → recipient', events };
};

const appendPaymentEvent = (
  account: AccountReplica,
  payment: DirectPaymentTx['data'],
  parties: { leftEntity: string; paymentFromEntity: string },
  byLeft: boolean,
  counterparty: string,
  events: string[],
): void => {
  const { amount, tokenId, description } = payment;
  const isOurFrame = byLeft === (account.proofHeader.fromEntity === parties.leftEntity);
  events.push(
    isOurFrame
      ? `💸 Sent ${amount.toString()} token ${tokenId} to Entity ${counterparty.slice(-4)} ${description ? `(${description})` : ''}`
      : `💰 Received ${amount.toString()} token ${tokenId} from Entity ${parties.paymentFromEntity.slice(-4)} ${description ? `(${description})` : ''}`,
  );
};

const buildPaymentForward = (
  account: AccountReplica,
  payment: DirectPaymentTx['data'],
  paymentFromEntity: string,
  counterparty: string,
): PendingPaymentForward | undefined => {
  const { route, tokenId, amount, description, trustedGatewayEntityId } = payment;
  const isOutgoing = sameEntity(paymentFromEntity, account.proofHeader.fromEntity);
  if (isOutgoing || route.length === 1) return undefined;

  const [currentEntityInRoute, nextHop] = route;
  const finalTarget = route.at(-1);
  if (!currentEntityInRoute || !nextHop || !finalTarget || !trustedGatewayEntityId) {
    throw new Error('TRUSTED_PAYMENT_FORWARD_CONTEXT_MISSING');
  }
  if (!sameEntity(currentEntityInRoute, account.proofHeader.fromEntity) || sameEntity(currentEntityInRoute, finalTarget)) {
    throw new Error('TRUSTED_PAYMENT_FORWARD_GATEWAY_MISMATCH');
  }
  if (sameEntity(counterparty, nextHop)) {
    throw new Error('TRUSTED_PAYMENT_FORWARD_LOOP');
  }
  return {
    tokenId,
    amount,
    route: [...route],
    ...(description ? { description } : {}),
    deliveryMode: 'trusted',
    trustedGatewayEntityId,
  };
};

export function handleDirectPayment(
  account: AccountReplica,
  accountTx: DirectPaymentTx,
  byLeft: boolean,
): DirectPaymentResult {
  const { tokenId, amount } = accountTx.data;
  const events: string[] = [];
  const envelopeError = validatePaymentEnvelope(accountTx.data, events);
  if (envelopeError) return envelopeError;
  const parties = resolvePaymentParties(account, accountTx.data, byLeft, events);
  if ('success' in parties) return parties;
  const routeError = validatePaymentRoute(accountTx.data, parties, events);
  if (routeError) return routeError;
  const { counterparty } = getAccountPerspective(account.state, account.proofHeader.fromEntity);
  const forward = buildPaymentForward(account, accountTx.data, parties.paymentFromEntity, counterparty);
  const delta = ensureDelta(account.state, tokenId);
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
  appendPaymentEvent(account, accountTx.data, parties, byLeft, counterparty, events);
  if (forward) {
    events.push(`↪️ Forwarding payment to ${forward.route.at(-1)!.slice(-4)} via ${forward.route.length - 1} more hops`);
    account.pendingForwards = [...(account.pendingForwards ?? []), forward];
  }
  return { success: true, events };
}
