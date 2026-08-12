import { rebuildOrderbookPairIndex, type BookState, type OrderbookExtState } from '../../orderbook';
import type { AccountReplica } from '../../types/account';
import type { EntityState } from '../../entity/types';
import {
  cloneCrossJurisdictionBookAdmission,
  cloneCrossJurisdictionAccountTxRoute,
  cloneCrossJurisdictionRoute,
} from '../../extensions/cross-j/index';
import type { StorageAccountDoc, StorageEntityCoreDoc } from '../types';
import { assertAccountMempoolWithinLimit } from '../../account/input/mempool';
import { assertAccountJClaimAccumulatorState } from '../../account/j-claims/j-claim-accumulator';
import { assertEntityAccountCountWithinLimit } from '../../entity/account/account-capacity';
import { assertConsumptionAccumulatorState } from '../../entity/consumption/consumption-accumulator';
import { LIMITS } from '../../config/constants';
import { assertJBatchWithinContractLimits } from '../../jurisdiction/machine/batch';
import { cloneAccountReplica } from '../../account/state/state-clone';

const withProp = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const publicCrossJurisdictionSwaps = (swaps: EntityState['crossJurisdictionSwaps']): EntityState['crossJurisdictionSwaps'] | undefined =>
  swaps ? new Map(Array.from(swaps.entries()).map(([id, route]) => [id, cloneCrossJurisdictionRoute(route)])) : undefined;

const publicCrossJurisdictionBookAdmissions = (
  admissions: EntityState['crossJurisdictionBookAdmissions'],
): EntityState['crossJurisdictionBookAdmissions'] | undefined =>
  admissions ? new Map(Array.from(admissions.entries()).map(([id, admission]) => [
    id,
    cloneCrossJurisdictionBookAdmission(admission),
  ])) : undefined;

const publicPendingCrossJurisdictionFillAcks = (
  pendingAcks: EntityState['pendingCrossJurisdictionFillAcks'],
): EntityState['pendingCrossJurisdictionFillAcks'] | undefined =>
  pendingAcks ? new Map(Array.from(pendingAcks.entries()).map(([id, pending]) => [
    id,
    {
      ...pending,
      tx: cloneCrossJurisdictionAccountTxRoute(pending.tx) as typeof pending.tx,
    },
  ])) : undefined;

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
  if (books.size > 0 || core.orderbookHubProfile || core.orderbookReferrals) {
    if (!core.orderbookHubProfile) {
      throw new Error(`STORAGE_ORDERBOOK_HUBPROFILE_MISSING:${core.entityId}`);
    }
    orderbookExt = {
      books,
      orderPairs: new Map(),
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
    ...withProp('entityCommandNonces', core.entityCommandNonces),
    proposals: core.proposals,
    config: core.config,
    reserves: core.reserves,
    ...withProp('externalWallet', core.externalWallet),
    accounts: new Map(Array.from(accounts.entries()).map(([key, value]) => [key, hydrateAccountDocFromStorage(value)])),
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    jBlockChain: core.jBlockChain,
    ...withProp('jHistoryFinality', core.jHistoryFinality),
    ...withProp('certifiedBoardState', core.certifiedBoardState),
    ...withProp('profileEncryptionManifest', core.profileEncryptionManifest),
    profile: core.profile,
    htlcRoutes: core.htlcRoutes,
    htlcFeesEarned: core.htlcFeesEarned,
    lockBook: core.lockBook,
    ...withProp('prevFrameHash', core.prevFrameHash),
    ...withProp('leaderState', core.leaderState),
    ...withProp('deferredAccountProposals', core.deferredAccountProposals),
    ...withProp('settlementContinuations', core.settlementContinuations),
    ...withProp('crontabState', core.crontabState),
    ...withProp('jBatchState', core.jBatchState),
    ...withProp('entityProviderActionState', core.entityProviderActionState),
    ...withProp('consumptionAccumulator', core.consumptionAccumulator),
    ...withProp('certifiedOutputSequences', core.certifiedOutputSequences),
    ...withProp('outDebtsByToken', core.outDebtsByToken),
    ...withProp('inDebtsByToken', core.inDebtsByToken),
    ...withProp('orderbookExt', orderbookExt),
    ...withProp('swapTradingPairs', core.swapTradingPairs),
    ...withProp('crossJurisdictionSwaps', publicCrossJurisdictionSwaps(core.crossJurisdictionSwaps)),
    ...withProp('crossJurisdictionAuthorizations', publicCrossJurisdictionSwaps(core.crossJurisdictionAuthorizations)),
    ...withProp('pendingCrossJurisdictionFillAcks', publicPendingCrossJurisdictionFillAcks(core.pendingCrossJurisdictionFillAcks)),
    ...withProp('crossJurisdictionBookAdmissions', publicCrossJurisdictionBookAdmissions(core.crossJurisdictionBookAdmissions)),
    ...withProp('hubRebalanceConfig', core.hubRebalanceConfig),
    ...withProp('lending', core.lending),
  };
};

export type { BookState };
