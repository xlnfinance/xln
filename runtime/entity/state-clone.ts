import type {
  EntityState,
  LendingLoan,
  LendingPoolPosition,
  LendingState,
} from '../types';
import {
  cloneCrossJurisdictionBookAdmission,
  cloneCrossJurisdictionRoute,
} from '../extensions/cross-j';
import { createStructuredLogger } from '../infra/logger';
import { cloneJBatch, type JBatchState } from '../jurisdiction/batch';
import { structuredCloneOrThrow } from '../protocol/structured-clone';
import { cloneCrossJurisdictionAccountTxRoute } from '../extensions/cross-j';
import { applyAccountClonePolicy } from '../account/state-clone';
import { copyEntityFrameEvents } from './frame-events';
import { validateEntityState } from './state-validation';
import { forkEntityAccountCommitmentCache } from './consensus/state-root';
import { forkQueuedAccountIndex } from './consensus/account-work-index';

const cloneLog = createStructuredLogger('entity.state_clone');

const cloneJBatchState = (state: JBatchState): JBatchState => {
  const cloned: JBatchState = {
    batch: cloneJBatch(state.batch),
    jurisdiction: state.jurisdiction,
    lastBroadcast: state.lastBroadcast,
    broadcastCount: state.broadcastCount,
    failedAttempts: state.failedAttempts,
    status: state.status,
  };
  if (state.sentBatch) {
    cloned.sentBatch = {
      ...state.sentBatch,
      batch: cloneJBatch(state.sentBatch.batch),
    };
  }
  if (state.entityNonce !== undefined) cloned.entityNonce = state.entityNonce;
  if (state.autoBroadcastDraft !== undefined) {
    cloned.autoBroadcastDraft = state.autoBroadcastDraft;
  }
  return cloned;
};

const cloneLendingPosition = (
  position: LendingPoolPosition,
): LendingPoolPosition => ({ ...position });

const cloneLendingLoan = (loan: LendingLoan): LendingLoan => ({ ...loan });

const cloneLendingState = (lending: LendingState): LendingState => ({
  pools: new Map(
    Array.from(lending.pools.entries()).map(([id, position]) => [
      id,
      cloneLendingPosition(position),
    ]),
  ),
  loans: new Map(
    Array.from(lending.loans.entries()).map(([id, loan]) => [
      id,
      cloneLendingLoan(loan),
    ]),
  ),
});

const cloneCrossJurisdictionState = (
  target: EntityState,
  source: EntityState,
): void => {
  if (source.crossJurisdictionSwaps) {
    target.crossJurisdictionSwaps = new Map(
      Array.from(source.crossJurisdictionSwaps.entries()).map(([id, route]) => [
        id,
        cloneCrossJurisdictionRoute(route),
      ]),
    );
  }
  if (source.pendingCrossJurisdictionFillAcks) {
    target.pendingCrossJurisdictionFillAcks = new Map(
      Array.from(source.pendingCrossJurisdictionFillAcks.entries()).map(
        ([id, pending]) => [
          id,
          {
            ...pending,
            tx: cloneCrossJurisdictionAccountTxRoute(
              structuredClone(pending.tx),
            ) as typeof pending.tx,
          },
        ],
      ),
    );
  }
  if (source.crossJurisdictionBookAdmissions) {
    target.crossJurisdictionBookAdmissions = new Map(
      Array.from(source.crossJurisdictionBookAdmissions.entries()).map(
        ([id, admission]) => [
          id,
          cloneCrossJurisdictionBookAdmission(admission),
        ],
      ),
    );
  }
};

const assertIdentityPreserved = (
  source: EntityState,
  cloned: EntityState,
): void => {
  if (!cloned.entityId || cloned.entityId !== source.entityId) {
    cloneLog.error('entity_id_corrupt', {
      original: source.entityId,
      cloned: cloned.entityId,
    });
    throw new Error('cloneEntityState failed: entityId was not preserved');
  }
  if (typeof cloned.lastFinalizedJHeight !== 'number') {
    cloneLog.error('last_finalized_j_height_corrupt', {
      original: source.lastFinalizedJHeight,
      originalType: typeof source.lastFinalizedJHeight,
      cloned: cloned.lastFinalizedJHeight,
      clonedType: typeof cloned.lastFinalizedJHeight,
    });
    throw new Error(
      'cloneEntityState failed: lastFinalizedJHeight was not preserved',
    );
  }
};

const cloneEntityStateWithPolicy = (
  source: EntityState,
  forSnapshot: boolean,
  validateClone: boolean,
): EntityState => {
  const cloned = structuredCloneOrThrow(
    source,
    'ENTITY_STATE_STRUCTURED_CLONE_FAILED',
  );
  copyEntityFrameEvents(source, cloned);
  assertIdentityPreserved(source, cloned);
  if (source.jBatchState) cloned.jBatchState = cloneJBatchState(source.jBatchState);
  if (source.lending) cloned.lending = cloneLendingState(source.lending);
  cloneCrossJurisdictionState(cloned, source);
  for (const [accountId, account] of cloned.accounts) {
    const sourceAccount = source.accounts.get(accountId);
    if (sourceAccount) {
      applyAccountClonePolicy(account, sourceAccount, forSnapshot);
    }
  }
  if (!forSnapshot) {
    forkEntityAccountCommitmentCache(source, cloned);
    forkQueuedAccountIndex(source, cloned);
  }
  return validateClone
    ? validateEntityState(cloned, 'cloneEntityState.structuredClone')
    : cloned;
};

export const cloneEntityState = (
  state: EntityState,
  forSnapshot = false,
): EntityState => cloneEntityStateWithPolicy(state, forSnapshot, true);

/**
 * Clone State that already crossed a validation or consensus boundary.
 * External decode and proposal validation must use cloneEntityState().
 */
export const cloneTrustedEntityState = (
  state: EntityState,
  forSnapshot = false,
): EntityState => cloneEntityStateWithPolicy(state, forSnapshot, false);
