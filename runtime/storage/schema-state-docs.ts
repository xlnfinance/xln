import type { BookState } from '../orderbook';
import { validateBookStructure } from '../orderbook/validity';
import { verifyAndWarmBookCommitment } from '../orderbook/commitment';
import { validateAccountReplica } from '../account/state-validation';
import {
  assertPersistedAccountReplicaIntegrity,
  type PersistedAccountHankoVerifier,
} from '../account/persisted-integrity';
import { validateEntityState } from '../entity/state-validation';
import { LIMITS } from '../config/constants';
import type { StorageAccountDoc, StorageEntityCoreDoc } from './types';
import { normalizeEntityId } from './keys';
import { validateSettlementContinuationValue } from '../entity/account-metadata-validation';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireStorageArray,
  requireStorageBigInt,
  requireStorageMap,
  requireStorageString,
} from './schema-primitives';

const ENTITY_REQUIRED = [
  'entityId', 'height', 'timestamp', 'nonces', 'proposals', 'config',
  'reserves', 'lastFinalizedJHeight', 'jBlockChain', 'profile', 'htlcRoutes',
  'htlcFeesEarned', 'lockBook',
] as const;

const ENTITY_OPTIONAL = [
  'entityCommandNonces', 'prevFrameHash', 'leaderState', 'externalWallet',
  'deferredAccountProposals', 'settlementContinuations', 'jHistoryFinality', 'certifiedBoardState',
  'crontabState', 'jBatchState', 'entityProviderActionState',
  'profileEncryptionManifest', 'consumptionAccumulator', 'certifiedOutputSequences',
  'outDebtsByToken', 'inDebtsByToken', 'swapTradingPairs',
  'crossJurisdictionSwaps', 'pendingCrossJurisdictionFillAcks',
  'crossJurisdictionBookAdmissions', 'hubRebalanceConfig', 'orderbookHubProfile',
  'orderbookReferrals', 'lending',
] as const;

const ACCOUNT_REPLICA_REQUIRED = [
  'state', 'status', 'mempool', 'currentFrame', 'currentHeight',
  'pendingSignatures', 'rollbackCount', 'proofHeader', 'proofBody',
  'pendingWithdrawals', 'shadow',
] as const;

const ACCOUNT_REPLICA_OPTIONAL = [
  'pendingFrame', 'pendingAccountInput',
  'lastOutboundFrameAck', 'pendingForwards', 'hankoSignature', 'lastRollbackFrameHash',
  'abiProofBody', 'currentFrameHanko', 'counterpartyFrameHanko', 'boardResealMigration',
  'counterpartyBoardReseal', 'currentDisputeProofHanko', 'currentDisputeProofNonce',
  'currentDisputeProofBodyHash', 'currentDisputeHash', 'counterpartyDisputeProofHanko',
  'counterpartyDisputeProofNonce', 'counterpartyDisputeProofBodyHash',
  'counterpartyDisputeHash', 'counterpartySettlementHanko', 'disputeProofNoncesByHash',
  'disputeProofBodiesByHash', 'disputeArgumentSnapshotsByHash', 'disputePrepare',
  'activeDispute', 'swapOrderHistory', 'swapClosedOrders',
] as const;

const ACCOUNT_STATE_REQUIRED = [
  'leftEntity', 'rightEntity', 'domain', 'watchSeed', 'deltas', 'locks',
  'swapOffers', 'globalCreditLimits', 'leftPendingJClaims', 'rightPendingJClaims',
  'lastFinalizedJHeight', 'disputeConfig', 'jNonce', 'requestedRebalance',
  'requestedRebalanceFeeState',
] as const;

const ACCOUNT_STATE_OPTIONAL = [
  'pulls', 'subcontracts', 'lendingIntents', 'settlementWorkspace',
  'rebalanceFeePolicies',
] as const;

export const validateStorageEntityCoreDocValue = (value: unknown): StorageEntityCoreDoc => {
  const code = 'STORAGE_ENTITY_DOC_INVALID';
  const doc = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(doc, ENTITY_REQUIRED, ENTITY_OPTIONAL, `${code}_FIELDS`);
  requireStorageString(doc['entityId'], `${code}_ENTITY_ID`);
  requireBoundaryInteger(doc['height'], `${code}_HEIGHT`);
  requireBoundaryInteger(doc['timestamp'], `${code}_TIMESTAMP`);
  requireStorageMap(doc['nonces'], `${code}_NONCES`);
  requireStorageMap(doc['proposals'], `${code}_PROPOSALS`);
  requireStorageMap(doc['reserves'], `${code}_RESERVES`);
  requireBoundaryInteger(doc['lastFinalizedJHeight'], `${code}_FINALIZED_J_HEIGHT`);
  requireStorageArray(doc['jBlockChain'], `${code}_J_BLOCK_CHAIN`);
  const profile = requireBoundaryRecord(doc['profile'], `${code}_PROFILE`);
  requireExactBoundaryKeys(profile, ['name', 'isHub', 'avatar', 'bio', 'website'], [], `${code}_PROFILE_FIELDS`);
  for (const key of ['name', 'avatar', 'bio', 'website']) {
    if (typeof profile[key] !== 'string') throw new Error(`${code}_PROFILE_${key}`);
  }
  if (typeof profile['isHub'] !== 'boolean') throw new Error(`${code}_PROFILE_IS_HUB`);
  requireStorageMap(doc['htlcRoutes'], `${code}_HTLC_ROUTES`);
  requireStorageBigInt(doc['htlcFeesEarned'], `${code}_HTLC_FEES`);
  requireStorageMap(doc['lockBook'], `${code}_LOCK_BOOK`);
  validateDeferredAccountProposals(doc['deferredAccountProposals'], code);
  validateSettlementContinuations(doc['settlementContinuations'], code);
  const {
    deferredAccountProposals: _splitAccountRefs,
    settlementContinuations: _splitSettlementContinuations,
    ...sharedCore
  } = doc;
  validateEntityState({ ...sharedCore, accounts: new Map() }, code);
  return doc as StorageEntityCoreDoc;
};

const validateSettlementContinuations = (value: unknown, code: string): void => {
  if (value === undefined) return;
  const continuations = requireStorageMap(value, `${code}_SETTLEMENT_CONTINUATIONS`);
  if (continuations.size > LIMITS.MAX_ACCOUNTS_PER_ENTITY) {
    throw new Error(`${code}_SETTLEMENT_CONTINUATIONS_LIMIT`);
  }
  for (const [accountId, continuation] of continuations) {
    if (!/^0x[0-9a-f]{64}$/.test(String(accountId))) {
      throw new Error(`${code}_SETTLEMENT_CONTINUATION_ACCOUNT_ID`);
    }
    validateSettlementContinuationValue(
      continuation,
      `${code}_SETTLEMENT_CONTINUATION`,
    );
  }
};

const validateDeferredAccountProposals = (value: unknown, code: string): void => {
  if (value === undefined) return;
  const proposals = requireStorageMap(value, `${code}_DEFERRED_ACCOUNTS`);
  if (proposals.size > LIMITS.MAX_ACCOUNTS_PER_ENTITY) throw new Error(`${code}_DEFERRED_ACCOUNTS_LIMIT`);
  for (const [accountId, workspaceHash] of proposals) {
    if (!/^0x[0-9a-f]{64}$/.test(String(accountId))) throw new Error(`${code}_DEFERRED_ACCOUNT_ID`);
    if (!/^0x[0-9a-f]{64}$/.test(String(workspaceHash))) throw new Error(`${code}_DEFERRED_WORKSPACE_HASH`);
  }
};

export const validateStorageAccountDocValue = (value: unknown): StorageAccountDoc => {
  const code = 'STORAGE_ACCOUNT_DOC_INVALID';
  const doc = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(doc, ACCOUNT_REPLICA_REQUIRED, ACCOUNT_REPLICA_OPTIONAL, `${code}_FIELDS`);
  const state = requireBoundaryRecord(doc['state'], `${code}_STATE`);
  requireExactBoundaryKeys(state, ACCOUNT_STATE_REQUIRED, ACCOUNT_STATE_OPTIONAL, `${code}_STATE_FIELDS`);
  return validateAccountReplica(doc, code);
};

function assertBookHeader(value: unknown): asserts value is BookState {
  const code = 'STORAGE_BOOK_DOC_INVALID';
  const book = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(book, [
    'params', 'orders', 'bidBuckets', 'askBuckets', 'bidBucketIdsDesc',
    'askBucketIdsAsc', 'nextSeq', 'tradeCount', 'tradeQtySum', 'eventHash',
  ], ['commitmentHash'], `${code}_FIELDS`);
  const params = requireBoundaryRecord(book['params'], `${code}_PARAMS`);
  requireExactBoundaryKeys(params, ['bucketWidthTicks', 'maxOrders', 'stpPolicy'], [], `${code}_PARAM_FIELDS`);
  requireStorageBigInt(params['bucketWidthTicks'], `${code}_BUCKET_WIDTH`, 1n);
  requireBoundaryInteger(params['maxOrders'], `${code}_MAX_ORDERS`, 1);
  if (params['stpPolicy'] !== 0 && params['stpPolicy'] !== 1) throw new Error(`${code}_STP_POLICY`);
  requireStorageMap(book['orders'], `${code}_ORDERS`);
  requireStorageMap(book['bidBuckets'], `${code}_BID_BUCKETS`);
  requireStorageMap(book['askBuckets'], `${code}_ASK_BUCKETS`);
  requireStorageArray(book['bidBucketIdsDesc'], `${code}_BID_IDS`);
  requireStorageArray(book['askBucketIdsAsc'], `${code}_ASK_IDS`);
  requireBoundaryInteger(book['nextSeq'], `${code}_NEXT_SEQ`);
  requireBoundaryInteger(book['tradeCount'], `${code}_TRADE_COUNT`);
  requireStorageBigInt(book['tradeQtySum'], `${code}_TRADE_QTY`);
  requireStorageBigInt(book['eventHash'], `${code}_EVENT_HASH`);
}

export const validateStorageBookDocValue = (value: unknown): BookState => {
  assertBookHeader(value);
  const report = validateBookStructure(value);
  if (!report.ok) throw new Error(`STORAGE_BOOK_DOC_STRUCTURE_INVALID:${report.errors.join('|')}`);
  verifyAndWarmBookCommitment(value, 'STORAGE_BOOK_DOC_COMMITMENT');
  return value;
};

export const assertStorageEntityDocBinding = (
  doc: StorageEntityCoreDoc,
  expectedEntityId: string,
  scope: string,
): StorageEntityCoreDoc => {
  if (normalizeEntityId(doc.entityId) !== normalizeEntityId(expectedEntityId)) {
    throw new Error(`STORAGE_ENTITY_DOC_KEY_MISMATCH:scope=${scope}`);
  }
  return doc;
};

export const assertStorageAccountDocBinding = (
  doc: StorageAccountDoc,
  entityId: string,
  counterpartyId: string,
  scope: string,
): StorageAccountDoc => {
  const owner = normalizeEntityId(entityId);
  const counterparty = normalizeEntityId(counterpartyId);
  if (owner === counterparty) {
    throw new Error(`STORAGE_ACCOUNT_DOC_SELF_RELATIONSHIP:scope=${scope}`);
  }
  const endpoints = new Set([
    normalizeEntityId(doc.state.leftEntity),
    normalizeEntityId(doc.state.rightEntity),
  ]);
  if (endpoints.size !== 2 || !endpoints.has(owner) || !endpoints.has(counterparty)) {
    throw new Error(`STORAGE_ACCOUNT_DOC_KEY_MISMATCH:scope=${scope}`);
  }
  if (
    normalizeEntityId(doc.proofHeader.fromEntity) !== owner ||
    normalizeEntityId(doc.proofHeader.toEntity) !== counterparty
  ) {
    throw new Error(`STORAGE_ACCOUNT_DOC_OWNER_MISMATCH:scope=${scope}`);
  }
  return doc;
};

/** Complete Account storage boundary, including canonical frame digests. */
export const validateStorageAccountDocIntegrity = async (options: {
  value: unknown;
  entityId: string;
  counterpartyId: string;
  scope: string;
  verifyHanko?: PersistedAccountHankoVerifier;
}): Promise<StorageAccountDoc> => {
  const doc = assertStorageAccountDocBinding(
    validateStorageAccountDocValue(options.value),
    options.entityId,
    options.counterpartyId,
    options.scope,
  );
  await assertPersistedAccountReplicaIntegrity(
    doc,
    `storage.account:${options.scope}`,
    options.verifyHanko,
  );
  return doc;
};
