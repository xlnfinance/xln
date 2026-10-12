import { iterateKeys } from '../../database/level';
import { computeStorageFrameHash } from '../../hashes';
import type { RuntimeDbLike, RuntimeFrame } from '../../types';

/** Native checkpoint/header/tree rows never belong to the canonical TS WAL.
 * Inspect physical DB keys only: the offline checkpoint exporter synthesizes
 * empty native tokens in its returned artifact, without writing these rows.
 */
export const assertTypeScriptStorageNamespaces = async (db: RuntimeDbLike): Promise<void> => {
  if (typeof db.keys !== 'function') {
    throw new Error('STORAGE_NATIVE_AUTHORITY_INSPECTION_UNAVAILABLE:key-iteration-required');
  }
  for await (const key of iterateKeys(db, { gte: Buffer.from([0x17]), lt: Buffer.from([0x1a]) })) {
    throw new Error(`STORAGE_NATIVE_AUTHORITY_RETIRED:key=${key.toString('hex')}:offline-migration-required`);
  }
};

/** Preserve the original frame's hash domain; never strip native metadata and
 * then certify the surviving TS projection as an equivalent recovery source.
 */
export const assertTypeScriptStorageFrame = (frame: RuntimeFrame): void => {
  if (frame.accountAuthorityCheckpoints === undefined) return;
  const expected = computeStorageFrameHash(frame);
  if (frame.frameHash !== expected) {
    throw new Error(
      `STORAGE_VERIFY_FRAME_HASH_MISMATCH: height=${frame.height} expected=${expected} actual=${frame.frameHash ?? 'none'}`,
    );
  }
  throw new Error(`STORAGE_NATIVE_AUTHORITY_RETIRED:frame=${frame.height}:offline-migration-required`);
};
