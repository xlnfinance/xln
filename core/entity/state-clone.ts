import type { EntityReplica, EntityState } from './types';
import type { LendingLoan, LendingPoolPosition, LendingState } from '../types/finance/lending';
import {
  cloneCrossJurisdictionAccountTxRoute,
  cloneCrossJurisdictionBookAdmission,
  cloneCrossJurisdictionRoute,
} from '../extensions/cross-j';
import { cloneJBatch, type JBatchState } from '../jurisdiction/machine/batch';
import { structuredCloneOrThrow } from '../protocol/serialization/structured-clone';
import { copyEntityFrameEvents } from './frame-events';
import { forkCrossJurisdictionBookAdmissionIndex } from '../extensions/cross-j/orderbook';
import {
  commitEntityAccountCandidate,
  commitEntityOrderbookCandidate,
  createEntityAccountCandidateMap,
  createEntityOrderbookCandidate,
} from './state/candidate-map';
import {
  EntityAccountCandidateMap,
  PersistentEntityAccountMap,
} from './state/persistent-account-map';
import {
  EntityCollectionCandidateMap,
} from './state/persistent-collection-map';
import type { ScheduledHook } from './scheduler/types';

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
  if (state.recoveryBatches) {
    cloned.recoveryBatches = state.recoveryBatches.map(cloneJBatch);
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
    target.crossJurisdictionSwaps = new EntityCollectionCandidateMap(
      source.crossJurisdictionSwaps,
      cloneCrossJurisdictionRoute,
    );
  }
  if (source.crossJurisdictionAuthorizations) {
    target.crossJurisdictionAuthorizations = new EntityCollectionCandidateMap(
      source.crossJurisdictionAuthorizations,
      cloneCrossJurisdictionRoute,
    );
  }
  if (source.pendingCrossJurisdictionFillAcks) {
    const forkPending = (
      pending: NonNullable<EntityState['pendingCrossJurisdictionFillAcks']> extends Map<string, infer Value>
        ? Value
        : never,
    ) => ({
      ...pending,
      tx: cloneCrossJurisdictionAccountTxRoute(structuredClone(pending.tx)) as typeof pending.tx,
    });
    target.pendingCrossJurisdictionFillAcks = new EntityCollectionCandidateMap(
      source.pendingCrossJurisdictionFillAcks,
      forkPending,
    );
  }
  if (source.crossJurisdictionBookAdmissions) {
    target.crossJurisdictionBookAdmissions = new EntityCollectionCandidateMap(
      source.crossJurisdictionBookAdmissions,
      cloneCrossJurisdictionBookAdmission,
    );
  }
};

const forkHtlcRoute = (
  route: EntityState['htlcRoutes'] extends Map<string, infer Value> ? Value : never,
) => ({
  ...route,
  ...(route.crossJurisdictionRelay
    ? { crossJurisdictionRelay: { ...route.crossJurisdictionRelay } }
    : {}),
});

const forkScheduledHook = <Hook extends ScheduledHook>(hook: Hook): Hook => ({
  ...hook,
  data: { ...hook.data },
});

const installGrowingEntityCollections = (
  target: EntityState,
  source: EntityState,
): void => {
  target.htlcRoutes = new EntityCollectionCandidateMap(source.htlcRoutes, forkHtlcRoute);
  target.lockBook = new EntityCollectionCandidateMap(source.lockBook, value => ({ ...value }));
  if (source.crontabState) {
    target.crontabState = {
      tasks: new Map([...source.crontabState.tasks].map(([method, task]) => [
        method,
        { ...task, params: { ...task.params } },
      ])),
      hooks: new EntityCollectionCandidateMap<ScheduledHook>(
        source.crontabState.hooks,
        forkScheduledHook,
      ),
    };
  }
  cloneCrossJurisdictionState(target, source);
};

/**
 * Isolate only the bounded Entity-frame shell.
 *
 * Accounts, Books, HTLC routes and cross-j indexes can contain millions of
 * leaves, so they are removed before this bounded copy and reattached as
 * Patricia-backed candidates below. The shell contains only fixed records and
 * bounded control queues; copying it provides rollback without traversing the
 * financial graph or hiding writes behind Proxy state.
 */
const isolateEntityFrameShell = (
  source: EntityState,
): EntityState => {
  const {
    accounts: _accounts,
    orderbookExt: _orderbookExt,
    htlcRoutes: _htlcRoutes,
    lockBook: _lockBook,
    crontabState: _crontabState,
    jBatchState: _jBatchState,
    lending: _lending,
    crossJurisdictionSwaps: _crossJurisdictionSwaps,
    crossJurisdictionAuthorizations: _crossJurisdictionAuthorizations,
    pendingCrossJurisdictionFillAcks: _pendingCrossJurisdictionFillAcks,
    crossJurisdictionBookAdmissions: _crossJurisdictionBookAdmissions,
    ...boundedShell
  } = source;
  const isolatedShell = structuredCloneOrThrow(
    boundedShell,
    'ENTITY_FRAME_SHELL_ISOLATION_FAILED',
  );
  const isolated: EntityState = {
    ...isolatedShell,
    // These shared roots are replaced by frame-owned candidates before the
    // shell escapes. Keeping their exact types here makes the boundary honest.
    accounts: source.accounts,
    htlcRoutes: source.htlcRoutes,
    lockBook: source.lockBook,
  };
  if (isolated.entityId !== source.entityId) {
    throw new Error('ENTITY_FRAME_SHELL_ID_MISMATCH');
  }
  if (source.jBatchState) isolated.jBatchState = cloneJBatchState(source.jBatchState);
  if (source.lending) isolated.lending = cloneLendingState(source.lending);
  return isolated;
};

/**
 * Entity frame replay already owns an isolated candidate. Standalone callers
 * get the same Account/Book overlay candidate, never a full Entity clone.
 * Propose/validate mutate this overlay; commitEntityFrameCandidateState folds
 * dirty Patricia roots into the live EntityState object.
 */
export const prepareEntityTxState = (
  state: EntityState,
  mutableFrameState = false,
): EntityState =>
  mutableFrameState ? state : createEntityFrameCandidateState(state);

/**
 * Begin the Entity-frame overlay. Bounded shell is isolated; growing
 * collections are dirty Patricia candidates. Rejection drops this object.
 */
export const createEntityFrameCandidateState = (
  source: EntityState,
): EntityState => {
  const accountBase = source.accounts instanceof EntityAccountCandidateMap
    ? source.accounts.snapshotCandidate()
    : source.accounts;
  if (!(accountBase instanceof PersistentEntityAccountMap)) {
    throw new Error('ENTITY_FRAME_CANDIDATE_ACCOUNTS_INVALID');
  }
  const candidate = isolateEntityFrameShell(source);
  candidate.accounts = createEntityAccountCandidateMap(accountBase);
  if (source.orderbookExt) {
    candidate.orderbookExt = createEntityOrderbookCandidate(
      source.orderbookExt,
    );
  }
  copyEntityFrameEvents(source, candidate);
  installGrowingEntityCollections(candidate, source);
  forkCrossJurisdictionBookAdmissionIndex(source, candidate);
  return candidate;
};

/** Fold the Entity overlay into this same state object. Hash stays lazy until state-root. */
export const commitEntityFrameCandidateState = (
  state: EntityState,
  _stateRoot?: string,
): EntityState => {
  state.accounts = commitEntityAccountCandidate(state.accounts);
  if (state.orderbookExt) {
    state.orderbookExt = commitEntityOrderbookCandidate(state.orderbookExt);
  }
  if (state.htlcRoutes instanceof EntityCollectionCandidateMap) {
    state.htlcRoutes = state.htlcRoutes.sealCandidate();
  }
  if (state.lockBook instanceof EntityCollectionCandidateMap) {
    state.lockBook = state.lockBook.sealCandidate();
  }
  if (state.crontabState?.hooks instanceof EntityCollectionCandidateMap) {
    state.crontabState.hooks = state.crontabState.hooks.sealCandidate();
  }
  if (state.crossJurisdictionSwaps instanceof EntityCollectionCandidateMap) {
    state.crossJurisdictionSwaps = state.crossJurisdictionSwaps.sealCandidate();
  }
  if (state.crossJurisdictionAuthorizations instanceof EntityCollectionCandidateMap) {
    state.crossJurisdictionAuthorizations = state.crossJurisdictionAuthorizations.sealCandidate();
  }
  if (state.pendingCrossJurisdictionFillAcks instanceof EntityCollectionCandidateMap) {
    state.pendingCrossJurisdictionFillAcks = state.pendingCrossJurisdictionFillAcks.sealCandidate();
  }
  if (state.crossJurisdictionBookAdmissions instanceof EntityCollectionCandidateMap) {
    state.crossJurisdictionBookAdmissions = state.crossJurisdictionBookAdmissions.sealCandidate();
  }
  return state;
};

/**
 * Root of the certified frame this replica just committed, whether the
 * current endpoint is carried by the short head or its checkpoint anchor.
 * A committed input that does not advance the height (mempool admission,
 * deferred proposal, precommit collection) must not write any
 * ENTITY_STATE_ROOT_FIELDS. Entity State changes only through certified frames.
 */
export const committedEntityStateRoot = (replica: EntityReplica): string | undefined => {
  const head = replica.certifiedFrameHead?.frame;
  if (
    head &&
    head.height === replica.state.height &&
    head.hash === replica.state.prevFrameHash
  ) return head.stateRoot;
  const anchor = replica.certifiedFrameAnchor;
  if (
    anchor &&
    anchor.height === replica.state.height &&
    anchor.frameHash === (replica.state.height === 0 ? 'genesis' : replica.state.prevFrameHash)
  ) return anchor.stateRoot;
  return undefined;
};
