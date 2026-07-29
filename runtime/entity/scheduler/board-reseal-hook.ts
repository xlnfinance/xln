import type {
  RuntimeState,
} from '../../types';
import type {
  CrontabExecutionContext,
  EntityTransitionContext,
  ScheduledHook,
} from '../scheduler-types';
import { getCertifiedBoardNodeStore } from '../../jurisdiction/board-registry';
import {
  applyBoardRotationResealMigrations,
  BOARD_RESEAL_HOOK_ID,
  BOARD_RESEAL_RETRY_MS,
  buildPendingBoardRotationResealDrafts,
} from '../tx/board-rotation-reseal';
import { scheduleHook } from './hook-state';
import type { DueHookPlan } from './due-hook-types';

export const processBoardResealHook = (
  env: RuntimeState,
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
  const pendingForActivation = [...replica.state.accounts.values()].some(account =>
    account.boardResealMigration?.activationJHeight === activation.jHeight &&
    account.boardResealMigration.activationLogIndex === activation.logIndex);
  if (!drafts.hasMore && !pendingForActivation) return;
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
