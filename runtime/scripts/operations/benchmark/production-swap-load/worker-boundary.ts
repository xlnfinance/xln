/**
 * Exact boundary decoders for the production swap-load worker. Disk manifests
 * and Runtime-adapter payloads remain unknown until every consumed shape has
 * been checked; no generic decode<T> can mint trusted financial state here.
 */

import type { RuntimeAdapterEntitySummary } from '../../../../api/runtime-adapter/types';
import { validateAccountReplica } from '../../../../account/validation/state-validation';
import type { AccountReplica } from '../../../../types/account';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';

export type LoadRuntimeEntry = Readonly<{ label: string; token: string; wsUrl: string }>;
export type LoadFrame = Readonly<{ height: number; canonicalStateHash: string }>;
export type LoadIdentity = Readonly<{ entityId: string; signerId: string }>;
export type LoadBurstReport = Readonly<{
  schema: 'xln-production-swap-load-burst-v1';
  mode: 'same';
  schedule: 'visible_depth_runtime_input_batches';
  configuredBurstSize: number;
  runtimeInputBatches: number;
  completedEconomicSwaps: number;
  completionAuthority: 'committed_orderbook_trade_count';
  enqueueAckElapsedMs: number;
  commandObservedElapsedMs: number;
  economicCompletionElapsedMs: number;
  completedTps: number;
  tradeCountBefore: number;
  tradeCountAfter: number;
  submittedEconomicSwaps: number;
  uncompletedEconomicSwapsAfterRun: number;
  driverRssBefore: number;
  driverRssAfter: number;
  walBytesBefore: number;
  walBytesAfter: number;
  durableBefore: LoadFrame;
  durableAfter: LoadFrame;
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
    requireExactBoundaryKeys(entry, ['access', 'label', 'token', 'wsUrl'], [], `PRODUCTION_SWAP_LOAD_MANIFEST_ENTRY_FIELDS_INVALID:${index}`);
    if (entry['access'] !== 'admin') throw new Error(`PRODUCTION_SWAP_LOAD_MANIFEST_ACCESS_INVALID:${index}`);
    return {
      label: requireText(entry['label'], `PRODUCTION_SWAP_LOAD_MANIFEST_LABEL_INVALID:${index}`),
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
    'nonces', 'proposals', 'reserves', 'lastFinalizedJHeight', 'jBlockChain',
    'htlcRoutes', 'htlcFeesEarned', 'lockBook',
  ], [
    'signerId', 'isProposer', 'prevFrameHash', 'externalWallet',
    'deferredAccountProposals', 'jBatchState', 'htlcNotes', 'outDebtsByToken',
    'inDebtsByToken', 'swapTradingPairs', 'crossJurisdictionSwaps',
    'pendingCrossJurisdictionFillAcks', 'crossJurisdictionBookAdmissions',
    'orderbookReferrals', 'orderbookHubProfile', 'hubRebalanceConfig',
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

export const decodeAccountPage = (value: unknown): AccountReplica | null => {
  const items = decodePageItems(value, 'PRODUCTION_SWAP_LOAD_ACCOUNT_PAGE_INVALID');
  if (items.length > 1) throw new Error('PRODUCTION_SWAP_LOAD_ACCOUNT_PAGE_CARDINALITY_INVALID');
  return items[0] === undefined ? null : validateAccountReplica(items[0], 'production-swap-load account');
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

export const decodeLoadBurstReport = (value: unknown): LoadBurstReport => {
  const report = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_REPORT_INVALID');
  const numeric = [
    'configuredBurstSize', 'runtimeInputBatches', 'completedEconomicSwaps', 'enqueueAckElapsedMs',
    'commandObservedElapsedMs', 'economicCompletionElapsedMs', 'tradeCountBefore',
    'tradeCountAfter', 'submittedEconomicSwaps', 'uncompletedEconomicSwapsAfterRun',
    'driverRssBefore', 'driverRssAfter',
    'walBytesBefore', 'walBytesAfter',
  ] as const;
  requireExactBoundaryKeys(report, [
    'schema', 'mode', 'schedule', 'configuredBurstSize', 'runtimeInputBatches', 'completedEconomicSwaps',
    'completionAuthority', 'enqueueAckElapsedMs', 'commandObservedElapsedMs',
    'economicCompletionElapsedMs', 'completedTps', 'tradeCountBefore',
    'tradeCountAfter', 'submittedEconomicSwaps', 'uncompletedEconomicSwapsAfterRun',
    'driverRssBefore', 'driverRssAfter',
    'walBytesBefore', 'walBytesAfter', 'durableBefore', 'durableAfter',
  ], [], 'PRODUCTION_SWAP_LOAD_REPORT_FIELDS_INVALID');
  if (report['schema'] !== 'xln-production-swap-load-burst-v1' || report['mode'] !== 'same') throw new Error('PRODUCTION_SWAP_LOAD_REPORT_SCHEMA_INVALID');
  if (report['schedule'] !== 'visible_depth_runtime_input_batches') throw new Error('PRODUCTION_SWAP_LOAD_REPORT_SCHEDULE_INVALID');
  if (report['completionAuthority'] !== 'committed_orderbook_trade_count') throw new Error('PRODUCTION_SWAP_LOAD_REPORT_AUTHORITY_INVALID');
  for (const field of numeric) requireBoundaryInteger(report[field], `PRODUCTION_SWAP_LOAD_REPORT_${field.toUpperCase()}_INVALID`);
  if (typeof report['completedTps'] !== 'number' || !Number.isFinite(report['completedTps']) || report['completedTps'] < 0) throw new Error('PRODUCTION_SWAP_LOAD_REPORT_TPS_INVALID');
  const durableBefore = decodeReportLoadFrame(report['durableBefore']);
  const durableAfter = decodeReportLoadFrame(report['durableAfter']);
  const completed = Number(report['completedEconomicSwaps']);
  if (Number(report['tradeCountAfter']) - Number(report['tradeCountBefore']) !== completed) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_TRADE_DELTA_MISMATCH');
  }
  if (Number(report['submittedEconomicSwaps']) !== completed || Number(report['uncompletedEconomicSwapsAfterRun']) !== 0) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_SUBMISSION_INVALID');
  }
  if (Number(report['configuredBurstSize']) !== completed) {
    throw new Error('PRODUCTION_SWAP_LOAD_REPORT_BURST_INCOMPLETE');
  }
  if (
    Number(report['enqueueAckElapsedMs']) > Number(report['commandObservedElapsedMs']) ||
    Number(report['commandObservedElapsedMs']) > Number(report['economicCompletionElapsedMs'])
  ) throw new Error('PRODUCTION_SWAP_LOAD_REPORT_TIMING_ORDER_INVALID');
  if (durableAfter.height < durableBefore.height) throw new Error('PRODUCTION_SWAP_LOAD_REPORT_HEIGHT_REGRESSION');
  return {
    schema: report['schema'], mode: report['mode'], schedule: report['schedule'],
    configuredBurstSize: Number(report['configuredBurstSize']),
    runtimeInputBatches: Number(report['runtimeInputBatches']),
    completedEconomicSwaps: completed,
    completionAuthority: report['completionAuthority'],
    enqueueAckElapsedMs: Number(report['enqueueAckElapsedMs']),
    commandObservedElapsedMs: Number(report['commandObservedElapsedMs']),
    economicCompletionElapsedMs: Number(report['economicCompletionElapsedMs']),
    completedTps: report['completedTps'], tradeCountBefore: Number(report['tradeCountBefore']),
    tradeCountAfter: Number(report['tradeCountAfter']),
    submittedEconomicSwaps: Number(report['submittedEconomicSwaps']),
    uncompletedEconomicSwapsAfterRun: Number(report['uncompletedEconomicSwapsAfterRun']),
    driverRssBefore: Number(report['driverRssBefore']),
    driverRssAfter: Number(report['driverRssAfter']), walBytesBefore: Number(report['walBytesBefore']),
    walBytesAfter: Number(report['walBytesAfter']), durableBefore, durableAfter,
  };
};
