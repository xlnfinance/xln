import { ethers } from 'ethers';
import type { AccountTx, EntityState, EntityTx } from './types';
import { HEAVY_LOGS } from './utils';
import { shortHash, shortId } from './logger';
import { safeStringify } from './serialization-utils';
import { compareCanonicalText } from './swap-execution';
import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
} from './j-event-observation';
import { normalizeJurisdictionEvents } from './j-event-normalization';
import { canonicalAccountTxForFrameHash } from './account-consensus-frame';

export type EntityFrameHashDebugRecord = {
  entityId: string;
  height: number;
  hash: string;
  payload: unknown;
};

let frameHashDebugRecorder: ((record: EntityFrameHashDebugRecord) => void) | null = null;

export function setEntityFrameHashDebugRecorder(
  recorder: ((record: EntityFrameHashDebugRecord) => void) | null,
): () => void {
  const previous = frameHashDebugRecorder;
  frameHashDebugRecorder = recorder;
  return () => {
    frameHashDebugRecorder = previous;
  };
}

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

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const toInt = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.floor(n) : 0;
};

const rawJEvents = (data: Record<string, unknown>): unknown[] =>
  Array.isArray(data['events'])
    ? data['events']
    : data['event'] !== undefined
      ? [data['event']]
      : [];

const canonicalEventsForFrameHash = (data: Record<string, unknown>): Array<Record<string, unknown>> =>
  normalizeJurisdictionEvents(rawJEvents(data)).map((event) => ({
    type: event.type,
    data: event.data,
  }));

const canonicalJEventDataForFrameHash = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  const events = canonicalEventsForFrameHash(data);
  const normalizedEvents = normalizeJurisdictionEvents(rawJEvents(data));
  const eventsHash = typeof data['eventsHash'] === 'string' && data['eventsHash']
    ? data['eventsHash'].toLowerCase()
    : canonicalJurisdictionEventsHash(normalizedEvents);
  const evidence = Array.isArray(data['disputeFinalizationEvidence'])
    ? data['disputeFinalizationEvidence']
    : [];
  const evidenceHash = typeof data['disputeFinalizationEvidenceHash'] === 'string' && data['disputeFinalizationEvidenceHash']
    ? data['disputeFinalizationEvidenceHash'].toLowerCase()
    : evidence.length > 0
      ? canonicalDisputeFinalizationEvidenceHash(evidence)
      : '';

  // J block hash, tx hash, and observation signature are external evidence.
  // They are fail-fast verified by handleJEvent before a validator signs this
  // frame. The RJEA frame hash commits to the semantic event set instead:
  // block height + eventsHash + canonical event bodies (+ evidence hash).
  // This avoids honest replay divergence when the same event bodies are carried
  // by different simulator block headers, while still changing the frame hash
  // whenever the event content or optional dispute evidence changes.
  return {
    version: 'xln:j-event-frame:v1',
    from: String(data['from'] ?? '').toLowerCase(),
    observedAt: toInt(data['observedAt']),
    blockNumber: toInt(data['blockNumber']),
    eventsHash,
    events,
    ...(evidenceHash ? { disputeFinalizationEvidenceHash: evidenceHash } : {}),
  };
};

const canonicalJEventAccountClaimDataForFrameHash = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  const events = canonicalEventsForFrameHash(data);
  const eventsHash = canonicalJurisdictionEventsHash(normalizeJurisdictionEvents(rawJEvents(data)));
  return {
    version: 'xln:j-event-account-claim-frame:v1',
    counterpartyEntityId: String(data['counterpartyEntityId'] ?? '').toLowerCase(),
    jHeight: toInt(data['jHeight']),
    eventsHash,
    events,
    observedAt: toInt(data['observedAt']),
  };
};

const canonicalNestedAccountFrameForFrameHash = (value: unknown): unknown => {
  const frame = toRecord(value);
  if (!Array.isArray(frame['accountTxs'])) return value;
  return {
    ...frame,
    accountTxs: frame['accountTxs'].map((tx) => canonicalAccountTxForFrameHash(tx as AccountTx)),
  };
};

const canonicalAccountInputForFrameHash = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  return {
    ...data,
    ...(data['newAccountFrame'] !== undefined
      ? { newAccountFrame: canonicalNestedAccountFrameForFrameHash(data['newAccountFrame']) }
      : {}),
  };
};

const canonicalEntityTxForFrameHash = (tx: EntityTx): Record<string, unknown> => {
  if (tx.type === 'j_event') {
    return { type: tx.type, data: canonicalJEventDataForFrameHash(tx.data) };
  }
  if (tx.type === 'j_event_account_claim') {
    return { type: tx.type, data: canonicalJEventAccountClaimDataForFrameHash(tx.data) };
  }
  if (tx.type === 'accountInput') {
    return { type: tx.type, data: canonicalAccountInputForFrameHash(tx.data) };
  }
  return {
    type: tx.type,
    data: tx.data,
  };
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
    txs: txs.map(canonicalEntityTxForFrameHash),
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
  const hash = ethers.keccak256(ethers.toUtf8Bytes(encoded));
  if (frameHashDebugRecorder) {
    frameHashDebugRecorder({
      entityId: newState.entityId,
      height,
      hash,
      payload: JSON.parse(encoded),
    });
  }
  return hash;
}
