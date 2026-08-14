import { rebuildOrderbookPairIndex, type BookState, type OrderbookExtState } from '../../orderbook';
import type { AccountReplica } from '../../types/account';
import type { EntityState } from '../../entity/types';
import type { StorageAccountDoc, StorageEntityCoreDoc } from '../types';
import { assertAccountMempoolWithinLimit } from '../../account/input/mempool';
import { assertAccountJClaimAccumulatorState } from '../../account/j-claims/j-claim-accumulator';
import { assertEntityAccountCountWithinLimit } from '../../entity/account/account-capacity';
import { assertConsumptionAccumulatorState } from '../../entity/consumption/consumption-accumulator';
import { LIMITS } from '../../config/constants';
import { assertJBatchWithinContractLimits } from '../../jurisdiction/machine/batch';
import { cloneAccountReplica } from '../../account/state/state-clone';
import {
  cloneStoredCrossJurisdictionBookAdmissions,
  cloneStoredCrossJurisdictionRoutes,
  cloneStoredPendingCrossJurisdictionFillAcks,
  withDefinedProperty,
} from './entity-core-boundary';

export const hydrateAccountDocFromStorage = (doc: StorageAccountDoc): AccountReplica => {
  assertAccountMempoolWithinLimit(doc, 'storage.account.mempool');
  const account = cloneAccountReplica(doc, true);
  account.state.leftPendingJClaims = assertAccountJClaimAccumulatorState(account.state.leftPendingJClaims);
  account.state.rightPendingJClaims = assertAccountJClaimAccumulatorState(account.state.rightPendingJClaims);
  return account;
};

export const hydrateEntityStateFromStorage = (options: {
  core: StorageEntityCoreDoc;
  accounts: Map<string, StorageAccountDoc>;
  books: Map<string, BookState>;
}): EntityState => {
  const { core, accounts, books } = options;
  assertEntityAccountCountWithinLimit(accounts, `storage.entity:${core.entityId}`);
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
    if (core.certifiedOutputSequences.size > LIMITS.MAX_ACCOUNTS_PER_ENTITY) {
      throw new Error(
        `STORAGE_CERTIFIED_OUTPUT_RELATIONSHIP_LIMIT_EXCEEDED:` +
        `${core.certifiedOutputSequences.size}:${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
      );
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
    accounts: new Map(Array.from(accounts.entries()).map(([key, value]) => [key, hydrateAccountDocFromStorage(value)])),
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    jBlockChain: core.jBlockChain,
    ...withDefinedProperty('jHistoryFinality', core.jHistoryFinality),
    ...withDefinedProperty('certifiedBoardState', core.certifiedBoardState),
    profile: core.profile,
    htlcRoutes: core.htlcRoutes,
    htlcFeesEarned: core.htlcFeesEarned,
    lockBook: core.lockBook,
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
    ...withDefinedProperty('crossJurisdictionSwaps', cloneStoredCrossJurisdictionRoutes(core.crossJurisdictionSwaps)),
    ...withDefinedProperty('crossJurisdictionAuthorizations', cloneStoredCrossJurisdictionRoutes(core.crossJurisdictionAuthorizations)),
    ...withDefinedProperty('pendingCrossJurisdictionFillAcks', cloneStoredPendingCrossJurisdictionFillAcks(core.pendingCrossJurisdictionFillAcks)),
    ...withDefinedProperty('crossJurisdictionBookAdmissions', cloneStoredCrossJurisdictionBookAdmissions(core.crossJurisdictionBookAdmissions)),
    ...withDefinedProperty('hubRebalanceConfig', core.hubRebalanceConfig),
    ...withDefinedProperty('lending', core.lending),
  };
};

export type { BookState };
