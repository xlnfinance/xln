import { ethers } from 'ethers';
import type { EntityState, EntityTx } from './types';
import { HEAVY_LOGS } from './utils';
import { shortHash, shortId } from './logger';
import { safeStringify } from './serialization-utils';
import { compareCanonicalText } from './swap-execution';

const compareNumericKey = (
  left: string | number,
  right: string | number,
): number => {
  const leftNum = Number(left);
  const rightNum = Number(right);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
    return leftNum - rightNum;
  }
  return compareCanonicalText(String(left), String(right));
};

// Entity-frame hashes are BFT commitments. Validators recompute the frame from
// txs and sign only if their locally derived state hashes to the proposal hash.
export async function createEntityFrameHash(
  prevFrameHash: string,
  height: number,
  timestamp: number,
  txs: EntityTx[],
  newState: EntityState,
): Promise<string> {
  if (HEAVY_LOGS) {
    const accountSnapshot = Array.from(newState.accounts.entries())
      .sort((a, b) => compareCanonicalText(a[0], b[0]))
      .map(([cpId, acct]) => ({
        cpId: shortId(cpId, 8),
        height: acct.currentHeight,
        stateHash: shortHash(acct.currentFrame?.stateHash || 'genesis'),
        mempoolSize: acct.mempool.length,
        pendingFrame: acct.pendingFrame?.height ?? null,
      }));
    console.log(`🔢 FRAME-HASH-INPUT: h=${height}, prevHash=${prevFrameHash.slice(0, 12)}, accounts=${JSON.stringify(accountSnapshot)}`);
  }

  const frameData = {
    prevFrameHash,
    height,
    timestamp,
    txs: txs.map(tx => ({
      type: tx.type,
      data: tx.data,
    })),
    entityId: newState.entityId,
    reserves: Array.from(newState.reserves.entries())
      .sort((a, b) => compareNumericKey(a[0], b[0]))
      .map(([k, v]) => [k, v.toString()]),
    lastFinalizedJHeight: newState.lastFinalizedJHeight,
    accountHashes: Array.from(newState.accounts.entries())
      .sort((a, b) => compareCanonicalText(a[0], b[0]))
      .map(([cpId, acct]) => ({
        cpId,
        height: acct.currentHeight,
        stateHash: acct.currentFrame?.stateHash || 'genesis',
      })),
    htlcRoutesHash: newState.htlcRoutes.size > 0
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(
          Array.from(newState.htlcRoutes.entries())
            .sort((a, b) => compareCanonicalText(String(a[0]), String(b[0]))),
        )))
      : null,
    htlcFeesEarned: newState.htlcFeesEarned.toString(),
    lockBookHash: newState.lockBook.size > 0
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(
          Array.from(newState.lockBook.entries())
            .sort((a, b) => compareCanonicalText(String(a[0]), String(b[0]))),
        )))
      : null,
    orderbookHash: newState.orderbookExt
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(newState.orderbookExt)))
      : null,
    swapTradingPairs: Array.isArray(newState.swapTradingPairs)
      ? [...newState.swapTradingPairs]
          .map(pair => ({
            baseTokenId: Number(pair.baseTokenId),
            quoteTokenId: Number(pair.quoteTokenId),
            pairId: String(pair.pairId || ''),
          }))
          .sort((a, b) => {
            if (a.quoteTokenId !== b.quoteTokenId) return a.quoteTokenId - b.quoteTokenId;
            if (a.baseTokenId !== b.baseTokenId) return a.baseTokenId - b.baseTokenId;
            return compareCanonicalText(a.pairId, b.pairId);
          })
      : [],
  };

  const encoded = safeStringify(frameData);
  return ethers.keccak256(ethers.toUtf8Bytes(encoded));
}
