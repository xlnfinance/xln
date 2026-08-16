/**
 * Audits every retained Patricia row, including rows unreachable from a root.
 * Snapshots are operator recovery authority, so orphan or unknown graph bytes
 * must fail verification instead of hiding outside normal graph traversal.
 * Human-audit importance: 98/100 — prevents incomplete/corrupt recovery roots.
 */
import {
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  keySnapshotAccount,
  keySnapshotAccountPrefix,
  keySnapshotBook,
  keySnapshotBookPrefix,
  keySnapshotGraphPrefix,
  parseLiveAccountBranchKey,
  parseLiveAccountLeafKey,
  parseLiveBookBranchKey,
  parseLiveBookLeafKey,
  parseLiveBookKey,
  parseSnapshotAccountKey,
  parseSnapshotGraphKey,
} from '../keys';
import { iterateKeys } from '../database/level';
import type { RuntimeDbLike } from '../types';

const ownerKey = (key: Buffer): string => key.toString('hex');

const collectSnapshotOwners = async (
  db: RuntimeDbLike,
  height: number,
): Promise<ReadonlySet<string>> => {
  const owners = new Set<string>();
  for await (const key of iterateKeys(db, { prefix: keySnapshotAccountPrefix(height) })) {
    const parsed = parseSnapshotAccountKey(key);
    if (parsed.height !== height) throw new Error('STORAGE_SNAPSHOT_ACCOUNT_HEIGHT_MISMATCH');
    owners.add(ownerKey(key));
  }
  for await (const key of iterateKeys(db, { prefix: keySnapshotBookPrefix(height) })) {
    parseLiveBookKey(key, 9);
    owners.add(ownerKey(key));
  }
  return owners;
};

const graphOwner = (height: number, liveKey: Buffer): Buffer => {
  switch (liveKey[0]) {
    case KEY_LIVE_ACCOUNT_BRANCH: {
      const owner = parseLiveAccountBranchKey(liveKey);
      return keySnapshotAccount(height, owner.entityId, owner.counterpartyId);
    }
    case KEY_LIVE_ACCOUNT_LEAF: {
      const owner = parseLiveAccountLeafKey(liveKey);
      return keySnapshotAccount(height, owner.entityId, owner.counterpartyId);
    }
    case KEY_LIVE_BOOK_BRANCH: {
      const owner = parseLiveBookBranchKey(liveKey);
      return keySnapshotBook(height, owner.entityId, owner.pairId);
    }
    case KEY_LIVE_BOOK_LEAF: {
      const owner = parseLiveBookLeafKey(liveKey);
      return keySnapshotBook(height, owner.entityId, owner.pairId);
    }
    default:
      throw new Error(`STORAGE_SNAPSHOT_GRAPH_TAG_INVALID:${String(liveKey[0])}`);
  }
};

/** Returns the exact graph-row count after validating every row and owner. */
export const inspectSnapshotGraphRows = async (
  db: RuntimeDbLike,
  height: number,
): Promise<number> => {
  const owners = await collectSnapshotOwners(db, height);
  let count = 0;
  for await (const key of iterateKeys(db, { prefix: keySnapshotGraphPrefix(height) })) {
    const parsed = parseSnapshotGraphKey(key);
    if (parsed.height !== height) throw new Error('STORAGE_SNAPSHOT_GRAPH_HEIGHT_MISMATCH');
    const owner = graphOwner(height, parsed.liveKey);
    if (!owners.has(ownerKey(owner))) {
      throw new Error(`STORAGE_SNAPSHOT_GRAPH_OWNER_MISSING:${owner.toString('hex')}`);
    }
    count += 1;
  }
  return count;
};
