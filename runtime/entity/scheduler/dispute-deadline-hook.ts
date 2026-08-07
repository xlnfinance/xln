import type {
  CrontabExecutionContext,
  EntityTransitionContext,
  ScheduledHook,
} from '../scheduler-types';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { scheduleHook } from './hook-state';
import type { DueHookPlan } from './due-hook-types';

const crontabLog = createStructuredLogger('entity.crontab');

const retryDisputeDeadline = (
  replica: EntityTransitionContext,
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
  replica: EntityTransitionContext,
  context: CrontabExecutionContext,
  currentJBlock: number,
  plan: DueHookPlan,
): void => {
  const { accountId } = hook.data;
  const account = replica.state.accounts.get(accountId);
  if (!account?.activeDispute) return;
  if (replica.state.hubRebalanceConfig?.disputeAutoFinalizeMode === 'ignore') return;
  const weAreLeft = account.state.leftEntity === replica.state.entityId;
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
  const recovery = account.activeDispute.crossJurisdictionRecovery;
  if (recovery) {
    // Mirror of the on-chain barrier in DeltaTransformer.applyPull: a dispute
    // with a live pull reveal window cannot finalize anyway, so wait out the
    // window (retrying doubles as the port watch). Once it closes, finalize
    // regardless of missing ports — a registration that never landed reads 0
    // on-chain, and that is the deadline's truth, not a runtime stall.
    const resolveBy = Number(recovery.resolveByTimestamp ?? 0);
    const now = Number(replica.state.timestamp || 0);
    if (resolveBy > 0 && now <= resolveBy) {
      const missingRecoveryResults = recovery.requiredPullIds.filter(
        (pullId) => !Object.hasOwn(recovery.resultsByPullId, pullId),
      ).length;
      retryDisputeDeadline(replica, hook, Math.min(5000, Math.max(250, resolveBy - now + 250)));
      crontabLog.debug('dispute.wait_cross_j_reveal_window', {
        account: shortId(accountId),
        missing: missingRecoveryResults,
        resolveInMs: resolveBy - now,
      });
      return;
    }
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
