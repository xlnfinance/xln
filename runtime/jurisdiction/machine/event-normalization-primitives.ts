import type { JurisdictionEvent } from '../../types/jurisdiction-events';

const BIGINT_WRAPPER_RE = /^BigInt\((-?\d+)\)$/;

export type UnknownRecord = Record<string, unknown>;
type EventType = JurisdictionEvent['type'];
type EventData<T extends EventType> = Extract<
  JurisdictionEvent,
  { type: T }
>['data'];

export type JurisdictionEventNormalizer = (
  data: UnknownRecord,
) => JurisdictionEvent | null;
type FieldDecoder<T> = (value: unknown) => T | null;
type FieldSchema = Readonly<Record<string, FieldDecoder<unknown>>>;
type DecodedFields<T extends FieldSchema> = {
  [K in keyof T]: Exclude<ReturnType<T[K]>, null>;
};

export const toRecord = (value: unknown): UnknownRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
};

export const normalizeEntity = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const entityId = value.trim().toLowerCase();
  return entityId || null;
};

export const normalizeAddress = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
};

export const normalizeBytes32 = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const bytes = value.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(bytes) ? bytes : null;
};

export const normalizeHexBytes = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const bytes = value.trim().toLowerCase();
  return /^0x(?:[0-9a-f]{2})*$/.test(bytes) ? bytes : null;
};

export const normalizeBigNumberish = (value: unknown): string | null => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isInteger(value)
      ? String(value)
      : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const wrapped = BIGINT_WRAPPER_RE.exec(text);
  if (wrapped) return BigInt(wrapped[1]!).toString();
  return /^-?\d+$/.test(text) ? BigInt(text).toString() : null;
};

export const normalizeInt = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  }
  const integer = normalizeBigNumberish(value);
  if (integer === null) return null;
  const number = Number(integer);
  return Number.isSafeInteger(number) ? number : null;
};

/**
 * Event booleans are already ABI-decoded values. Do not accept 0/1 or text:
 * coercion here would let a malformed adapter payload change the signed Pull
 * role, which selects a different registry slot and deadline.
 */
export const normalizeBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

export const normalizeMetadata = (
  raw: UnknownRecord,
): Pick<
  JurisdictionEvent,
  'blockNumber' | 'blockHash' | 'transactionHash' | 'logIndex' | 'eventIndex'
> => {
  const metadata: Pick<
    JurisdictionEvent,
    'blockNumber' | 'blockHash' | 'transactionHash' | 'logIndex' | 'eventIndex'
  > = {};
  const blockNumber = normalizeInt(raw['blockNumber']);
  const logIndex = normalizeInt(raw['logIndex']);
  const eventIndex = normalizeInt(raw['eventIndex']);
  if (blockNumber !== null) metadata.blockNumber = blockNumber;
  if (typeof raw['blockHash'] === 'string' && raw['blockHash'].trim()) {
    metadata.blockHash = raw['blockHash'];
  }
  if (
    typeof raw['transactionHash'] === 'string' &&
    raw['transactionHash'].trim()
  ) {
    metadata.transactionHash = raw['transactionHash'];
  }
  if (logIndex !== null && logIndex >= 0) metadata.logIndex = logIndex;
  if (eventIndex !== null && eventIndex >= 0) metadata.eventIndex = eventIndex;
  return metadata;
};

export const isPositiveUint256 = (value: string | null): value is string =>
  value !== null && BigInt(value) >= 1n && BigInt(value) <= (1n << 256n) - 1n;

export const isActionKind = (value: number | null): value is 0 | 1 =>
  value === 0 || value === 1;

export const normalizeString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

export const decodeFields = <T extends FieldSchema>(
  data: UnknownRecord,
  schema: T,
): DecodedFields<T> | null => {
  const decoded: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    const value = schema[key]!(data[key]);
    if (value === null) return null;
    decoded[key] = value;
  }
  return decoded as DecodedFields<T>;
};

/**
 * The one assertion is confined to this decoder boundary. The callback must
 * produce the exact data member selected by `type`, so handlers cannot attach
 * AccountSettled data to (for example) a DebtCreated discriminator.
 */
export const defineEventNormalizer = <T extends EventType>(
  type: T,
  normalizeData: (data: UnknownRecord) => EventData<T> | null,
): JurisdictionEventNormalizer => data => {
  const normalized = normalizeData(data);
  return normalized
    ? { type, data: normalized } as Extract<JurisdictionEvent, { type: T }>
    : null;
};
