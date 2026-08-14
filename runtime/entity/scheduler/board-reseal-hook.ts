import type {
  EntityRuntimeContext,
} from '../runtime-context';
import type {
  CrontabExecutionContext,
  EntityTransitionContext,
  ScheduledHook,
} from './types';
import { getCertifiedBoardNodeStore } from '../../jurisdiction/machine/board-registry';
import {
  accountBoardResealEvidenceChanged,
  applyBoardRotationResealMigrations,
  accountNeedsBoardResealForActivation,
  BOARD_RESEAL_HOOK_ID,
  BOARD_RESEAL_RETRY_MS,
  buildPendingBoardRotationResealDrafts,
} from '../tx/state-effects/board-rotation-reseal';
import { scheduleHook } from './hook-state';
import type { DueHookPlan } from './due-hook-types';

export const processBoardResealHook = (
  env: EntityRuntimeContext,
  hook: ScheduledHook & { type: 'board_reseal' },
  replica: EntityTransitionContext,
  context: CrontabExecutionContext,
  plan: DueHookPlan,
): void => {
  if (!context.hashesToSign) throw new Error('BOARD_RESEAL_HASH_COLLECTOR_MISSING');
  const activation = {
    entityId: replica.state.entityId.toLowerCase(),
    jHeight: hook.data.activationJHeight,
    logIndex: hook.data.activationLogIndex,
  };
  const drafts = buildPendingBoardRotationResealDrafts(
    replica.state,
    getCertifiedBoardNodeStore(env),
    activation,
    hook.data.afterCounterpartyId,
  );
  applyBoardRotationResealMigrations(replica.state, drafts.accountMigrations);
  plan.outputs.push(...drafts.outputs);
  context.hashesToSign.push(...drafts.hashesToSign);
  for (const update of drafts.accountMigrations) {
    context.accountChanges.add(update.counterpartyId);
  }
  if (!drafts.hasMore && !drafts.retryRequired) return;
  if (!replica.state.crontabState) throw new Error('BOARD_RESEAL_CRONTAB_MISSING');
  scheduleHook(replica.state.crontabState, {
    id: BOARD_RESEAL_HOOK_ID,
    triggerAt: drafts.hasMore
      ? replica.state.timestamp
      : replica.state.timestamp + BOARD_RESEAL_RETRY_MS,
    type: 'board_reseal',
    data: {
      activationJHeight: activation.jHeight,
      activationLogIndex: activation.logIndex,
      afterCounterpartyId: drafts.hasMore ? drafts.nextAfterCounterpartyId : '',
    },
  });
};

/** Re-arm the latest board reseal only when a changed Account outgrows its issued frame. */
export const scheduleChangedAccountBoardReseals = (
  state: EntityTransitionContext['state'],
  previousEvidence: ReadonlyMap<
    string,
    ReadonlyArray<string | number | bigint | boolean | undefined>
  >,
  changedAccountIds: ReadonlySet<string>,
): void => {
  let activation: { jHeight: number; logIndex: number } | undefined;
  for (const accountId of changedAccountIds) {
    const account = state.accounts.get(accountId);
    const marker = account?.boardResealMigration;
    if (!account || !marker) continue;
    if (!accountBoardResealEvidenceChanged(previousEvidence.get(accountId), account)) continue;
    const candidate = {
      jHeight: marker.activationJHeight,
      logIndex: marker.activationLogIndex,
    };
    if (!accountNeedsBoardResealForActivation(account, candidate)) continue;
    if (
      !activation ||
      candidate.jHeight > activation.jHeight ||
      (candidate.jHeight === activation.jHeight && candidate.logIndex > activation.logIndex)
    ) activation = candidate;
  }
  if (!activation) return;
  if (!state.crontabState) throw new Error('BOARD_RESEAL_CRONTAB_MISSING');
  scheduleHook(state.crontabState, {
    id: BOARD_RESEAL_HOOK_ID,
    triggerAt: state.timestamp,
    type: 'board_reseal',
    data: {
      activationJHeight: activation.jHeight,
      activationLogIndex: activation.logIndex,
      afterCounterpartyId: '',
    },
  });
};
