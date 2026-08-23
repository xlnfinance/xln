import type { EntityCandidateEffect, EntityState, HashToSign } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import { executeCrontab } from '../../../scheduler';
import { assertScheduledWakeMatchesState } from '../../../scheduler/wake/scheduled-wake-validation';
import { isCollectiveEntityActionTx } from '../../../auth/authorization';
import { collectDueProposalResends } from '../../../scheduler/wake/proposal-resend';

type ScheduledWakeTx = Extract<EntityTx, { type: 'scheduledWake' }>;

export const handleScheduledWakeEntityTx = async (
  env: EntityRuntimeContext,
  state: EntityState,
  tx: ScheduledWakeTx,
  manualBroadcastInInput: boolean,
) => {
  assertScheduledWakeMatchesState(state, tx);
  // Resends are recomputed from committed Account state at the frame clock,
  // like hooks and tasks: the wake's job list is advisory, never authority.
  const accountResendWork = collectDueProposalResends(state, state.timestamp).map(due => due.accountKey);
  if (!state.crontabState) {
    if (accountResendWork.length === 0) throw new Error('SCHEDULED_WAKE_CRONTAB_MISSING');
    return { newState: state, outputs: [], accountResendWork };
  }
  const transition = {
    entityId: state.entityId,
    state,
  };
  const hashesToSign: HashToSign[] = [];
  const accountChanges = new Set<string>();
  const candidateEffects: EntityCandidateEffect[] = [];
  const outputs = await executeCrontab(env, transition, state.crontabState, {
    manualBroadcastInInput,
    hashesToSign,
    accountChanges,
    candidateEffects,
  });
  const approvedEntityTxs: EntityTx[] = [];
  const externalOutputs = outputs.filter((output) => {
    const isLocalCollectiveAction =
      output.entityId.toLowerCase() === state.entityId.toLowerCase() &&
      (output.entityTxs?.length ?? 0) > 0 &&
      output.entityTxs!.every(isCollectiveEntityActionTx);
    if (!isLocalCollectiveAction) return true;
    approvedEntityTxs.push(...output.entityTxs!);
    return false;
  });
  return {
    newState: transition.state,
    outputs: externalOutputs,
    // A scheduled wake is already part of this Entity proposal. Its
    // deterministic self-actions therefore belong to the same signed frame;
    // certifying an output back to the same Entity adds a second Runtime frame
    // and lets the command become stale behind unrelated local progress.
    ...(approvedEntityTxs.length > 0 ? { approvedEntityTxs } : {}),
    ...(accountResendWork.length > 0 ? { accountResendWork } : {}),
    ...(hashesToSign.length > 0 ? { hashesToSign } : {}),
    ...(accountChanges.size > 0 ? { accountChanges: [...accountChanges].sort() } : {}),
    ...(candidateEffects.length > 0 ? { candidateEffects } : {}),
  };
};
