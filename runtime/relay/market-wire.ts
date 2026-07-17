import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../protocol/boundary-validation';
import { deserializeTaggedJson, serializeTaggedJson } from '../protocol/serialization';
import { XLN_PROTOCOL_VERSION, type XlnProtocolVersion } from '../protocol/version';
import {
  normalizeMarketEntityId,
  normalizeMarketPairId,
  RPC_MARKET_MAX_DEPTH,
  type MarketSideLevel,
  type MarketSnapshotPayload,
} from './market-snapshot';

export type MarketMessageType =
  | 'market_subscribe'
  | 'market_unsubscribe'
  | 'market_snapshot_request';

type MarketSelector = {
  hubEntityIds?: string[];
  hubEntityId?: string;
  pairs?: string[];
  pairId?: string;
};

export type MarketWireRequest =
  | ({ type: 'market_subscribe'; id: string; replace?: boolean; depth?: number } & MarketSelector)
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
  | { type: 'market_snapshot'; id: string; timestamp: number; payload: MarketSnapshotPayload }
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

const validateSelector = (message: Record<string, unknown>): void => {
  if (message['hubEntityIds'] !== undefined) requireStringArray(message['hubEntityIds'], 'MARKET_WIRE_HUB_IDS_INVALID');
  if (message['hubEntityId'] !== undefined) requireString(message['hubEntityId'], 'MARKET_WIRE_HUB_ID_INVALID');
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
    ['orderCount', 'ownerIds', 'orderIds'],
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
  return level as MarketSideLevel;
};

const validateMarketSnapshot = (value: unknown): MarketSnapshotPayload => {
  const payload = requireBoundaryRecord(value, 'MARKET_WIRE_SNAPSHOT_INVALID');
  requireExactBoundaryKeys(payload, [
    'format',
    'hubEntityId',
    'pairId',
    'depth',
    'displayDecimals',
    'priceScale',
    'bucketWidthTicks',
    'bids',
    'asks',
    'spread',
    'spreadPercent',
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
      'replace', 'depth', 'hubEntityIds', 'hubEntityId', 'pairs', 'pairId',
    ], 'MARKET_WIRE_FIELDS_INVALID');
    requireString(message['id'], 'MARKET_WIRE_ID_INVALID');
    validateSelector(message);
    if (message['replace'] !== undefined && typeof message['replace'] !== 'boolean') {
      throw new Error('MARKET_WIRE_REPLACE_INVALID');
    }
    if (message['depth'] !== undefined) requireBoundaryInteger(message['depth'], 'MARKET_WIRE_DEPTH_INVALID', 1);
  } else if (type === 'market_unsubscribe') {
    requireExactBoundaryKeys(message, ['v', 'type', 'id'], [
      'hubEntityIds', 'hubEntityId', 'pairs', 'pairId',
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
    validateMarketSnapshot(message['payload']);
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
  return stripEnvelope(validateMarketEnvelope(deserializeTaggedJson<unknown>(raw)));
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
