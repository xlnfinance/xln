import { Transaction } from 'ethers';
import { assertStorageFrameHash } from '../read/integrity/native-authority';
import { listStorageSnapshotHeights, readStorageFrameRecord, readStorageHead } from '../read/read';
import type { RuntimeDbLike } from '../types';

export const evmAttemptSlot = (chainId: number | bigint, payer: string, nonce: number): string =>
  `${chainId}:${payer.toLowerCase()}:${nonce}`;

/** Scan the retained suffix of one authoritative WAL. Live callers hold the
 * storage read lock across this query so concurrent pruning cannot cut it. */
export const readEvmAttemptHistory = async (
  db: RuntimeDbLike,
  slots: ReadonlySet<string>,
  hashes: Map<string, string[]>,
  through?: number,
): Promise<boolean> => {
  const deadline = performance.now() + 3_000;
  const head = await readStorageHead(db);
  if (!head || head.latestHeight === 0) return true;
  const snapshots = await listStorageSnapshotHeights(db);
  const retainedFrom = snapshots.find(height => height <= head.latestSnapshotHeight) ?? 1;
  const headHeight = through ?? head.latestHeight;
  if (headHeight < retainedFrom || headHeight > head.latestHeight)
    throw new Error(`STORAGE_EVM_ATTEMPT_HEIGHT_UNAVAILABLE:${headHeight}`);
  let nextPrevHash: string | undefined;
  for (let height = headHeight; height >= retainedFrom; height--) {
    if (performance.now() >= deadline) return false;
    const frame = await readStorageFrameRecord(db, height);
    if (!frame) throw new Error(`STORAGE_VERIFY_FRAME_MISSING: height=${height}`);
    if (nextPrevHash && nextPrevHash !== frame.frameHash)
      throw new Error(`STORAGE_VERIFY_FRAME_CHAIN_BROKEN: height=${height}`);
    nextPrevHash = frame.prevFrameHash;
    assertStorageFrameHash(frame);
    for (const tx of frame.runtimeInput.runtimeTxs) {
      if (
        tx.type !== 'recordJPreparedTransaction' &&
        tx.type !== 'replaceJPreparedTransaction' &&
        tx.type !== 'recordEvmWalletApproval'
      )
        continue;
      if (!tx.data.rawTransaction.startsWith('0x02')) continue; // The EIP-1559 authority uses type-2 EVM wires.
      const wire = Transaction.from(tx.data.rawTransaction);
      if (!wire.from || !wire.hash) throw new Error('STORAGE_WAL_SIGNED_EVM_ATTEMPT_INVALID');
      const slot = evmAttemptSlot(wire.chainId, wire.from, wire.nonce);
      if (slots.has(slot)) hashes.set(slot, [...new Set([...(hashes.get(slot) ?? []), wire.hash])]);
    }
  }
  return true;
};
