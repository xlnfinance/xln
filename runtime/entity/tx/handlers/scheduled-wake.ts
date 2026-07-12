import type { EntityReplica, EntityState, EntityTx, Env } from '../../../types';
import { executeCrontab } from '../../scheduler';
import { assertScheduledWakeMatchesState } from '../../../machine/scheduled-wake';

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
  const outputs = await executeCrontab(env, replica, state.crontabState, {
    manualBroadcastInInput,
  });
  return { newState: replica.state, outputs };
};
