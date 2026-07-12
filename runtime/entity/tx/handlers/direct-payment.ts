import { isLeftEntity } from '../../../entity-id-utils';
import { FINANCIAL } from '../../../constants';
import type { AccountTx, EntityInput, EntityState, EntityTx, Env } from '../../../types';
import { formatEntityId } from '../../../utils';
import { createStructuredLogger, logError, shortId } from '../../../logger';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import type { MempoolOp } from './account';
import { requireTrustedPaymentGateway } from '../../../protocol/payments/delivery';

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
): Promise<DirectPaymentResult> => {
  const trace = (message: string, fields: Record<string, unknown> = {}): void => {
    if (env.quietRuntimeLogs !== true) directPaymentLog.debug(message, fields);
  };
  env.emit('HtlcInitiated', {
    fromEntity: entityState.entityId,
    toEntity: entityTx.data.targetEntityId,
    tokenId: entityTx.data.tokenId,
    amount: entityTx.data.amount.toString(),
    route: entityTx.data.route,
  });
  trace('start', {
    from: shortId(entityState.entityId),
    target: shortId(entityTx.data.targetEntityId),
    tokenId: entityTx.data.tokenId,
    amount: entityTx.data.amount.toString(),
    route: entityTx.data.route?.map((entityId) => shortId(entityId)) ?? [],
    hasDescription: Boolean(entityTx.data.description),
  });

  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  trace('initialized');

  let { targetEntityId, tokenId, amount, route, description } = entityTx.data;
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

  if (!route || route.length === 0) {
    if (newState.accounts.has(targetEntityId)) {
      trace('route.direct_account', { target: shortId(targetEntityId) });
      route = [entityState.entityId, targetEntityId];
    } else if (env.gossip) {
      trace('route.discovery_start', { target: shortId(targetEntityId) });
      const networkGraph = env.gossip.getNetworkGraph();
      const paths = await networkGraph.findPaths(entityState.entityId, targetEntityId, amount, tokenId);

      if (paths.length > 0) {
        const firstPath = paths[0];
        if (!firstPath) {
          throw new Error('ROUTE_DISCOVERY_INVARIANT: paths.length > 0 but paths[0] is missing');
        }
        route = firstPath.path;
        trace('route.discovery_found', { route: route.map((entityId) => shortId(entityId)) });
      } else {
        logError('ENTITY_TX', `❌ No route found to ${formatEntityId(targetEntityId)}`);
        addMessage(newState, `❌ Payment failed: No route to ${formatEntityId(targetEntityId)}`);
        return { newState, outputs: [] };
      }
    } else {
      logError('ENTITY_TX', `❌ Cannot find route: Gossip layer not available`);
      addMessage(newState, `❌ Payment failed: Network routing unavailable`);
      return { newState, outputs: [] };
    }
  }

  if (route.length < 1 || route[0] !== entityState.entityId) {
    throw directPaymentInvariant(
      'ROUTE_START_INVALID',
      `entity=${entityState.entityId}:route0=${route[0] ?? ''}:target=${targetEntityId}`,
    );
  }

  if (route[route.length - 1] !== targetEntityId) {
    throw directPaymentInvariant(
      'ROUTE_END_INVALID',
      `entity=${entityState.entityId}:last=${route[route.length - 1] ?? ''}:target=${targetEntityId}`,
    );
  }

  if (deliveryMode === 'trusted') {
    requireTrustedPaymentGateway(route, targetEntityId, trustedGatewayEntityId);
  }

  if (route.length === 1 && route[0] === targetEntityId) {
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
