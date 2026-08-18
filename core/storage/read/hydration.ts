import { rebuildOrderbookPairIndex, type BookState, type OrderbookExtState } from '../../orderbook';
import type { AccountReplica } from '../../types/account';
import type { EntityState } from '../../entity/types';
import type { StorageAccountDoc, StorageEntityCoreDoc } from '../types';
import { assertAccountMempoolWithinLimit } from '../../account/input/mempool';
import { assertAccountJClaimAccumulatorState } from '../../account/j-claims/j-claim-accumulator';
import { assertConsumptionAccumulatorState } from '../../entity/consumption/consumption-accumulator';
import { assertJBatchWithinContractLimits } from '../../jurisdiction/machine/batch';
import { createStructuredLogger } from '../../support/logger';

const hydrationLog = createStructuredLogger('storage.hydration');
import {
  withDefinedProperty,
} from './entity-core-boundary';
import { computeEntityAccountValueHash } from '../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../entity/state/persistent-account-map';
import { PersistentEntityCollectionMap } from '../../entity/state/persistent-collection-map';

export const hydrateAccountDocFromStorage = (doc: StorageAccountDoc): AccountReplica => {
  assertAccountMempoolWithinLimit(doc, 'storage.account.mempool');
  doc.state.leftPendingJClaims = assertAccountJClaimAccumulatorState(doc.state.leftPendingJClaims);
  doc.state.rightPendingJClaims = assertAccountJClaimAccumulatorState(doc.state.rightPendingJClaims);
  hydrationLog.debug('account.ownership_transferred', {
    from: doc.proofHeader.fromEntity,
    to: doc.proofHeader.toEntity,
    height: doc.currentHeight,
  });
  return doc;
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

  if (core.consumptionAccumulator) assertConsumptionAccumulatorState(core.consumptionAccumulator);
  if (core.certifiedOutputSequences) {
    if (!(core.certifiedOutputSequences instanceof Map)) {
      throw new Error('STORAGE_CERTIFIED_OUTPUT_SEQUENCES_INVALID');
    }
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
      computeEntityAccountValueHash,
    ),
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    ...withDefinedProperty('jHistoryFinality', core.jHistoryFinality),
    ...withDefinedProperty('certifiedBoardState', core.certifiedBoardState),
    profile: core.profile,
    htlcRoutes: PersistentEntityCollectionMap.from(core.htlcRoutes),
    htlcFeesEarned: core.htlcFeesEarned,
    lockBook: PersistentEntityCollectionMap.from(core.lockBook),
    ...withDefinedProperty('prevFrameHash', core.prevFrameHash),
    ...withDefinedProperty('leaderState', core.leaderState),
    ...withDefinedProperty('deferredAccountProposals', core.deferredAccountProposals),
    ...withDefinedProperty('settlementContinuations', core.settlementContinuations),
    ...withDefinedProperty('crontabState', core.crontabState),
    ...withDefinedProperty('jBatchState', core.jBatchState),
    ...withDefinedProperty('entityProviderActionState', core.entityProviderActionState),
    ...withDefinedProperty('consumptionAccumulator', core.consumptionAccumulator),
    ...withDefinedProperty('certifiedOutputSequences', core.certifiedOutputSequences),
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
      'pendingCrossJurisdictionFillAcks',
      core.pendingCrossJurisdictionFillAcks && PersistentEntityCollectionMap.from(core.pendingCrossJurisdictionFillAcks),
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
