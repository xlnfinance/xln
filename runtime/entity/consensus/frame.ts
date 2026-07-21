import { ethers } from 'ethers';
import type { AccountTx, EntityState, EntityTx, JPrefixCertificate } from '../../types';
import { HEAVY_LOGS } from '../../utils';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import { compareCanonicalText } from '../../orderbook/swap-execution';
import { canonicalJurisdictionEventsHash } from '../../jurisdiction/event-observation';
import { normalizeJurisdictionEvents } from '../../jurisdiction/event-normalization';
import { canonicalAccountTxForFrameHash } from '../../account/consensus/frame';
import {
  computeCanonicalEntityConsensusStateHash,
  buildEntityFrameAuthority,
  computeEntityFrameAuthorityRoot,
  encodeCanonicalEntityConsensusValue,
} from './state-root';
import { LIMITS } from '../../constants';
import { assertNoConsensusVisibleHtlcPaymentSecrets } from '../../protocol/htlc/consensus-secret-guard';

export const MAX_ENTITY_FRAME_TX_BYTES = LIMITS.MAX_FRAME_SIZE_BYTES;

export const isCanonicalEntityFrameDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);

export type EntityFrameHashDebugRecord = {
  entityId: string;
  height: number;
  hash: string;
  payload: unknown;
};

let frameHashDebugRecorder: ((record: EntityFrameHashDebugRecord) => void) | null = null;
const entityFrameLog = createStructuredLogger('entity.frame');

export function setEntityFrameHashDebugRecorder(
  recorder: ((record: EntityFrameHashDebugRecord) => void) | null,
): () => void {
  const previous = frameHashDebugRecorder;
  frameHashDebugRecorder = recorder;
  return () => {
    frameHashDebugRecorder = previous;
  };
}

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
    blockNumber: event.blockNumber ?? null,
    blockHash: event.blockHash?.toLowerCase() ?? null,
    transactionHash: event.transactionHash?.toLowerCase() ?? null,
    logIndex: event.logIndex ?? null,
    eventIndex: event.eventIndex ?? null,
    type: event.type,
    data: event.data,
  }));

const canonicalJEventDataForFrameHash = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  if (!Array.isArray(data['blocks']) || data['rangeHash'] === undefined) {
    throw new Error('ENTITY_FRAME_J_EVENT_RANGE_REQUIRED');
  }
  const blocks = Array.isArray(data['blocks'])
    ? data['blocks'].map((rawBlock) => {
        const block = toRecord(rawBlock);
        const blockEvents = canonicalEventsForFrameHash({ events: block['events'] });
        return {
          blockNumber: toInt(block['blockNumber']),
          blockHash: String(block['blockHash'] ?? '').toLowerCase(),
          eventsHash: String(block['eventsHash'] ?? '').toLowerCase(),
          events: blockEvents,
          disputeFinalizationEvidenceHash: String(block['disputeFinalizationEvidenceHash'] ?? '').toLowerCase(),
        };
      })
    : [];
  return {
    version: 'xln:j-event-range-frame:v1',
    from: String(data['from'] ?? '').toLowerCase(),
    jurisdictionRef: String(data['jurisdictionRef'] ?? '').trim().toLowerCase(),
    baseHeight: toInt(data['baseHeight']),
    scannedThroughHeight: toInt(data['scannedThroughHeight']),
    tipBlockHash: String(data['tipBlockHash'] ?? '').toLowerCase(),
    eventHistoryRoot: String(data['eventHistoryRoot'] ?? '').toLowerCase(),
    rangeHash: String(data['rangeHash'] ?? '').toLowerCase(),
    blocks,
    signature: String(data['signature'] ?? '').toLowerCase(),
    observedAt: toInt(data['observedAt']),
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
    ...(data['proposal'] !== undefined
      ? {
          proposal: {
            ...toRecord(data['proposal']),
            frame: canonicalNestedAccountFrameForFrameHash(toRecord(data['proposal'])['frame']),
          },
        }
      : {}),
  };
};

export const canonicalEntityTxForFrameHash = (tx: EntityTx): Record<string, unknown> => {
  assertNoConsensusVisibleHtlcPaymentSecrets([tx]);
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

export const getEntityFrameTxByteLength = (txs: EntityTx[]): number =>
  new TextEncoder().encode(encodeCanonicalEntityConsensusValue({
    domain: 'xln:entity-frame-txs:v1',
    txs: txs.map(canonicalEntityTxForFrameHash),
  })).byteLength;

export const assertEntityFrameTxByteBudget = (txs: EntityTx[]): void => {
  const byteLength = getEntityFrameTxByteLength(txs);
  if (byteLength > MAX_ENTITY_FRAME_TX_BYTES) {
    throw new Error(`ENTITY_FRAME_TX_BYTE_LIMIT_EXCEEDED:${byteLength}:${MAX_ENTITY_FRAME_TX_BYTES}`);
  }
};

export const selectEntityFrameTxByteBudget = (txs: EntityTx[]): EntityTx[] => {
  if (getEntityFrameTxByteLength(txs) <= MAX_ENTITY_FRAME_TX_BYTES) return txs;
  let low = 0;
  let high = txs.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (getEntityFrameTxByteLength(txs.slice(0, mid)) <= MAX_ENTITY_FRAME_TX_BYTES) low = mid;
    else high = mid - 1;
  }
  if (low === 0 && txs.length > 0) {
    throw new Error(
      `ENTITY_FRAME_HEAD_TX_BYTE_LIMIT_EXCEEDED:${getEntityFrameTxByteLength([txs[0]!])}:${MAX_ENTITY_FRAME_TX_BYTES}`,
    );
  }
  return txs.slice(0, low);
};

// Entity-frame hashes are BFT commitments. Validators recompute the frame from
// txs and sign only if their locally derived state hashes to the proposal hash.
export function createEntityFrameHashFromStateRoot(
  prevFrameHash: string,
  height: number,
  timestamp: number,
  txs: EntityTx[],
  entityId: string,
  stateRoot: string,
  authorityRoot: string,
  jPrefixCertificate?: JPrefixCertificate,
): string {
  if (!isCanonicalEntityFrameDigest(stateRoot)) {
    throw new Error(`ENTITY_FRAME_STATE_ROOT_INVALID:${stateRoot}`);
  }
  if (!isCanonicalEntityFrameDigest(authorityRoot)) {
    throw new Error(`ENTITY_FRAME_AUTHORITY_ROOT_INVALID:${authorityRoot}`);
  }
  const frameData = {
    version: 'xln:entity-frame:v4',
    prevFrameHash,
    height,
    timestamp,
    txs: txs.map(canonicalEntityTxForFrameHash),
    entityId,
    stateRoot: stateRoot.toLowerCase(),
    authorityRoot: authorityRoot.toLowerCase(),
    jPrefixCertificate: jPrefixCertificate ?? null,
  };
  const encoded = encodeCanonicalEntityConsensusValue(frameData);
  const hash = ethers.keccak256(ethers.toUtf8Bytes(encoded));
  if (frameHashDebugRecorder) {
    frameHashDebugRecorder({
      entityId,
      height,
      hash,
      payload: JSON.parse(encoded),
    });
  }
  return hash;
}

export async function createEntityFrameHash(
  prevFrameHash: string,
  height: number,
  timestamp: number,
  txs: EntityTx[],
  newState: EntityState,
  jPrefixCertificate?: JPrefixCertificate,
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
    entityFrameLog.debug('frame_hash.input', {
      height,
      prevFrameHash: shortHash(prevFrameHash, 12),
      accounts: accountSnapshot,
    });
  }

  const stateRoot = computeCanonicalEntityConsensusStateHash(newState);
  const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(newState));
  const hash = createEntityFrameHashFromStateRoot(
    prevFrameHash,
    height,
    timestamp,
    txs,
    newState.entityId,
    stateRoot,
    authorityRoot,
    jPrefixCertificate,
  );
  return hash;
}
