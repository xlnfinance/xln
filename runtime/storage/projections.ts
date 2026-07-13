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
import { encodeBuffer } from './codec';
import { DEFAULT_ACCOUNT_MERKLE_RADIX, normalizeEntityId } from './keys';
import { buildHexKeyedMerkle, type RadixMerkleRadix } from './merkle';
import type { StorageAccountDoc, StorageEntityCoreDoc, StorageReplicaMeta } from './types';

export {
  hydrateAccountDocFromStorage,
  hydrateEntityStateFromStorage,
} from './hydration';

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
  new Map(Array.from((offers ?? new Map()).entries()).map(([id, offer]) => [
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
  ...withProp('externalWallet', state.externalWallet),
  lastFinalizedJHeight: state.lastFinalizedJHeight,
  jBlockObservations: state.jBlockObservations,
  jBlockChain: state.jBlockChain,
  ...withProp('jHistoryCheckpoints', state.jHistoryCheckpoints),
  ...withProp('jHistoryFinality', state.jHistoryFinality),
  entityEncPubKey: state.entityEncPubKey,
  entityEncPrivKey: state.entityEncPrivKey,
  profile: state.profile,
  htlcRoutes: state.htlcRoutes,
  htlcFeesEarned: state.htlcFeesEarned,
  lockBook: state.lockBook,
  ...withProp('prevFrameHash', state.prevFrameHash),
  ...withProp('leaderState', state.leaderState),
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
  ...withProp('crossJurisdictionSwaps', publicCrossJurisdictionSwaps(state.crossJurisdictionSwaps)),
  ...withProp('pendingCrossJurisdictionFillAcks', publicPendingCrossJurisdictionFillAcks(state.pendingCrossJurisdictionFillAcks)),
  ...withProp('crossJurisdictionBookAdmissions', publicCrossJurisdictionBookAdmissions(state.crossJurisdictionBookAdmissions)),
  ...withProp('hubRebalanceConfig', state.hubRebalanceConfig),
  ...withProp('orderbookHubProfile', state.orderbookExt?.hubProfile),
  ...withProp('orderbookReferrals', state.orderbookExt?.referrals),
  ...withProp('lending', state.lending),
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
  ...withProp('mempool', replica.mempool),
  ...withProp('position', replica.position),
  ...withProp('proposal', replica.proposal),
  ...withProp('lockedFrame', replica.lockedFrame),
  ...withProp('validatorComputedState', replica.validatorComputedState),
  ...withProp('hankoWitness', cloneHankoWitness(replica.hankoWitness)),
  ...withProp('leaderVotes', replica.leaderVotes),
  ...withProp('pendingLeaderCertificate', replica.pendingLeaderCertificate),
  ...withProp('lastConsensusProgressAt', replica.lastConsensusProgressAt),
});

const projectAccountDocFull = (account: AccountMachine): StorageAccountDoc => ({
  leftEntity: account.leftEntity,
  rightEntity: account.rightEntity,
  watchSeed: account.watchSeed,
  status: account.status,
  mempool: account.mempool.map(cloneCrossJurisdictionAccountTxRoute),
  currentFrame: cloneCrossJurisdictionAccountFrameRoute(account.currentFrame),
  deltas: account.deltas,
  locks: account.locks,
  swapOffers: publicSwapOffers(account.swapOffers),
  pulls: account.pulls,
  ...withProp('subcontracts', account.subcontracts),
  ...withProp('lendingIntents', account.lendingIntents),
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
  jNonce: account.jNonce,
  pendingWithdrawals: account.pendingWithdrawals,
  requestedRebalance: account.requestedRebalance,
  requestedRebalanceFeeState: account.requestedRebalanceFeeState,
  shadow: account.shadow,
  ...withProp('pendingFrame', account.pendingFrame ? cloneCrossJurisdictionAccountFrameRoute(account.pendingFrame) : undefined),
  ...withProp('pendingAccountInput', account.pendingAccountInput ? cloneCrossJurisdictionAccountInputRoute(account.pendingAccountInput) : undefined),
  ...withProp('lastOutboundFrameAck', account.lastOutboundFrameAck),
  ...withProp('pendingForward', account.pendingForward),
  ...withProp('hankoSignature', account.hankoSignature),
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
  ...withProp('disputeArgumentSnapshotsByHash', account.disputeArgumentSnapshotsByHash),
  ...withProp('disputePrepare', account.disputePrepare),
  ...withProp('settlementWorkspace', account.settlementWorkspace),
  ...withProp('activeDispute', account.activeDispute),
  ...withProp('swapOrderHistory', publicSwapHistory(account.swapOrderHistory)),
  ...withProp('swapClosedOrders', publicSwapHistory(account.swapClosedOrders)),
  ...withProp('counterpartyRebalanceFeePolicy', account.counterpartyRebalanceFeePolicy),
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
