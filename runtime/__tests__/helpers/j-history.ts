import { signAccountFrame } from '../../account/crypto';
import {
  applyJEvent,
  applyJHistoryCheckpoint,
  type JEventEntityTxData,
} from '../../entity/tx/j-events';
import {
  buildJHistoryCheckpointDigest,
  EMPTY_J_HISTORY_ROOT,
  foldJHistoryRoot,
} from '../../jurisdiction/history-consensus';
import { getJEventJurisdictionRef } from '../../jurisdiction/event-observation';
import type { EntityState, Env } from '../../types';
import type { JEventApplyResult } from '../../entity/tx/j-events-types';

const finalizedRoot = (state: EntityState): string =>
  state.jHistoryFinality?.eventHistoryRoot || foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, state.jBlockChain);

export const buildJHistoryCheckpointData = (
  state: EntityState,
  env: Env,
  signerId: string,
  scannedThroughHeight: number,
  tipBlockHash: string,
) => {
  const baseHeight = state.lastFinalizedJHeight;
  const jurisdictionRef = getJEventJurisdictionRef(state.config.jurisdiction);
  const eventHistoryRoot = foldJHistoryRoot(
    finalizedRoot(state),
    state.jBlockObservations.filter((observation) =>
      String(observation.signerId).toLowerCase() === String(signerId).toLowerCase() &&
      observation.jHeight > baseHeight &&
      observation.jHeight <= scannedThroughHeight
    ),
  );
  const signature = signAccountFrame(env, signerId, buildJHistoryCheckpointDigest({
    entityId: state.entityId,
    jurisdictionRef,
    signerId,
    baseHeight,
    scannedThroughHeight,
    tipBlockHash,
    eventHistoryRoot,
  }));
  return {
    from: signerId,
    jurisdictionRef,
    baseHeight,
    scannedThroughHeight,
    tipBlockHash,
    eventHistoryRoot,
    signature,
  };
};

export const submitJHistoryCheckpoint = async (
  state: EntityState,
  env: Env,
  signerId: string,
  scannedThroughHeight: number,
  tipBlockHash: string,
): Promise<EntityState> => {
  return (await applyJHistoryCheckpoint(
    state,
    buildJHistoryCheckpointData(state, env, signerId, scannedThroughHeight, tipBlockHash),
    env,
  )).newState;
};

export const applyJEventAndCheckpoint = async (
  state: EntityState,
  data: JEventEntityTxData,
  env: Env,
): Promise<JEventApplyResult> => {
  const observed = await applyJEvent(state, data, env);
  return applyJHistoryCheckpoint(
    observed.newState,
    buildJHistoryCheckpointData(observed.newState, env, data.from, data.blockNumber, data.blockHash),
    env,
  );
};
