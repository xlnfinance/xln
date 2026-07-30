import type { JurisdictionEvent } from '../types/jurisdiction-events';
import { compareStableText, safeStringify } from '../protocol/serialization';
import {
  normalizeMetadata,
  toRecord,
} from './event-normalization-primitives';
import { EVENT_NORMALIZERS } from './event-normalizers';

/**
 * This table is the only jurisdiction-event decoding registry. Each handler
 * validates one untrusted payload and returns a canonical discriminated-union
 * member. Unknown event types are intentionally ignored: a watcher may observe
 * newer contract logs before this Runtime understands their state semantics.
 */
const isKnownEventType = (value: string): value is JurisdictionEvent['type'] =>
  Object.hasOwn(EVENT_NORMALIZERS, value);

export function normalizeJurisdictionEvent(
  value: unknown,
): JurisdictionEvent | null {
  const raw = toRecord(value);
  const data = raw ? toRecord(raw['data']) : null;
  const type = raw && typeof raw['type'] === 'string' ? raw['type'] : '';
  if (!raw || !data || !isKnownEventType(type)) return null;
  const normalize = EVENT_NORMALIZERS[type];
  const event = normalize(data);
  return event ? { ...normalizeMetadata(raw), ...event } : null;
}

/**
 * Decode bytes that are already part of a consensus or history commitment.
 *
 * Filtering is forbidden here: otherwise `hash(valid + invalid)` would equal
 * `hash(valid)`, allowing signed bytes to disappear before application.
 * External watchers may ignore unknown logs before constructing J inputs, but
 * once an array enters RJEA every member must be canonical.
 */
export function requireCanonicalJurisdictionEvents(
  value: unknown,
): JurisdictionEvent[] {
  if (!Array.isArray(value)) throw new Error('JURISDICTION_EVENTS_ARRAY_REQUIRED');
  return value.map((item, index) => {
    const event = normalizeJurisdictionEvent(item);
    if (!event) {
      throw new Error(`JURISDICTION_EVENT_INVALID:${index}`);
    }
    return event;
  });
}

const canonicalJurisdictionEventPayloadKey = (
  event: JurisdictionEvent,
): string => {
  if (event.type === 'AccountSettled') {
    const data = event.data;
    return [
      'AccountSettled',
      data.leftEntity.toLowerCase(),
      data.rightEntity.toLowerCase(),
      data.tokenId,
      data.leftReserve,
      data.rightReserve,
      data.collateral,
      data.ondelta,
      data.nonce,
    ].join(':');
  }
  return `${event.type}:${safeStringify(event.data)}`;
};

export function canonicalJurisdictionEventKey(
  event: JurisdictionEvent,
): string {
  return safeStringify([
    event.blockNumber ?? null,
    event.blockHash?.toLowerCase() ?? null,
    event.transactionHash?.toLowerCase() ?? null,
    event.logIndex ?? null,
    event.eventIndex ?? null,
    canonicalJurisdictionEventPayloadKey(event),
  ]);
}

const compareOptionalIndex = (
  left: number | undefined,
  right: number | undefined,
): number => {
  if (left !== undefined && right !== undefined) return left - right;
  if (left !== undefined) return -1;
  if (right !== undefined) return 1;
  return 0;
};

/**
 * EVM execution order is consensus data. Payload sorting is only a deterministic
 * fallback for synthetic events that have no chain log position.
 */
export function compareCanonicalJurisdictionEvents(
  left: JurisdictionEvent,
  right: JurisdictionEvent,
): number {
  return (
    compareOptionalIndex(left.blockNumber, right.blockNumber) ||
    compareOptionalIndex(left.logIndex, right.logIndex) ||
    compareOptionalIndex(left.eventIndex, right.eventIndex) ||
    compareStableText(
      left.transactionHash?.toLowerCase() ?? '',
      right.transactionHash?.toLowerCase() ?? '',
    ) ||
    compareStableText(
      canonicalJurisdictionEventPayloadKey(left),
      canonicalJurisdictionEventPayloadKey(right),
    )
  );
}
