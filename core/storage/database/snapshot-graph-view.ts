/**
 * Read-only projection of one snapshot's typed graph as ordinary live keys.
 * This keeps Account hydration canonical: snapshots and live storage use the
 * same exact decoders, while only the physical key namespace differs.
 * Human-audit importance: 98/100 — a snapshot must restore without live rows.
 */
import { Buffer } from '../../support/platform-crypto';
import {
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_FIELD,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_LIVE_ENTITY,
  KEY_LIVE_ENTITY_BRANCH,
  KEY_LIVE_ENTITY_FIELD,
  KEY_LIVE_ENTITY_LEAF,
  KEY_RUNTIME_MACHINE_BRANCH,
  KEY_RUNTIME_MACHINE_LEAF,
  KEY_SNAPSHOT_ACCOUNT,
  KEY_SNAPSHOT_ENTITY,
  encodeHeight,
  keySnapshotGraph,
  parseSnapshotGraphKey,
} from '../keys';
import type { RuntimeDbLike } from '../types';

const snapshotAccountKey = (height: number, liveKey: Buffer): Buffer => {
  if (liveKey[0] !== KEY_LIVE_ACCOUNT || liveKey.byteLength !== 65) {
    throw new Error(`STORAGE_SNAPSHOT_ACCOUNT_LIVE_KEY_INVALID:${liveKey.toString('hex')}`);
  }
  return Buffer.concat([
    Buffer.from([KEY_SNAPSHOT_ACCOUNT]),
    encodeHeight(height),
    liveKey.subarray(1),
  ]);
};

const snapshotEntityKey = (height: number, liveKey: Buffer): Buffer => {
  if (liveKey[0] !== KEY_LIVE_ENTITY || liveKey.byteLength !== 33) {
    throw new Error(`STORAGE_SNAPSHOT_ENTITY_LIVE_KEY_INVALID:${liveKey.toString('hex')}`);
  }
  return Buffer.concat([
    Buffer.from([KEY_SNAPSHOT_ENTITY]),
    encodeHeight(height),
    liveKey.subarray(1),
  ]);
};

const isAccountGraphKey = (key: Buffer): boolean =>
  key[0] === KEY_LIVE_ACCOUNT_FIELD ||
  key[0] === KEY_LIVE_ACCOUNT_BRANCH ||
  key[0] === KEY_LIVE_ACCOUNT_LEAF;

const isEntityGraphKey = (key: Buffer): boolean =>
  key[0] === KEY_LIVE_ENTITY_FIELD ||
  key[0] === KEY_LIVE_ENTITY_BRANCH ||
  key[0] === KEY_LIVE_ENTITY_LEAF;

const isRuntimeMachineGraphKey = (key: Buffer): boolean =>
  key[0] === KEY_RUNTIME_MACHINE_BRANCH || key[0] === KEY_RUNTIME_MACHINE_LEAF;

const snapshotKey = (height: number, liveKey: Buffer): Buffer =>
  liveKey[0] === KEY_LIVE_ACCOUNT
    ? snapshotAccountKey(height, liveKey)
    : isAccountGraphKey(liveKey)
      ? keySnapshotGraph(height, liveKey)
      : (() => {
          throw new Error(`STORAGE_SNAPSHOT_GRAPH_LIVE_KEY_UNSUPPORTED:${liveKey.toString('hex')}`);
        })();

/** Exact inverse key view used only while decoding a retained snapshot. */
export const createSnapshotAccountGraphView = (
  db: RuntimeDbLike,
  height: number,
): RuntimeDbLike => ({
  get: (key: Buffer) => db.get(snapshotKey(height, key)),
  batch: () => {
    throw new Error('STORAGE_SNAPSHOT_GRAPH_VIEW_READ_ONLY');
  },
  keys: async function* (options) {
    const gte = options?.gte;
    const lt = options?.lt;
    if (!gte || !isAccountGraphKey(gte)) {
      throw new Error('STORAGE_SNAPSHOT_GRAPH_RANGE_INVALID');
    }
    const range = {
      gte: keySnapshotGraph(height, gte),
      ...(lt ? { lt: keySnapshotGraph(height, lt) } : {}),
      ...(options?.reverse ? { reverse: true } : {}),
    };
    if (typeof db.keys !== 'function') return;
    for await (const rawKey of db.keys(range)) {
      const key = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey);
      const parsed = parseSnapshotGraphKey(key);
      if (parsed.height !== height || !isAccountGraphKey(parsed.liveKey)) {
        throw new Error('STORAGE_SNAPSHOT_GRAPH_RANGE_KEY_INVALID');
      }
      yield parsed.liveKey;
    }
  },
});

/** Entity equivalent: the manifest and all owned graph rows share one decoder. */
export const createSnapshotEntityGraphView = (
  db: RuntimeDbLike,
  height: number,
): RuntimeDbLike => ({
  get: (key: Buffer) => db.get(
    key[0] === KEY_LIVE_ENTITY
      ? snapshotEntityKey(height, key)
      : isEntityGraphKey(key)
        ? keySnapshotGraph(height, key)
        : (() => { throw new Error(`STORAGE_SNAPSHOT_ENTITY_GRAPH_KEY_UNSUPPORTED:${key.toString('hex')}`); })(),
  ),
  batch: () => { throw new Error('STORAGE_SNAPSHOT_GRAPH_VIEW_READ_ONLY'); },
  keys: async function* (options) {
    const gte = options?.gte;
    const lt = options?.lt;
    if (!gte || !isEntityGraphKey(gte)) throw new Error('STORAGE_SNAPSHOT_ENTITY_GRAPH_RANGE_INVALID');
    const range = {
      gte: keySnapshotGraph(height, gte),
      ...(lt ? { lt: keySnapshotGraph(height, lt) } : {}),
      ...(options?.reverse ? { reverse: true } : {}),
    };
    if (typeof db.keys !== 'function') return;
    for await (const rawKey of db.keys(range)) {
      const parsed = parseSnapshotGraphKey(Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey));
      if (parsed.height !== height || !isEntityGraphKey(parsed.liveKey)) {
        throw new Error('STORAGE_SNAPSHOT_ENTITY_GRAPH_RANGE_KEY_INVALID');
      }
      yield parsed.liveKey;
    }
  },
});

/** Historical Runtime-machine equivalent of the latest-only live graph. */
export const createSnapshotRuntimeMachineGraphView = (
  db: RuntimeDbLike,
  height: number,
): RuntimeDbLike => ({
  get: (key: Buffer) => {
    if (!isRuntimeMachineGraphKey(key)) {
      throw new Error(`STORAGE_SNAPSHOT_RUNTIME_MACHINE_KEY_UNSUPPORTED:${key.toString('hex')}`);
    }
    return db.get(keySnapshotGraph(height, key));
  },
  batch: () => { throw new Error('STORAGE_SNAPSHOT_GRAPH_VIEW_READ_ONLY'); },
  keys: async function* (options) {
    const gte = options?.gte;
    const lt = options?.lt;
    if (!gte || !isRuntimeMachineGraphKey(gte)) {
      throw new Error('STORAGE_SNAPSHOT_RUNTIME_MACHINE_RANGE_INVALID');
    }
    const range = {
      gte: keySnapshotGraph(height, gte),
      ...(lt ? { lt: keySnapshotGraph(height, lt) } : {}),
      ...(options?.reverse ? { reverse: true } : {}),
    };
    if (typeof db.keys !== 'function') return;
    for await (const rawKey of db.keys(range)) {
      const parsed = parseSnapshotGraphKey(
        Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey),
      );
      if (parsed.height !== height || !isRuntimeMachineGraphKey(parsed.liveKey)) {
        throw new Error('STORAGE_SNAPSHOT_RUNTIME_MACHINE_RANGE_KEY_INVALID');
      }
      yield parsed.liveKey;
    }
  },
});
