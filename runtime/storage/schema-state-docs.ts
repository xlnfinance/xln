import type { BookState } from '../orderbook';
import { validateBookStructure } from '../orderbook/validity';
import { verifyAndWarmBookCommitment } from '../orderbook/commitment';
import { validateAccountMachine, validateEntityState } from '../validation-utils';
import { LIMITS } from '../constants';
import type { StorageAccountDoc, StorageEntityCoreDoc } from './types';
import { normalizeAccountStateDomain } from '../account/state-root';
import { normalizeEntityId } from './keys';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireStorageArray,
  requireStorageBigInt,
  requireStorageMap,
  requireStorageString,
  requireStringArray,
} from './schema-primitives';

const ENTITY_REQUIRED = [
  'entityId', 'height', 'timestamp', 'messages', 'nonces', 'proposals', 'config',
  'reserves', 'lastFinalizedJHeight', 'jBlockChain', 'profile', 'htlcRoutes',
  'htlcFeesEarned', 'lockBook',
] as const;

const ENTITY_OPTIONAL = [
  'entityCommandNonces', 'prevFrameHash', 'leaderState', 'externalWallet',
  'deferredAccountProposals', 'jHistoryFinality', 'certifiedBoardState', 'batchHistory',
  'accountInputQueue', 'crontabState', 'jBatchState', 'entityProviderActionState',
  'profileEncryptionManifest', 'consumptionAccumulator', 'certifiedOutputSequences',
  'outDebtsByToken', 'inDebtsByToken', 'swapTradingPairs',
  'crossJurisdictionSwaps', 'pendingCrossJurisdictionFillAcks',
  'crossJurisdictionBookAdmissions', 'hubRebalanceConfig', 'orderbookHubProfile',
  'orderbookReferrals', 'lending',
] as const;

const ACCOUNT_REQUIRED = [
  'leftEntity', 'rightEntity', 'domain', 'watchSeed', 'status', 'mempool', 'currentFrame',
  'deltas', 'locks', 'swapOffers', 'globalCreditLimits', 'currentHeight',
  'pendingSignatures', 'rollbackCount', 'leftPendingJClaims', 'rightPendingJClaims',
  'lastFinalizedJHeight', 'proofHeader', 'proofBody', 'disputeConfig', 'jNonce',
  'pendingWithdrawals', 'requestedRebalance', 'requestedRebalanceFeeState', 'shadow',
] as const;

const ACCOUNT_OPTIONAL = [
  'pulls', 'subcontracts', 'lendingIntents', 'pendingFrame', 'pendingAccountInput',
  'pendingAccountInputSignerId',
  'lastOutboundFrameAck', 'pendingForwards', 'hankoSignature', 'lastRollbackFrameHash',
  'abiProofBody', 'currentFrameHanko', 'counterpartyFrameHanko', 'boardResealMigration',
  'counterpartyBoardReseal', 'currentDisputeProofHanko', 'currentDisputeProofNonce',
  'currentDisputeProofBodyHash', 'currentDisputeHash', 'counterpartyDisputeProofHanko',
  'counterpartyDisputeProofNonce', 'counterpartyDisputeProofBodyHash',
  'counterpartyDisputeHash', 'counterpartySettlementHanko', 'disputeProofNoncesByHash',
  'disputeProofBodiesByHash', 'disputeArgumentSnapshotsByHash', 'disputePrepare',
  'settlementWorkspace', 'activeDispute', 'swapOrderHistory', 'swapClosedOrders',
  'rebalanceFeePolicies',
] as const;

export const validateStorageEntityCoreDocValue = (value: unknown): StorageEntityCoreDoc => {
  const code = 'STORAGE_ENTITY_DOC_INVALID';
  const doc = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(doc, ENTITY_REQUIRED, ENTITY_OPTIONAL, `${code}_FIELDS`);
  requireStorageString(doc['entityId'], `${code}_ENTITY_ID`);
  requireBoundaryInteger(doc['height'], `${code}_HEIGHT`);
  requireBoundaryInteger(doc['timestamp'], `${code}_TIMESTAMP`);
  requireStorageArray(doc['messages'], `${code}_MESSAGES`);
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
  const { deferredAccountProposals: _splitAccountRefs, ...sharedCore } = doc;
  validateEntityState({ ...sharedCore, accounts: new Map(), entityEncPubKey: '', entityEncPrivKey: '' }, code);
  return doc as StorageEntityCoreDoc;
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
  requireExactBoundaryKeys(doc, ACCOUNT_REQUIRED, ACCOUNT_OPTIONAL, `${code}_FIELDS`);
  requireStorageString(doc['leftEntity'], `${code}_LEFT_ENTITY`);
  requireStorageString(doc['rightEntity'], `${code}_RIGHT_ENTITY`);
  normalizeAccountStateDomain(doc['domain'] as StorageAccountDoc['domain'], `${code}_DOMAIN`);
  if (typeof doc['watchSeed'] !== 'string') throw new Error(`${code}_WATCH_SEED`);
  if (!['active', 'dispute_preparing', 'disputed'].includes(String(doc['status']))) throw new Error(`${code}_STATUS`);
  requireStorageArray(doc['mempool'], `${code}_MEMPOOL`);
  requireStorageMap(doc['deltas'], `${code}_DELTAS`);
  requireStorageMap(doc['locks'], `${code}_LOCKS`);
  requireStorageMap(doc['swapOffers'], `${code}_SWAP_OFFERS`);
  requireBoundaryInteger(doc['currentHeight'], `${code}_CURRENT_HEIGHT`);
  requireStringArray(doc['pendingSignatures'], `${code}_PENDING_SIGNATURES`);
  requireBoundaryInteger(doc['rollbackCount'], `${code}_ROLLBACK_COUNT`);
  requireBoundaryInteger(doc['lastFinalizedJHeight'], `${code}_FINALIZED_J_HEIGHT`);
  requireBoundaryInteger(doc['jNonce'], `${code}_J_NONCE`);
  requireStorageMap(doc['pendingWithdrawals'], `${code}_PENDING_WITHDRAWALS`);
  requireStorageMap(doc['requestedRebalance'], `${code}_REQUESTED_REBALANCE`);
  requireStorageMap(doc['requestedRebalanceFeeState'], `${code}_REBALANCE_FEES`);
  validateAccountMachine(doc, code);
  return doc as StorageAccountDoc;
};

const validateBookHeader = (value: unknown): BookState => {
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
  return book as unknown as BookState;
};

export const validateStorageBookDocValue = (value: unknown): BookState => {
  const book = validateBookHeader(value);
  const report = validateBookStructure(book);
  if (!report.ok) throw new Error(`STORAGE_BOOK_DOC_STRUCTURE_INVALID:${report.errors.join('|')}`);
  verifyAndWarmBookCommitment(book, 'STORAGE_BOOK_DOC_COMMITMENT');
  return book;
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
  const endpoints = new Set([normalizeEntityId(doc.leftEntity), normalizeEntityId(doc.rightEntity)]);
  if (!endpoints.has(normalizeEntityId(entityId)) || !endpoints.has(normalizeEntityId(counterpartyId))) {
    throw new Error(`STORAGE_ACCOUNT_DOC_KEY_MISMATCH:scope=${scope}`);
  }
  return doc;
};
