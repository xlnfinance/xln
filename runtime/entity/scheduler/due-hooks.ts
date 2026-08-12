import type { EntityInput } from '../types';
import type { EntityRuntimeContext } from '../runtime-context';
import type {
  CrontabExecutionContext,
  EntityTransitionContext,
  ScheduledHook,
} from './types';
import { getEntityCertifiedJurisdictionHeight } from '../../jurisdiction/machine/height';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import { terminateHtlcRoute } from '../tx/htlc-route-lifecycle';
import { createDueHookPlan, type DueHookPlan } from './due-hook-types';
import { processDisputeDeadlineHook } from './dispute-deadline-hook';
import { processBoardResealHook } from './board-reseal-hook';

const crontabLog = createStructuredLogger('entity.crontab');

const processSecretAckTimeout = (
  hook: Extract<ScheduledHook, { type: 'htlc_secret_ack_timeout' }>,
  replica: EntityTransitionContext,
  plan: DueHookPlan,
): void => {
  const { hashlock, counterpartyEntityId, inboundLockId } = hook.data;
  const route = replica.state.htlcRoutes.get(hashlock);
  if (!route?.secretAckPending) return;
  const account = replica.state.accounts.get(counterpartyEntityId);
  if (!account) return;
  if (inboundLockId && !account.state.locks?.has(inboundLockId)) {
    terminateHtlcRoute(replica.state, hashlock, replica.state.timestamp);
    return;
  }
  if (account.activeDispute) return;
  plan.disputePrepareCounterparties.add(counterpartyEntityId);
  crontabLog.warn('htlc_secret_ack_timeout', {
    counterparty: shortId(counterpartyEntityId),
    hashlock: shortHash(hashlock),
  });
};

const processDueHook = (
  env: EntityRuntimeContext,
  hook: ScheduledHook,
  replica: EntityTransitionContext,
  context: CrontabExecutionContext,
  plan: DueHookPlan,
  firstValidator: string,
  currentJBlock: number,
): void => {
  crontabLog.debug('hook.fired', { type: hook.type, id: shortHash(hook.id) });
  switch (hook.type) {
    case 'htlc_timeout': {
      const account = replica.state.accounts.get(hook.data.accountId);
      if (account?.state.locks?.has(hook.data.lockId)) {
        plan.htlcTimeoutLocks.push(hook.data);
      }
      return;
    }
    case 'dispute_deadline':
      processDisputeDeadlineHook(hook, replica, context, currentJBlock, plan);
      return;
    case 'htlc_secret_ack_timeout':
      processSecretAckTimeout(hook, replica, plan);
      return;
    case 'settlement_window':
    case 'watchdog':
      crontabLog.debug('hook.unimplemented', { type: hook.type });
      return;
    case 'hub_rebalance_kick': {
      const task = replica.state.crontabState?.tasks?.get('hubRebalance');
      if (task) {
        task.lastRun = 0;
        crontabLog.debug('hub_rebalance.kick');
      }
      return;
    }
    case 'board_reseal':
      processBoardResealHook(env, hook, replica, context, plan);
      return;
    case 'cross_j_orderbook_sweep':
      plan.outputs.push({
        entityId: replica.entityId,
        signerId: firstValidator,
        entityTxs: [{
          type: 'orderbookSweepCrossJurisdiction',
          data: { reason: String(hook.data.reason || 'cross-j-orderbook-sweep') },
        }],
      });
      return;
  }
};

const appendBatchedHookOutputs = (
  replica: EntityTransitionContext,
  context: CrontabExecutionContext,
  plan: DueHookPlan,
  firstValidator: string,
): void => {
  if (plan.htlcTimeoutLocks.length > 0) {
    plan.outputs.push({
      entityId: replica.entityId,
      signerId: firstValidator,
      entityTxs: [{
        type: 'processHtlcTimeouts',
        data: { expiredLocks: plan.htlcTimeoutLocks },
      }],
    });
    crontabLog.debug('htlc_timeout.queued', {
      locks: plan.htlcTimeoutLocks.length,
    });
  }
  if (plan.disputePrepareCounterparties.size > 0) {
    plan.outputs.push({
      entityId: replica.entityId,
      signerId: firstValidator,
      entityTxs: [...plan.disputePrepareCounterparties].map(counterpartyEntityId => ({
        type: 'prepareDispute',
        data: {
          counterpartyEntityId,
          description: 'auto-prepare-dispute-after-secret-ack-timeout',
        },
      })),
    });
    crontabLog.debug('dispute_prepare.queued', {
      accounts: plan.disputePrepareCounterparties.size,
    });
  }
  if (plan.disputeFinalizeCounterparties.size > 0) {
    plan.outputs.push({
      entityId: replica.entityId,
      signerId: firstValidator,
      entityTxs: [
        ...[...plan.disputeFinalizeCounterparties].map(counterpartyEntityId => ({
          type: 'disputeFinalize' as const,
          data: {
            counterpartyEntityId,
            description: 'auto-finalize-after-timeout',
            useOnchainRegistry: true,
          },
        })),
        { type: 'j_broadcast', data: {} },
      ],
    });
    crontabLog.debug('dispute_finalize.queued', {
      accounts: plan.disputeFinalizeCounterparties.size,
    });
    return;
  }
  if (
    plan.shouldBroadcastQueuedDisputeFinalizations &&
    !context.manualBroadcastInInput
  ) {
    plan.outputs.push({
      entityId: replica.entityId,
      signerId: firstValidator,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    });
    crontabLog.debug('j_broadcast.queued_for_drafted_finalize');
  }
};

export const processDueHooks = (
  env: EntityRuntimeContext,
  hooks: ScheduledHook[],
  replica: EntityTransitionContext,
  context: CrontabExecutionContext,
): EntityInput[] => {
  const firstValidator = replica.state.config.validators?.[0];
  if (!firstValidator) return [];
  const plan = createDueHookPlan();
  const currentJBlock = getEntityCertifiedJurisdictionHeight(replica.state);
  for (const hook of hooks) {
    processDueHook(
      env,
      hook,
      replica,
      context,
      plan,
      firstValidator,
      currentJBlock,
    );
  }
  appendBatchedHookOutputs(replica, context, plan, firstValidator);
  return plan.outputs;
};
