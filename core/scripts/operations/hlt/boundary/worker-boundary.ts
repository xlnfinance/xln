/**
 * Exact boundary decoders for the production swap-load worker. Disk manifests
 * and Runtime-adapter payloads remain unknown until every consumed shape has
 * been checked; no generic decode<T> can mint trusted financial state here.
 */

import type { RuntimeAdapterEntitySummary } from '../../../../api/runtime-adapter/types';
import { decodeHltEnvironmentManifest, type HltEnvironmentManifest } from './environment-manifest';
import { canonicalAccountDisputeConfig } from '../../../../account/config/dispute-config';
import { validateAccountDeltas } from '../../../../account/validation/delta-validation';
import { decodeAccountFrame } from '../../../../account/validation/frame-validation';
import type { AccountState, Delta } from '../../../../types/account';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';
import {
  assertProductionSwapFullySettled,
  decodeProductionSwapSettlementEvidence,
  type ProductionSwapSettlementEvidence,
} from '../settlement';

export type LoadRuntimeEntry = Readonly<{
  label: string;
  engine: 'ts' | 'rust';
  token: string;
  wsUrl: string;
}>;
export type LoadFrame = Readonly<{ height: number; canonicalStateHash: string }>;
export type LoadIdentity = Readonly<{ entityId: string; signerId: string }>;
export type LoadAccountProjection = Readonly<{
  state: Readonly<{
    leftEntity: string;
    rightEntity: string;
    deltas: Map<number, Delta>;
    disputeConfig: AccountState['disputeConfig'];
  }>;
}>;
export type LoadSustainedReport = Readonly<{
  schema: 'xln-production-swap-load-sustained-v1';
  engine: 'ts' | 'rust';
  mode: 'same';
  schedule: 'one_order_per_account_per_round' | 'resting_maker_aggressive_taker' | 'balanced_role_rotation';
  configuredUsers: number;
  configuredRounds: number;
  cadenceMs: number;
  offeredOrderRate: number;
  offeredEconomicSwapRate: number;
  loadMakerAccountCount: number;
  loadTakerAccountCount: number;
  loadParticipantAccountCount: number;
  maxOrdersPerAccountFrame: number;
  runtimeInputBatches: number;
  roundSubmissionLagMs: readonly number[];
  expectedSubmittedOffers: number;
  expectedMatchedTrades: number;
  cancelledOffers: number;
  matchedSubmittedOffers: number;
  exchangeDistribution: LoadExchangeDistribution;
  completionAuthority: 'committed_trade_count_and_bilateral_runtime_quiescence';
  enqueueAckElapsedMs: number;
  commandObservedElapsedMs: number;
  matchedElapsedMs: number;
  fullySettledElapsedMs: number;
  matchedTps: number;
  fullySettledTps: number;
  tradeCountBefore: number;
  tradeCountAfter: number;
  driverRssBefore: number;
  driverRssAfter: number;
  walBytesBefore: number;
  walBytesAfter: number;
  crossedBookAfterRun: false;
  durableBefore: LoadFrame;
  durableAfter: LoadFrame;
  loadDurableBefore: LoadFrame;
  loadDurableAfter: LoadFrame;
  settlementEvidence: ProductionSwapSettlementEvidence;
  environment: HltEnvironmentManifest;
}>;

export type LoadExchangeDistribution = Readonly<{
  submittedOffers: number;
  matchedSubmittedOffers: number;
  matchedTrades: number;
  cancelledOffers: number;
  mmOnlyTakers: number;
  userOnlyTakers: number;
  partialUserMakerFills: number;
  mmResidualTakers: number;
  sweep2Takers: number;
  sweep5Takers: number;
  sweep10Takers: number;
  sweep20Takers: number;
}>;

const requireText = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};

const decodeJurisdiction = (
  value: unknown,
  index: number,
): NonNullable<RuntimeAdapterEntitySummary['jurisdiction']> => {
  const jurisdiction = requireBoundaryRecord(value, `PRODUCTION_SWAP_LOAD_JURISDICTION_INVALID:${index}`);
  requireExactBoundaryKeys(
    jurisdiction,
    [],
    ['name', 'address', 'chainId', 'depositoryAddress', 'entityProviderAddress'],
    `PRODUCTION_SWAP_LOAD_JURISDICTION_FIELDS_INVALID:${index}`,
  );
  const decoded: NonNullable<RuntimeAdapterEntitySummary['jurisdiction']> = {};
  for (const key of ['name', 'address', 'depositoryAddress', 'entityProviderAddress'] as const) {
    if (jurisdiction[key] !== undefined) {
      decoded[key] = requireText(jurisdiction[key], `PRODUCTION_SWAP_LOAD_JURISDICTION_${key.toUpperCase()}_INVALID:${index}`);
    }
  }
  if (jurisdiction['chainId'] !== undefined) {
    const chainId = jurisdiction['chainId'];
    if (typeof chainId === 'string' && chainId.trim()) decoded.chainId = chainId;
    else if (typeof chainId === 'number' && Number.isSafeInteger(chainId)) decoded.chainId = chainId;
    else throw new Error(`PRODUCTION_SWAP_LOAD_JURISDICTION_CHAIN_ID_INVALID:${index}`);
  }
  return decoded;
};

export const decodeRuntimeManifestEntries = (value: unknown): LoadRuntimeEntry[] => {
  const root = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_MANIFEST_INVALID');
  requireExactBoundaryKeys(root, ['importUrl', 'manifest'], [], 'PRODUCTION_SWAP_LOAD_MANIFEST_FIELDS_INVALID');
  requireText(root['importUrl'], 'PRODUCTION_SWAP_LOAD_MANIFEST_IMPORT_URL_INVALID');
  const manifest = requireBoundaryRecord(root['manifest'], 'PRODUCTION_SWAP_LOAD_MANIFEST_BODY_INVALID');
  requireExactBoundaryKeys(manifest, ['v', 'issuedAt', 'expiresAt', 'entries'], [], 'PRODUCTION_SWAP_LOAD_MANIFEST_BODY_FIELDS_INVALID');
  if (manifest['v'] !== 1) throw new Error('PRODUCTION_SWAP_LOAD_MANIFEST_VERSION_INVALID');
  requireBoundaryInteger(manifest['issuedAt'], 'PRODUCTION_SWAP_LOAD_MANIFEST_ISSUED_AT_INVALID');
  requireBoundaryInteger(manifest['expiresAt'], 'PRODUCTION_SWAP_LOAD_MANIFEST_EXPIRES_AT_INVALID');
  if (!Array.isArray(manifest['entries'])) throw new Error('PRODUCTION_SWAP_LOAD_MANIFEST_ENTRIES_INVALID');
  return manifest['entries'].map((raw, index) => {
    const entry = requireBoundaryRecord(raw, `PRODUCTION_SWAP_LOAD_MANIFEST_ENTRY_INVALID:${index}`);
    requireExactBoundaryKeys(entry, ['access', 'engine', 'label', 'token', 'wsUrl'], [], `PRODUCTION_SWAP_LOAD_MANIFEST_ENTRY_FIELDS_INVALID:${index}`);
    if (entry['access'] !== 'admin') throw new Error(`PRODUCTION_SWAP_LOAD_MANIFEST_ACCESS_INVALID:${index}`);
    const engine = entry['engine'];
    if (engine !== 'ts' && engine !== 'rust') {
      throw new Error(`PRODUCTION_SWAP_LOAD_MANIFEST_ENGINE_INVALID:${index}`);
    }
    return {
      label: requireText(entry['label'], `PRODUCTION_SWAP_LOAD_MANIFEST_LABEL_INVALID:${index}`),
      engine,
      token: requireText(entry['token'], `PRODUCTION_SWAP_LOAD_MANIFEST_TOKEN_INVALID:${index}`),
      wsUrl: requireText(entry['wsUrl'], `PRODUCTION_SWAP_LOAD_MANIFEST_WS_URL_INVALID:${index}`),
    };
  });
};

export const decodeEntitySummaries = (value: unknown): RuntimeAdapterEntitySummary[] => {
  if (!Array.isArray(value)) throw new Error('PRODUCTION_SWAP_LOAD_ENTITIES_INVALID');
  return value.map((raw, index) => {
    const entity = requireBoundaryRecord(raw, `PRODUCTION_SWAP_LOAD_ENTITY_INVALID:${index}`);
    requireExactBoundaryKeys(entity, ['entityId', 'label', 'height'], ['runtimeId', 'signerId', 'isHub', 'jurisdiction'], `PRODUCTION_SWAP_LOAD_ENTITY_FIELDS_INVALID:${index}`);
    const decoded: RuntimeAdapterEntitySummary = {
      entityId: requireText(entity['entityId'], `PRODUCTION_SWAP_LOAD_ENTITY_ID_INVALID:${index}`),
      label: requireText(entity['label'], `PRODUCTION_SWAP_LOAD_ENTITY_LABEL_INVALID:${index}`),
      height: requireBoundaryInteger(entity['height'], `PRODUCTION_SWAP_LOAD_ENTITY_HEIGHT_INVALID:${index}`),
    };
    if (entity['runtimeId'] !== undefined) decoded.runtimeId = requireText(entity['runtimeId'], `PRODUCTION_SWAP_LOAD_RUNTIME_ID_INVALID:${index}`);
    if (entity['signerId'] !== undefined) decoded.signerId = requireText(entity['signerId'], `PRODUCTION_SWAP_LOAD_SIGNER_ID_INVALID:${index}`);
    if (entity['isHub'] !== undefined) {
      if (typeof entity['isHub'] !== 'boolean') throw new Error(`PRODUCTION_SWAP_LOAD_IS_HUB_INVALID:${index}`);
      decoded.isHub = entity['isHub'];
    }
    if (entity['jurisdiction'] !== undefined) decoded.jurisdiction = decodeJurisdiction(entity['jurisdiction'], index);
    return decoded;
  });
};

export const selectLocalHubIdentity = (
  entities: readonly RuntimeAdapterEntitySummary[],
  runtimeId: string,
  chainId: number,
): LoadIdentity => {
  const matches = entities.filter(entity =>
    entity.runtimeId === runtimeId &&
    entity.signerId !== undefined &&
    entity.isHub === true &&
    Number(entity.jurisdiction?.chainId) === chainId
  );
  if (matches.length !== 1 || !matches[0]?.signerId) {
    throw new Error('PRODUCTION_SWAP_LOAD_PRIMARY_HUB_IDENTITY_NOT_UNIQUE');
  }
  return { entityId: matches[0].entityId, signerId: matches[0].signerId };
};

export const decodeHubCoreRecord = (value: unknown): Record<string, unknown> => {
  const core = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_HUB_CORE_INVALID');
  requireExactBoundaryKeys(core, [
    'entityId', 'entityEncryptionPublicKey', 'height', 'timestamp', 'profile', 'config',
    'nonces', 'proposals', 'reserves', 'lastFinalizedJHeight',
    'paybook',
  ], [
    'signerId', 'isProposer', 'prevFrameHash', 'externalWallet',
    'deferredAccountProposals', 'jBatchState', 'outDebtsByToken',
    'inDebtsByToken', 'swapTradingPairs', 'crossJurisdictionSwaps',
    'pendingCrossJurisdictionFillAcks', 'crossJurisdictionBookAdmissions',
    'orderbookReferrals', 'orderbookHubProfile', 'hubRebalanceConfig',
    'paybookOpen', 'metrics',
  ], 'PRODUCTION_SWAP_LOAD_HUB_CORE_FIELDS_INVALID');
  return core;
};

export const decodeHubMinTradeSize = (value: unknown): bigint => {
  const core = decodeHubCoreRecord(value);
  const profile = requireBoundaryRecord(
    core['orderbookHubProfile'],
    'PRODUCTION_SWAP_LOAD_HUB_PROFILE_MISSING',
  );
  requireExactBoundaryKeys(profile, [
    'entityId', 'name', 'spreadDistribution', 'referenceTokenId',
    'usdQuoteAuthorityEntityId', 'minTradeSize', 'supportedPairs',
  ], [], 'PRODUCTION_SWAP_LOAD_HUB_PROFILE_FIELDS_INVALID');
  requireText(profile['entityId'], 'PRODUCTION_SWAP_LOAD_HUB_PROFILE_ENTITY_INVALID');
  requireText(profile['name'], 'PRODUCTION_SWAP_LOAD_HUB_PROFILE_NAME_INVALID');
  requireText(profile['usdQuoteAuthorityEntityId'], 'PRODUCTION_SWAP_LOAD_HUB_PROFILE_AUTHORITY_INVALID');
  requireBoundaryInteger(profile['referenceTokenId'], 'PRODUCTION_SWAP_LOAD_HUB_PROFILE_TOKEN_INVALID');
  if (!Array.isArray(profile['supportedPairs']) || profile['supportedPairs'].some(pair => typeof pair !== 'string' || !pair)) {
    throw new Error('PRODUCTION_SWAP_LOAD_HUB_PROFILE_PAIRS_INVALID');
  }
  const spread = requireBoundaryRecord(profile['spreadDistribution'], 'PRODUCTION_SWAP_LOAD_HUB_PROFILE_SPREAD_INVALID');
  requireExactBoundaryKeys(spread, [
    'makerBps', 'takerBps', 'hubBps', 'makerReferrerBps', 'takerReferrerBps',
  ], [], 'PRODUCTION_SWAP_LOAD_HUB_PROFILE_SPREAD_FIELDS_INVALID');
  for (const field of ['makerBps', 'takerBps', 'hubBps', 'makerReferrerBps', 'takerReferrerBps'] as const) {
    requireBoundaryInteger(spread[field], `PRODUCTION_SWAP_LOAD_HUB_PROFILE_${field.toUpperCase()}_INVALID`);
  }
  const minimum = profile['minTradeSize'];
  if (typeof minimum !== 'bigint' || minimum < 0n) throw new Error('PRODUCTION_SWAP_LOAD_HUB_PROFILE_MIN_TRADE_INVALID');
  return minimum;
};

export const decodePageItems = (value: unknown, code: string): unknown[] => {
  const page = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(page, ['items', 'nextCursor', 'prevCursor', 'firstCursor', 'lastCursor', 'pageIndex', 'pageCount', 'totalItems', 'limit'], ['summary'], `${code}_FIELDS`);
  if (!Array.isArray(page['items'])) throw new Error(`${code}_ITEMS`);
  return page['items'];
};

const ACCOUNT_VIEW_REQUIRED = [
  'state', 'status', 'mempool', 'currentFrame', 'currentHeight',
  'rollbackCount', 'proofHeader',
  'pendingWithdrawals', 'shadow',
] as const;
const ACCOUNT_VIEW_OPTIONAL = [
  'pendingFrame', 'pendingAccountInput', 'lastOutboundAckFrame',
  'lastRollbackFrameHash', 'currentFrameHanko',
  'counterpartyFrameHanko', 'boardHankoRefreshMigration', 'counterpartyBoardHankoRefresh',
  'currentDisputeProofHanko', 'currentDisputeProofNonce', 'currentDisputeProofBodyHash',
  'currentDisputeHash', 'counterpartyDisputeProofHanko', 'counterpartyDisputeProofNonce',
  'counterpartyDisputeProofBodyHash', 'currentDisputeProofProposerIsLeft',
  'counterpartyDisputeProofProposerIsLeft', 'counterpartyDisputeHash',
  'counterpartySettlementHanko', 'disputePrepare', 'activeDispute',
] as const;
const ACCOUNT_VIEW_STATE_REQUIRED = [
  'leftEntity', 'rightEntity', 'domain', 'watchSeed', 'deltas', 'locks',
  'swapOffers', 'leftPendingJClaims', 'rightPendingJClaims', 'lastFinalizedJHeight',
  'disputeConfig', 'jNonce', 'requestedRebalance', 'requestedRebalanceFeeState',
] as const;
const ACCOUNT_VIEW_STATE_OPTIONAL = [
  'pulls', 'subcontracts', 'lendingIntents', 'settlementWorkspace', 'rebalanceFeePolicies',
] as const;

const requireCanonicalEntityId = (value: unknown, code: string): string => {
  const entityId = requireText(value, code);
  if (!/^0x[0-9a-f]{64}$/.test(entityId)) throw new Error(code);
  return entityId;
};

const decodeAccountView = (value: unknown): LoadAccountProjection => {
  const account = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_ACCOUNT_INVALID');
  requireExactBoundaryKeys(
    account,
    ACCOUNT_VIEW_REQUIRED,
    ACCOUNT_VIEW_OPTIONAL,
    'PRODUCTION_SWAP_LOAD_ACCOUNT_FIELDS_INVALID',
  );
  const state = requireBoundaryRecord(account['state'], 'PRODUCTION_SWAP_LOAD_ACCOUNT_STATE_INVALID');
  requireExactBoundaryKeys(
    state,
    ACCOUNT_VIEW_STATE_REQUIRED,
    ACCOUNT_VIEW_STATE_OPTIONAL,
    'PRODUCTION_SWAP_LOAD_ACCOUNT_STATE_FIELDS_INVALID',
  );
  const leftEntity = requireCanonicalEntityId(state['leftEntity'], 'PRODUCTION_SWAP_LOAD_ACCOUNT_LEFT_INVALID');
  const rightEntity = requireCanonicalEntityId(state['rightEntity'], 'PRODUCTION_SWAP_LOAD_ACCOUNT_RIGHT_INVALID');
  if (leftEntity >= rightEntity) throw new Error('PRODUCTION_SWAP_LOAD_ACCOUNT_ORDER_INVALID');
  const dispute = requireBoundaryRecord(
    state['disputeConfig'],
    'PRODUCTION_SWAP_LOAD_ACCOUNT_DISPUTE_CONFIG_INVALID',
  );
  requireExactBoundaryKeys(
    dispute,
    ['leftResponseSeconds', 'rightResponseSeconds'],
    [],
    'PRODUCTION_SWAP_LOAD_ACCOUNT_DISPUTE_CONFIG_FIELDS_INVALID',
  );
  // The compact API intentionally omits pendingAccountInput but still exposes
  // a bounded pendingFrame for status. Decode that frame independently instead
  // of laundering the projection into a complete AccountReplica.
  if (account['pendingFrame'] !== undefined) {
    decodeAccountFrame(account['pendingFrame'], 'production-swap-load account.pendingFrame');
  }
  return {
    state: {
      leftEntity,
      rightEntity,
      deltas: validateAccountDeltas(state['deltas'], 'production-swap-load account.state.deltas'),
      disputeConfig: canonicalAccountDisputeConfig({
        leftResponseSeconds: requireBoundaryInteger(
          dispute['leftResponseSeconds'],
          'PRODUCTION_SWAP_LOAD_ACCOUNT_LEFT_RESPONSE_INVALID',
          0,
        ),
        rightResponseSeconds: requireBoundaryInteger(
          dispute['rightResponseSeconds'],
          'PRODUCTION_SWAP_LOAD_ACCOUNT_RIGHT_RESPONSE_INVALID',
          0,
        ),
      }),
    },
  };
};

export const decodeAccountPage = (value: unknown): LoadAccountProjection | null => {
  const items = decodePageItems(value, 'PRODUCTION_SWAP_LOAD_ACCOUNT_PAGE_INVALID');
  if (items.length > 1) throw new Error('PRODUCTION_SWAP_LOAD_ACCOUNT_PAGE_CARDINALITY_INVALID');
  return items[0] === undefined ? null : decodeAccountView(items[0]);
};

export const decodeAccountPageItems = (value: unknown): LoadAccountProjection[] =>
  decodePageItems(value, 'PRODUCTION_SWAP_LOAD_ACCOUNT_PAGE_INVALID').map(decodeAccountView);

export const decodeAccountPageCursor = (value: unknown): {
  items: LoadAccountProjection[];
  nextCursor: string | null;
} => {
  const page = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_ACCOUNT_PAGE_INVALID');
  requireExactBoundaryKeys(page, [
    'items', 'nextCursor', 'prevCursor', 'firstCursor', 'lastCursor', 'pageIndex', 'pageCount', 'totalItems', 'limit',
  ], ['summary'], 'PRODUCTION_SWAP_LOAD_ACCOUNT_PAGE_INVALID_FIELDS');
  const nextCursor = page['nextCursor'];
  if (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor.trim())) {
    throw new Error('PRODUCTION_SWAP_LOAD_ACCOUNT_PAGE_CURSOR_INVALID');
  }
  if (!Array.isArray(page['items'])) throw new Error('PRODUCTION_SWAP_LOAD_ACCOUNT_PAGE_ITEMS');
  return {
    items: page['items'].map(decodeAccountView),
    nextCursor,
  };
};

export type HubSettlementCounters = Readonly<{
  height: number;
  paybookOpen: number;
  paybookFeesEarned: bigint;
  acceptedPayments: number;
  completedPayments: number;
  matchedSwaps: number;
  metricsRuntimeHeight: number;
}>;

export const decodeHubSettlementCounters = (value: unknown): HubSettlementCounters => {
  const core = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_HUB_SETTLEMENT_COUNTERS_INVALID');
  requireExactBoundaryKeys(
    core,
    ['height', 'paybookOpen', 'paybookFeesEarned', 'metrics'],
    [],
    'PRODUCTION_SWAP_LOAD_HUB_SETTLEMENT_COUNTERS_FIELDS_INVALID',
  );
  const paybookOpen = core['paybookOpen'];
  if (!Number.isSafeInteger(paybookOpen) || Number(paybookOpen) < 0) {
    throw new Error('PRODUCTION_SWAP_LOAD_HUB_PAYBOOK_OPEN_INVALID');
  }
  const fees = core['paybookFeesEarned'];
  if (typeof fees !== 'bigint' || fees < 0n) throw new Error('PRODUCTION_SWAP_LOAD_HUB_PAYBOOK_FEES_INVALID');
  const metrics = requireBoundaryRecord(core['metrics'], 'PRODUCTION_SWAP_LOAD_HUB_METRICS_INVALID');
  requireExactBoundaryKeys(
    metrics,
    ['acceptedPayments', 'completedPayments', 'matchedSwaps', 'updatedAtRuntimeHeight'],
    [],
    'PRODUCTION_SWAP_LOAD_HUB_METRICS_FIELDS_INVALID',
  );
  return {
    height: requireBoundaryInteger(core['height'], 'PRODUCTION_SWAP_LOAD_HUB_HEIGHT_INVALID', 0),
    paybookOpen: Number(paybookOpen),
    paybookFeesEarned: fees,
    acceptedPayments: requireBoundaryInteger(
      metrics['acceptedPayments'],
      'PRODUCTION_SWAP_LOAD_HUB_ACCEPTED_PAYMENTS_INVALID',
      0,
    ),
    completedPayments: requireBoundaryInteger(
      metrics['completedPayments'],
      'PRODUCTION_SWAP_LOAD_HUB_COMPLETED_PAYMENTS_INVALID',
      0,
    ),
    matchedSwaps: requireBoundaryInteger(
      metrics['matchedSwaps'],
      'PRODUCTION_SWAP_LOAD_HUB_MATCHED_SWAPS_INVALID',
      0,
    ),
    metricsRuntimeHeight: requireBoundaryInteger(
      metrics['updatedAtRuntimeHeight'],
      'PRODUCTION_SWAP_LOAD_HUB_METRICS_HEIGHT_INVALID',
      0,
    ),
  };
};

export const decodeLoadFrame = (value: unknown): LoadFrame => {
  const frame = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_FRAME_INVALID');
  requireExactBoundaryKeys(frame, ['height', 'timestamp', 'postStateHash', 'stateHash', 'runtimeInputCounts', 'touchedCounts'], ['prevFrameHash', 'frameHash', 'hashMode', 'materializedState', 'canonicalStateHash', 'entityHashes', 'canonicalEntityHashes'], 'PRODUCTION_SWAP_LOAD_FRAME_FIELDS_INVALID');
  const canonicalStateHash = requireText(frame['canonicalStateHash'] ?? frame['postStateHash'], 'PRODUCTION_SWAP_LOAD_FRAME_ROOT_INVALID');
  if (!/^0x[0-9a-f]{64}$/.test(canonicalStateHash)) throw new Error('PRODUCTION_SWAP_LOAD_FRAME_ROOT_INVALID');
  return {
    height: requireBoundaryInteger(frame['height'], 'PRODUCTION_SWAP_LOAD_FRAME_HEIGHT_INVALID', 1),
    canonicalStateHash,
  };
};

const decodeReportLoadFrame = (value: unknown): LoadFrame => {
  const frame = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_REPORT_FRAME_INVALID');
  requireExactBoundaryKeys(frame, ['height', 'canonicalStateHash'], [], 'PRODUCTION_SWAP_LOAD_REPORT_FRAME_FIELDS_INVALID');
  const canonicalStateHash = requireText(frame['canonicalStateHash'], 'PRODUCTION_SWAP_LOAD_REPORT_FRAME_ROOT_INVALID');
  if (!/^0x[0-9a-f]{64}$/.test(canonicalStateHash)) throw new Error('PRODUCTION_SWAP_LOAD_REPORT_FRAME_ROOT_INVALID');
  return {
    height: requireBoundaryInteger(frame['height'], 'PRODUCTION_SWAP_LOAD_REPORT_FRAME_HEIGHT_INVALID', 1),
    canonicalStateHash,
  };
};

const decodeLoadExchangeDistribution = (value: unknown): LoadExchangeDistribution => {
  const distribution = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_DISTRIBUTION_INVALID');
  const fields = [
    'submittedOffers', 'matchedSubmittedOffers', 'matchedTrades', 'cancelledOffers',
    'mmOnlyTakers', 'userOnlyTakers', 'partialUserMakerFills', 'mmResidualTakers',
    'sweep2Takers', 'sweep5Takers', 'sweep10Takers', 'sweep20Takers',
  ] as const;
  requireExactBoundaryKeys(distribution, fields, [], 'PRODUCTION_SWAP_LOAD_DISTRIBUTION_FIELDS_INVALID');
  return Object.fromEntries(fields.map(field => [field, requireBoundaryInteger(
    distribution[field],
    `PRODUCTION_SWAP_LOAD_DISTRIBUTION_${field.toUpperCase()}_INVALID`,
    0,
  )])) as LoadExchangeDistribution;
};

export const decodeLoadSustainedReport = (value: unknown): LoadSustainedReport => {
  const report = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_REPORT_INVALID');
  const numeric = [
    'configuredUsers', 'configuredRounds', 'cadenceMs', 'offeredOrderRate',
    'offeredEconomicSwapRate', 'loadMakerAccountCount', 'loadTakerAccountCount',
    'loadParticipantAccountCount', 'maxOrdersPerAccountFrame',
    'runtimeInputBatches', 'expectedSubmittedOffers', 'expectedMatchedTrades',
    'cancelledOffers', 'matchedSubmittedOffers',
    'enqueueAckElapsedMs', 'commandObservedElapsedMs', 'matchedElapsedMs',
    'fullySettledElapsedMs', 'tradeCountBefore',
    'tradeCountAfter',
    'driverRssBefore', 'driverRssAfter',
    'walBytesBefore', 'walBytesAfter',
  ] as const;
  requireExactBoundaryKeys(report, [
    'schema', 'engine', 'mode', 'schedule', 'configuredUsers', 'configuredRounds', 'cadenceMs',
    'offeredOrderRate', 'offeredEconomicSwapRate', 'loadMakerAccountCount',
    'loadTakerAccountCount', 'loadParticipantAccountCount', 'maxOrdersPerAccountFrame',
    'runtimeInputBatches', 'roundSubmissionLagMs', 'expectedSubmittedOffers',
    'expectedMatchedTrades', 'cancelledOffers',
    'matchedSubmittedOffers', 'exchangeDistribution',
    'completionAuthority', 'enqueueAckElapsedMs', 'commandObservedElapsedMs',
    'matchedElapsedMs', 'fullySettledElapsedMs', 'matchedTps', 'fullySettledTps', 'tradeCountBefore',
    'tradeCountAfter',
    'driverRssBefore', 'driverRssAfter',
    'walBytesBefore', 'walBytesAfter', 'crossedBookAfterRun',
    'durableBefore', 'durableAfter', 'loadDurableBefore', 'loadDurableAfter',
    'settlementEvidence', 'environment',
  ], [], 'PRODUCTION_SWAP_LOAD_REPORT_FIELDS_INVALID');
  if (report['schema'] !== 'xln-production-swap-load-sustained-v1' || report['mode'] !== 'same') throw new Error('PRODUCTION_SWAP_LOAD_REPORT_SCHEMA_INVALID');
  const engine = report['engine'];
  if (engine !== 'ts' && engine !== 'rust') throw new Error('PRODUCTION_SWAP_LOAD_REPORT_ENGINE_INVALID');
  const schedule = report['schedule'];
  if (
    schedule !== 'one_order_per_account_per_round' &&
    schedule !== 'resting_maker_aggressive_taker' &&
    schedule !== 'balanced_role_rotation'
  ) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_SCHEDULE_INVALID');
  }
  if (report['completionAuthority'] !== 'committed_trade_count_and_bilateral_runtime_quiescence') throw new Error('PRODUCTION_SWAP_LOAD_REPORT_AUTHORITY_INVALID');
  if (report['crossedBookAfterRun'] !== false) throw new Error('PRODUCTION_SWAP_LOAD_REPORT_CROSSED_BOOK_REMAINS');
  for (const field of numeric) requireBoundaryInteger(report[field], `PRODUCTION_SWAP_LOAD_REPORT_${field.toUpperCase()}_INVALID`);
  for (const field of ['matchedTps', 'fullySettledTps'] as const) {
    if (typeof report[field] !== 'number' || !Number.isFinite(report[field]) || report[field] < 0) {
      throw new Error(`PRODUCTION_SWAP_LOAD_REPORT_${field.toUpperCase()}_INVALID`);
    }
  }
  const durableBefore = decodeReportLoadFrame(report['durableBefore']);
  const durableAfter = decodeReportLoadFrame(report['durableAfter']);
  const loadDurableBefore = decodeReportLoadFrame(report['loadDurableBefore']);
  const loadDurableAfter = decodeReportLoadFrame(report['loadDurableAfter']);
  const submitted = Number(report['expectedSubmittedOffers']);
  const matched = Number(report['expectedMatchedTrades']);
  const cancelled = Number(report['cancelledOffers']);
  const matchedSubmitted = Number(report['matchedSubmittedOffers']);
  if (Number(report['tradeCountAfter']) - Number(report['tradeCountBefore']) !== matched) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_TRADE_DELTA_MISMATCH');
  }
  if (matchedSubmitted + cancelled !== submitted) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_SUBMISSION_INVALID');
  }
  const maxOrdersPerAccountFrame = Number(report['maxOrdersPerAccountFrame']);
  if (!Number.isSafeInteger(maxOrdersPerAccountFrame) || maxOrdersPerAccountFrame < 1) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_ACCOUNT_FRAME_CAP_INVALID');
  }
  const makerAccounts = Number(report['loadMakerAccountCount']);
  const takerAccounts = Number(report['loadTakerAccountCount']);
  const participantAccounts = Number(report['loadParticipantAccountCount']);
  const rounds = Number(report['configuredRounds']);
  const cadenceMs = Number(report['cadenceMs']);
  if (participantAccounts !== makerAccounts + takerAccounts || makerAccounts !== takerAccounts || takerAccounts < 1) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_ACCOUNT_COUNTS_INVALID');
  }
  const expectedSubmitted = participantAccounts * rounds;
  if (Number(report['configuredUsers']) !== participantAccounts || submitted !== expectedSubmitted) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_SCHEDULE_TOTAL_INVALID');
  }
  if ((schedule === 'one_order_per_account_per_round' || schedule === 'balanced_role_rotation') &&
    (matched > takerAccounts * rounds || cancelled > submitted || matchedSubmitted > submitted)) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_PEER_TOTAL_INVALID');
  }
  if (Number(report['runtimeInputBatches']) !== expectedSubmitted) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_ROUND_COUNT_INVALID');
  }
  const expectedOrderRate = participantAccounts * 1_000 / cadenceMs;
  const expectedEconomicRate = (schedule === 'resting_maker_aggressive_taker'
    ? participantAccounts
    : takerAccounts) * 1_000 / cadenceMs;
  if (report['offeredOrderRate'] !== expectedOrderRate || report['offeredEconomicSwapRate'] !== expectedEconomicRate) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_OFFERED_RATE_INVALID');
  }
  if (
    !Array.isArray(report['roundSubmissionLagMs']) ||
    report['roundSubmissionLagMs'].length !== Number(report['runtimeInputBatches'])
  ) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_ROUND_LAG_INVALID');
  }
  const roundSubmissionLagMs = report['roundSubmissionLagMs'].map((entry, index) =>
    requireBoundaryInteger(entry, `PRODUCTION_SWAP_LOAD_REPORT_ROUND_LAG_INVALID:${index}`, 0));
  if (
    Number(report['enqueueAckElapsedMs']) > Number(report['commandObservedElapsedMs']) ||
    Number(report['commandObservedElapsedMs']) > Number(report['matchedElapsedMs']) ||
    Number(report['matchedElapsedMs']) > Number(report['fullySettledElapsedMs'])
  ) throw new Error('PRODUCTION_SWAP_LOAD_REPORT_TIMING_ORDER_INVALID');
  if (durableAfter.height < durableBefore.height) throw new Error('PRODUCTION_SWAP_LOAD_REPORT_HEIGHT_REGRESSION');
  if (loadDurableAfter.height < loadDurableBefore.height) throw new Error('PRODUCTION_SWAP_LOAD_REPORT_LOAD_HEIGHT_REGRESSION');
  const settlementEvidence = decodeProductionSwapSettlementEvidence(report['settlementEvidence']);
  const exchangeDistribution = decodeLoadExchangeDistribution(report['exchangeDistribution']);
  const rates = assertProductionSwapFullySettled(settlementEvidence);
  if (settlementEvidence.expectedSubmittedOffers !== submitted ||
    settlementEvidence.expectedMatchedTrades !== matched ||
    settlementEvidence.cancelledOffers !== cancelled ||
    settlementEvidence.tradeCountBefore !== Number(report['tradeCountBefore']) ||
    settlementEvidence.tradeCountAfter !== Number(report['tradeCountAfter']) ||
    settlementEvidence.matchedElapsedMs !== Number(report['matchedElapsedMs']) ||
    settlementEvidence.fullySettledElapsedMs !== Number(report['fullySettledElapsedMs']) ||
    rates.matchedTps !== report['matchedTps'] || rates.fullySettledTps !== report['fullySettledTps']) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_SETTLEMENT_EVIDENCE_MISMATCH');
  }
  if (exchangeDistribution.submittedOffers !== submitted ||
    exchangeDistribution.matchedSubmittedOffers !== matchedSubmitted ||
    exchangeDistribution.matchedTrades !== matched ||
    exchangeDistribution.cancelledOffers !== cancelled) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_DISTRIBUTION_MISMATCH');
  }
  return {
    schema: report['schema'], engine, mode: report['mode'], schedule,
    configuredUsers: Number(report['configuredUsers']), configuredRounds: rounds,
    cadenceMs, offeredOrderRate: report['offeredOrderRate'],
    offeredEconomicSwapRate: report['offeredEconomicSwapRate'],
    loadMakerAccountCount: makerAccounts,
    loadTakerAccountCount: takerAccounts,
    loadParticipantAccountCount: participantAccounts,
    maxOrdersPerAccountFrame,
    runtimeInputBatches: Number(report['runtimeInputBatches']),
    roundSubmissionLagMs,
    expectedSubmittedOffers: submitted,
    expectedMatchedTrades: matched,
    cancelledOffers: cancelled,
    matchedSubmittedOffers: matchedSubmitted,
    exchangeDistribution,
    completionAuthority: report['completionAuthority'],
    enqueueAckElapsedMs: Number(report['enqueueAckElapsedMs']),
    commandObservedElapsedMs: Number(report['commandObservedElapsedMs']),
    matchedElapsedMs: Number(report['matchedElapsedMs']),
    fullySettledElapsedMs: Number(report['fullySettledElapsedMs']),
    matchedTps: report['matchedTps'], fullySettledTps: report['fullySettledTps'],
    tradeCountBefore: Number(report['tradeCountBefore']),
    tradeCountAfter: Number(report['tradeCountAfter']),
    driverRssBefore: Number(report['driverRssBefore']),
    driverRssAfter: Number(report['driverRssAfter']), walBytesBefore: Number(report['walBytesBefore']),
    walBytesAfter: Number(report['walBytesAfter']), crossedBookAfterRun: false,
    durableBefore, durableAfter, loadDurableBefore, loadDurableAfter, settlementEvidence,
    environment: decodeHltEnvironmentManifest(report['environment'], 'PRODUCTION_SWAP_LOAD_REPORT_ENVIRONMENT'),
  };
};
