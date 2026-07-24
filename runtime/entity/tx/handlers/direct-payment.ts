import { isLeftEntity } from '../../id';
import { FINANCIAL } from '../../../constants';
import type {
  AccountTx,
  EntityCandidateEffect,
  EntityInput,
  EntityState,
  EntityTx,
  Env,
} from '../../../types';
import { formatEntityId } from '../../../utils';
import { createStructuredLogger, logError, shortId } from '../../../infra/logger';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import type { MempoolOp } from './account';
import { requireTrustedPaymentGateway } from '../../../protocol/payments/delivery';
import { requireCommittedDirectPaymentRoute } from '../../../protocol/payments/route';

type DirectPaymentEntityTx = Extract<EntityTx, { type: 'directPayment' }>;

type DirectPaymentResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

const directPaymentInvariant = (code: string, detail: string): Error =>
  new Error(`DIRECT_PAYMENT_${code}:${detail}`);

const directPaymentLog = createStructuredLogger('entity.payment');

export const handleDirectPaymentEntityTx = async (
  env: Env,
  entityState: EntityState,
  entityTx: DirectPaymentEntityTx,
  candidateEffects: EntityCandidateEffect[] = [],
): Promise<DirectPaymentResult> => {
  const trace = (message: string, fields: Record<string, unknown> = {}): void => {
    if (env.quietRuntimeLogs !== true) directPaymentLog.debug(message, fields);
  };
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
  trace('initialized');

  const { targetEntityId, tokenId, amount, description } = entityTx.data;
  const deliveryMode = entityTx.data.deliveryMode;
  const trustedGatewayEntityId = entityTx.data.trustedGatewayEntityId;
  if (deliveryMode && deliveryMode !== 'trusted') {
    throw directPaymentInvariant('DELIVERY_MODE_INVALID', String(deliveryMode));
  }
  if (amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    logError(
      'ENTITY_TX',
      `❌ Payment amount out of bounds: ${amount.toString()} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT.toString()}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT.toString()})`,
    );
    addMessage(newState, `❌ Payment failed: amount out of bounds`);
    return { newState, outputs: [] };
  }

  if (deliveryMode === 'trusted') {
    requireTrustedPaymentGateway(route, targetEntityId, trustedGatewayEntityId);
  }

  if (route.length === 1 && route[0] === targetEntityId) {
    candidateEffects.push({
      kind: 'runtimeEvent',
      eventName: 'HtlcInitiated',
      data: {
        fromEntity: entityState.entityId,
        toEntity: targetEntityId,
        tokenId,
        amount: amount.toString(),
        route,
      },
    });
    trace('final_destination', { entity: shortId(entityState.entityId), tokenId, amount: amount.toString() });
    addMessage(newState, `💰 Received payment of ${amount} (token ${tokenId})`);
    return { newState, outputs: [] };
  }

  const nextHop = route[1];
  if (!nextHop) {
    throw directPaymentInvariant(
      'NEXT_HOP_MISSING',
      `entity=${entityState.entityId}:target=${targetEntityId}:route=${route.join(',')}`,
    );
  }

  const accountMachine = newState.accounts.get(nextHop);
  if (!accountMachine) {
    throw directPaymentInvariant(
      'NEXT_HOP_ACCOUNT_MISSING',
      `entity=${entityState.entityId}:nextHop=${nextHop}:target=${targetEntityId}`,
    );
  }

  const accountTx: AccountTx = {
    type: 'direct_payment',
    data: {
      tokenId,
      amount,
      route: route.slice(1),
      description: description || `Payment to ${formatEntityId(targetEntityId)}`,
      fromEntityId: entityState.entityId,
      toEntityId: nextHop,
      ...(deliveryMode ? { deliveryMode } : {}),
      ...(trustedGatewayEntityId ? { trustedGatewayEntityId } : {}),
    },
  };

  mempoolOps.push({ accountId: nextHop, tx: accountTx });
  trace('mempool.queued', {
    account: shortId(nextHop),
    tx: accountTx.type,
    amount: accountTx.data.amount.toString(),
    from: shortId(accountTx.data.fromEntityId),
    to: shortId(accountTx.data.toEntityId),
    route: accountTx.data.route?.map((entityId: string) => shortId(entityId)) ?? [],
    mempoolOps: mempoolOps.length,
  });

  const isLeft = isLeftEntity(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
  trace('account.state', { isLeft, hasPendingFrame: Boolean(accountMachine.pendingFrame) });

  addMessage(
    newState,
    `💸 Sending ${amount} (token ${tokenId}) to ${formatEntityId(targetEntityId)} via ${route.length - 1} hops`,
  );
  candidateEffects.push({
    kind: 'runtimeEvent',
    eventName: 'HtlcInitiated',
    data: {
      fromEntity: entityState.entityId,
      toEntity: targetEntityId,
      tokenId,
      amount: amount.toString(),
      route,
    },
  });

  trace('bilateral.queued', { nextHop: shortId(nextHop) });

  const firstValidator = entityState.config.validators[0];
  if (firstValidator) {
    outputs.push({
      entityId: entityState.entityId,
      signerId: firstValidator,
      entityTxs: [],
    });
    trace('processing_trigger.added', { outputs: outputs.length });
  }
  trace('complete', { mempoolOps: mempoolOps.length, outputs: outputs.length });

  return { newState, outputs, mempoolOps };
};
