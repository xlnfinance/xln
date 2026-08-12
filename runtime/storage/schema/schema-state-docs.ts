import type { BookState } from '../../orderbook';
import { validateSpreadDistribution } from '../../orderbook';
import { validateBookStructure } from '../../orderbook/validity';
import { verifyAndWarmBookCommitment } from '../../orderbook/commitment';
import { assertAccountFrameHash } from '../../account/consensus/frame/hash';
import { canonicalAccountDisputeConfig } from '../../account/config/dispute-config';
import { validateAccountReplica } from '../../account/validation/state-validation';
import { assertCanonicalSettlementWorkspace } from '../../account/tx/handlers/settlement/transition';
import { MAX_CREDIT_LIMIT } from '../../account/tx/handlers/balance/set-credit-limit';
import { validateEntityState } from '../../entity/state/state-validation';
import { FINANCIAL, LIMITS, TOKENS } from '../../config/constants';
import { normalizeAccountWatchSeed } from '../../protocol/identity/account-watch-seed';
import { INT256_MAX, INT256_MIN, UINT256_MAX } from '../../protocol/boundary/integer-ranges';
import type { AccountFrame, AccountState, Delta } from '../../types/account';
import type { StorageAccountDoc, StorageEntityCoreDoc } from '../types';
import { normalizeEntityId } from '../keys';
import { validateSettlementContinuationValue } from '../../entity/account/account-metadata-validation';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireStorageArray,
  requireStorageBigInt,
  requireStorageHash,
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
  'crossJurisdictionAuthorizations',
  'crossJurisdictionBookAdmissions', 'hubRebalanceConfig', 'orderbookHubProfile',
  'orderbookReferrals', 'lending',
] as const;

const HUB_REBALANCE_CONFIG_REQUIRED = [
  'matchingStrategy', 'policyVersion', 'routingFeePPM', 'baseFee', 'rebalanceLiquidityFeeBps',
] as const;
const HUB_REBALANCE_CONFIG_OPTIONAL = [
  'hubName', 'swapTakerFeeBps', 'disputeAutoFinalizeMode', 'minCollateralThreshold',
  'c2rWithdrawSoftLimit', 'rebalanceBaseFee', 'rebalanceGasFee', 'rebalanceTimeoutMs',
] as const;

const validateStorageHubRebalanceConfig = (value: unknown, code: string): void => {
  if (value === undefined) return;
  const config = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    config,
    HUB_REBALANCE_CONFIG_REQUIRED,
    HUB_REBALANCE_CONFIG_OPTIONAL,
    `${code}_FIELDS`,
  );
  if (!['amount', 'time', 'fee'].includes(String(config['matchingStrategy']))) {
    throw new Error(`${code}_MATCHING_STRATEGY`);
  }
  requireBoundaryInteger(config['policyVersion'], `${code}_POLICY_VERSION`, 1);
  requireBoundaryInteger(config['routingFeePPM'], `${code}_ROUTING_FEE_PPM`);
  requireStorageBigInt(config['baseFee'], `${code}_BASE_FEE`);
  requireStorageBigInt(config['rebalanceLiquidityFeeBps'], `${code}_LIQUIDITY_FEE_BPS`, 0n, 10_000n);
  if (config['hubName'] !== undefined) requireStorageString(config['hubName'], `${code}_HUB_NAME`);
  if (config['swapTakerFeeBps'] !== undefined) requireBoundaryInteger(config['swapTakerFeeBps'], `${code}_SWAP_TAKER_FEE_BPS`);
  if (config['disputeAutoFinalizeMode'] !== undefined && config['disputeAutoFinalizeMode'] !== 'auto' && config['disputeAutoFinalizeMode'] !== 'ignore') {
    throw new Error(`${code}_DISPUTE_AUTO_FINALIZE_MODE`);
  }
  for (const field of ['minCollateralThreshold', 'c2rWithdrawSoftLimit', 'rebalanceBaseFee', 'rebalanceGasFee']) {
    if (config[field] !== undefined) requireStorageBigInt(config[field], `${code}_${field}`);
  }
  if (config['rebalanceTimeoutMs'] !== undefined) requireBoundaryInteger(config['rebalanceTimeoutMs'], `${code}_REBALANCE_TIMEOUT_MS`);
};

const validateStorageOrderbookHubProfile = (
  value: unknown,
  entityId: string,
  code: string,
): void => {
  if (value === undefined) return;
  const profile = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(profile, [
    'entityId', 'name', 'spreadDistribution', 'referenceTokenId',
    'usdQuoteAuthorityEntityId', 'minTradeSize', 'supportedPairs',
  ], [], `${code}_FIELDS`);
  if (requireStorageString(profile['entityId'], `${code}_ENTITY`) !== entityId) {
    throw new Error(`${code}_ENTITY_MISMATCH`);
  }
  requireStorageString(profile['name'], `${code}_NAME`);
  const authority = requireStorageString(profile['usdQuoteAuthorityEntityId'], `${code}_USD_AUTHORITY`).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(authority)) throw new Error(`${code}_USD_AUTHORITY`);
  requireBoundaryInteger(profile['referenceTokenId'], `${code}_REFERENCE_TOKEN`, 1);
  requireStorageBigInt(profile['minTradeSize'], `${code}_MIN_TRADE`, 0n);
  requireStorageArray(profile['supportedPairs'], `${code}_SUPPORTED_PAIRS`)
    .forEach((pair, index) => requireStorageString(pair, `${code}_PAIR_${index}`));
  const spread = requireBoundaryRecord(profile['spreadDistribution'], `${code}_SPREAD`);
  requireExactBoundaryKeys(
    spread,
    ['makerBps', 'takerBps', 'hubBps', 'makerReferrerBps', 'takerReferrerBps'],
    [],
    `${code}_SPREAD_FIELDS`,
  );
  const canonicalSpread = {
    makerBps: requireBoundaryInteger(spread['makerBps'], `${code}_MAKER_BPS`),
    takerBps: requireBoundaryInteger(spread['takerBps'], `${code}_TAKER_BPS`),
    hubBps: requireBoundaryInteger(spread['hubBps'], `${code}_HUB_BPS`),
    makerReferrerBps: requireBoundaryInteger(spread['makerReferrerBps'], `${code}_MAKER_REFERRER_BPS`),
    takerReferrerBps: requireBoundaryInteger(spread['takerReferrerBps'], `${code}_TAKER_REFERRER_BPS`),
  };
  if (!validateSpreadDistribution(canonicalSpread)) throw new Error(`${code}_SPREAD_TOTAL`);
};

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
  'currentDisputeProofProposerIsLeft', 'counterpartyDisputeProofProposerIsLeft',
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
const DELTA_FIELDS = [
  'tokenId', 'collateral', 'ondelta', 'offdelta', 'leftCreditLimit', 'rightCreditLimit', 'leftAllowance',
  'rightAllowance', 'leftHold', 'rightHold',
] as const;
const validateStorageDelta = (value: unknown, code: string): number => {
  const delta = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(delta, DELTA_FIELDS, [], `${code}_FIELDS`);
  const tokenId = requireBoundaryInteger(delta['tokenId'], `${code}_TOKEN`);
  if (tokenId > TOKENS.MAX_TOKEN_ID) throw new Error(`${code}_TOKEN`);
  for (const field of ['collateral', 'leftCreditLimit', 'rightCreditLimit', 'leftAllowance', 'rightAllowance', 'leftHold', 'rightHold']) {
    requireStorageBigInt(delta[field], `${code}_${field}`, 0n, field.endsWith('CreditLimit') ? MAX_CREDIT_LIMIT : UINT256_MAX);
  }
  for (const field of ['ondelta', 'offdelta']) requireStorageBigInt(delta[field], `${code}_${field}`, INT256_MIN, INT256_MAX);
  return tokenId;
};

const validateStorageAccountStateCore = (state: Record<string, unknown>, code: string): void => {
  normalizeAccountWatchSeed(state['watchSeed'], code);
  for (const [key, value] of requireStorageMap(state['deltas'], `${code}_DELTAS`)) {
    const tokenId = requireBoundaryInteger(key, `${code}_DELTA_KEY`);
    if (tokenId !== validateStorageDelta(value, `${code}_DELTA`)) throw new Error(`${code}_DELTA_KEY_MISMATCH`);
  }
  const credit = requireBoundaryRecord(state['globalCreditLimits'], `${code}_CREDIT`);
  requireExactBoundaryKeys(credit, ['ownLimit', 'peerLimit'], [], `${code}_CREDIT_FIELDS`);
  requireStorageBigInt(credit['ownLimit'], `${code}_OWN_CREDIT`, 0n, UINT256_MAX);
  requireStorageBigInt(credit['peerLimit'], `${code}_PEER_CREDIT`, 0n, UINT256_MAX);
  requireBoundaryInteger(state['jNonce'], `${code}_J_NONCE`);
  const dispute = requireBoundaryRecord(state['disputeConfig'], `${code}_DISPUTE`);
  requireExactBoundaryKeys(
    dispute,
    ['leftResponseSeconds', 'rightResponseSeconds'],
    [],
    `${code}_DISPUTE_FIELDS`,
  );
  // Account clocks are signed uint32 seconds, not uint16 reveal ratios. A user
  // default is 86,400 seconds, so truncating this storage boundary to uint16
  // makes a healthy hub fail-stop on its first authoritative restart.
  canonicalAccountDisputeConfig({
    leftResponseSeconds: requireBoundaryInteger(
      dispute['leftResponseSeconds'],
      `${code}_leftResponseSeconds`,
    ),
    rightResponseSeconds: requireBoundaryInteger(
      dispute['rightResponseSeconds'],
      `${code}_rightResponseSeconds`,
    ),
  });
};

const validateStorageAccountStateMaps = (state: AccountState, code: string): void => {
  const locks = requireStorageMap(state.locks, `${code}_LOCKS`);
  if (locks.size > LIMITS.MAX_ACCOUNT_HTLC_LOCKS) throw new Error(`${code}_LOCKS_LIMIT`);
  for (const [lockId, lock] of locks) {
    const row = requireBoundaryRecord(lock, `${code}_LOCK`);
    if (requireStorageString(lockId, `${code}_LOCK_KEY`) !== requireStorageString(row['lockId'], `${code}_LOCK_ID`)) throw new Error(`${code}_LOCK_KEY_MISMATCH`);
    requireStorageString(row['hashlock'], `${code}_LOCK_HASHLOCK`);
    requireStorageBigInt(row['amount'], `${code}_LOCK_AMOUNT`, FINANCIAL.MIN_PAYMENT_AMOUNT, FINANCIAL.MAX_PAYMENT_AMOUNT);
  }
  if (state.pulls !== undefined) {
    for (const pull of requireStorageMap(state.pulls, `${code}_PULLS`).values()) {
      const row = requireBoundaryRecord(pull, `${code}_PULL`);
      const amount = row['amount'];
      if (typeof amount !== 'bigint' || amount === 0n || (amount < 0n ? -amount : amount) > FINANCIAL.MAX_PAYMENT_AMOUNT) throw new Error(`${code}_PULL_AMOUNT`);
      requireStorageHash(row['fullHash'], `${code}_PULL_FULL_HASH`);
      requireStorageHash(row['partialRoot'], `${code}_PULL_PARTIAL_ROOT`);
      const binding = requireBoundaryRecord(row['crossJurisdiction'], `${code}_PULL_CROSS_J`);
      requireStorageString(binding['orderId'], `${code}_PULL_CROSS_J_ORDER`);
      requireStorageHash(binding['routeHash'], `${code}_PULL_CROSS_J_ROUTE_HASH`);
      if (binding['leg'] !== 'source' && binding['leg'] !== 'target') {
        throw new Error(`${code}_PULL_CROSS_J_LEG`);
      }
    }
  }
  for (const offer of requireStorageMap(state.swapOffers, `${code}_OFFERS`).values()) {
    const row = requireBoundaryRecord(offer, `${code}_OFFER`);
    for (const field of ['giveTokenId', 'wantTokenId']) if (requireBoundaryInteger(row[field], `${code}_OFFER_TOKEN`) > TOKENS.MAX_TOKEN_ID) throw new Error(`${code}_OFFER_TOKEN`);
    // Zero persisted offers are inert financial state and must not survive hydration.
    requireStorageBigInt(row['giveAmount'], `${code}_OFFER_GIVE`, FINANCIAL.MIN_PAYMENT_AMOUNT, FINANCIAL.MAX_PAYMENT_AMOUNT);
    const wantAmount = requireStorageBigInt(row['wantAmount'], `${code}_OFFER_WANT`, FINANCIAL.MIN_PAYMENT_AMOUNT, FINANCIAL.MAX_PAYMENT_AMOUNT);
    requireStorageBigInt(row['maxFee'], `${code}_OFFER_MAX_FEE`, 0n, wantAmount);
    requireStorageBigInt(row['minNetReceive'], `${code}_OFFER_MIN_NET`, 0n, wantAmount);
  }
  if (state.subcontracts !== undefined) {
    for (const subcontract of requireStorageMap(state.subcontracts, `${code}_SUBCONTRACTS`).values()) {
      const row = requireBoundaryRecord(subcontract, `${code}_SUBCONTRACT`);
      const address = requireStorageString(row['transformerAddress'], `${code}_TRANSFORMER`);
      if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${code}_TRANSFORMER`);
      for (const allowance of requireStorageArray(row['allowances'], `${code}_ALLOWANCES`)) for (const side of ['leftAllowance', 'rightAllowance']) requireStorageBigInt(requireBoundaryRecord(allowance, `${code}_ALLOWANCE`)[side], `${code}_ALLOWANCE_${side}`, 0n, UINT256_MAX);
    }
  }
  if (state.settlementWorkspace !== undefined) {
    const workspace = requireBoundaryRecord(state.settlementWorkspace, `${code}_WORKSPACE`);
    requireBoundaryInteger(workspace['revision'], `${code}_WORKSPACE_REVISION`, 1);
    assertCanonicalSettlementWorkspace(state, state.settlementWorkspace);
  }
};
const validateStorageAccountReplicaCore = (doc: Record<string, unknown>, code: string): void => {
  const currentHeight = requireBoundaryInteger(doc['currentHeight'], `${code}_CURRENT_HEIGHT`);
  const frames = [doc['currentFrame'], doc['pendingFrame']].filter((frame): frame is AccountFrame => frame !== undefined);
  for (const frame of frames) {
    const deltas = requireStorageArray<Delta>(requireBoundaryRecord(frame, `${code}_FRAME`)['deltas'], `${code}_FRAME_DELTAS`);
    if (deltas.length > LIMITS.MAX_ACCOUNT_TOKEN_ROWS) throw new Error(`${code}_FRAME_DELTAS_LIMIT`);
    for (const delta of deltas) validateStorageDelta(delta, `${code}_FRAME_DELTA`);
    if (frame.height > 0) assertAccountFrameHash(frame, `${code}_FRAME_HASH`);
  }
  const current = frames[0]!;
  if (current.height !== currentHeight) throw new Error(`${code}_FRAME_HEIGHT`);
  const expectedPendingPrevHash = currentHeight === 0 ? 'genesis' : current.stateHash;
  if (frames[1] && (frames[1].height !== currentHeight + 1 || frames[1].prevFrameHash !== expectedPendingPrevHash)) {
    throw new Error(`${code}_PENDING_FRAME_LINK`);
  }
  const header = requireBoundaryRecord(doc['proofHeader'], `${code}_PROOF_HEADER`);
  requireExactBoundaryKeys(header, ['fromEntity', 'toEntity', 'nextProofNonce'], [], `${code}_PROOF_HEADER_FIELDS`);
  requireBoundaryInteger(header['nextProofNonce'], `${code}_PROOF_NONCE`);
  const body = requireBoundaryRecord(doc['proofBody'], `${code}_PROOF_BODY`);
  requireExactBoundaryKeys(body, ['tokenIds', 'deltas'], ['htlcLocks'], `${code}_PROOF_BODY_FIELDS`);
  const tokenIds = requireStorageArray(body['tokenIds'], `${code}_PROOF_TOKENS`);
  const deltas = requireStorageArray(body['deltas'], `${code}_PROOF_DELTAS`);
  if (tokenIds.length !== deltas.length) throw new Error(`${code}_PROOF_LENGTH`);
  tokenIds.forEach((tokenId, index) => {
    requireBoundaryInteger(tokenId, `${code}_PROOF_TOKEN_${index}`);
    requireStorageBigInt(deltas[index], `${code}_PROOF_DELTA_${index}`, INT256_MIN, INT256_MAX);
  });
  for (const withdrawal of requireStorageMap(doc['pendingWithdrawals'], `${code}_WITHDRAWALS`).values()) {
    requireStorageBigInt(requireBoundaryRecord(withdrawal, `${code}_WITHDRAWAL`)['amount'], `${code}_WITHDRAWAL_AMOUNT`, FINANCIAL.MIN_PAYMENT_AMOUNT, FINANCIAL.MAX_PAYMENT_AMOUNT);
  }
};

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
  validateStorageHubRebalanceConfig(doc['hubRebalanceConfig'], `${code}_HUB_REBALANCE_CONFIG`);
  validateStorageOrderbookHubProfile(
    doc['orderbookHubProfile'],
    String(doc['entityId']),
    `${code}_ORDERBOOK_HUB_PROFILE`,
  );
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
  validateStorageAccountStateCore(state, `${code}_STATE`);
  validateStorageAccountReplicaCore(doc, code);
  const account = validateAccountReplica(doc, code);
  validateStorageAccountStateMaps(account.state, `${code}_STATE`);
  return account;
};

function assertBookHeader(value: unknown): asserts value is BookState {
  const code = 'STORAGE_BOOK_DOC_INVALID';
  const book = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(book, [
    'params', 'orders', 'bidBuckets', 'askBuckets', 'bidBucketIdsDesc',
    'askBucketIdsAsc', 'nextSeq', 'tradeCount', 'tradeQtySum',
    'lastTradePriceTicks', 'lastAcceptedUsdAskPriceTicks', 'eventHash',
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
  // Retained trade telemetry; it is not cross-j admission authority.
  requireStorageBigInt(book['lastTradePriceTicks'], `${code}_LAST_TRADE_PRICE`);
  // This is the signed-authority quote consumed by the cross-j notional cap.
  // It is intentionally independent of user-controlled trade history.
  requireStorageBigInt(book['lastAcceptedUsdAskPriceTicks'], `${code}_LAST_USD_ASK_PRICE`);
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
  const endpoints = new Set([
    normalizeEntityId(doc.state.leftEntity),
    normalizeEntityId(doc.state.rightEntity),
  ]);
  if (owner === counterparty || endpoints.size !== 2 || !endpoints.has(owner) || !endpoints.has(counterparty)) {
    throw new Error(`STORAGE_ACCOUNT_DOC_KEY_MISMATCH:scope=${scope}`);
  }
  // The storage key owns proof orientation; endpoint swaps cannot reinterpret one document.
  if (
    normalizeEntityId(doc.proofHeader.fromEntity) !== owner ||
    normalizeEntityId(doc.proofHeader.toEntity) !== counterparty
  ) throw new Error(`STORAGE_ACCOUNT_DOC_OWNER_MISMATCH:scope=${scope}`);
  return doc;
};
