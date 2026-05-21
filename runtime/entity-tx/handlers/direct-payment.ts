import { isLeftEntity } from '../../entity-id-utils';
import { FINANCIAL } from '../../constants';
import type { AccountTx, EntityInput, EntityState, EntityTx, Env } from '../../types';
import { formatEntityId } from '../../utils';
import { logError } from '../../logger';
import { cloneEntityState, addMessage } from '../../state-helpers';
import type { MempoolOp } from './account';

type DirectPaymentEntityTx = Extract<EntityTx, { type: 'directPayment' }>;

type DirectPaymentResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

export const handleDirectPaymentEntityTx = async (
  env: Env,
  entityState: EntityState,
  entityTx: DirectPaymentEntityTx,
): Promise<DirectPaymentResult> => {
  const verbose = env.quietRuntimeLogs !== true;
  env.emit('HtlcInitiated', {
    fromEntity: entityState.entityId,
    toEntity: entityTx.data.targetEntityId,
    tokenId: entityTx.data.tokenId,
    amount: entityTx.data.amount.toString(),
    route: entityTx.data.route,
  });
  if (verbose) {
    console.log(`💸 ═════════════════════════════════════════════════════════════`);
    console.log(
      `💸 DIRECT-PAYMENT HANDLER: ${entityState.entityId.slice(-4)} → ${entityTx.data.targetEntityId.slice(-4)}`,
    );
    console.log(`💸 Amount: ${entityTx.data.amount}, TokenId: ${entityTx.data.tokenId}`);
    console.log(`💸 Route: ${entityTx.data.route?.map(r => r.slice(-4)).join('→') || 'NONE (will calculate)'}`);
    console.log(`💸 Description: ${entityTx.data.description || 'none'}`);
  }

  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  if (verbose) console.log(`💸 Initialized: outputs=[], mempoolOps=[]`);

  let { targetEntityId, tokenId, amount, route, description } = entityTx.data;
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
      if (verbose) console.log(`💸 Direct account exists with ${formatEntityId(targetEntityId)}`);
      route = [entityState.entityId, targetEntityId];
    } else if (env.gossip) {
      if (verbose) console.log(`💸 No direct account, finding route to ${formatEntityId(targetEntityId)}`);
      const networkGraph = env.gossip.getNetworkGraph();
      const paths = await networkGraph.findPaths(entityState.entityId, targetEntityId, amount, tokenId);

      if (paths.length > 0) {
        const firstPath = paths[0];
        if (!firstPath) {
          throw new Error('ROUTE_DISCOVERY_INVARIANT: paths.length > 0 but paths[0] is missing');
        }
        route = firstPath.path;
        if (verbose) console.log(`💸 Found route: ${route.map(e => formatEntityId(e)).join(' → ')}`);
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
    console.error(
      `❌ ROUTE VALIDATION FAILED: route.length=${route.length}, route[0]=${route[0]?.slice(-4)}, entityId=${entityState.entityId.slice(-4)}`,
    );
    logError('ENTITY_TX', `❌ Invalid route: doesn't start with current entity`);
    return { newState: entityState, outputs: [] };
  }

  if (route[route.length - 1] !== targetEntityId) {
    console.error(
      `❌ ROUTE VALIDATION FAILED: route ends with ${route[route.length - 1]?.slice(-4)}, expected targetEntityId=${targetEntityId.slice(-4)}`,
    );
    logError('ENTITY_TX', `❌ Invalid route: route end must match targetEntityId`);
    return { newState: entityState, outputs: [] };
  }

  if (route.length === 1 && route[0] === targetEntityId) {
    console.error(`✅ FINAL DESTINATION: Entity ${entityState.entityId.slice(-4)} is the final recipient`);
    addMessage(newState, `💰 Received payment of ${amount} (token ${tokenId})`);
    return { newState, outputs: [] };
  }

  const nextHop = route[1];
  if (!nextHop) {
    console.error(`❌ ROUTE ERROR: No next hop in route=[${route.map(r => r.slice(-4)).join(',')}]`);
    logError('ENTITY_TX', `❌ Invalid route: no next hop specified in route`);
    return { newState, outputs: [] };
  }

  const accountMachine = newState.accounts.get(nextHop);
  if (!accountMachine) {
    logError('ENTITY_TX', `❌ No account with next hop: ${nextHop}`);
    addMessage(newState, `❌ Payment failed: No account with ${formatEntityId(nextHop)}`);
    return { newState, outputs: [] };
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
    },
  };

  mempoolOps.push({ accountId: nextHop, tx: accountTx });
  if (verbose) {
    console.log(`💸 QUEUED TO MEMPOOL: account=${formatEntityId(nextHop)}`);
    console.log(`💸   AccountTx type: ${accountTx.type}`);
    console.log(`💸   Amount: ${accountTx.data.amount}`);
    console.log(`💸   From: ${accountTx.data.fromEntityId?.slice(-4)}`);
    console.log(`💸   To: ${accountTx.data.toEntityId?.slice(-4)}`);
    console.log(
      `💸   Route after slice: [${accountTx.data.route?.map((r: string) => r.slice(-4)).join(',') || 'none'}]`,
    );
    console.log(`💸 mempoolOps.length: ${mempoolOps.length}`);
  }

  const isLeft = isLeftEntity(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
  if (verbose) console.log(`💸 Account state: isLeft=${isLeft}, hasPendingFrame=${!!accountMachine.pendingFrame}`);

  addMessage(
    newState,
    `💸 Sending ${amount} (token ${tokenId}) to ${formatEntityId(targetEntityId)} via ${route.length - 1} hops`,
  );

  if (verbose) {
    console.log(`💸 Payment queued for bilateral consensus with ${formatEntityId(nextHop)}`);
    console.log(`💸 Account ${formatEntityId(nextHop)} will be added to proposableAccounts`);
  }

  const firstValidator = entityState.config.validators[0];
  if (firstValidator) {
    outputs.push({
      entityId: entityState.entityId,
      signerId: firstValidator,
      entityTxs: [],
    });
    if (verbose) console.log(`💸 Added processing trigger: outputs.length=${outputs.length}`);
  }
  if (verbose) {
    console.log(`💸 DIRECT-PAYMENT COMPLETE: mempoolOps=${mempoolOps.length}, outputs=${outputs.length}`);
    console.log(`💸 ═════════════════════════════════════════════════════════════`);
  }

  return { newState, outputs, mempoolOps };
};
