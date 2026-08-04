import type {
  RuntimeAdapterActivityPage,
  RuntimeAdapterReadQuery,
  RuntimeActivityEvent,
  RuntimeActivityFilters,
} from '@xln/runtime/api/public/runtime-module';

export const WALLET_ACTIVITY_TYPES = Object.freeze([
  'payment',
  'swap',
  'cross_swap',
  'htlc',
  'settlement',
  'account',
  'j_event',
  'j_batch',
  'system',
  'error',
] as const);

export type WalletActivityType = typeof WALLET_ACTIVITY_TYPES[number];
export type WalletActivityKind = 'all' | 'onchain' | 'offchain';

export type WalletActivityQuery = Readonly<{
  entityId: string;
  kind: WalletActivityKind;
  types: readonly WalletActivityType[];
  search: string;
  limit: number;
  beforeHeight: number | null;
}>;

export type WalletActivityPage = Readonly<{
  latestHeight: number;
  fromHeight: number;
  toHeight: number;
  scannedFrames: number;
  limit: number;
  scanLimit: number;
  nextBeforeHeight: number | null;
  filters: RuntimeActivityFilters;
  events: readonly RuntimeActivityEvent[];
}>;

const ACTIVITY_KINDS = new Set(['onchain', 'offchain']);
const ACTIVITY_TYPES = new Set<string>(WALLET_ACTIVITY_TYPES);
const ACTIVITY_SOURCES = new Set(['runtime_input', 'runtime_log', 'j_input']);
const ACTIVITY_DIRECTIONS = new Set(['in', 'out', 'neutral']);
const INTEGER_TEXT = /^-?(?:0|[1-9]\d*)$/;

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const text = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value;
};

const integer = (value: unknown, code: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(code);
  return Number(value);
};

const optionalText = (value: unknown, code: string): string | undefined => {
  if (value === undefined) return undefined;
  return text(value, code);
};

const optionalPositiveInteger = (value: unknown, code: string): number | undefined => {
  if (value === undefined) return undefined;
  return integer(value, code, 1);
};

const optionalAmount = (value: unknown, code: string): string | undefined => {
  if (value === undefined) return undefined;
  const amount = text(value, code);
  if (!INTEGER_TEXT.test(amount)) throw new Error(code);
  BigInt(amount);
  return amount;
};

const optionalId = (value: unknown, code: string): string | undefined => {
  const id = optionalText(value, code);
  if (id !== undefined && id !== id.trim().toLowerCase()) throw new Error(code);
  return id;
};

const activityEvent = (value: unknown, index: number): RuntimeActivityEvent => {
  const raw = record(value, `WALLET_ACTIVITY_EVENT_INVALID:${index}`);
  const kind = text(raw['kind'], `WALLET_ACTIVITY_KIND_INVALID:${index}`);
  const type = text(raw['type'], `WALLET_ACTIVITY_TYPE_INVALID:${index}`);
  const source = text(raw['source'], `WALLET_ACTIVITY_SOURCE_INVALID:${index}`);
  const direction = text(raw['direction'], `WALLET_ACTIVITY_DIRECTION_INVALID:${index}`);
  if (!ACTIVITY_KINDS.has(kind)) throw new Error(`WALLET_ACTIVITY_KIND_UNKNOWN:${kind}`);
  if (!ACTIVITY_TYPES.has(type)) throw new Error(`WALLET_ACTIVITY_TYPE_UNKNOWN:${type}`);
  if (!ACTIVITY_SOURCES.has(source)) throw new Error(`WALLET_ACTIVITY_SOURCE_UNKNOWN:${source}`);
  if (!ACTIVITY_DIRECTIONS.has(direction)) throw new Error(`WALLET_ACTIVITY_DIRECTION_UNKNOWN:${direction}`);

  const event: RuntimeActivityEvent = {
    id: text(raw['id'], `WALLET_ACTIVITY_ID_INVALID:${index}`),
    height: integer(raw['height'], `WALLET_ACTIVITY_HEIGHT_INVALID:${index}`, 1),
    timestamp: integer(raw['timestamp'], `WALLET_ACTIVITY_TIMESTAMP_INVALID:${index}`, 1),
    kind: kind as RuntimeActivityEvent['kind'],
    type: type as RuntimeActivityEvent['type'],
    source: source as RuntimeActivityEvent['source'],
    direction: direction as RuntimeActivityEvent['direction'],
    title: text(raw['title'], `WALLET_ACTIVITY_TITLE_INVALID:${index}`),
    subtitle: text(raw['subtitle'], `WALLET_ACTIVITY_SUBTITLE_INVALID:${index}`),
    status: text(raw['status'], `WALLET_ACTIVITY_STATUS_INVALID:${index}`),
    rawType: text(raw['rawType'], `WALLET_ACTIVITY_RAW_TYPE_INVALID:${index}`),
  };
  const runtimeId = optionalId(raw['runtimeId'], `WALLET_ACTIVITY_RUNTIME_ID_INVALID:${index}`);
  const entityId = optionalId(raw['entityId'], `WALLET_ACTIVITY_ENTITY_ID_INVALID:${index}`);
  const counterpartyId = optionalId(raw['counterpartyId'], `WALLET_ACTIVITY_COUNTERPARTY_ID_INVALID:${index}`);
  const tokenId = optionalPositiveInteger(raw['tokenId'], `WALLET_ACTIVITY_TOKEN_ID_INVALID:${index}`);
  const quoteTokenId = optionalPositiveInteger(raw['quoteTokenId'], `WALLET_ACTIVITY_QUOTE_TOKEN_ID_INVALID:${index}`);
  const amount = optionalAmount(raw['amount'], `WALLET_ACTIVITY_AMOUNT_INVALID:${index}`);
  const quoteAmount = optionalAmount(raw['quoteAmount'], `WALLET_ACTIVITY_QUOTE_AMOUNT_INVALID:${index}`);
  const orderId = optionalText(raw['orderId'], `WALLET_ACTIVITY_ORDER_ID_INVALID:${index}`);
  const hash = optionalText(raw['hash'], `WALLET_ACTIVITY_HASH_INVALID:${index}`);
  return Object.freeze({
    ...event,
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    ...(entityId !== undefined ? { entityId } : {}),
    ...(counterpartyId !== undefined ? { counterpartyId } : {}),
    ...(tokenId !== undefined ? { tokenId } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(quoteTokenId !== undefined ? { quoteTokenId } : {}),
    ...(quoteAmount !== undefined ? { quoteAmount } : {}),
    ...(orderId !== undefined ? { orderId } : {}),
    ...(hash !== undefined ? { hash } : {}),
  });
};

const stableActivityOrder = (left: RuntimeActivityEvent, right: RuntimeActivityEvent): number =>
  right.timestamp - left.timestamp || right.height - left.height || right.id.localeCompare(left.id);

const validateFilters = (value: unknown): RuntimeActivityFilters => {
  const raw = record(value, 'WALLET_ACTIVITY_FILTERS_INVALID');
  const kind = raw['kind'];
  if (kind !== undefined && kind !== 'all' && !ACTIVITY_KINDS.has(String(kind))) {
    throw new Error(`WALLET_ACTIVITY_FILTER_KIND_UNKNOWN:${String(kind)}`);
  }
  if (raw['types'] !== undefined) {
    if (!Array.isArray(raw['types']) || raw['types'].some(candidate => typeof candidate !== 'string')) {
      throw new Error('WALLET_ACTIVITY_FILTER_TYPES_INVALID');
    }
  }
  return raw as RuntimeActivityFilters;
};

export const buildWalletActivityReadQuery = (query: WalletActivityQuery): RuntimeAdapterReadQuery => {
  const entityId = query.entityId.trim().toLowerCase();
  if (!entityId) throw new Error('WALLET_ACTIVITY_ENTITY_ID_MISSING');
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) {
    throw new Error(`WALLET_ACTIVITY_LIMIT_INVALID:${query.limit}`);
  }
  if (query.beforeHeight !== null && (!Number.isSafeInteger(query.beforeHeight) || query.beforeHeight < 1)) {
    throw new Error(`WALLET_ACTIVITY_CURSOR_INVALID:${String(query.beforeHeight)}`);
  }
  const selectedTypes = [...new Set(query.types)];
  if (selectedTypes.some(type => !ACTIVITY_TYPES.has(type))) throw new Error('WALLET_ACTIVITY_FILTER_TYPE_UNKNOWN');
  const search = query.search.trim();
  const filtered = selectedTypes.length > 0 || search.length > 0;
  return {
    entityId,
    kind: query.kind,
    limit: query.limit,
    scanLimit: filtered ? 1000 : 100,
    ...(selectedTypes.length > 0 ? { types: selectedTypes } : {}),
    ...(search ? { q: search } : {}),
    ...(query.beforeHeight !== null ? { beforeHeight: query.beforeHeight } : {}),
  };
};

export const parseWalletActivityPage = (value: unknown): WalletActivityPage => {
  const raw = record(value, 'WALLET_ACTIVITY_PAGE_INVALID');
  if (raw['ok'] !== true) throw new Error('WALLET_ACTIVITY_READ_FAILED');
  if (!Array.isArray(raw['events'])) throw new Error('WALLET_ACTIVITY_EVENTS_INVALID');
  const events = raw['events'].map(activityEvent);
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.id)) throw new Error(`WALLET_ACTIVITY_DUPLICATE_EVENT:${event.id}`);
    ids.add(event.id);
  }
  const returned = integer(raw['returned'], 'WALLET_ACTIVITY_RETURNED_INVALID');
  if (returned !== events.length) throw new Error(`WALLET_ACTIVITY_RETURNED_MISMATCH:${returned}:${events.length}`);
  const cursor = raw['nextBeforeHeight'] === null
    ? null
    : integer(raw['nextBeforeHeight'], 'WALLET_ACTIVITY_CURSOR_INVALID', 1);
  return Object.freeze({
    latestHeight: integer(raw['latestHeight'], 'WALLET_ACTIVITY_LATEST_HEIGHT_INVALID'),
    fromHeight: integer(raw['fromHeight'], 'WALLET_ACTIVITY_FROM_HEIGHT_INVALID'),
    toHeight: integer(raw['toHeight'], 'WALLET_ACTIVITY_TO_HEIGHT_INVALID'),
    scannedFrames: integer(raw['scannedFrames'], 'WALLET_ACTIVITY_SCANNED_INVALID'),
    limit: integer(raw['limit'], 'WALLET_ACTIVITY_PAGE_LIMIT_INVALID', 1),
    scanLimit: integer(raw['scanLimit'], 'WALLET_ACTIVITY_SCAN_LIMIT_INVALID', 1),
    nextBeforeHeight: cursor,
    filters: validateFilters(raw['filters']),
    events: Object.freeze(events.toSorted(stableActivityOrder)),
  });
};

export const mergeWalletActivityEvents = (
  current: readonly RuntimeActivityEvent[],
  next: readonly RuntimeActivityEvent[],
): readonly RuntimeActivityEvent[] => {
  const byId = new Map(current.map(event => [event.id, event] as const));
  for (const event of next) {
    const prior = byId.get(event.id);
    const same = prior && Object.keys({ ...prior, ...event }).every(key =>
      prior[key as keyof RuntimeActivityEvent] === event[key as keyof RuntimeActivityEvent]
    );
    if (prior && !same) {
      throw new Error(`WALLET_ACTIVITY_EVENT_CONFLICT:${event.id}`);
    }
    byId.set(event.id, event);
  }
  return Object.freeze([...byId.values()].toSorted(stableActivityOrder));
};
