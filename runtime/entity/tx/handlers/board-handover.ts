import type { EntityTx } from '../../../types/entity-tx';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityState } from '../../types';
import { encodeBoard, hashBoard } from '../../factory';
import { prepareEntityTxState } from '../../state-clone';
import { validateConsensusConfig } from '../../consensus/config-validation';
import type { EntityTxReducerResult } from '../apply';

type BoardHandoverTx = Extract<EntityTx, { type: 'boardHandover' }>;

export const handleBoardHandoverEntityTx = (
  entityState: EntityState,
  tx: BoardHandoverTx,
  env: EntityRuntimeContext,
  mutableFrameState = false,
): EntityTxReducerResult => {
  const config = validateConsensusConfig({
    ...tx.data.board,
    ...(entityState.config.jurisdiction
      ? { jurisdiction: structuredClone(entityState.config.jurisdiction) }
      : {}),
  }, 'BOARD_HANDOVER_CONFIG');
  if (config.mode !== entityState.config.mode) throw new Error('BOARD_HANDOVER_MODE_CHANGE_FORBIDDEN');
  const record = resolveObserverCertifiedBoardRecord(
    entityState,
    getCertifiedBoardNodeStore(env),
    entityState.entityId,
  );
  if (!record || record.source !== 'BoardActivated') {
    throw new Error('BOARD_HANDOVER_CERTIFIED_ACTIVATION_REQUIRED');
  }
  const previousHash = hashBoard(encodeBoard(entityState.config, env)).toLowerCase();
  const nextHash = hashBoard(encodeBoard(config, env)).toLowerCase();
  if (record.previousBoardHash !== previousHash || record.boardHash !== nextHash) {
    throw new Error(
      `BOARD_HANDOVER_CERTIFIED_AUTHORITY_MISMATCH:` +
        `previous=${record.previousBoardHash}:${previousHash}:next=${record.boardHash}:${nextHash}`,
    );
  }
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const activeValidatorId = config.validators[0];
  if (!activeValidatorId) throw new Error('BOARD_HANDOVER_VALIDATOR_MISSING');
  newState.config = structuredClone(config);
  newState.leaderState = {
    activeValidatorId,
    view: 0,
    changedAtHeight: entityState.height + 1,
  };
  return { newState, outputs: [] };
};
