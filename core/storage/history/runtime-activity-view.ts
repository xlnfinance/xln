import { Level } from 'level';

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import type { RuntimeReplica } from '../../runtime/types';
import type { FrameLogEntry } from '../../types/logging';
import { createStructuredLogger } from '../../support/logger';
import { decodeBuffer, encodeBuffer, notFound } from '../codec/codec';
import { MAX_STORAGE_RECORD_BYTES } from '../schema/book-graph-codec';
import { resolveDbPath } from '../runtime-db-path';
import type { RuntimeFrame } from '../types';

const VIEW_SCHEMA_VERSION = 1;
const KEY_VIEW_HEAD = Buffer.from([0x00]);
const KEY_FRAME_MARKER = 0x01;
const KEY_FRAME_EVENT = 0x02;

export type RuntimeActivityViewHead = Readonly<{
  schemaVersion: 1;
  latestHeight: number;
  availableFromHeight: number;
  unavailableThroughHeight: number;
}>;

type RuntimeActivityFrameMarker = Readonly<{
  height: number;
  timestamp: number;
  frameHash: string;
  eventCount: number;
}>;

type ActivityViewHandle = Readonly<{
  db: Level<Buffer, Buffer>;
  open: Promise<void>;
}>;

const handles = new Map<string, ActivityViewHandle>();
const operationTails = new Map<string, Promise<void>>();
const repairFlights = new Map<string, Promise<void>>();
const closingPaths = new Set<string>();
const storageLog = createStructuredLogger('runtime.storage');

const resolveRuntimeActivityViewPath = (env: RuntimeReplica): string =>
  `${resolveDbPath(env, 'core')}-history-views`;

const heightKey = (tag: number, height: number): Buffer => {
  const key = Buffer.allocUnsafe(9);
  key[0] = tag;
  key.writeBigUInt64BE(BigInt(requireBoundaryInteger(height, 'RUNTIME_ACTIVITY_HEIGHT_INVALID')), 1);
  return key;
};

const eventKey = (height: number, ordinal: number): Buffer => {
  const key = Buffer.allocUnsafe(13);
  heightKey(KEY_FRAME_EVENT, height).copy(key);
  key.writeUInt32BE(requireBoundaryInteger(ordinal, 'RUNTIME_ACTIVITY_ORDINAL_INVALID'), 9);
  return key;
};

const openView = async (env: RuntimeReplica): Promise<Level<Buffer, Buffer>> => {
  const path = resolveRuntimeActivityViewPath(env);
  let handle = handles.get(path);
  if (!handle) {
    const db = new Level<Buffer, Buffer>(path, {
      keyEncoding: 'binary',
      valueEncoding: 'buffer',
    });
    handle = { db, open: db.open() };
    handles.set(path, handle);
  }
  try {
    await handle.open;
    return handle.db;
  } catch (error) {
    if (handles.get(path) === handle) handles.delete(path);
    throw error;
  }
};

const withRuntimeActivityViewLock = async <T>(
  env: RuntimeReplica,
  operation: (db: Level<Buffer, Buffer>) => Promise<T>,
): Promise<T> => {
  const path = resolveRuntimeActivityViewPath(env);
  if (closingPaths.has(path)) throw new Error(`RUNTIME_ACTIVITY_VIEW_CLOSING:${path}`);
  const previous = operationTails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => hold);
  operationTails.set(path, tail);
  await previous.catch(() => {});
  try {
    return await operation(await openView(env));
  } finally {
    release();
    if (operationTails.get(path) === tail) operationTails.delete(path);
  }
};

const readOptional = async (db: Level<Buffer, Buffer>, key: Buffer): Promise<unknown | null> => {
  try {
    return decodeBuffer(await db.get(key));
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
};

const validateHead = (value: unknown): RuntimeActivityViewHead => {
  const record = requireBoundaryRecord(value, 'RUNTIME_ACTIVITY_VIEW_HEAD_INVALID');
  requireExactBoundaryKeys(record, [
    'schemaVersion',
    'latestHeight',
    'availableFromHeight',
    'unavailableThroughHeight',
  ], [], 'RUNTIME_ACTIVITY_VIEW_HEAD_FIELDS_INVALID');
  if (record['schemaVersion'] !== VIEW_SCHEMA_VERSION) {
    throw new Error(`RUNTIME_ACTIVITY_VIEW_SCHEMA_MISMATCH:${String(record['schemaVersion'])}`);
  }
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    latestHeight: requireBoundaryInteger(record['latestHeight'], 'RUNTIME_ACTIVITY_VIEW_HEAD_HEIGHT_INVALID'),
    availableFromHeight: requireBoundaryInteger(record['availableFromHeight'], 'RUNTIME_ACTIVITY_VIEW_FLOOR_INVALID'),
    unavailableThroughHeight: requireBoundaryInteger(record['unavailableThroughHeight'], 'RUNTIME_ACTIVITY_VIEW_UNAVAILABLE_INVALID'),
  };
};

const validateMarker = (value: unknown): RuntimeActivityFrameMarker => {
  const record = requireBoundaryRecord(value, 'RUNTIME_ACTIVITY_VIEW_MARKER_INVALID');
  requireExactBoundaryKeys(record, ['height', 'timestamp', 'frameHash', 'eventCount'], [], 'RUNTIME_ACTIVITY_VIEW_MARKER_FIELDS_INVALID');
  const frameHash = String(record['frameHash'] ?? '');
  if (!/^0x[0-9a-f]{64}$/i.test(frameHash)) throw new Error(`RUNTIME_ACTIVITY_VIEW_FRAME_HASH_INVALID:${frameHash}`);
  return {
    height: requireBoundaryInteger(record['height'], 'RUNTIME_ACTIVITY_VIEW_MARKER_HEIGHT_INVALID'),
    timestamp: requireBoundaryInteger(record['timestamp'], 'RUNTIME_ACTIVITY_VIEW_MARKER_TIMESTAMP_INVALID'),
    frameHash,
    eventCount: requireBoundaryInteger(record['eventCount'], 'RUNTIME_ACTIVITY_VIEW_EVENT_COUNT_INVALID'),
  };
};

const validateEvent = (value: unknown, height: number, ordinal: number): FrameLogEntry => {
  const record = requireBoundaryRecord(value, `RUNTIME_ACTIVITY_VIEW_EVENT_INVALID:${height}:${ordinal}`);
  requireExactBoundaryKeys(record, ['id', 'timestamp', 'level', 'category', 'message'], ['entityId', 'data'], `RUNTIME_ACTIVITY_VIEW_EVENT_FIELDS_INVALID:${height}:${ordinal}`);
  if (record['level'] !== 'info' || record['category'] !== 'system') {
    throw new Error(`RUNTIME_ACTIVITY_VIEW_EVENT_KIND_INVALID:${height}:${ordinal}`);
  }
  if (record['id'] !== ordinal) {
    throw new Error(`RUNTIME_ACTIVITY_VIEW_EVENT_ORDINAL_MISMATCH:${height}:${ordinal}`);
  }
  const timestamp = requireBoundaryInteger(
    record['timestamp'],
    `RUNTIME_ACTIVITY_VIEW_EVENT_TIMESTAMP_INVALID:${height}:${ordinal}`,
  );
  const entityId = record['entityId'];
  if (entityId !== undefined && typeof entityId !== 'string') {
    throw new Error(`RUNTIME_ACTIVITY_VIEW_EVENT_ENTITY_INVALID:${height}:${ordinal}`);
  }
  const data = record['data'] === undefined
    ? undefined
    : requireBoundaryRecord(
      record['data'],
      `RUNTIME_ACTIVITY_VIEW_EVENT_DATA_INVALID:${height}:${ordinal}`,
    );
  if (typeof record['message'] !== 'string' || !record['message']) {
    throw new Error(`RUNTIME_ACTIVITY_VIEW_EVENT_MESSAGE_INVALID:${height}:${ordinal}`);
  }
  return {
    id: ordinal,
    timestamp,
    level: 'info',
    category: 'system',
    message: record['message'],
    ...(entityId === undefined ? {} : { entityId }),
    ...(data === undefined ? {} : { data }),
  };
};

const readRuntimeActivityViewHead = async (
  db: Level<Buffer, Buffer>,
): Promise<RuntimeActivityViewHead | null> => {
  const value = await readOptional(db, KEY_VIEW_HEAD);
  return value === null ? null : validateHead(value);
};

const deterministicEvents = (
  frame: RuntimeFrame,
  events: readonly FrameLogEntry[],
): FrameLogEntry[] => events
  .filter(event => event.level === 'info' && event.category === 'system')
  .map((event, ordinal) => ({
    ...structuredClone(event),
    id: ordinal,
    timestamp: frame.timestamp,
  }));

const assertBounded = (value: Buffer, code: string): void => {
  if (value.byteLength >= MAX_STORAGE_RECORD_BYTES) {
    throw new Error(`${code}:bytes=${value.byteLength}:max=${MAX_STORAGE_RECORD_BYTES - 1}`);
  }
};

const appendFrame = async (
  db: Level<Buffer, Buffer>,
  frame: RuntimeFrame,
  sourceEvents: readonly FrameLogEntry[],
): Promise<'written' | 'idempotent' | 'gap'> => {
  if (!frame.frameHash) throw new Error(`RUNTIME_ACTIVITY_VIEW_FRAME_HASH_MISSING:${frame.height}`);
  const head = await readRuntimeActivityViewHead(db);
  if (head?.latestHeight === frame.height) {
    const existing = await readOptional(db, heightKey(KEY_FRAME_MARKER, frame.height));
    const marker = existing === null ? null : validateMarker(existing);
    if (marker?.frameHash === frame.frameHash) return 'idempotent';
    throw new Error(`RUNTIME_ACTIVITY_VIEW_FRAME_CONFLICT:${frame.height}`);
  }
  const expected = (head?.latestHeight ?? 0) + 1;
  if (frame.height !== expected) return 'gap';
  const events = deterministicEvents(frame, sourceEvents);
  const marker: RuntimeActivityFrameMarker = {
    height: frame.height,
    timestamp: frame.timestamp,
    frameHash: frame.frameHash,
    eventCount: events.length,
  };
  const batch = db.batch();
  const markerValue = encodeBuffer(marker);
  assertBounded(markerValue, 'RUNTIME_ACTIVITY_VIEW_MARKER_TOO_LARGE');
  batch.put(heightKey(KEY_FRAME_MARKER, frame.height), markerValue);
  for (let ordinal = 0; ordinal < events.length; ordinal += 1) {
    const value = encodeBuffer(events[ordinal]);
    assertBounded(value, `RUNTIME_ACTIVITY_VIEW_EVENT_TOO_LARGE:${frame.height}:${ordinal}`);
    batch.put(eventKey(frame.height, ordinal), value);
  }
  batch.put(KEY_VIEW_HEAD, encodeBuffer({
    schemaVersion: VIEW_SCHEMA_VERSION,
    latestHeight: frame.height,
    availableFromHeight: head?.availableFromHeight || frame.height,
    unavailableThroughHeight: head?.unavailableThroughHeight ?? 0,
  } satisfies RuntimeActivityViewHead));
  await batch.write();
  return 'written';
};

export const appendRuntimeActivityViewFrame = (
  env: RuntimeReplica,
  frame: RuntimeFrame,
  events: readonly FrameLogEntry[],
): Promise<'written' | 'idempotent' | 'gap'> =>
  withRuntimeActivityViewLock(env, db => appendFrame(db, frame, events));

export const resetRuntimeActivityViewAtFloor = (
  env: RuntimeReplica,
  unavailableThroughHeight: number,
): Promise<void> => withRuntimeActivityViewLock(env, async db => {
  const floor = requireBoundaryInteger(unavailableThroughHeight, 'RUNTIME_ACTIVITY_VIEW_RESET_FLOOR_INVALID');
  await db.clear();
  await db.put(KEY_VIEW_HEAD, encodeBuffer({
    schemaVersion: VIEW_SCHEMA_VERSION,
    latestHeight: floor,
    availableFromHeight: 0,
    unavailableThroughHeight: floor,
  } satisfies RuntimeActivityViewHead));
});

export const readRuntimeActivityViewFrame = (
  env: RuntimeReplica,
  height: number,
): Promise<Readonly<{ marker: RuntimeActivityFrameMarker; logs: FrameLogEntry[] }> | null> =>
  withRuntimeActivityViewLock(env, async db => {
    const head = await readRuntimeActivityViewHead(db);
    if (!head || height > head.latestHeight) return null;
    if (height <= head.unavailableThroughHeight) {
      throw new Error(`RUNTIME_ACTIVITY_VIEW_UNAVAILABLE:height=${height}:through=${head.unavailableThroughHeight}`);
    }
    const raw = await readOptional(db, heightKey(KEY_FRAME_MARKER, height));
    if (raw === null) throw new Error(`RUNTIME_ACTIVITY_VIEW_MARKER_MISSING:${height}`);
    const marker = validateMarker(raw);
    if (marker.height !== height) throw new Error(`RUNTIME_ACTIVITY_VIEW_MARKER_HEIGHT_MISMATCH:${height}:${marker.height}`);
    const logs: FrameLogEntry[] = [];
    for (let ordinal = 0; ordinal < marker.eventCount; ordinal += 1) {
      const event = await readOptional(db, eventKey(height, ordinal));
      if (event === null) throw new Error(`RUNTIME_ACTIVITY_VIEW_EVENT_MISSING:${height}:${ordinal}`);
      logs.push(validateEvent(event, height, ordinal));
    }
    return { marker, logs };
  });

export const readRuntimeActivityViewStatus = (
  env: RuntimeReplica,
): Promise<RuntimeActivityViewHead | null> =>
  withRuntimeActivityViewLock(env, readRuntimeActivityViewHead);

export const withRuntimeActivityRepairFlight = async (
  env: RuntimeReplica,
  repair: () => Promise<void>,
): Promise<void> => {
  const path = resolveRuntimeActivityViewPath(env);
  const existing = repairFlights.get(path);
  if (existing) return existing;
  const flight = repair().finally(() => {
    if (repairFlights.get(path) === flight) repairFlights.delete(path);
  });
  repairFlights.set(path, flight);
  return flight;
};

export const closeRuntimeActivityViewDb = async (env: RuntimeReplica): Promise<void> => {
  const path = resolveRuntimeActivityViewPath(env);
  closingPaths.add(path);
  try {
    await repairFlights.get(path)?.catch(() => {});
    await operationTails.get(path)?.catch(() => {});
    const handle = handles.get(path);
    if (!handle) return;
    handles.delete(path);
    await handle.open;
    await handle.db.close();
  } catch (error) {
    storageLog.warn('activity_view.close_failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    closingPaths.delete(path);
  }
};
