import { FINANCIAL } from '../../../constants';
import type {
  AccountTx,
  EntityCandidateEffect,
  EntityInput,
  EntityState,
  EntityTx,
  RuntimeState,
} from '../../../types';
import { formatEntityId } from '../../../utils';
import { createStructuredLogger, logError, shortId } from '../../../infra/logger';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import type { MempoolOp } from './account';
import { requireTrustedPaymentGateway } from '../../../protocol/payments/delivery';
import { requireCommittedDirectPaymentRoute } from '../../../protocol/payments/route';

type DirectPaymentEntityTx = Extract<EntityTx, { type: 'directPayment' }>;
type DirectPaymentAccountTx = Extract<AccountTx, { type: 'direct_payment' }>;

type DirectPaymentResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

const directPaymentInvariant = (code: string, detail: string): Error =>
  new Error(`DIRECT_PAYMENT_${code}:${detail}`);

const directPaymentLog = createStructuredLogger('entity.payment');

type PaymentTrace = (message: string, fields?: Record<string, unknown>) => void;

const createPaymentTrace = (env: RuntimeState): PaymentTrace =>
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
  if (deliveryMode && deliveryMode !== 'trusted') {
    throw directPaymentInvariant('DELIVERY_MODE_INVALID', String(deliveryMode));
  }
  if (amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    logError(
      'ENTITY_TX',
      `❌ Payment amount out of bounds: ${amount.toString()} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT.toString()}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT.toString()})`,
    );
    addMessage(state, '❌ Payment failed: amount out of bounds');
    return { newState: state, outputs };
  }
  if (deliveryMode === 'trusted') {
    requireTrustedPaymentGateway(route, targetEntityId, trustedGatewayEntityId);
  }
  return undefined;
};

const emitPaymentInitiated = (
  effects: EntityCandidateEffect[],
  fromEntity: string,
  tx: DirectPaymentEntityTx,
  route: string[],
): void => {
  effects.push({
    kind: 'runtimeEvent',
    eventName: 'HtlcInitiated',
    data: {
      fromEntity,
      toEntity: tx.data.targetEntityId,
      tokenId: tx.data.tokenId,
      amount: tx.data.amount.toString(),
      route,
    },
  });
};

const finishReceivedPayment = (
  state: EntityState,
  tx: DirectPaymentEntityTx,
  route: string[],
  effects: EntityCandidateEffect[],
  trace: PaymentTrace,
): DirectPaymentResult | undefined => {
  if (route.length !== 1 || route[0] !== tx.data.targetEntityId) return undefined;
  emitPaymentInitiated(effects, state.entityId, tx, route);
  trace('final_destination', {
    entity: shortId(state.entityId),
    tokenId: tx.data.tokenId,
    amount: tx.data.amount.toString(),
  });
  addMessage(state, `💰 Received payment of ${tx.data.amount} (token ${tx.data.tokenId})`);
  return { newState: state, outputs: [] };
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
        description: description || `Payment to ${formatEntityId(targetEntityId)}`,
        fromEntityId: state.entityId,
        toEntityId: nextHop,
        ...(deliveryMode ? { deliveryMode } : {}),
        ...(trustedGatewayEntityId ? { trustedGatewayEntityId } : {}),
      },
    },
  };
};

export const handleDirectPaymentEntityTx = async (
  env: RuntimeState,
  entityState: EntityState,
  entityTx: DirectPaymentEntityTx,
  candidateEffects: EntityCandidateEffect[] = [],
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
    route: route.map((entityId) => shortId(entityId)),
    hasDescription: Boolean(entityTx.data.description),
  });

  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  const validationError = validateEntityPayment(newState, entityTx, route, []);
  if (validationError) return validationError;
  const received = finishReceivedPayment(newState, entityTx, route, candidateEffects, trace);
  if (received) return received;
  const { nextHop, accountTx } = buildNextHopPayment(newState, entityTx, route);
  mempoolOps.push({ accountId: nextHop, tx: accountTx });
  trace('mempool.queued', {
    account: shortId(nextHop),
    tx: accountTx.type,
    amount: entityTx.data.amount.toString(),
    from: shortId(accountTx.data.fromEntityId),
    to: shortId(accountTx.data.toEntityId),
    route: accountTx.data.route?.map((entityId: string) => shortId(entityId)) ?? [],
    mempoolOps: mempoolOps.length,
  });

  addMessage(
    newState,
    `💸 Sending ${entityTx.data.amount} (token ${entityTx.data.tokenId}) to ${formatEntityId(entityTx.data.targetEntityId)} via ${route.length - 1} hops`,
  );
  emitPaymentInitiated(candidateEffects, entityState.entityId, entityTx, route);

  const firstValidator = entityState.config.validators[0];
  if (firstValidator) {
    outputs.push({
      entityId: entityState.entityId,
      signerId: firstValidator,
      entityTxs: [],
    });
  }

  return { newState, outputs, mempoolOps };
};
