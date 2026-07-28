import type {
  EntityReplica,
} from '../../types';
import type {
  CrontabExecutionContext,
  ScheduledHook,
} from '../scheduler-types';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { scheduleHook } from './hook-state';
import type { DueHookPlan } from './due-hook-types';

const crontabLog = createStructuredLogger('entity.crontab');

const retryDisputeDeadline = (
  replica: EntityReplica,
  hook: ScheduledHook & { type: 'dispute_deadline' },
  retryMs: number,
): void => {
  if (!replica.state.crontabState) return;
  scheduleHook(replica.state.crontabState, {
    id: hook.id,
    triggerAt: replica.state.timestamp + retryMs,
    type: 'dispute_deadline',
    data: { accountId: hook.data.accountId },
  });
};

export const processDisputeDeadlineHook = (
  hook: ScheduledHook & { type: 'dispute_deadline' },
  replica: EntityReplica,
  context: CrontabExecutionContext,
  currentJBlock: number,
  plan: DueHookPlan,
): void => {
  const { accountId } = hook.data;
  const account = replica.state.accounts.get(accountId);
  if (!account?.activeDispute) return;
  if (replica.state.hubRebalanceConfig?.disputeAutoFinalizeMode === 'ignore') return;
  const weAreLeft = account.leftEntity === replica.state.entityId;
  const weAreStarter = weAreLeft === account.activeDispute.startedByLeft;
  const timeoutBlock = Number(account.activeDispute.disputeTimeout || 0);
  if (account.activeDispute.observedOnChain !== true) {
    retryDisputeDeadline(replica, hook, 5000);
    crontabLog.debug('dispute.wait_onchain_start', {
      account: shortId(accountId),
      retryMs: 5000,
    });
    return;
  }
  if (weAreStarter && (!timeoutBlock || currentJBlock < timeoutBlock)) {
    retryDisputeDeadline(replica, hook, 1000);
    crontabLog.debug('dispute.retry_until_timeout', {
      account: shortId(accountId),
      currentJBlock,
      timeoutBlock,
      retryMs: 1000,
    });
    return;
  }
  const accountIdNorm = accountId.toLowerCase();
  const draft = replica.state.jBatchState?.batch?.disputeFinalizations || [];
  const sent = replica.state.jBatchState?.sentBatch?.batch?.disputeFinalizations || [];
  const draftHasFinalize = draft.some(
    entry => String(entry?.counterentity || '').toLowerCase() === accountIdNorm,
  );
  const sentHasFinalize = sent.some(
    entry => String(entry?.counterentity || '').toLowerCase() === accountIdNorm,
  );
  if (sentHasFinalize || replica.state.jBatchState?.sentBatch) {
    account.activeDispute.finalizeQueued =
      sentHasFinalize || (account.activeDispute.finalizeQueued ?? false);
    context.accountChanges.add(accountId);
    retryDisputeDeadline(replica, hook, 1000);
    crontabLog.debug('dispute.deferred_sent_batch', {
      account: shortId(accountId),
      retryMs: 1000,
    });
    return;
  }
  if (draftHasFinalize) {
    account.activeDispute.finalizeQueued = true;
    context.accountChanges.add(accountId);
    plan.shouldBroadcastQueuedDisputeFinalizations = true;
    return;
  }
  if (account.activeDispute.finalizeQueued) {
    // An abort/drop may remove the draft while leaving this local latch.
    account.activeDispute.finalizeQueued = false;
    context.accountChanges.add(accountId);
  }
  plan.disputeFinalizeCounterparties.add(accountId);
};
