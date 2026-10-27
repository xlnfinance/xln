import { deriveDelta } from '../../../../account/utils';
import { UINT256_MAX } from '../../../../protocol/boundary/integer-ranges';
import { FINANCIAL } from '../../../../config/constants';
import type { AccountTx } from '../../../../types/account';
import type { EntityCandidateEffect, EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import { createStructuredLogger, logError, shortId } from '../../../../support/logger';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import type { AccountTxTarget } from '../account';
import { requireTrustedPaymentGateway } from '../../../../protocol/payments/delivery';
import { requireCommittedDirectPaymentRoute } from '../../../../protocol/payments/route';
import { rejectFailure } from '../../../../protocol/errors/failure-taxonomy';

type DirectPaymentEntityTx = Extract<EntityTx, { type: 'directPayment' }>;
type DirectPaymentAccountTx = Extract<AccountTx, { type: 'direct_payment' }>;

type DirectPaymentResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
};

const directPaymentInvariant = (code: string, detail: string): Error =>
  rejectFailure(`DIRECT_PAYMENT_${code}`, `DIRECT_PAYMENT_${code}:${detail}`);

const directPaymentLog = createStructuredLogger('entity.payment');

type PaymentTrace = (message: string, fields?: Record<string, unknown>) => void;

const createPaymentTrace =
  (env: EntityRuntimeContext): PaymentTrace =>
  (message, fields = {}) => {
    if (env.quietRuntimeLogs !== true) directPaymentLog.debug(message, fields);
  };

const validateEntityPayment = (
  state: EntityState,
  tx: DirectPaymentEntityTx,
  route: string[],
  outputs: EntityInput[],
): DirectPaymentResult | undefined => {
  const { amount, deliveryMode, targetEntityId, trustedGatewayEntityId } = tx.data;
  if (deliveryMode !== 'direct' && deliveryMode !== 'trusted') {
    throw directPaymentInvariant('DELIVERY_MODE_INVALID', String(deliveryMode));
  }
  if (amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > UINT256_MAX) {
    logError(
      'ENTITY_TX',
      `❌ Payment amount out of bounds: ${amount.toString()} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT.toString()}, max ${UINT256_MAX.toString()})`,
    );
    addMessage(state, '❌ Payment failed: amount out of bounds');
    return { newState: state, outputs };
  }
  if (deliveryMode === 'trusted') {
    requireTrustedPaymentGateway(route, targetEntityId, trustedGatewayEntityId);
  } else if (trustedGatewayEntityId !== undefined) {
    throw directPaymentInvariant('DIRECT_GATEWAY_FORBIDDEN', trustedGatewayEntityId);
  } else if (route.length !== 2) {
    throw directPaymentInvariant('ROUTE_MUST_BE_BILATERAL', route.join(','));
  }
  return undefined;
};

const buildNextHopPayment = (
  state: EntityState,
  tx: DirectPaymentEntityTx,
  route: string[],
): { nextHop: string; accountTx: DirectPaymentAccountTx } => {
  const nextHop = route[1];
  if (!nextHop) {
    throw directPaymentInvariant(
      'NEXT_HOP_MISSING',
      `entity=${state.entityId}:target=${tx.data.targetEntityId}:route=${route.join(',')}`,
    );
  }
  if (!state.accounts.has(nextHop)) {
    throw directPaymentInvariant(
      'NEXT_HOP_ACCOUNT_MISSING',
      `entity=${state.entityId}:nextHop=${nextHop}:target=${tx.data.targetEntityId}`,
    );
  }
  const { targetEntityId, tokenId, amount, description, deliveryMode, trustedGatewayEntityId } = tx.data;
  return {
    nextHop,
    accountTx: {
      type: 'direct_payment',
      data: {
        tokenId,
        amount,
        route: route.slice(1),
        description: description || `Payment to ${targetEntityId}`,
        fromEntityId: state.entityId,
        toEntityId: nextHop,
        deliveryMode,
        ...(trustedGatewayEntityId ? { trustedGatewayEntityId } : {}),
      },
    },
  };
};

export const handleDirectPaymentEntityTx = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: DirectPaymentEntityTx,
  candidateEffects: EntityCandidateEffect[] = [],
  mutableFrameState = false,
): Promise<DirectPaymentResult> => {
  const trace = createPaymentTrace(env);
  const route = requireCommittedDirectPaymentRoute({
    sourceEntityId: entityState.entityId,
    targetEntityId: entityTx.data.targetEntityId,
    route: entityTx.data.route,
  });
  trace('start', {
    from: shortId(entityState.entityId),
    target: shortId(entityTx.data.targetEntityId),
    tokenId: entityTx.data.tokenId,
    amount: entityTx.data.amount.toString(),
    route: route.map(entityId => shortId(entityId)),
    hasDescription: Boolean(entityTx.data.description),
  });

  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  const validationError = validateEntityPayment(newState, entityTx, route, []);
  if (validationError) return validationError;
  const { nextHop, accountTx } = buildNextHopPayment(newState, entityTx, route);
  const account = newState.accounts.get(nextHop);
  if (!account) throw directPaymentInvariant('NEXT_HOP_ACCOUNT_MISSING', nextHop);
  const delta = account.state.deltas.get(entityTx.data.tokenId);
  const isLeft = account.state.leftEntity.toLowerCase() === newState.entityId.toLowerCase();
  if (!delta || deriveDelta(delta, isLeft).outCapacity < entityTx.data.amount) {
    candidateEffects.push({ kind: 'runtimeEvent', eventName: 'PaymentFailed', data: {
      entityId: newState.entityId, targetEntityId: entityTx.data.targetEntityId,
      tokenId: entityTx.data.tokenId, amount: entityTx.data.amount, reason: 'insufficient_capacity',
    } });
    return { newState, outputs, accountTxs };
  }
  accountTxs.push({ accountId: nextHop, tx: accountTx });
  trace('mempool.queued', {
    account: shortId(nextHop),
    tx: accountTx.type,
    amount: entityTx.data.amount.toString(),
    from: shortId(accountTx.data.fromEntityId),
    to: shortId(accountTx.data.toEntityId),
    route: accountTx.data.route?.map((entityId: string) => shortId(entityId)) ?? [],
    accountTxs: accountTxs.length,
  });

  addMessage(
    newState,
    `💸 Sending ${entityTx.data.amount} (token ${entityTx.data.tokenId}) to ${entityTx.data.targetEntityId} via ${route.length - 1} hops`,
  );
  const firstValidator = entityState.config.validators[0];
  if (firstValidator) {
    outputs.push({
      entityId: entityState.entityId,
      signerId: firstValidator,
      entityTxs: [],
    });
  }

  return { newState, outputs, accountTxs };
};
