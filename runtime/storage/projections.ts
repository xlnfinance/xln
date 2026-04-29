import { rebuildOrderbookPairIndex, type BookState, type OrderbookExtState } from '../orderbook';
import type { AccountMachine, EntityReplica, EntityState } from '../types';
import { encodeBuffer } from './codec';
import { DEFAULT_ACCOUNT_MERKLE_RADIX, normalizeEntityId } from './keys';
import { buildHexKeyedMerkle, type RadixMerkleRadix } from './merkle';
import type { StorageAccountDoc, StorageEntityCoreDoc, StorageReplicaMeta } from './types';

const withProp = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

export const projectEntityCoreDoc = (
  state: EntityState,
  replica?: Pick<EntityReplica, 'signerId' | 'isProposer'>,
): StorageEntityCoreDoc => ({
  entityId: state.entityId,
  ...withProp('signerId', replica?.signerId ? normalizeEntityId(replica.signerId) : undefined),
  ...withProp('isProposer', typeof replica?.isProposer === 'boolean' ? replica.isProposer : undefined),
  height: state.height,
  timestamp: state.timestamp,
  messages: state.messages,
  nonces: state.nonces,
  proposals: state.proposals,
  config: state.config,
  reserves: state.reserves,
  lastFinalizedJHeight: state.lastFinalizedJHeight,
  jBlockObservations: state.jBlockObservations,
  jBlockChain: state.jBlockChain,
  entityEncPubKey: state.entityEncPubKey,
  entityEncPrivKey: state.entityEncPrivKey,
  profile: state.profile,
  htlcRoutes: state.htlcRoutes,
  htlcFeesEarned: state.htlcFeesEarned,
  lockBook: state.lockBook,
  ...withProp('prevFrameHash', state.prevFrameHash),
  ...withProp('deferredAccountProposals', state.deferredAccountProposals),
  ...withProp('accountInputQueue', state.accountInputQueue),
  ...withProp('crontabState', state.crontabState),
  ...withProp('batchHistory', state.batchHistory),
  ...withProp('jBatchState', state.jBatchState),
  ...withProp('htlcNotes', state.htlcNotes),
  ...withProp('outDebtsByToken', state.outDebtsByToken),
  ...withProp('inDebtsByToken', state.inDebtsByToken),
  ...withProp('swapTradingPairs', state.swapTradingPairs),
  ...withProp('pendingSwapFillRatios', state.pendingSwapFillRatios),
  ...withProp('hubRebalanceConfig', state.hubRebalanceConfig),
  ...withProp('orderbookHubProfile', state.orderbookExt?.hubProfile),
  ...withProp('orderbookReferrals', state.orderbookExt?.referrals),
});

const cloneHankoWitness = (hankoWitness?: EntityReplica['hankoWitness']): EntityReplica['hankoWitness'] | undefined => {
  if (!(hankoWitness instanceof Map) || hankoWitness.size === 0) return undefined;
  return new Map(
    Array.from(hankoWitness.entries()).map(([hash, entry]) => [
      String(hash),
      {
        hanko: entry.hanko,
        type: entry.type,
        entityHeight: entry.entityHeight,
        createdAt: entry.createdAt,
      },
    ]),
  );
};

export const projectReplicaMeta = (replica: EntityReplica): StorageReplicaMeta => ({
  entityId: normalizeEntityId(replica.entityId),
  signerId: normalizeEntityId(replica.signerId),
  isProposer: replica.isProposer,
  ...withProp('proposal', replica.proposal),
  ...withProp('lockedFrame', replica.lockedFrame),
  ...withProp('validatorComputedState', replica.validatorComputedState),
  ...withProp('hankoWitness', cloneHankoWitness(replica.hankoWitness)),
});

const projectAccountDocFull = (account: AccountMachine): StorageAccountDoc => ({
  leftEntity: account.leftEntity,
  rightEntity: account.rightEntity,
  status: account.status,
  mempool: account.mempool,
  currentFrame: account.currentFrame,
  deltas: account.deltas,
  locks: account.locks,
  swapOffers: account.swapOffers,
  globalCreditLimits: account.globalCreditLimits,
  currentHeight: account.currentHeight,
  pendingSignatures: account.pendingSignatures,
  rollbackCount: account.rollbackCount,
  leftJObservations: account.leftJObservations,
  rightJObservations: account.rightJObservations,
  jEventChain: account.jEventChain,
  lastFinalizedJHeight: account.lastFinalizedJHeight,
  proofHeader: account.proofHeader,
  proofBody: account.proofBody,
  disputeConfig: account.disputeConfig,
  onChainSettlementNonce: account.onChainSettlementNonce,
  pendingWithdrawals: account.pendingWithdrawals,
  requestedRebalance: account.requestedRebalance,
  requestedRebalanceFeeState: account.requestedRebalanceFeeState,
  rebalancePolicy: account.rebalancePolicy,
  ...withProp('pendingFrame', account.pendingFrame),
  ...withProp('pendingAccountInput', account.pendingAccountInput),
  ...withProp('lastRollbackFrameHash', account.lastRollbackFrameHash),
  ...withProp('abiProofBody', account.abiProofBody),
  ...withProp('currentFrameHanko', account.currentFrameHanko),
  ...withProp('counterpartyFrameHanko', account.counterpartyFrameHanko),
  ...withProp('currentDisputeProofHanko', account.currentDisputeProofHanko),
  ...withProp('currentDisputeProofNonce', account.currentDisputeProofNonce),
  ...withProp('currentDisputeProofBodyHash', account.currentDisputeProofBodyHash),
  ...withProp('currentDisputeHash', account.currentDisputeHash),
  ...withProp('counterpartyDisputeProofHanko', account.counterpartyDisputeProofHanko),
  ...withProp('counterpartyDisputeProofNonce', account.counterpartyDisputeProofNonce),
  ...withProp('counterpartyDisputeProofBodyHash', account.counterpartyDisputeProofBodyHash),
  ...withProp('counterpartyDisputeHash', account.counterpartyDisputeHash),
  ...withProp('counterpartySettlementHanko', account.counterpartySettlementHanko),
  ...withProp('disputeProofNoncesByHash', account.disputeProofNoncesByHash),
  ...withProp('disputeProofBodiesByHash', account.disputeProofBodiesByHash),
  ...withProp('settlementWorkspace', account.settlementWorkspace),
  ...withProp('activeDispute', account.activeDispute),
  ...withProp('swapOrderHistory', account.swapOrderHistory),
  ...withProp('swapClosedOrders', account.swapClosedOrders),
  ...withProp('counterpartyRebalanceFeePolicy', account.counterpartyRebalanceFeePolicy),
  ...withProp('activeRebalanceQuote', account.activeRebalanceQuote),
  ...withProp('pendingRebalanceRequest', account.pendingRebalanceRequest),
});

export const projectAccountDoc = (account: AccountMachine): StorageAccountDoc => {
  // Historical account frames are not future-consensus state. They are written
  // to the frame DB by deterministic keys and intentionally omitted here.
  return projectAccountDocFull(account);
};

export const buildAccountMerkleFromDocs = (
  accounts: ReadonlyMap<string, StorageAccountDoc>,
  radix: RadixMerkleRadix = DEFAULT_ACCOUNT_MERKLE_RADIX,
) => {
  return buildHexKeyedMerkle(
    Array.from(accounts.entries()).map(([counterpartyId, doc]) => ({
      hexKey: counterpartyId,
      value: encodeBuffer(doc),
    })),
    { radix },
  );
};

export const buildAccountMerkleFromState = (
  accounts: ReadonlyMap<string, AccountMachine>,
  radix: RadixMerkleRadix = DEFAULT_ACCOUNT_MERKLE_RADIX,
) => {
  return buildHexKeyedMerkle(
    Array.from(accounts.entries()).map(([counterpartyId, account]) => ({
      hexKey: counterpartyId,
      value: encodeBuffer(projectAccountDoc(account)),
    })),
    { radix },
  );
};

const hydrateAccountDoc = (doc: StorageAccountDoc): AccountMachine => ({
  leftEntity: doc.leftEntity,
  rightEntity: doc.rightEntity,
  status: doc.status,
  mempool: doc.mempool,
  currentFrame: doc.currentFrame,
  deltas: doc.deltas,
  locks: doc.locks,
  swapOffers: doc.swapOffers,
  globalCreditLimits: doc.globalCreditLimits,
  currentHeight: doc.currentHeight,
  pendingSignatures: doc.pendingSignatures,
  rollbackCount: doc.rollbackCount,
  leftJObservations: doc.leftJObservations ?? [],
  rightJObservations: doc.rightJObservations ?? [],
  jEventChain: doc.jEventChain ?? [],
  lastFinalizedJHeight: doc.lastFinalizedJHeight,
  proofHeader: doc.proofHeader,
  proofBody: doc.proofBody,
  disputeConfig: doc.disputeConfig,
  onChainSettlementNonce: doc.onChainSettlementNonce,
  pendingWithdrawals: doc.pendingWithdrawals ?? new Map(),
  requestedRebalance: doc.requestedRebalance ?? new Map(),
  requestedRebalanceFeeState: doc.requestedRebalanceFeeState ?? new Map(),
  rebalancePolicy: doc.rebalancePolicy ?? new Map(),
  swapOrderHistory: doc.swapOrderHistory ?? new Map(),
  swapClosedOrders: doc.swapClosedOrders ?? new Map(),
  ...withProp('pendingFrame', doc.pendingFrame),
  ...withProp('pendingAccountInput', doc.pendingAccountInput),
  ...withProp('lastRollbackFrameHash', doc.lastRollbackFrameHash),
  ...withProp('abiProofBody', doc.abiProofBody),
  ...withProp('currentFrameHanko', doc.currentFrameHanko),
  ...withProp('counterpartyFrameHanko', doc.counterpartyFrameHanko),
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
  ...withProp('settlementWorkspace', doc.settlementWorkspace),
  ...withProp('activeDispute', doc.activeDispute),
  ...withProp('counterpartyRebalanceFeePolicy', doc.counterpartyRebalanceFeePolicy),
  ...withProp('activeRebalanceQuote', doc.activeRebalanceQuote),
  ...withProp('pendingRebalanceRequest', doc.pendingRebalanceRequest),
});

export const hydrateEntityStateFromStorage = (options: {
  core: StorageEntityCoreDoc;
  accounts: Map<string, StorageAccountDoc>;
  books: Map<string, BookState>;
}): EntityState => {
  const { core, accounts, books } = options;
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

  return {
    entityId: core.entityId,
    height: core.height,
    timestamp: core.timestamp,
    nonces: core.nonces ?? new Map(),
    messages: core.messages ?? [],
    proposals: core.proposals ?? new Map(),
    config: core.config,
    reserves: core.reserves ?? new Map(),
    accounts: new Map(Array.from(accounts.entries()).map(([key, value]) => [key, hydrateAccountDoc(value)])),
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    jBlockObservations: core.jBlockObservations ?? [],
    jBlockChain: core.jBlockChain ?? [],
    entityEncPubKey: core.entityEncPubKey,
    entityEncPrivKey: core.entityEncPrivKey,
    profile: core.profile,
    htlcRoutes: core.htlcRoutes ?? new Map(),
    htlcFeesEarned: core.htlcFeesEarned,
    lockBook: core.lockBook ?? new Map(),
    ...withProp('prevFrameHash', core.prevFrameHash),
    ...withProp('deferredAccountProposals', core.deferredAccountProposals),
    ...withProp('accountInputQueue', core.accountInputQueue),
    ...withProp('crontabState', core.crontabState),
    ...withProp('batchHistory', core.batchHistory),
    ...withProp('jBatchState', core.jBatchState),
    ...withProp('htlcNotes', core.htlcNotes),
    ...withProp('outDebtsByToken', core.outDebtsByToken),
    ...withProp('inDebtsByToken', core.inDebtsByToken),
    ...withProp('orderbookExt', orderbookExt),
    ...withProp('swapTradingPairs', core.swapTradingPairs),
    ...withProp('pendingSwapFillRatios', core.pendingSwapFillRatios),
    ...withProp('hubRebalanceConfig', core.hubRebalanceConfig),
  };
};
