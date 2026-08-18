import { encodeCanonicalConsensusValue, memoizeCanonicalEncoding } from '../../protocol/serialization/canonical-consensus-value';
import { keccakTextHash, utf8ByteLength } from '../../protocol/crypto/keccak-text';
import type { EntityFrameEvent, EntityState } from '../types';
import type { EntityTx } from '../../types/entity-tx';
import type { JPrefixCertificate } from '../../types/jurisdiction-events';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import { HEAVY_LOGS } from '../../support/debug-flags';
import { createStructuredLogger, shortHash, shortId } from '../../support/logger';
import { compareCanonicalText } from '../../orderbook/swap-execution';
import { requireCanonicalJurisdictionEvents } from '../../jurisdiction/machine/events/event-normalization';
import {
  canonicalAccountInputCommitment,
  canonicalConsensusOutputForEntityFrameHash,
  ENTITY_FRAME_ACCOUNT_INPUT_MODE,
} from './frame/account-input-commitment';
import {
  computeCanonicalEntityConsensusStateHash,
  buildEntityFrameAuthority,
  computeEntityFrameAuthorityRoot,
} from './state-root';
import { LIMITS } from '../../config/constants';
import { assertNoConsensusVisibleHtlcPaymentSecrets } from '../../protocol/htlc/consensus-secret-guard';
import { readEntityFrameEvents } from '../frame-events';
import { assertEntityFrameEventByteBudget } from './frame/events';

// Txs may fill only half of the wire frame: the frame also carries events, the
// entity infra context and the J-prefix certificate, and a Hub frame that
// selected 10 MB of txs then failed the 10 MB wire assertion halted the
// Runtime (500-user load, ~350 payments per frame). Deferring the tail of the
// mempool to the next frame is the intended behaviour; halting is not.
export const MAX_ENTITY_FRAME_TX_BYTES = Math.floor(LIMITS.MAX_FRAME_SIZE_BYTES / 2);
export {
  MAX_ENTITY_FRAME_EVENT_BYTES,
  assertEntityFrameEventByteBudget,
  entityFrameEventsEqual,
} from './frame/events';

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
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const toInt = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.floor(n) : 0;
};

const rawJEvents = (data: Record<string, unknown>): unknown[] =>
  Array.isArray(data['events']) ? data['events'] : data['event'] !== undefined ? [data['event']] : [];

const canonicalEventsForFrameHash = (data: Record<string, unknown>): Array<Record<string, unknown>> =>
  requireCanonicalJurisdictionEvents(rawJEvents(data)).map(event => ({
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
    ? data['blocks'].map(rawBlock => {
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
    jurisdictionRef: String(data['jurisdictionRef'] ?? '')
      .trim()
      .toLowerCase(),
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

const canonicalEntityTxForFrameHash = (tx: EntityTx): Record<string, unknown> => {
  assertNoConsensusVisibleHtlcPaymentSecrets([tx]);
  if (tx.type === 'j_event') {
    return { type: tx.type, data: canonicalJEventDataForFrameHash(tx.data) };
  }
  if (tx.type === 'accountInput') {
    return { type: tx.type, data: canonicalAccountInputCommitment(tx.data, ENTITY_FRAME_ACCOUNT_INPUT_MODE) };
  }
  if (tx.type === 'consensusOutput') {
    return { type: tx.type, data: canonicalConsensusOutputForEntityFrameHash(tx.data) };
  }
  return {
    type: tx.type,
    data: tx.data,
  };
};

const encodeEntityFrameTxsPayload = (canonicalTxs: unknown[]): string =>
  encodeCanonicalConsensusValue({
    domain: 'xln:entity-frame-txs:v1',
    txs: canonicalTxs,
  });

const canonicalEntityTxsMemo = new WeakMap<EntityTx[], unknown[]>();

const canonicalEntityTxsForFrameHash = (txs: EntityTx[]): unknown[] => {
  const cached = canonicalEntityTxsMemo.get(txs);
  if (cached) return cached;
  const canonical = memoizeCanonicalEncoding(txs.map(canonicalEntityTxForFrameHash));
  canonicalEntityTxsMemo.set(txs, canonical);
  return canonical;
};

const getEntityFrameTxByteLengthFromCanonical = (canonicalTxs: unknown[]): number =>
  utf8ByteLength(encodeEntityFrameTxsPayload(canonicalTxs));

const getEntityFrameTxByteLength = (txs: EntityTx[]): number =>
  getEntityFrameTxByteLengthFromCanonical(canonicalEntityTxsForFrameHash(txs));

export const assertEntityFrameTxByteBudget = (txs: EntityTx[]): void => {
  const byteLength = getEntityFrameTxByteLength(txs);
  if (byteLength > MAX_ENTITY_FRAME_TX_BYTES) {
    throw new Error(`ENTITY_FRAME_TX_BYTE_LIMIT_EXCEEDED:${byteLength}:${MAX_ENTITY_FRAME_TX_BYTES}`);
  }
};

export const selectEntityFrameTxByteBudget = (txs: EntityTx[]): EntityTx[] => {
  const canonical = canonicalEntityTxsForFrameHash(txs);
  if (getEntityFrameTxByteLengthFromCanonical(canonical) <= MAX_ENTITY_FRAME_TX_BYTES) return txs;
  let low = 0;
  let high = txs.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (getEntityFrameTxByteLengthFromCanonical(canonical.slice(0, mid)) <= MAX_ENTITY_FRAME_TX_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  if (low === 0 && txs.length > 0) {
    throw new Error(
      `ENTITY_FRAME_HEAD_TX_BYTE_LIMIT_EXCEEDED:${getEntityFrameTxByteLengthFromCanonical(canonical.slice(0, 1))}:${MAX_ENTITY_FRAME_TX_BYTES}`,
    );
  }
  return txs.slice(0, low);
};

export const ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES = 256_000;

export type EntityFrameWireBudgetInput = {
  prevFrameHash: string;
  height: number;
  timestamp: number;
  txs: EntityTx[];
  events: EntityFrameEvent[];
  entityId: string;
  stateRoot: string;
  authorityRoot: string;
  entityContext: EntityInfraContext;
  jPrefixCertificate?: JPrefixCertificate;
};

export const measureEntityFrameWireBytes = (input: EntityFrameWireBudgetInput): number =>
  utf8ByteLength(encodeCanonicalConsensusValue({
    domain: 'xln:entity-frame',
    ...input,
    txs: canonicalEntityTxsForFrameHash(input.txs),
    jPrefixCertificate: input.jPrefixCertificate ?? null,
  }));

export const selectEntityFrameTxPrefixForWireBudget = (
  txs: EntityTx[],
  rest: Omit<EntityFrameWireBudgetInput, 'txs'>,
  maxBytes = LIMITS.MAX_FRAME_SIZE_BYTES - ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES,
): EntityTx[] => {
  if (txs.length === 0) return txs;
  if (measureEntityFrameWireBytes({ ...rest, txs }) <= maxBytes) return txs;
  let low = 0;
  let high = txs.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measureEntityFrameWireBytes({ ...rest, txs: txs.slice(0, mid) }) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  if (low === 0) {
    throw new Error(
      `ENTITY_FRAME_HEAD_WIRE_LIMIT_EXCEEDED:${measureEntityFrameWireBytes({ ...rest, txs: txs.slice(0, 1) })}:${maxBytes}`,
    );
  }
  return txs.slice(0, low);
};

export const assertEntityFrameTotalByteBudget = (input: EntityFrameWireBudgetInput): string => {
  const encoded = encodeCanonicalConsensusValue({
    domain: 'xln:entity-frame',
    ...input,
    txs: canonicalEntityTxsForFrameHash(input.txs),
    jPrefixCertificate: input.jPrefixCertificate ?? null,
  });
  const frameBytes = utf8ByteLength(encoded);
  if (frameBytes > LIMITS.MAX_FRAME_SIZE_BYTES) {
    throw new Error(`ENTITY_FRAME_TOTAL_BYTE_LIMIT_EXCEEDED:${frameBytes}:${LIMITS.MAX_FRAME_SIZE_BYTES}`);
  }
  return encoded;
};

// Entity-frame hashes are BFT commitments. Validators recompute the frame from
// txs and sign only if their locally derived state hashes to the proposal hash.
export function createEntityFrameHashFromStateRoot(
  prevFrameHash: string,
  height: number,
  timestamp: number,
  txs: EntityTx[],
  events: EntityFrameEvent[],
  entityId: string,
  stateRoot: string,
  authorityRoot: string,
  entityContext: EntityInfraContext,
  jPrefixCertificate?: JPrefixCertificate,
): string {
  assertEntityFrameEventByteBudget(events);
  if (!isCanonicalEntityFrameDigest(stateRoot)) {
    throw new Error(`ENTITY_FRAME_STATE_ROOT_INVALID:${stateRoot}`);
  }
  if (!isCanonicalEntityFrameDigest(authorityRoot)) {
    throw new Error(`ENTITY_FRAME_AUTHORITY_ROOT_INVALID:${authorityRoot}`);
  }
  const frameData = {
    prevFrameHash,
    height,
    timestamp,
    txs,
    events,
    entityId,
    stateRoot: stateRoot.toLowerCase(),
    authorityRoot: authorityRoot.toLowerCase(),
    entityContext,
    ...(jPrefixCertificate ? { jPrefixCertificate } : {}),
  };
  const encoded = assertEntityFrameTotalByteBudget(frameData);
  const hash = keccakTextHash(encoded);
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
  entityContext: EntityInfraContext,
  jPrefixCertificate?: JPrefixCertificate,
  events: EntityFrameEvent[] = readEntityFrameEvents(newState),
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
    events,
    newState.entityId,
    stateRoot,
    authorityRoot,
    entityContext,
    jPrefixCertificate,
  );
  return hash;
}
