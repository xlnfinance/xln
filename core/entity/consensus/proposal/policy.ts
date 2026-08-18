import { getEntityConfigBoardHash } from '../../../hanko/signing';
import { getCertifiedBoardNodeStore, resolveObserverCertifiedBoardRecord } from '../../../jurisdiction/machine/board-registry';
import { selectEntityTxsWithinJRangeBudget } from '../../../jurisdiction/machine/range-budget';
import type { EntityTx } from '../../../types/entity-tx';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityState, EntityFrame } from '../../types';
import { selectCrossJCommitPhaseTxs } from '../../transition/cross-j-proposer-materialization';
import { selectEntityFrameTxByteBudget } from '../frame';
import {
  normalizeConsensusOutputOrigin,
  resolveConsensusOutputBoardAuthority,
} from '../output/certification';
import { attachTargetConsumptionProofs } from '../output/consumption';
import {
  verifyEntityLeaderCertificate,
  verifyEntityRelayCertificate,
} from '../leader/certificates';
import {
  getBoardHandoverFrameConfig,
  withBoardAuthority,
} from '../authority/board-handover';

const FOUNDATION_ENTITY_ID = `0x${'0'.repeat(63)}1`;

const getSelfAuthorityTargetFromJRange = (
  tx: Extract<EntityTx, { type: 'j_event' }>,
  entityId: string,
): string | null => {
  const normalizedEntityId = entityId.toLowerCase();
  let target: string | null = null;
  for (const block of tx.data.blocks) {
    for (const event of block.events) {
      if (event.type === 'FoundationBootstrapped' && normalizedEntityId === FOUNDATION_ENTITY_ID) {
        target = event.data.boardHash.toLowerCase();
      } else if (
        (event.type === 'EntityRegistered' || event.type === 'BoardActivated') &&
        event.data.entityId.toLowerCase() === normalizedEntityId
      ) {
        target = (event.type === 'EntityRegistered' ? event.data.boardHash : event.data.newBoardHash).toLowerCase();
      }
    }
  }
  return target;
};

export type ProposableEntityTxSelection = {
  txs: EntityTx[];
  currentAuthorityReady: boolean;
  reason?: string;
};

const applyJRangeBudgetToSelection = (selection: ProposableEntityTxSelection): ProposableEntityTxSelection => {
  const budgeted = selectEntityTxsWithinJRangeBudget(selection.txs);
  const frameBudgetedTxs = selectEntityFrameTxByteBudget(budgeted.txs);
  const deferredByFrameBytes = frameBudgetedTxs.length !== budgeted.txs.length;
  if (budgeted.deferredJRangeCount === 0 && !deferredByFrameBytes) return selection;
  return {
    ...selection,
    txs: frameBudgetedTxs,
    ...(selection.reason
      ? {}
      : { reason: deferredByFrameBytes ? 'ENTITY_FRAME_BYTE_BUDGET_DEFERRED' : 'J_RANGE_FRAME_BUDGET_DEFERRED' }),
  };
};

/**
 * Select only transactions whose authority prerequisites are already
 * committed. Deferred work remains in the replica mempool unchanged.
 */
export const selectProposableEntityTxs = async (
  env: EntityRuntimeContext,
  state: EntityState,
  mempool: EntityTx[],
): Promise<ProposableEntityTxSelection> => {
  const configBoardHash = await getEntityConfigBoardHash(env, state.config);
  const normalizedEntityId = state.entityId.toLowerCase();
  const selfRecord = resolveObserverCertifiedBoardRecord(state, getCertifiedBoardNodeStore(env), normalizedEntityId);
  const currentAuthorityReady = configBoardHash === normalizedEntityId || selfRecord?.boardHash === configBoardHash;
  const jRanges = mempool.filter((tx): tx is Extract<EntityTx, { type: 'j_event' }> => tx.type === 'j_event');
  const selfAuthorityRanges = jRanges
    .map(tx => ({ tx, target: getSelfAuthorityTargetFromJRange(tx, normalizedEntityId) }))
    .filter((entry): entry is { tx: Extract<EntityTx, { type: 'j_event' }>; target: string } => Boolean(entry.target));
  const handovers = mempool.filter(
    (tx): tx is Extract<EntityTx, { type: 'boardHandover' }> => tx.type === 'boardHandover',
  );

  if (selfAuthorityRanges.length > 0) {
    const latestRange = selfAuthorityRanges.at(-1);
    if (!latestRange) throw new Error('SELF_BOARD_AUTHORITY_RANGE_MISSING');
    const latestTarget = latestRange.target;
    if (latestTarget !== configBoardHash) {
      if (handovers.length === 1) {
        const handover = handovers[0];
        if (!handover) throw new Error('SELF_BOARD_HANDOVER_MISSING');
        const transitionTxs: EntityTx[] = [latestRange.tx, handover];
        getBoardHandoverFrameConfig(env, state, transitionTxs);
        return {
          txs: transitionTxs,
          currentAuthorityReady: true,
          reason: 'SELF_BOARD_HANDOVER_PRIORITY',
        };
      }
      return { txs: [], currentAuthorityReady, reason: 'SELF_BOARD_CONFIG_HANDOVER_REQUIRED' };
    }
    return applyJRangeBudgetToSelection({
      txs: selfAuthorityRanges.map(entry => entry.tx),
      currentAuthorityReady,
      reason: currentAuthorityReady ? 'SELF_BOARD_ROTATION_PRIORITY' : 'SELF_BOARD_BOOTSTRAP_PRIORITY',
    });
  }
  if (handovers.length > 0) {
    if (handovers.length !== 1) {
      throw new Error(`BOARD_HANDOVER_COUNT_INVALID:${handovers.length}`);
    }
    return {
      txs: [],
      currentAuthorityReady,
      reason: 'SELF_BOARD_ACTIVATION_REQUIRED',
    };
  }
  if (!currentAuthorityReady) {
    return { txs: [], currentAuthorityReady: false, reason: 'SELF_BOARD_CERTIFICATION_REQUIRED' };
  }

  const blockedOutput = mempool.some(tx => {
    if (tx.type !== 'consensusOutput') return false;
    const origin = normalizeConsensusOutputOrigin(tx.data.origin);
    return resolveConsensusOutputBoardAuthority(origin, state, env).kind === 'defer';
  });
  if (!blockedOutput) {
    const phaseSelection = selectCrossJCommitPhaseTxs(mempool);
    return applyJRangeBudgetToSelection({
      txs: attachTargetConsumptionProofs(env, state, phaseSelection.txs),
      currentAuthorityReady: true,
      ...(phaseSelection.deferredCrossJSetup ? { reason: 'CROSS_J_ACCOUNT_COMMIT_PRIORITY' } : {}),
    });
  }
  if (jRanges.length > 0) {
    return applyJRangeBudgetToSelection({
      txs: [jRanges[0]!],
      currentAuthorityReady: true,
      reason: 'OUTPUT_BOARD_CATCH_UP_PRIORITY',
    });
  }
  return { txs: [], currentAuthorityReady: true, reason: 'OUTPUT_BOARD_CATCH_UP_REQUIRED' };
};

export const isSelfBoardAuthorityTransitionFrame = async (
  env: EntityRuntimeContext,
  state: EntityState,
  entityTxs: EntityTx[],
): Promise<boolean> => {
  if (getBoardHandoverFrameConfig(env, state, entityTxs)) return true;
  if (entityTxs.length === 0 || entityTxs.some(tx => tx.type !== 'j_event')) return false;
  const configBoardHash = await getEntityConfigBoardHash(env, state.config);
  if (configBoardHash === state.entityId.toLowerCase()) return false;
  const current = resolveObserverCertifiedBoardRecord(state, getCertifiedBoardNodeStore(env), state.entityId);
  if (current?.boardHash === configBoardHash) return false;
  const finalTarget = entityTxs
    .map(tx => getSelfAuthorityTargetFromJRange(tx as Extract<EntityTx, { type: 'j_event' }>, state.entityId))
    .filter((target): target is string => Boolean(target))
    .at(-1);
  return finalTarget === configBoardHash;
};

export const validateProposedFrameLeader = (
  env: EntityRuntimeContext,
  state: EntityState,
  frame: EntityFrame,
): boolean => {
  const handoverConfig = getBoardHandoverFrameConfig(env, state, frame.txs);
  if (handoverConfig) {
    const handoverLeader = handoverConfig.validators[0];
    if (
      !handoverLeader ||
      frame.leader.view !== 0 ||
      frame.leader.certificate ||
      frame.leader.relayCertificate ||
      frame.leader.proposerSignerId.toLowerCase() !== handoverLeader.toLowerCase()
    ) return false;
  }
  const authorityState = handoverConfig
    ? withBoardAuthority(state, handoverConfig, frame.height)
    : state;
  return Boolean(
    frame.leader &&
    verifyEntityLeaderCertificate(env, authorityState, frame) &&
    verifyEntityRelayCertificate(env, authorityState, frame)
  );
};
