/**
 * Read-only projection of one snapshot's typed graph as ordinary live keys.
 * This keeps Account hydration canonical: snapshots and live storage use the
 * same exact decoders, while only the physical key namespace differs.
 * Human-audit importance: 98/100 — a snapshot must restore without live rows.
 */
import { Buffer } from '../../infra/platform-crypto';
import {
  KEY_LIVE_ACCOUNT,
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_SNAPSHOT_ACCOUNT,
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

const isAccountGraphKey = (key: Buffer): boolean =>
  key[0] === KEY_LIVE_ACCOUNT_BRANCH || key[0] === KEY_LIVE_ACCOUNT_LEAF;

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
