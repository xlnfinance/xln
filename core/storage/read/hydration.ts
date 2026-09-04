import { engineAccountValueHash } from '../../rscore/engine-leaf/leaf-cache';
import { rebuildOrderbookPairIndex, type BookState, type OrderbookExtState } from '../../orderbook';
import type { AccountReplica } from '../../types/account';
import type { EntityState } from '../../entity/types';
import type { StorageAccountDoc, StorageEntityCoreDoc } from '../types';
import { assertAccountMempoolWithinLimit } from '../../account/input/mempool';
import { assertAccountJClaimAccumulatorState } from '../../account/j-claims/j-claim-accumulator';
import { assertJBatchWithinContractLimits } from '../../jurisdiction/machine/batch';
import { createStructuredLogger } from '../../support/logger';

const hydrationLog = createStructuredLogger('storage.hydration');
import {
  withDefinedProperty,
} from './entity-core-boundary';
import { PersistentEntityAccountMap } from '../../entity/state/persistent-account-map';
import { PersistentEntityCollectionMap } from '../../entity/state/persistent-collection-map';
import {
  isPersistentAccountStateMap,
  PersistentAccountStateMap,
  type AccountStateMapKey,
  type AccountStateMapNamespace,
} from '../../account/state/persistent-state-map';

/**
 * Structural equality over sealed leaf values: primitives, bigints, bytes,
 * arrays and plain records. Stricter than canonical-bytes equality (a
 * mismatch only costs one fresh leaf seal), never looser.
 */
const plainValueEquals = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!plainValueEquals(left[index], right[index])) return false;
    }
    return true;
  }
  if (left instanceof Map || right instanceof Map || left instanceof Set || right instanceof Set) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  const rightRecord = right as Record<string, unknown>;
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key)) return false;
    if (!plainValueEquals((left as Record<string, unknown>)[key], rightRecord[key])) return false;
  }
  return true;
};

/**
 * Mirror refresh: fold only the changed leaves into the previously committed
 * map. Untouched leaves keep their sealed identity (digest memo hit) and
 * untouched subtrees are shared, so a one-payment account refresh re-hashes
 * one path instead of every leaf.
 */
export const reuseAccountStateMap = <Key extends AccountStateMapKey, Value>(
  namespace: AccountStateMapNamespace,
  value: ReadonlyMap<Key, Value>,
  previous: ReadonlyMap<Key, Value> | undefined,
): PersistentAccountStateMap<Key, Value> => {
  if (isPersistentAccountStateMap(value)) return value as PersistentAccountStateMap<Key, Value>;
  if (!isPersistentAccountStateMap(previous) || previous.namespace !== namespace) {
    return PersistentAccountStateMap.fromEntries(namespace, value);
  }
  let next = previous as PersistentAccountStateMap<Key, Value>;
  for (const [key, entry] of value) {
    if (next.has(key) && plainValueEquals(next.get(key), entry)) continue;
    next = next.updated(key, entry);
  }
  if (next.size !== value.size) {
    for (const key of previous.keys()) {
      if (!value.has(key as Key)) next = next.removed(key as Key);
    }
  }
  return next;
};

const persistentAccountMap = <Key extends AccountStateMapKey, Value>(
  namespace: AccountStateMapNamespace,
  value: ReadonlyMap<Key, Value>,
  previous?: ReadonlyMap<Key, Value>,
): PersistentAccountStateMap<Key, Value> => isPersistentAccountStateMap(value)
  ? value as PersistentAccountStateMap<Key, Value>
  : previous
    ? reuseAccountStateMap(namespace, value, previous)
    : PersistentAccountStateMap.fromEntries(namespace, value);

/**
 * `previous` is the caller's committed mirror of the same account (post-phase
 * refresh from an Account worker): unchanged leaves are shared with it.
 */
export const hydrateAccountDocFromStorage = (
  doc: StorageAccountDoc,
  previous?: AccountReplica,
): AccountReplica => {
  assertAccountMempoolWithinLimit(doc, 'storage.account.mempool');
  const state = {
    ...doc.state,
    deltas: persistentAccountMap('deltas', doc.state.deltas, previous?.state.deltas),
    locks: persistentAccountMap('locks', doc.state.locks, previous?.state.locks),
    swapOffers: persistentAccountMap(
      'swapOffers',
      doc.state.swapOffers,
      previous?.state.swapOffers,
    ),
    ...(doc.state.pulls ? { pulls: persistentAccountMap('pulls', doc.state.pulls, previous?.state.pulls) } : {}),
    ...(doc.state.subcontracts
      ? { subcontracts: persistentAccountMap(
          'subcontracts',
          doc.state.subcontracts,
          previous?.state.subcontracts,
        ) }
      : {}),
    ...(doc.state.lendingIntents
      ? { lendingIntents: persistentAccountMap(
          'lendingIntents',
          doc.state.lendingIntents,
          previous?.state.lendingIntents,
        ) }
      : {}),
    requestedRebalance: persistentAccountMap(
      'requestedRebalance',
      doc.state.requestedRebalance,
      previous?.state.requestedRebalance,
    ),
    requestedRebalanceFeeState: persistentAccountMap(
      'requestedRebalanceFeeState',
      doc.state.requestedRebalanceFeeState,
      previous?.state.requestedRebalanceFeeState,
    ),
    ...(doc.state.rebalanceFeePolicies
      ? { rebalanceFeePolicies: persistentAccountMap(
          'rebalanceFeePolicies',
          doc.state.rebalanceFeePolicies,
          previous?.state.rebalanceFeePolicies,
        ) }
      : {}),
    leftPendingJClaims: assertAccountJClaimAccumulatorState(doc.state.leftPendingJClaims),
    rightPendingJClaims: assertAccountJClaimAccumulatorState(doc.state.rightPendingJClaims),
  };
  hydrationLog.debug('account.ownership_transferred', {
    from: doc.proofHeader.fromEntity,
    to: doc.proofHeader.toEntity,
    height: doc.currentHeight,
  });
  return {
    ...doc,
    state,
    pendingWithdrawals: persistentAccountMap(
      'pendingWithdrawals',
      doc.pendingWithdrawals,
      previous?.pendingWithdrawals,
    ),
    shadow: {
      ...doc.shadow,
      rebalance: {
        ...doc.shadow.rebalance,
        policy: persistentAccountMap(
          'rebalanceShadowPolicy',
          doc.shadow.rebalance.policy,
          previous?.shadow.rebalance.policy,
        ),
        submittedAtByToken: persistentAccountMap(
          'rebalanceShadowSubmitted',
          doc.shadow.rebalance.submittedAtByToken,
          previous?.shadow.rebalance.submittedAtByToken,
        ),
      },
    },
  };
};

export const hydrateEntityStateFromStorage = (options: {
  core: StorageEntityCoreDoc;
  accounts: Map<string, StorageAccountDoc>;
  books: Map<string, BookState>;
}): EntityState => {
  const { core, accounts, books } = options;
  let orderbookExt: OrderbookExtState | undefined;
  if (books.size > 0 || core.orderbookHubProfile || core.orderbookReferrals || core.orderbookPairDimensions) {
    if (!core.orderbookHubProfile) {
      throw new Error(`STORAGE_ORDERBOOK_HUBPROFILE_MISSING:${core.entityId}`);
    }
    if (!(core.orderbookPairDimensions instanceof Map)) {
      throw new Error(`STORAGE_ORDERBOOK_PAIR_DIMENSIONS_MISSING:${core.entityId}`);
    }
    orderbookExt = {
      books,
      orderPairs: new Map(),
      pairDimensions: core.orderbookPairDimensions,
      referrals: core.orderbookReferrals ?? new Map(),
      hubProfile: core.orderbookHubProfile,
    };
    rebuildOrderbookPairIndex(orderbookExt);
  }

  if (core.jBatchState) {
    assertJBatchWithinContractLimits(core.jBatchState.batch, 'storage.entity.jBatchState.batch');
    if (core.jBatchState.sentBatch) {
      assertJBatchWithinContractLimits(
        core.jBatchState.sentBatch.batch,
        'storage.entity.jBatchState.sentBatch.batch',
      );
    }
    for (const [index, recoveryBatch] of (core.jBatchState.recoveryBatches ?? []).entries()) {
      assertJBatchWithinContractLimits(
        recoveryBatch,
        `storage.entity.jBatchState.recoveryBatches[${index}]`,
      );
    }
  }

  return {
    entityId: core.entityId,
    height: core.height,
    timestamp: core.timestamp,
    nonces: core.nonces,
    ...withDefinedProperty('entityCommandNonces', core.entityCommandNonces),
    proposals: core.proposals,
    config: core.config,
    entityEncryptionPublicKey: core.entityEncryptionPublicKey,
    reserves: core.reserves,
    ...withDefinedProperty('externalWallet', core.externalWallet),
    accounts: PersistentEntityAccountMap.fromEntries(
      (function* () {
        for (const [key, value] of accounts) yield [key, hydrateAccountDocFromStorage(value)] as const;
      })(),
      core.entityId,
      engineAccountValueHash(core.entityId),
    ),
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    ...withDefinedProperty('jHistoryFinality', core.jHistoryFinality),
    ...withDefinedProperty('certifiedBoardState', core.certifiedBoardState),
    profile: core.profile,
    paybook: {
      entries: PersistentEntityCollectionMap.from(core.paybook.entries, 'paybookHashlock'),
      feesEarned: core.paybook.feesEarned,
    },
    ...withDefinedProperty('prevFrameHash', core.prevFrameHash),
    ...withDefinedProperty('leaderState', core.leaderState),
    ...withDefinedProperty(
      'deferredAccountProposals',
      core.deferredAccountProposals && PersistentEntityCollectionMap.from(core.deferredAccountProposals),
    ),
    ...withDefinedProperty(
      'settlementContinuations',
      core.settlementContinuations && PersistentEntityCollectionMap.from(core.settlementContinuations),
    ),
    ...withDefinedProperty(
      'crontabState',
      core.crontabState && {
        tasks: core.crontabState.tasks,
        hooks: PersistentEntityCollectionMap.from(core.crontabState.hooks),
      },
    ),
    ...withDefinedProperty('jBatchState', core.jBatchState),
    ...withDefinedProperty('entityProviderActionState', core.entityProviderActionState),
    ...withDefinedProperty('outDebtsByToken', core.outDebtsByToken),
    ...withDefinedProperty('inDebtsByToken', core.inDebtsByToken),
    ...withDefinedProperty('orderbookExt', orderbookExt),
    ...withDefinedProperty('swapTradingPairs', core.swapTradingPairs),
    ...withDefinedProperty(
      'crossJurisdictionSwaps',
      core.crossJurisdictionSwaps && PersistentEntityCollectionMap.from(core.crossJurisdictionSwaps),
    ),
    ...withDefinedProperty(
      'crossJurisdictionAuthorizations',
      core.crossJurisdictionAuthorizations && PersistentEntityCollectionMap.from(core.crossJurisdictionAuthorizations),
    ),
    ...withDefinedProperty(
      'crossJurisdictionBookAdmissions',
      core.crossJurisdictionBookAdmissions && PersistentEntityCollectionMap.from(core.crossJurisdictionBookAdmissions),
    ),
    ...withDefinedProperty('hubRebalanceConfig', core.hubRebalanceConfig),
    ...withDefinedProperty('lending', core.lending),
  };
};

export type { BookState };
