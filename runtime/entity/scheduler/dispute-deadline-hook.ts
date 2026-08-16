import type {
  CrontabExecutionContext,
  EntityTransitionContext,
  ScheduledHook,
} from './types';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { getEntityAccountForWrite } from '../state/persistent-account-map';
import { scheduleHook } from './hook-state';
import type { DueHookPlan } from './due-hook-types';
import { toUnixMs, unixMsToUnixSFloor } from '../../protocol/units';

const crontabLog = createStructuredLogger('entity.crontab');

const retryDisputeDeadline = (
  replica: EntityTransitionContext,
  hook: ScheduledHook & { type: 'dispute_deadline' },
  retryMs: number,
): void => {
  if (!replica.state.crontabState) return;
  scheduleHook(replica.state.crontabState, {
    id: hook.id,
    triggerAt: toUnixMs(toUnixMs(Number(replica.state.timestamp)) + retryMs),
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
  const visible = replica.state.accounts.get(accountId);
  if (!visible?.activeDispute) return;
  if (replica.state.hubRebalanceConfig?.disputeAutoFinalizeMode === 'ignore') return;
  const weAreLeft = visible.state.leftEntity === replica.state.entityId;
  const weAreStarter = weAreLeft === visible.activeDispute.startedByLeft;
  // L1 disputeTimeout is absolute unix seconds (jurisdiction clock).
  const timeoutSec = Number(visible.activeDispute.disputeTimeout || 0);
  const nowSec = unixMsToUnixSFloor(toUnixMs(Number(replica.state.timestamp || 0)));
  if (visible.activeDispute.observedOnChain !== true) {
    retryDisputeDeadline(replica, hook, 5000);
    crontabLog.debug('dispute.wait_onchain_start', {
      account: shortId(accountId),
      retryMs: 5000,
    });
    return;
  }
  // Wait until the on-chain challenge end (seconds). Event-driven fanout
  // starts sibling legs; no sealed pull deadline and no cross-j margin.
  if (!timeoutSec || nowSec < timeoutSec) {
    const recovery = visible.activeDispute.crossJurisdictionRecovery;
    const missingRecoveryResults = recovery
      ? recovery.requiredPullIds.filter(
        (pullId) => !Object.hasOwn(recovery.resultsByPullId, pullId),
      ).length
      : 0;
    retryDisputeDeadline(replica, hook, 1000);
    crontabLog.debug('dispute.retry_until_timeout', {
      account: shortId(accountId),
      nowSec,
      timeoutSec,
      currentJBlock,
      weAreStarter,
      missingRecoveryResults,
      retryMs: 1000,
    });
    return;
  }
  const accountIdNorm = accountId.toLowerCase();
  const draft = replica.state.jBatchState?.batch?.disputeFinalizations || [];
  const sent = replica.state.jBatchState?.sentBatch?.batch?.disputeFinalizations || [];
  const recovered = (replica.state.jBatchState?.recoveryBatches ?? [])
    .flatMap(batch => batch.disputeFinalizations);
  const draftHasFinalize = draft.some(
    entry => String(entry?.counterentity || '').toLowerCase() === accountIdNorm,
  );
  const sentHasFinalize = sent.some(
    entry => String(entry?.counterentity || '').toLowerCase() === accountIdNorm,
  );
  const recoveryHasFinalize = recovered.some(
    entry => String(entry?.counterentity || '').toLowerCase() === accountIdNorm,
  );
  const account = getEntityAccountForWrite(replica.state.accounts, accountId);
  if (!account?.activeDispute) throw new Error(`DISPUTE_DEADLINE_WRITE_ACCOUNT_MISSING:${accountId}`);
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
  if (draftHasFinalize || recoveryHasFinalize) {
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
  if (plan.disputeFinalizeCounterparties.size > 0) {
    // Depository intentionally accepts one defensive finalization per batch.
    // Retain every additional same-tick deadline instead of creating one
    // unprocessable Entity output that would roll back the whole frame.
    retryDisputeDeadline(replica, hook, 1);
    crontabLog.debug('dispute.deferred_finalize_slot', {
      account: shortId(accountId),
      retryMs: 1,
    });
    return;
  }
  plan.disputeFinalizeCounterparties.add(accountId);
};
