import type {
  RuntimeAdapterActivityPage,
  RuntimeAdapterReadQuery,
  RuntimeActivityFilters,
} from '@xln/runtime/xln-api';
import { formatTokenAmount } from './entity-asset-values';
import { requireTokenDecimals } from './token-metadata';

export type ActivityHistoryQueryInput = {
  entityId: string;
  kind: 'all' | 'onchain' | 'offchain';
  pageSize: number;
  selectedTypes: string[];
  search: string;
  mode: 'paged' | 'infinite' | 'timeframe';
  beforeHeight: number | null;
  fromTimestamp?: number | undefined;
  toTimestamp?: number | undefined;
};

export const BASE_ACTIVITY_SCAN_LIMIT = 100;
export const FILTERED_ACTIVITY_SCAN_LIMIT = 1000;
export const TRANSIENT_ACTIVITY_READ_ERROR_PATTERN = /Database is not open|Iterator is not open|cannot call next\(\) after close/i;

export const normalizeActivityEntityId = (value: string): string => value.trim().toLowerCase();

export const formatActivityTokenAmount = (
  value: string | undefined,
  tokenId: number | undefined,
  getTokenInfo: (tokenId: number) => { decimals?: number },
  precision: unknown,
): string => {
  if (!value) return '';
  const amount = BigInt(value);
  if (tokenId === undefined) return amount.toString();
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    throw new Error(`ACTIVITY_TOKEN_ID_INVALID:${String(tokenId)}`);
  }
  const decimals = requireTokenDecimals(getTokenInfo(tokenId).decimals, `activity-token:${tokenId}`);
  return formatTokenAmount(amount, decimals, precision);
};

export const isTransientActivityReadError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '');
  return TRANSIENT_ACTIVITY_READ_ERROR_PATTERN.test(message);
};

export const resolveActivityHistoryScanLimit = (input: Pick<ActivityHistoryQueryInput, 'selectedTypes' | 'search' | 'mode'>): number => {
  const hasTypedFilter = input.selectedTypes.length > 0;
  const hasSearchFilter = input.search.trim().length > 0;
  return hasTypedFilter || hasSearchFilter || input.mode === 'timeframe'
    ? FILTERED_ACTIVITY_SCAN_LIMIT
    : BASE_ACTIVITY_SCAN_LIMIT;
};

export const buildActivityHistoryReadQuery = (input: ActivityHistoryQueryInput): RuntimeAdapterReadQuery => {
  const query: RuntimeAdapterReadQuery = {
    entityId: normalizeActivityEntityId(input.entityId),
    kind: input.kind,
    limit: input.pageSize,
    scanLimit: resolveActivityHistoryScanLimit(input),
  };
  if (input.selectedTypes.length > 0) query.types = input.selectedTypes;
  const trimmedSearch = input.search.trim();
  if (trimmedSearch) query.q = trimmedSearch;
  if (input.beforeHeight !== null) query.beforeHeight = input.beforeHeight;
  if (input.mode === 'timeframe') {
    if (input.fromTimestamp !== undefined) query.fromTimestamp = input.fromTimestamp;
    if (input.toTimestamp !== undefined) query.toTimestamp = input.toTimestamp;
  }
  return query;
};

type RawActivityHistoryPage = Partial<Omit<RuntimeAdapterActivityPage, 'events' | 'filters'>> & {
  events?: RuntimeAdapterActivityPage['events'];
  filters?: RuntimeActivityFilters;
  failures?: Array<{ hub?: string; apiPort?: number; error?: string }>;
  partial?: boolean;
};

const finiteFloor = (value: unknown, fallback: number): number => {
  const next = Math.floor(Number(value));
  return Number.isFinite(next) ? next : fallback;
};

const normalizeTypes = (value: RuntimeAdapterReadQuery['types']): string[] | undefined => {
  const types = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const normalized = types.map((item) => String(item || '').trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
};

export const activityFiltersFromQuery = (query: RuntimeAdapterReadQuery): RuntimeActivityFilters => ({
  ...(query.entityId ? { entityId: String(query.entityId).trim().toLowerCase() } : {}),
  kind: query.kind ?? 'all',
  ...(normalizeTypes(query.types) ? { types: normalizeTypes(query.types) } : {}),
  ...(String(query.q ?? query.query ?? '').trim() ? { query: String(query.q ?? query.query ?? '').trim() } : {}),
  ...(Number.isFinite(query.fromTimestamp) ? { fromTimestamp: finiteFloor(query.fromTimestamp, 0) } : {}),
  ...(Number.isFinite(query.toTimestamp) ? { toTimestamp: finiteFloor(query.toTimestamp, 0) } : {}),
});

export const normalizeActivityHistoryPage = (
  raw: RawActivityHistoryPage,
  query: RuntimeAdapterReadQuery,
): RuntimeAdapterActivityPage & {
  partial?: boolean;
  failures?: Array<{ hub?: string; apiPort?: number; error?: string }>;
} => {
  if ((raw as { ok?: unknown }).ok === false) {
    throw new Error('ACTIVITY_HISTORY_READ_FAILED');
  }
  const events = Array.isArray(raw.events) ? raw.events : [];
  const failures = Array.isArray(raw.failures) ? raw.failures : [];
  return {
    ok: true,
    latestHeight: Math.max(0, finiteFloor(raw.latestHeight, 0)),
    fromHeight: Math.max(0, finiteFloor(raw.fromHeight, 0)),
    toHeight: Math.max(0, finiteFloor(raw.toHeight, 0)),
    scannedFrames: Math.max(0, finiteFloor(raw.scannedFrames, 0)),
    returned: Math.max(0, finiteFloor(raw.returned, events.length)),
    limit: Math.max(1, finiteFloor(raw.limit, finiteFloor(query.limit, 100))),
    scanLimit: Math.max(1, finiteFloor(raw.scanLimit, finiteFloor(query.scanLimit, 100))),
    nextBeforeHeight: raw.nextBeforeHeight === null
      ? null
      : Number.isFinite(raw.nextBeforeHeight)
        ? Math.max(1, finiteFloor(raw.nextBeforeHeight, 1))
        : null,
    filters: raw.filters ?? activityFiltersFromQuery(query),
    events,
    ...(raw.partial === true || failures.length > 0 ? { partial: true } : {}),
    ...(failures.length > 0 ? { failures } : {}),
  };
};
