import { rebuildOrderbookPairIndex, type BookState, type OrderbookExtState } from '../orderbook';
import type { AccountMachine, EntityReplica, EntityState } from '../types';
import {
  cloneCrossJurisdictionBookAdmission,
  cloneCrossJurisdictionAccountFrameRoute,
  cloneCrossJurisdictionAccountInputRoute,
  cloneCrossJurisdictionAccountTxRoute,
  cloneCrossJurisdictionRoute,
  cloneCrossJurisdictionSwapHistoryRoute,
  cloneCrossJurisdictionSwapOfferRoute,
} from '../extensions/cross-j/index';
import type { StorageAccountDoc, StorageEntityCoreDoc } from './types';
import { assertAccountMempoolWithinLimit } from '../account/mempool';
import { assertAccountJClaimAccumulatorState } from '../account/j-claim-accumulator';
import { assertEntityAccountCountWithinLimit } from '../entity/account-capacity';
import { assertConsumptionAccumulatorState } from '../entity/consumption-accumulator';
import { LIMITS } from '../constants';
import { assertJBatchWithinContractLimits } from '../jurisdiction/batch';

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

const publicSwapOffers = (offers: AccountMachine['swapOffers']): AccountMachine['swapOffers'] =>
  new Map(Array.from(offers.entries()).map(([id, offer]) => [
    id,
    cloneCrossJurisdictionSwapOfferRoute(offer),
  ]));

const publicSwapHistory = (history: AccountMachine['swapOrderHistory']): AccountMachine['swapOrderHistory'] =>
  history instanceof Map
    ? new Map(Array.from(history.entries()).map(([id, entry]) => [
        id,
        cloneCrossJurisdictionSwapHistoryRoute(entry),
      ]))
    : history;

export const hydrateAccountDocFromStorage = (doc: StorageAccountDoc): AccountMachine => {
  assertAccountMempoolWithinLimit(doc, 'storage.account.mempool');
  return {
  leftEntity: doc.leftEntity,
  rightEntity: doc.rightEntity,
  domain: structuredClone(doc.domain),
  watchSeed: doc.watchSeed,
  status: doc.status,
  mempool: doc.mempool.map(cloneCrossJurisdictionAccountTxRoute),
  currentFrame: cloneCrossJurisdictionAccountFrameRoute(doc.currentFrame),
  deltas: doc.deltas,
  locks: doc.locks,
  swapOffers: publicSwapOffers(doc.swapOffers),
  ...withProp('pulls', doc.pulls),
  ...withProp('subcontracts', doc.subcontracts),
  ...withProp('lendingIntents', doc.lendingIntents),
  globalCreditLimits: doc.globalCreditLimits,
  currentHeight: doc.currentHeight,
  pendingSignatures: doc.pendingSignatures,
  rollbackCount: doc.rollbackCount,
  leftPendingJClaims: assertAccountJClaimAccumulatorState(doc.leftPendingJClaims),
  rightPendingJClaims: assertAccountJClaimAccumulatorState(doc.rightPendingJClaims),
  lastFinalizedJHeight: doc.lastFinalizedJHeight,
  proofHeader: doc.proofHeader,
  proofBody: doc.proofBody,
  disputeConfig: doc.disputeConfig,
  jNonce: doc.jNonce,
  pendingWithdrawals: doc.pendingWithdrawals,
  requestedRebalance: doc.requestedRebalance,
  requestedRebalanceFeeState: doc.requestedRebalanceFeeState,
  shadow: doc.shadow,
  ...withProp('swapOrderHistory', publicSwapHistory(doc.swapOrderHistory)),
  ...withProp('swapClosedOrders', publicSwapHistory(doc.swapClosedOrders)),
  ...withProp('pendingFrame', doc.pendingFrame ? cloneCrossJurisdictionAccountFrameRoute(doc.pendingFrame) : undefined),
  ...withProp('pendingAccountInput', doc.pendingAccountInput ? cloneCrossJurisdictionAccountInputRoute(doc.pendingAccountInput) : undefined),
  ...withProp('pendingAccountInputSignerId', doc.pendingAccountInputSignerId),
  ...withProp('lastOutboundFrameAck', doc.lastOutboundFrameAck),
  ...withProp('pendingForwards', doc.pendingForwards),
  ...withProp('hankoSignature', doc.hankoSignature),
  ...withProp('lastRollbackFrameHash', doc.lastRollbackFrameHash),
  ...withProp('abiProofBody', doc.abiProofBody),
  ...withProp('currentFrameHanko', doc.currentFrameHanko),
  ...withProp('counterpartyFrameHanko', doc.counterpartyFrameHanko),
  ...withProp('boardResealMigration', doc.boardResealMigration),
  ...withProp('counterpartyBoardReseal', doc.counterpartyBoardReseal),
  ...withProp('currentDisputeProofHanko', doc.currentDisputeProofHanko),
  ...withProp('currentDisputeProofNonce', doc.currentDisputeProofNonce),
  ...withProp('currentDisputeProofBodyHash', doc.currentDisputeProofBodyHash),
  ...withProp('currentDisputeHash', doc.currentDisputeHash),
  ...withProp('counterpartyDisputeProofHanko', doc.counterpartyDisputeProofHanko),
  ...withProp('counterpartyDisputeProofNonce', doc.counterpartyDisputeProofNonce),
  ...withProp('counterpartyDisputeProofBodyHash', doc.counterpartyDisputeProofBodyHash),
  ...withProp('counterpartyDisputeHash', doc.counterpartyDisputeHash),
  ...withProp('counterpartySettlementHanko', doc.counterpartySettlementHanko),
  ...withProp('disputeProofNoncesByHash', doc.disputeProofNoncesByHash),
  ...withProp('disputeProofBodiesByHash', doc.disputeProofBodiesByHash),
  ...withProp('disputeArgumentSnapshotsByHash', doc.disputeArgumentSnapshotsByHash),
  ...withProp('disputePrepare', doc.disputePrepare),
  ...withProp('settlementWorkspace', doc.settlementWorkspace),
  ...withProp('activeDispute', doc.activeDispute),
  ...withProp('rebalanceFeePolicies', doc.rebalanceFeePolicies),
  };
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
    orderbookExt = {
      books,
      orderPairs: new Map(),
      referrals: core.orderbookReferrals ?? new Map(),
      hubProfile: core.orderbookHubProfile ?? {
        entityId: core.entityId,
        name: core.profile.name || core.entityId.slice(-8),
        spreadDistribution: { makerBps: 0, takerBps: 10000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [],
      },
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
  }

  return {
    entityId: core.entityId,
    height: core.height,
    timestamp: core.timestamp,
    nonces: core.nonces,
    ...withProp('entityCommandNonces', core.entityCommandNonces),
    messages: core.messages,
    proposals: core.proposals,
    config: core.config,
    reserves: core.reserves,
    ...withProp('externalWallet', core.externalWallet),
    accounts: new Map(Array.from(accounts.entries()).map(([key, value]) => [key, hydrateAccountDocFromStorage(value)])),
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    jBlockChain: core.jBlockChain,
    ...withProp('jHistoryFinality', core.jHistoryFinality),
    ...withProp('certifiedBoardState', core.certifiedBoardState),
    // Entity encryption keys are validator-local identity material. Latest
    // restore overlays the exact values from StorageReplicaMeta; historical
    // shared state deliberately has no validator-local key owner.
    entityEncPubKey: '',
    entityEncPrivKey: '',
    ...withProp('profileEncryptionManifest', core.profileEncryptionManifest),
    profile: core.profile,
    htlcRoutes: core.htlcRoutes,
    htlcFeesEarned: core.htlcFeesEarned,
    lockBook: core.lockBook,
    ...withProp('prevFrameHash', core.prevFrameHash),
    ...withProp('leaderState', core.leaderState),
    ...withProp('deferredAccountProposals', core.deferredAccountProposals),
    ...withProp('accountInputQueue', core.accountInputQueue),
    ...withProp('crontabState', core.crontabState),
    ...withProp('batchHistory', core.batchHistory),
    ...withProp('jBatchState', core.jBatchState),
    ...withProp('entityProviderActionState', core.entityProviderActionState),
    ...withProp('consumptionAccumulator', core.consumptionAccumulator),
    ...withProp('certifiedOutputSequences', core.certifiedOutputSequences),
    ...withProp('outDebtsByToken', core.outDebtsByToken),
    ...withProp('inDebtsByToken', core.inDebtsByToken),
    ...withProp('orderbookExt', orderbookExt),
    ...withProp('swapTradingPairs', core.swapTradingPairs),
    ...withProp('pendingSwapFillRatios', core.pendingSwapFillRatios),
    ...withProp('crossJurisdictionSwaps', publicCrossJurisdictionSwaps(core.crossJurisdictionSwaps)),
    ...withProp('pendingCrossJurisdictionFillAcks', publicPendingCrossJurisdictionFillAcks(core.pendingCrossJurisdictionFillAcks)),
    ...withProp('crossJurisdictionBookAdmissions', publicCrossJurisdictionBookAdmissions(core.crossJurisdictionBookAdmissions)),
    ...withProp('hubRebalanceConfig', core.hubRebalanceConfig),
    ...withProp('lending', core.lending),
  };
};

export type { BookState, EntityReplica };
