import type { EntityTx } from '../../../types/entity-tx';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { ConsensusConfig, EntityState } from '../../types';
import { encodeBoard, hashBoard } from '../../factory';
import { validateConsensusConfig } from '../config-validation';

type BoardHandoverTx = Extract<EntityTx, { type: 'boardHandover' }>;
type JEventTx = Extract<EntityTx, { type: 'j_event' }>;
type BoardActivatedEvent = Extract<JurisdictionEvent, { type: 'BoardActivated' }>;
type BoardAuthorityState = Pick<EntityState, 'entityId' | 'height' | 'config'>;

const canonicalSigner = (value: string): string => value.trim().toLowerCase();

const requireFirstValidator = (config: ConsensusConfig): string => {
  const validator = config.validators[0];
  if (!validator) throw new Error('BOARD_HANDOVER_VALIDATOR_MISSING');
  return validator;
};

const assertCanonicalConfig = (
  state: BoardAuthorityState,
  rawBoard: BoardHandoverTx['data']['board'],
): ConsensusConfig => {
  const config = validateConsensusConfig({
    ...rawBoard,
    ...(state.config.jurisdiction
      ? { jurisdiction: structuredClone(state.config.jurisdiction) }
      : {}),
  }, 'BOARD_HANDOVER_CONFIG');
  if (config.mode !== state.config.mode) {
    throw new Error(`BOARD_HANDOVER_MODE_CHANGE_FORBIDDEN:${state.config.mode}:${config.mode}`);
  }
  for (const validator of config.validators) {
    if (validator !== canonicalSigner(validator)) {
      throw new Error(`BOARD_HANDOVER_VALIDATOR_NON_CANONICAL:${validator}`);
    }
  }
  for (const signer of Object.keys(config.shares)) {
    if (signer !== canonicalSigner(signer)) {
      throw new Error(`BOARD_HANDOVER_SHARE_SIGNER_NON_CANONICAL:${signer}`);
    }
  }
  return structuredClone(config);
};

const selfBoardActivations = (
  state: BoardAuthorityState,
  tx: JEventTx,
): BoardActivatedEvent[] => {
  const entityId = state.entityId.toLowerCase();
  return tx.data.blocks.flatMap(block => block.events).filter(
    (event): event is BoardActivatedEvent =>
      event.type === 'BoardActivated' && event.data.entityId.toLowerCase() === entityId,
  );
};

const requireSingleHandoverTx = (txs: readonly EntityTx[]): BoardHandoverTx | null => {
  const handovers = txs.filter((tx): tx is BoardHandoverTx => tx.type === 'boardHandover');
  if (handovers.length === 0) return null;
  if (handovers.length !== 1) throw new Error(`BOARD_HANDOVER_COUNT_INVALID:${handovers.length}`);
  if (txs.length !== 2 || txs[0]?.type !== 'j_event' || txs[1]?.type !== 'boardHandover') {
    throw new Error(`BOARD_HANDOVER_FRAME_SHAPE_INVALID:${txs.map(tx => tx.type).join(',')}`);
  }
  const handover = handovers[0];
  if (!handover) throw new Error('BOARD_HANDOVER_MISSING');
  return handover;
};

/**
 * Resolve the new authority only from a transition frame whose exact J range
 * proves a contiguous on-chain BoardActivated chain from the committed board.
 */
export const getBoardHandoverFrameConfig = (
  env: EntityRuntimeContext,
  state: BoardAuthorityState,
  txs: readonly EntityTx[],
): ConsensusConfig | null => {
  const handover = requireSingleHandoverTx(txs);
  if (!handover) return null;
  const config = assertCanonicalConfig(state, handover.data.board);
  const activations = selfBoardActivations(state, txs[0] as JEventTx);
  if (activations.length === 0) throw new Error('BOARD_HANDOVER_ACTIVATION_MISSING');
  let expectedPrevious = hashBoard(encodeBoard(state.config, env)).toLowerCase();
  for (const activation of activations) {
    const receivedPrevious = activation.data.previousBoardHash.toLowerCase();
    if (receivedPrevious !== expectedPrevious) {
      throw new Error(`BOARD_HANDOVER_ACTIVATION_CHAIN_INVALID:${receivedPrevious}:${expectedPrevious}`);
    }
    expectedPrevious = activation.data.newBoardHash.toLowerCase();
  }
  const configHash = hashBoard(encodeBoard(config, env)).toLowerCase();
  if (configHash !== expectedPrevious) {
    throw new Error(`BOARD_HANDOVER_CONFIG_HASH_MISMATCH:${configHash}:${expectedPrevious}`);
  }
  return config;
};

export const getEntityFrameConsensusConfig = (
  env: EntityRuntimeContext,
  state: BoardAuthorityState,
  txs: readonly EntityTx[],
): ConsensusConfig => getBoardHandoverFrameConfig(env, state, txs) ?? state.config;

export const getBoardHandoverLeaderState = (
  env: EntityRuntimeContext,
  state: BoardAuthorityState,
  txs: readonly EntityTx[],
): NonNullable<EntityState['leaderState']> | null => {
  const config = getBoardHandoverFrameConfig(env, state, txs);
  return config
    ? {
        activeValidatorId: requireFirstValidator(config),
        view: 0,
        changedAtHeight: state.height + 1,
      }
    : null;
};

/**
 * Uncommitted local coordination only. It may select who assembles the
 * transition proof, but never authenticates a frame without BoardActivated.
 */
export const getPendingBoardHandoverConfig = (
  state: EntityState,
  txs: readonly EntityTx[],
): ConsensusConfig | null => {
  const handovers = txs.filter((tx): tx is BoardHandoverTx => tx.type === 'boardHandover');
  if (handovers.length === 0) return null;
  if (handovers.length !== 1) throw new Error(`BOARD_HANDOVER_COUNT_INVALID:${handovers.length}`);
  const handover = handovers[0];
  if (!handover) throw new Error('BOARD_HANDOVER_MISSING');
  return assertCanonicalConfig(state, handover.data.board);
};

export const withBoardAuthority = (
  state: EntityState,
  config: ConsensusConfig,
  changedAtHeight = state.height + 1,
): EntityState => ({
  ...state,
  config,
  leaderState: {
    activeValidatorId: requireFirstValidator(config),
    view: 0,
    changedAtHeight,
  },
});
