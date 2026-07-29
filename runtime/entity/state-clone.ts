import type {
  AccountState,
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
import { forkAccountWorkIndexes } from './consensus/account-work-index';
import { forkCrossJurisdictionBookAdmissionIndex } from '../extensions/cross-j/orderbook';
import {
  createEntityAccountCandidateMap,
  commitEntityAccountCandidate,
  snapshotEntityAccountMap,
} from './account-candidate-map';
import {
  commitEntityOrderbookCandidate,
  createEntityOrderbookCandidate,
  snapshotEntityOrderbookCandidate,
} from './orderbook-candidate';

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
  const cloneSource = {
    ...source,
    accounts: snapshotEntityAccountMap(source.accounts),
    ...(source.orderbookExt
      ? {
          orderbookExt: snapshotEntityOrderbookCandidate(
            source.orderbookExt,
          ),
        }
      : {}),
  };
  // These sections have stricter clone policies below. Keeping them in the
  // bulk structuredClone duplicates work and can fail on aliased Cross-J route
  // carriers even though the canonical field clone is valid.
  delete cloneSource.jBatchState;
  delete cloneSource.lending;
  delete cloneSource.crossJurisdictionSwaps;
  delete cloneSource.pendingCrossJurisdictionFillAcks;
  delete cloneSource.crossJurisdictionBookAdmissions;
  const cloned = structuredCloneOrThrow(
    cloneSource,
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
    forkAccountWorkIndexes(source, cloned);
    forkCrossJurisdictionBookAdmissionIndex(source, cloned);
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
 * Entity frame replay already owns an isolated candidate. Reducers mutate that
 * candidate directly; standalone callers retain the pure clone-on-entry API.
 */
export const prepareEntityTxState = (
  state: EntityState,
  mutableFrameState = false,
): EntityState =>
  mutableFrameState ? state : cloneEntityState(state);

/**
 * Clone State that already crossed a validation or consensus boundary.
 * External decode and proposal validation must use cloneEntityState().
 */
export const cloneTrustedEntityState = (
  state: EntityState,
  forSnapshot = false,
): EntityState => cloneEntityStateWithPolicy(state, forSnapshot, false);

/**
 * Build an Entity-frame candidate without copying the potentially million-entry
 * Account map. Every other Entity section remains isolated by structuredClone;
 * Account isolation is provided lazily by EntityAccountCandidateMap.
 */
export const createEntityFrameCandidateState = (
  source: EntityState,
): EntityState => {
  if (!(source.accounts instanceof Map)) {
    throw new Error('ENTITY_FRAME_CANDIDATE_ACCOUNTS_INVALID');
  }
  const shellSource = {
    ...source,
    accounts: new Map<string, AccountState>(),
  };
  delete shellSource.orderbookExt;
  const candidate = cloneEntityStateWithPolicy(shellSource, false, false);
  candidate.accounts = createEntityAccountCandidateMap(source.accounts);
  if (source.orderbookExt) {
    candidate.orderbookExt = createEntityOrderbookCandidate(
      source.orderbookExt,
    );
  }
  copyEntityFrameEvents(source, candidate);
  forkEntityAccountCommitmentCache(source, candidate);
  forkAccountWorkIndexes(source, candidate);
  forkCrossJurisdictionBookAdmissionIndex(source, candidate);
  return candidate;
};

export const commitEntityFrameCandidateState = (
  state: EntityState,
): EntityState => {
  state.accounts = commitEntityAccountCandidate(state.accounts);
  if (state.orderbookExt) {
    state.orderbookExt = commitEntityOrderbookCandidate(state.orderbookExt);
  }
  return state;
};
