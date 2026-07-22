import type { EntityReplica, EntityState, EntityTx, Env, HashToSign } from '../../../types';
import { executeCrontab } from '../../scheduler';
import { assertScheduledWakeMatchesState } from '../../../machine/scheduled-wake';
import { isCollectiveEntityActionTx } from '../../authorization';

type ScheduledWakeTx = Extract<EntityTx, { type: 'scheduledWake' }>;

export const handleScheduledWakeEntityTx = async (
  env: Env,
  state: EntityState,
  tx: ScheduledWakeTx,
  manualBroadcastInInput: boolean,
) => {
  assertScheduledWakeMatchesState(state, tx);
  if (!state.crontabState) throw new Error('SCHEDULED_WAKE_CRONTAB_MISSING');
  const replica: EntityReplica = {
    entityId: state.entityId,
    signerId: tx.data.proposerSignerId,
    state,
    mempool: [],
    isProposer: true,
  };
  const hashesToSign: HashToSign[] = [];
  const accountChanges = new Set<string>();
  const outputs = await executeCrontab(env, replica, state.crontabState, {
    manualBroadcastInInput,
    hashesToSign,
    accountChanges,
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
    newState: replica.state,
    outputs: externalOutputs,
    // A scheduled wake is already part of this Entity proposal. Its
    // deterministic self-actions therefore belong to the same signed frame;
    // certifying an output back to the same Entity adds a second Runtime frame
    // and lets the command become stale behind unrelated local progress.
    ...(approvedEntityTxs.length > 0 ? { approvedEntityTxs } : {}),
    ...(hashesToSign.length > 0 ? { hashesToSign } : {}),
    ...(accountChanges.size > 0 ? { accountChanges: [...accountChanges].sort() } : {}),
  };
};
