import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary-validation';
import { compareStableText, deserializeTaggedJson, serializeTaggedJson } from '../../../protocol/serialization';
import { XLN_PROTOCOL_VERSION, type XlnProtocolVersion } from '../../../protocol/version';
import { isJurisdictionStackRef } from '../../../jurisdiction/machine/jurisdiction-stack';
import {
  RPC_MARKET_MAX_DEPTH,
  type MarketPairCatalogPayload,
  type MarketSideLevel,
  type MarketSnapshotPayload,
} from './snapshot';
import type { RelayMarketSnapshotPayload, RelayMarketSource } from './aggregate';
import { normalizeMarketEntityId, normalizeMarketPairId } from './identifiers';

export type MarketMessageType =
  | 'market_subscribe'
  | 'market_unsubscribe'
  | 'market_snapshot_request';

type MarketSelector = {
  pairs?: string[];
  pairId?: string;
};

export type MarketWireRequest =
  | ({
      type: 'market_subscribe';
      id: string;
      replace?: boolean;
      depth?: number;
      hubEntityIds?: string[];
    } & MarketSelector)
  | ({ type: 'market_unsubscribe'; id: string } & MarketSelector)
  | { type: 'market_snapshot_request'; id: string };

type MarketSubscriptionData = {
  hubEntityIds: string[];
  pairs: string[];
  depth: number;
  intervalMs?: number;
};

export type MarketWireResponse =
  | {
      type: 'ack';
      inReplyTo: string;
      status: 'market_subscribed' | 'market_unsubscribed' | 'market_snapshot_sent';
      data?: MarketSubscriptionData;
    }
  | { type: 'error'; inReplyTo?: string; code?: string; error: string }
  | { type: 'market_snapshot'; id: string; timestamp: number; payload: RelayMarketSnapshotPayload }
  | { type: 'market_status'; inReplyTo?: string; status: 'no_market'; data: MarketSubscriptionData };

export type MarketWireMessage = MarketWireRequest | MarketWireResponse;
type MarketWireEnvelope = MarketWireMessage & { v: XlnProtocolVersion };

const MARKET_REQUEST_TYPES = new Set<MarketMessageType>([
  'market_subscribe',
  'market_unsubscribe',
  'market_snapshot_request',
]);
const MARKET_RESPONSE_TYPES = new Set(['ack', 'error', 'market_snapshot', 'market_status']);
const DEFAULT_MAX_MARKET_MESSAGE_BYTES = 1_048_576;

export const isMarketMessageType = (type: unknown): type is MarketMessageType =>
  typeof type === 'string' && MARKET_REQUEST_TYPES.has(type as MarketMessageType);

const requireString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
};

const requireUnsignedDecimal = (value: unknown, code: string, allowZero: boolean): string => {
  const text = requireString(value, code);
  if (text.length > 78 || !/^(0|[1-9]\d*)$/.test(text) || (!allowZero && text === '0')) {
    throw new Error(code);
  }
  return text;
};

const requireCanonicalMarketId = (
  value: unknown,
  normalize: (candidate: unknown) => string | null,
  code: string,
): string => {
  const text = requireString(value, code);
  if (normalize(text) !== text) throw new Error(code);
  return text;
};

const requireStringArray = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error(code);
  return value;
};

const validateHubSelector = (message: Record<string, unknown>): void => {
  if (message['hubEntityIds'] !== undefined) {
    const hubEntityIds = requireStringArray(message['hubEntityIds'], 'MARKET_WIRE_HUB_IDS_INVALID');
    if (
      hubEntityIds.length === 0
      || hubEntityIds.some(hubEntityId => normalizeMarketEntityId(hubEntityId) !== hubEntityId)
      || new Set(hubEntityIds).size !== hubEntityIds.length
      || hubEntityIds.some((hubEntityId, index) => {
        const previous = hubEntityIds[index - 1];
        return index > 0 && previous !== undefined && previous >= hubEntityId;
      })
    ) throw new Error('MARKET_WIRE_HUB_IDS_INVALID');
  }
};

const validateSelector = (message: Record<string, unknown>): void => {
  if (message['pairs'] !== undefined) requireStringArray(message['pairs'], 'MARKET_WIRE_PAIRS_INVALID');
  if (message['pairId'] !== undefined) requireString(message['pairId'], 'MARKET_WIRE_PAIR_ID_INVALID');
};

const validateSubscriptionData = (value: unknown): MarketSubscriptionData => {
  const data = requireBoundaryRecord(value, 'MARKET_WIRE_DATA_INVALID');
  requireExactBoundaryKeys(
    data,
    ['hubEntityIds', 'pairs', 'depth'],
    ['intervalMs'],
    'MARKET_WIRE_DATA_FIELDS_INVALID',
  );
  requireStringArray(data['hubEntityIds'], 'MARKET_WIRE_DATA_HUB_IDS_INVALID');
  requireStringArray(data['pairs'], 'MARKET_WIRE_DATA_PAIRS_INVALID');
  requireBoundaryInteger(data['depth'], 'MARKET_WIRE_DATA_DEPTH_INVALID', 0);
  if (data['intervalMs'] !== undefined) {
    requireBoundaryInteger(data['intervalMs'], 'MARKET_WIRE_DATA_INTERVAL_INVALID', 0);
  }
  return data as MarketSubscriptionData;
};

const validateMarketLevel = (value: unknown): MarketSideLevel => {
  const level = requireBoundaryRecord(value, 'MARKET_WIRE_LEVEL_INVALID');
  requireExactBoundaryKeys(
    level,
    ['price', 'size', 'total'],
    ['orderCount', 'ownerIds', 'orderIds', 'sourceHubEntityIds'],
    'MARKET_WIRE_LEVEL_FIELDS_INVALID',
  );
  requireUnsignedDecimal(level['price'], 'MARKET_WIRE_LEVEL_PRICE_INVALID', false);
  requireUnsignedDecimal(level['size'], 'MARKET_WIRE_LEVEL_SIZE_INVALID', false);
  requireUnsignedDecimal(level['total'], 'MARKET_WIRE_LEVEL_TOTAL_INVALID', false);
  if (level['orderCount'] !== undefined) {
    requireBoundaryInteger(level['orderCount'], 'MARKET_WIRE_LEVEL_COUNT_INVALID', 0);
  }
  if (level['ownerIds'] !== undefined) requireStringArray(level['ownerIds'], 'MARKET_WIRE_LEVEL_OWNERS_INVALID');
  if (level['orderIds'] !== undefined) requireStringArray(level['orderIds'], 'MARKET_WIRE_LEVEL_ORDERS_INVALID');
  if (level['sourceHubEntityIds'] !== undefined) {
    const sourceIds = requireStringArray(level['sourceHubEntityIds'], 'MARKET_WIRE_LEVEL_SOURCE_HUBS_INVALID');
    if (
      sourceIds.some(sourceId => normalizeMarketEntityId(sourceId) !== sourceId)
      || new Set(sourceIds).size !== sourceIds.length
    ) throw new Error('MARKET_WIRE_LEVEL_SOURCE_HUBS_INVALID');
  }
  return level as MarketSideLevel;
};

export const decodeMarketPairCatalogPayload = (value: unknown): MarketPairCatalogPayload => {
  const payload = requireBoundaryRecord(value, 'MARKET_PAIR_CATALOG_INVALID');
  requireExactBoundaryKeys(payload, [
    'format',
    'hubEntityId',
    'jurisdictionRef',
    'pairIds',
    'entityHeight',
    'entityStateHash',
    'updatedAt',
  ], [], 'MARKET_PAIR_CATALOG_FIELDS_INVALID');
  if (payload['format'] !== 'market-pair-catalog') throw new Error('MARKET_PAIR_CATALOG_FORMAT_INVALID');
  requireCanonicalMarketId(payload['hubEntityId'], normalizeMarketEntityId, 'MARKET_PAIR_CATALOG_HUB_INVALID');
  if (!isJurisdictionStackRef(payload['jurisdictionRef']) || String(payload['jurisdictionRef']).toLowerCase() !== payload['jurisdictionRef']) {
    throw new Error('MARKET_PAIR_CATALOG_JURISDICTION_INVALID');
  }
  const pairIds = requireStringArray(payload['pairIds'], 'MARKET_PAIR_CATALOG_PAIRS_INVALID');
  if (
    pairIds.some(pair => normalizeMarketPairId(pair) !== pair)
    || new Set(pairIds).size !== pairIds.length
    || pairIds.some((pair, index) => {
      const previous = pairIds[index - 1];
      return index > 0 && previous !== undefined && previous >= pair;
    })
  ) {
    throw new Error('MARKET_PAIR_CATALOG_PAIRS_INVALID');
  }
  for (const key of ['entityHeight', 'updatedAt'] as const) {
    requireBoundaryInteger(payload[key], `MARKET_PAIR_CATALOG_${key}_INVALID`, 0);
  }
  if (
    payload['entityStateHash'] !== null
    && !/^0x[0-9a-f]{64}$/.test(requireString(payload['entityStateHash'], 'MARKET_PAIR_CATALOG_HASH_INVALID'))
  ) throw new Error('MARKET_PAIR_CATALOG_HASH_INVALID');
  return payload as MarketPairCatalogPayload;
};

export const decodeMarketSnapshotPayload = (value: unknown): MarketSnapshotPayload => {
  const payload = requireBoundaryRecord(value, 'MARKET_WIRE_SNAPSHOT_INVALID');
  requireExactBoundaryKeys(payload, [
    'format',
    'hubEntityId',
    'jurisdictionRef',
    'pairId',
    'depth',
    'displayDecimals',
    'priceScale',
    'bucketWidthTicks',
    'bids',
    'asks',
    'spread',
    'spreadPercent',
    'lastTradePrice',
    'tradeCount',
    'source',
    'entityHeight',
    'entityStateHash',
    'hubUpdatedAt',
    'updatedAt',
  ], [], 'MARKET_WIRE_SNAPSHOT_FIELDS_INVALID');
  if (payload['format'] !== 'exact-price-levels') throw new Error('MARKET_WIRE_SNAPSHOT_FORMAT_INVALID');
  if (payload['source'] !== 'orderbookExt') throw new Error('MARKET_WIRE_SNAPSHOT_SOURCE_INVALID');
  requireCanonicalMarketId(
    payload['hubEntityId'],
    normalizeMarketEntityId,
    'MARKET_WIRE_SNAPSHOT_hubEntityId_INVALID',
  );
  if (!isJurisdictionStackRef(payload['jurisdictionRef']) || String(payload['jurisdictionRef']).toLowerCase() !== payload['jurisdictionRef']) {
    throw new Error('MARKET_WIRE_SNAPSHOT_jurisdictionRef_INVALID');
  }
  requireCanonicalMarketId(
    payload['pairId'],
    normalizeMarketPairId,
    'MARKET_WIRE_SNAPSHOT_pairId_INVALID',
  );
  requireUnsignedDecimal(payload['priceScale'], 'MARKET_WIRE_SNAPSHOT_priceScale_INVALID', false);
  const spreadPercent = requireString(payload['spreadPercent'], 'MARKET_WIRE_SNAPSHOT_spreadPercent_INVALID');
  if (spreadPercent !== '-' && !/^(0|[1-9]\d*)(\.\d+)?$/.test(spreadPercent)) {
    throw new Error('MARKET_WIRE_SNAPSHOT_spreadPercent_INVALID');
  }
  for (const key of ['displayDecimals', 'entityHeight', 'hubUpdatedAt', 'updatedAt'] as const) {
    requireBoundaryInteger(payload[key], `MARKET_WIRE_SNAPSHOT_${key}_INVALID`, 0);
  }
  const tradeCount = requireBoundaryInteger(payload['tradeCount'], 'MARKET_WIRE_SNAPSHOT_tradeCount_INVALID', 0);
  if (payload['lastTradePrice'] === null) {
    if (tradeCount !== 0) throw new Error('MARKET_WIRE_SNAPSHOT_lastTradePrice_INVALID');
  } else {
    requireUnsignedDecimal(payload['lastTradePrice'], 'MARKET_WIRE_SNAPSHOT_lastTradePrice_INVALID', false);
    if (tradeCount === 0) throw new Error('MARKET_WIRE_SNAPSHOT_lastTradePrice_INVALID');
  }
  const depth = requireBoundaryInteger(payload['depth'], 'MARKET_WIRE_SNAPSHOT_depth_INVALID', 1);
  if (depth > RPC_MARKET_MAX_DEPTH) throw new Error('MARKET_WIRE_SNAPSHOT_depth_INVALID');
  for (const key of ['bucketWidthTicks', 'spread'] as const) {
    if (payload[key] !== null) {
      requireUnsignedDecimal(payload[key], `MARKET_WIRE_SNAPSHOT_${key}_INVALID`, key === 'spread');
    }
  }
  if (
    payload['entityStateHash'] !== null
    && !/^0x[0-9a-f]{64}$/.test(requireString(payload['entityStateHash'], 'MARKET_WIRE_SNAPSHOT_entityStateHash_INVALID'))
  ) {
    throw new Error('MARKET_WIRE_SNAPSHOT_entityStateHash_INVALID');
  }
  for (const key of ['bids', 'asks'] as const) {
    if (!Array.isArray(payload[key])) throw new Error(`MARKET_WIRE_SNAPSHOT_${key}_INVALID`);
    if (payload[key].length > depth) throw new Error(`MARKET_WIRE_SNAPSHOT_${key}_INVALID`);
    payload[key].forEach(validateMarketLevel);
  }
  return payload as MarketSnapshotPayload;
};

const validateRelayMarketSource = (value: unknown): RelayMarketSource => {
  const source = requireBoundaryRecord(value, 'MARKET_WIRE_AGGREGATE_SOURCE_INVALID');
  requireExactBoundaryKeys(source, [
    'hubEntityId',
    'jurisdictionRef',
    'entityHeight',
    'entityStateHash',
    'hubUpdatedAt',
    'snapshotUpdatedAt',
    'tradeCount',
    'lastTradePrice',
  ], [], 'MARKET_WIRE_AGGREGATE_SOURCE_FIELDS_INVALID');
  requireCanonicalMarketId(source['hubEntityId'], normalizeMarketEntityId, 'MARKET_WIRE_AGGREGATE_SOURCE_HUB_INVALID');
  if (!isJurisdictionStackRef(source['jurisdictionRef']) || String(source['jurisdictionRef']).toLowerCase() !== source['jurisdictionRef']) {
    throw new Error('MARKET_WIRE_AGGREGATE_SOURCE_JURISDICTION_INVALID');
  }
  for (const key of ['entityHeight', 'hubUpdatedAt', 'snapshotUpdatedAt', 'tradeCount'] as const) {
    requireBoundaryInteger(source[key], `MARKET_WIRE_AGGREGATE_SOURCE_${key}_INVALID`, 0);
  }
  if (
    source['entityStateHash'] !== null
    && !/^0x[0-9a-f]{64}$/.test(requireString(source['entityStateHash'], 'MARKET_WIRE_AGGREGATE_SOURCE_HASH_INVALID'))
  ) throw new Error('MARKET_WIRE_AGGREGATE_SOURCE_HASH_INVALID');
  const tradeCount = Number(source['tradeCount']);
  if (source['lastTradePrice'] === null) {
    if (tradeCount !== 0) throw new Error('MARKET_WIRE_AGGREGATE_SOURCE_LAST_TRADE_INVALID');
  } else {
    requireUnsignedDecimal(source['lastTradePrice'], 'MARKET_WIRE_AGGREGATE_SOURCE_LAST_TRADE_INVALID', false);
    if (tradeCount === 0) throw new Error('MARKET_WIRE_AGGREGATE_SOURCE_LAST_TRADE_INVALID');
  }
  return source as RelayMarketSource;
};

const validateRelayMarketSnapshot = (value: unknown): RelayMarketSnapshotPayload => {
  const payload = requireBoundaryRecord(value, 'MARKET_WIRE_AGGREGATE_INVALID');
  requireExactBoundaryKeys(payload, [
    'format',
    'pairId',
    'jurisdictionRef',
    'depth',
    'displayDecimals',
    'priceScale',
    'bids',
    'asks',
    'spread',
    'spreadPercent',
    'lastTradePrice',
    'lastTradeObservedAt',
    'lastTradeHubEntityId',
    'source',
    'sourceCount',
    'sources',
    'updatedAt',
  ], [], 'MARKET_WIRE_AGGREGATE_FIELDS_INVALID');
  if (payload['format'] !== 'exact-price-levels') throw new Error('MARKET_WIRE_AGGREGATE_FORMAT_INVALID');
  if (payload['source'] !== 'relayAggregate') throw new Error('MARKET_WIRE_AGGREGATE_KIND_INVALID');
  requireCanonicalMarketId(payload['pairId'], normalizeMarketPairId, 'MARKET_WIRE_AGGREGATE_PAIR_INVALID');
  if (!isJurisdictionStackRef(payload['jurisdictionRef']) || String(payload['jurisdictionRef']).toLowerCase() !== payload['jurisdictionRef']) {
    throw new Error('MARKET_WIRE_AGGREGATE_JURISDICTION_INVALID');
  }
  requireUnsignedDecimal(payload['priceScale'], 'MARKET_WIRE_AGGREGATE_SCALE_INVALID', false);
  const depth = requireBoundaryInteger(payload['depth'], 'MARKET_WIRE_AGGREGATE_DEPTH_INVALID', 1);
  if (depth > RPC_MARKET_MAX_DEPTH) throw new Error('MARKET_WIRE_AGGREGATE_DEPTH_INVALID');
  for (const key of ['displayDecimals', 'sourceCount', 'updatedAt'] as const) {
    requireBoundaryInteger(payload[key], `MARKET_WIRE_AGGREGATE_${key}_INVALID`, 0);
  }
  if (payload['sourceCount'] === 0) throw new Error('MARKET_WIRE_AGGREGATE_SOURCES_INVALID');
  if (!Array.isArray(payload['sources']) || payload['sources'].length !== payload['sourceCount']) {
    throw new Error('MARKET_WIRE_AGGREGATE_SOURCES_INVALID');
  }
  const decodedSources = payload['sources'].map(validateRelayMarketSource);
  const aggregateSourceIds = decodedSources.map(source => source.hubEntityId);
  if (
    new Set(aggregateSourceIds).size !== aggregateSourceIds.length
    || [...aggregateSourceIds].sort(compareStableText).some((sourceId, index) => sourceId !== aggregateSourceIds[index])
  ) {
    throw new Error('MARKET_WIRE_AGGREGATE_SOURCES_NONCANONICAL');
  }
  if (decodedSources.some(source => source.jurisdictionRef !== payload['jurisdictionRef'])) {
    throw new Error('MARKET_WIRE_AGGREGATE_SOURCE_JURISDICTION_MISMATCH');
  }
  for (const key of ['bids', 'asks'] as const) {
    if (!Array.isArray(payload[key]) || payload[key].length > depth) {
      throw new Error(`MARKET_WIRE_AGGREGATE_${key}_INVALID`);
    }
    const levels = payload[key].map(validateMarketLevel);
    if (levels.some(level =>
      !level.sourceHubEntityIds?.length
      || level.sourceHubEntityIds.some(sourceId => !aggregateSourceIds.includes(sourceId))
    )) throw new Error('MARKET_WIRE_AGGREGATE_LEVEL_SOURCES_INVALID');
  }
  if (payload['spread'] !== null) requireUnsignedDecimal(payload['spread'], 'MARKET_WIRE_AGGREGATE_SPREAD_INVALID', true);
  const spreadPercent = requireString(payload['spreadPercent'], 'MARKET_WIRE_AGGREGATE_SPREAD_PERCENT_INVALID');
  if (spreadPercent !== '-' && !/^(0|[1-9]\d*)(\.\d+)?$/.test(spreadPercent)) {
    throw new Error('MARKET_WIRE_AGGREGATE_SPREAD_PERCENT_INVALID');
  }
  const nullableTrade = [payload['lastTradePrice'], payload['lastTradeObservedAt'], payload['lastTradeHubEntityId']];
  if (nullableTrade.every(entry => entry === null)) {
    if (decodedSources.some(source => source.lastTradePrice !== null)) {
      throw new Error('MARKET_WIRE_AGGREGATE_LAST_TRADE_INVALID');
    }
    return payload as RelayMarketSnapshotPayload;
  }
  if (nullableTrade.some(entry => entry === null)) throw new Error('MARKET_WIRE_AGGREGATE_LAST_TRADE_INVALID');
  requireUnsignedDecimal(payload['lastTradePrice'], 'MARKET_WIRE_AGGREGATE_LAST_TRADE_PRICE_INVALID', false);
  const observedAt = requireBoundaryInteger(payload['lastTradeObservedAt'], 'MARKET_WIRE_AGGREGATE_LAST_TRADE_TIME_INVALID', 0);
  if (observedAt > Number(payload['updatedAt'])) throw new Error('MARKET_WIRE_AGGREGATE_LAST_TRADE_TIME_INVALID');
  const hubEntityId = requireCanonicalMarketId(
    payload['lastTradeHubEntityId'],
    normalizeMarketEntityId,
    'MARKET_WIRE_AGGREGATE_LAST_TRADE_HUB_INVALID',
  );
  const source = decodedSources.find(candidate => candidate.hubEntityId === hubEntityId);
  if (!source || source.lastTradePrice !== payload['lastTradePrice']) {
    throw new Error('MARKET_WIRE_AGGREGATE_LAST_TRADE_SOURCE_INVALID');
  }
  return payload as RelayMarketSnapshotPayload;
};

const validateMarketEnvelope = (value: unknown): MarketWireEnvelope => {
  const message = requireBoundaryRecord(value, 'MARKET_WIRE_OBJECT_INVALID');
  if (message['v'] !== XLN_PROTOCOL_VERSION) {
    throw new Error(`MARKET_WIRE_VERSION_INVALID:${String(message['v'] ?? 'missing')}`);
  }
  const type = requireString(message['type'], 'MARKET_WIRE_TYPE_INVALID');
  if (!MARKET_REQUEST_TYPES.has(type as MarketMessageType) && !MARKET_RESPONSE_TYPES.has(type)) {
    throw new Error(`MARKET_WIRE_TYPE_INVALID:${type}`);
  }

  if (type === 'market_subscribe') {
    requireExactBoundaryKeys(message, ['v', 'type', 'id'], [
      'replace', 'depth', 'hubEntityIds', 'pairs', 'pairId',
    ], 'MARKET_WIRE_FIELDS_INVALID');
    requireString(message['id'], 'MARKET_WIRE_ID_INVALID');
    validateHubSelector(message);
    validateSelector(message);
    if (message['replace'] !== undefined && typeof message['replace'] !== 'boolean') {
      throw new Error('MARKET_WIRE_REPLACE_INVALID');
    }
    if (message['depth'] !== undefined) requireBoundaryInteger(message['depth'], 'MARKET_WIRE_DEPTH_INVALID', 1);
  } else if (type === 'market_unsubscribe') {
    requireExactBoundaryKeys(message, ['v', 'type', 'id'], [
      'pairs', 'pairId',
    ], 'MARKET_WIRE_FIELDS_INVALID');
    requireString(message['id'], 'MARKET_WIRE_ID_INVALID');
    validateSelector(message);
  } else if (type === 'market_snapshot_request') {
    requireExactBoundaryKeys(message, ['v', 'type', 'id'], [], 'MARKET_WIRE_FIELDS_INVALID');
    requireString(message['id'], 'MARKET_WIRE_ID_INVALID');
  } else if (type === 'ack') {
    requireExactBoundaryKeys(message, ['v', 'type', 'inReplyTo', 'status'], ['data'], 'MARKET_WIRE_FIELDS_INVALID');
    requireString(message['inReplyTo'], 'MARKET_WIRE_REPLY_ID_INVALID');
    if (!['market_subscribed', 'market_unsubscribed', 'market_snapshot_sent'].includes(String(message['status']))) {
      throw new Error('MARKET_WIRE_ACK_STATUS_INVALID');
    }
    if (message['data'] !== undefined) validateSubscriptionData(message['data']);
  } else if (type === 'error') {
    requireExactBoundaryKeys(message, ['v', 'type', 'error'], ['inReplyTo', 'code'], 'MARKET_WIRE_FIELDS_INVALID');
    requireString(message['error'], 'MARKET_WIRE_ERROR_INVALID');
    if (message['inReplyTo'] !== undefined) requireString(message['inReplyTo'], 'MARKET_WIRE_REPLY_ID_INVALID');
    if (message['code'] !== undefined) requireString(message['code'], 'MARKET_WIRE_ERROR_CODE_INVALID');
  } else if (type === 'market_snapshot') {
    requireExactBoundaryKeys(message, ['v', 'type', 'id', 'timestamp', 'payload'], [], 'MARKET_WIRE_FIELDS_INVALID');
    requireString(message['id'], 'MARKET_WIRE_ID_INVALID');
    requireBoundaryInteger(message['timestamp'], 'MARKET_WIRE_TIMESTAMP_INVALID', 0);
    validateRelayMarketSnapshot(message['payload']);
  } else {
    requireExactBoundaryKeys(message, ['v', 'type', 'status', 'data'], ['inReplyTo'], 'MARKET_WIRE_FIELDS_INVALID');
    if (message['status'] !== 'no_market') throw new Error('MARKET_WIRE_STATUS_INVALID');
    if (message['inReplyTo'] !== undefined) requireString(message['inReplyTo'], 'MARKET_WIRE_REPLY_ID_INVALID');
    validateSubscriptionData(message['data']);
  }
  return message as MarketWireEnvelope;
};

const stripEnvelope = (envelope: MarketWireEnvelope): MarketWireMessage => {
  const { v: _version, ...message } = envelope;
  return message;
};

const marketMaxMessageBytes = (): number => {
  const configured = typeof process === 'undefined' ? undefined : process.env['XLN_MARKET_WS_MAX_MESSAGE_BYTES'];
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_MARKET_MESSAGE_BYTES;
};

export const encodeMarketWireMessage = (message: MarketWireMessage): string =>
  serializeTaggedJson(validateMarketEnvelope({ ...message, v: XLN_PROTOCOL_VERSION }));

export const decodeMarketWireMessage = (raw: unknown): MarketWireMessage => {
  if (typeof raw !== 'string') throw new Error('MARKET_WIRE_JSON_REQUIRED');
  const bytes = new TextEncoder().encode(raw).byteLength;
  const max = marketMaxMessageBytes();
  if (bytes > max) throw new Error(`MARKET_WIRE_TOO_LARGE:bytes=${bytes}:max=${max}`);
  return stripEnvelope(validateMarketEnvelope(deserializeTaggedJson(raw)));
};

export const decodeMarketWireRequest = (raw: unknown): MarketWireRequest => {
  const message = decodeMarketWireMessage(raw);
  switch (message.type) {
    case 'market_subscribe':
    case 'market_unsubscribe':
    case 'market_snapshot_request':
      return message;
    default:
      throw new Error('MARKET_WIRE_REQUEST_REQUIRED');
  }
};

export const decodeMarketWireResponse = (raw: unknown): MarketWireResponse => {
  const message = decodeMarketWireMessage(raw);
  switch (message.type) {
    case 'ack':
    case 'error':
    case 'market_snapshot':
    case 'market_status':
      return message;
    default:
      throw new Error('MARKET_WIRE_RESPONSE_REQUIRED');
  }
};
