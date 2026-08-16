import { applyEntityFrame } from '../../entity/consensus/frame/application';
import { materializeEntityInfraContext } from '../../entity/consensus/proposal/infra-context';
import type { EntityReplica, EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import type { EntityTx } from '../../types/entity-tx';

/** Execute a test frame through the same materialized infra-context boundary as production proposals. */
export const applyEntityFrameWithMaterializedTestInfraContext = async (
  env: RuntimeReplica,
  state: EntityState,
  txs: EntityTx[],
  timestamp: number = env.state.timestamp,
) => {
  const proposerSignerId = state.config.validators[0]?.toLowerCase();
  if (!proposerSignerId) throw new Error(`TEST_ENTITY_FRAME_PROPOSER_REQUIRED:${state.entityId}`);
  const replica: EntityReplica = {
    entityId: state.entityId,
    signerId: proposerSignerId,
    state,
    mempool: [],
    isProposer: true,
  };
  const entityContext = await materializeEntityInfraContext(env, replica, txs, {
    usePersistedReplayContext: true,
  });
  const result = await applyEntityFrame(env, state, entityContext, txs, timestamp);
  return { ...result, entityContext };
};
