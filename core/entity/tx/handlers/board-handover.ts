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
  authorizedConfig?: EntityState['config'],
): EntityTxReducerResult => {
  const config = validateConsensusConfig({
    ...tx.data.board,
    ...(entityState.config.jurisdiction
      ? { jurisdiction: entityState.config.jurisdiction }
      : {}),
  }, 'BOARD_HANDOVER_CONFIG');
  if (config.mode !== entityState.config.mode) throw new Error('BOARD_HANDOVER_MODE_CHANGE_FORBIDDEN');
  if (!authorizedConfig) {
    throw new Error('BOARD_HANDOVER_TRANSITION_PROOF_REQUIRED');
  }
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
  const authorizedHash = hashBoard(encodeBoard(authorizedConfig, env)).toLowerCase();
  if (authorizedHash !== nextHash || record.boardHash !== nextHash) {
    throw new Error(
      `BOARD_HANDOVER_CERTIFIED_AUTHORITY_MISMATCH:` +
        `previous=${record.previousBoardHash}:${previousHash}:` +
        `certified=${record.boardHash}:authorized=${authorizedHash}:next=${nextHash}`,
    );
  }
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const activeValidatorId = config.validators[0];
  if (!activeValidatorId) throw new Error('BOARD_HANDOVER_VALIDATOR_MISSING');
  // The board is tiny consensus metadata, so detach only its mutable leaves.
  // The jurisdiction object is immutable carry-forward authority and is never
  // copied with the potentially million-entry Entity state.
  newState.config = {
    mode: config.mode,
    threshold: config.threshold,
    validators: [...config.validators],
    shares: { ...config.shares },
    ...(config.jurisdiction ? { jurisdiction: config.jurisdiction } : {}),
  };
  newState.leaderState = {
    activeValidatorId,
    view: 0,
    changedAtHeight: entityState.height + 1,
  };
  return { newState, outputs: [] };
};
