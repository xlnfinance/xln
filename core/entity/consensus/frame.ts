import { keccakBytesHash } from '../../protocol/crypto/keccak-text';
import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';
import { decodeBinaryPayload, encodeBinaryPayload } from '../../protocol/serialization/binary-codec';
import type { EntityFrameEvent, EntityState } from '../types';
import type { EntityTx } from '../../types/entity-tx';
import type { JPrefixCertificate } from '../../types/jurisdiction-events';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import { HEAVY_LOGS } from '../../support/debug-flags';
import { createStructuredLogger, shortHash, shortId } from '../../support/logger';
import { compareCanonicalText } from '../../orderbook/swap-execution';
import { requireCanonicalJurisdictionEvents } from '../../jurisdiction/machine/events/event-normalization';
import { canonicalAccountInputCommitment } from './frame/account-input-commitment';
import {
  computeCanonicalEntityConsensusStateHash,
  buildEntityFrameAuthority,
  computeEntityFrameAuthorityRoot,
} from './state-root';
import { LIMITS } from '../../config/constants';
import { assertNoConsensusVisibleHtlcPaymentSecrets } from '../../protocol/htlc/consensus-secret-guard';
import { readEntityFrameEvents } from '../frame-events';
import { assertEntityFrameEventByteBudget } from './frame/events';
import { RecencyMemo } from '../../support/collections/recency-memo';

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
    return { type: tx.type, data: canonicalAccountInputCommitment(tx.data) };
  }
  return {
    type: tx.type,
    data: tx.data,
  };
};

// Entity frame commitment, binary form. Each tx commits as the MessagePack
// bytes of its canonical projection; the tx set commits as one digest over
// the length-prefixed concatenation, and the frame hash is keccak256 of the
// MessagePack header that carries that digest. Canonical JSON text was the
// preimage before this (2026-08-23): every multi-megabyte frame was rendered
// to JSON several times per proposal for hashing and wire metering.
const ENTITY_FRAME_TXS_DOMAIN = 'xln:entity-frame-txs:binary';
const ENTITY_FRAME_DOMAIN = 'xln:entity-frame:binary-context-digest';
const TX_LENGTH_PREFIX_BYTES = 4;

type CanonicalFrameTxs = {
  length: number;
  perTxBytes: number[];
  /** Cumulative tx bytes, index = tx count (0 .. length). */
  prefixBytes: number[];
  digest: string;
};
// Only the frames in flight (candidate, last committed) are ever re-encoded.
const canonicalTxsByFrameTxs = new RecencyMemo<EntityTx[], CanonicalFrameTxs>(64);
// Wire fitting, the frame hash and validation each see a different array of
// the same tx objects; the per-tx bytes are what is expensive to produce.
// Hanko witness attachment replaces `tx.data` in place after commit
// (hanko-witness.ts); the memo is valid only for the exact body it encoded.
const canonicalTxBytes = new RecencyMemo<EntityTx, { data: unknown; bytes: Uint8Array }>(65_536);
const encodeCanonicalFrameTx = (tx: EntityTx): Uint8Array => {
  const hit = canonicalTxBytes.get(tx);
  if (hit && hit.data === tx.data) return hit.bytes;
  const bytes = encodeBinaryPayload(canonicalEntityTxForFrameHash(tx));
  canonicalTxBytes.set(tx, { data: tx.data, bytes });
  return bytes;
};
const canonicalFrameTxs = (txs: EntityTx[]): CanonicalFrameTxs => {
  const hit = canonicalTxsByFrameTxs.get(txs);
  if (hit && hit.length === txs.length) return hit;
  const encoded = txs.map(encodeCanonicalFrameTx);
  const perTxBytes = encoded.map(bytes => bytes.byteLength);
  const prefixBytes = [0];
  for (const [index, bytes] of perTxBytes.entries()) {
    prefixBytes.push(prefixAt(prefixBytes, index) + TX_LENGTH_PREFIX_BYTES + bytes);
  }
  const domain = textEncoder.encode(ENTITY_FRAME_TXS_DOMAIN);
  const preimage = new Uint8Array(domain.byteLength + prefixAt(prefixBytes, txs.length));
  preimage.set(domain, 0);
  let offset = domain.byteLength;
  const view = new DataView(preimage.buffer);
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.byteLength);
    preimage.set(bytes, offset + TX_LENGTH_PREFIX_BYTES);
    offset += TX_LENGTH_PREFIX_BYTES + bytes.byteLength;
  }
  const entry = { length: txs.length, perTxBytes, prefixBytes, digest: computeIntegrityDigest(preimage) };
  canonicalTxsByFrameTxs.set(txs, entry);
  return entry;
};

const textEncoder = new TextEncoder();

/** Prefix tables are dense (index 0..count); a gap is a programming error. */
const prefixAt = (prefixBytes: readonly number[], index: number): number => {
  const value = prefixBytes[index];
  if (value === undefined) throw new Error(`ENTITY_FRAME_TX_PREFIX_GAP:${index}`);
  return value;
};

/** Bytes the tx set adds to a frame on the wire, index = tx count. */
const buildEntityFrameTxPrefixBytes = (txs: EntityTx[]): number[] => canonicalFrameTxs(txs).prefixBytes;

const getEntityFrameTxByteLength = (txs: EntityTx[]): number => {
  const frameTxs = canonicalFrameTxs(txs);
  return prefixAt(frameTxs.prefixBytes, frameTxs.length);
};

export const assertEntityFrameTxByteBudget = (txs: EntityTx[]): void => {
  const byteLength = getEntityFrameTxByteLength(txs);
  if (byteLength > MAX_ENTITY_FRAME_TX_BYTES) {
    throw new Error(`ENTITY_FRAME_TX_BYTE_LIMIT_EXCEEDED:${byteLength}:${MAX_ENTITY_FRAME_TX_BYTES}`);
  }
};

const largestPrefixWithin = (prefixBytes: number[], maxBytes: number): number => {
  let low = 0;
  let high = prefixBytes.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (prefixAt(prefixBytes, mid) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return low;
};

export const selectEntityFrameTxByteBudget = (txs: EntityTx[]): EntityTx[] => {
  const prefixBytes = buildEntityFrameTxPrefixBytes(txs);
  if (prefixAt(prefixBytes, txs.length) <= MAX_ENTITY_FRAME_TX_BYTES) return txs;
  const low = largestPrefixWithin(prefixBytes, MAX_ENTITY_FRAME_TX_BYTES);
  if (low === 0 && txs.length > 0) {
    throw new Error(
      `ENTITY_FRAME_HEAD_TX_BYTE_LIMIT_EXCEEDED:${prefixBytes[1]}:${MAX_ENTITY_FRAME_TX_BYTES}`,
    );
  }
  return txs.slice(0, low);
};

// Events are not known before apply. 500 users needed 1.7 MB beyond a 256 KB
// slack. Mixed 1000e certified 11.5 MB at 208 txs after a 2 MB event reserve —
// events+hankos still overflowed validateProposedEntityFrame. Reserve a third.
export const ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES = Math.floor(LIMITS.MAX_FRAME_SIZE_BYTES / 3);

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

// The infra context (every inbound HTLC entry with its inner onion layer) is
// the bulk of a Hub frame header. It commits as one digest over its canonical
// bytes, computed once per context object for the wire-budget measure, the
// frame hash and validation alike.
type CanonicalEntityContext = { digest: string; byteLength: number };
const canonicalContexts = new RecencyMemo<EntityInfraContext, CanonicalEntityContext>(64);
const canonicalEntityContext = (context: EntityInfraContext): CanonicalEntityContext => {
  const hit = canonicalContexts.get(context);
  if (hit) return hit;
  const bytes = encodeBinaryPayload(context);
  const entry = { digest: computeIntegrityDigest(bytes), byteLength: bytes.byteLength };
  canonicalContexts.set(context, entry);
  return entry;
};

const encodeEntityFrameHeader = (
  rest: Omit<EntityFrameWireBudgetInput, 'txs'>,
  txCount: number,
  txsDigest: string,
): Uint8Array => encodeBinaryPayload({
  domain: ENTITY_FRAME_DOMAIN,
  prevFrameHash: rest.prevFrameHash,
  height: rest.height,
  timestamp: rest.timestamp,
  txCount,
  txsDigest,
  events: rest.events,
  entityId: rest.entityId,
  stateRoot: rest.stateRoot,
  authorityRoot: rest.authorityRoot,
  entityContextDigest: canonicalEntityContext(rest.entityContext).digest,
  jPrefixCertificate: rest.jPrefixCertificate ?? null,
});

const EMPTY_TXS_DIGEST = canonicalFrameTxs([]).digest;

/** Wire bytes of the frame without txs: the header plus the context it commits by digest. */
const measureEntityFrameRestBytes = (rest: Omit<EntityFrameWireBudgetInput, 'txs'>): number =>
  encodeEntityFrameHeader(rest, 0, EMPTY_TXS_DIGEST).byteLength
  + canonicalEntityContext(rest.entityContext).byteLength;

export const measureEntityFrameWireBytes = (input: EntityFrameWireBudgetInput): number =>
  measureEntityFrameRestBytes(input) + getEntityFrameTxByteLength(input.txs);

/** Reuses exact tx bytes while tx-dependent infra context is rematerialized during proposal fitting. */
export type EntityFrameWirePrefixMeter = ((
  rest: Omit<EntityFrameWireBudgetInput, 'txs'>,
  count: number,
) => number) & {
  /** Bind one immutable proposal context and encode its fixed bytes once. */
  forRest: (rest: Omit<EntityFrameWireBudgetInput, 'txs'>) => (count: number) => number;
  /** Exact standalone tx bytes for the same prefix. */
  txBytes: (count: number) => number;
};

export const createEntityFrameWirePrefixMeter = (txs: EntityTx[]): EntityFrameWirePrefixMeter => {
  const prefixBytes = buildEntityFrameTxPrefixBytes(txs);
  const assertCount = (count: number): void => {
    if (!Number.isSafeInteger(count) || count < 0 || count >= prefixBytes.length) {
      throw new Error('ENTITY_FRAME_WIRE_PREFIX_COUNT_INVALID:' + count + ':' + txs.length);
    }
  };
  const meter = ((
    rest: Omit<EntityFrameWireBudgetInput, 'txs'>,
    count: number,
  ): number => {
    assertCount(count);
    return measureEntityFrameRestBytes(rest) + prefixAt(prefixBytes, count);
  }) as EntityFrameWirePrefixMeter;
  meter.forRest = (rest) => {
    const fixedBytes = measureEntityFrameRestBytes(rest);
    return (count: number): number => {
      assertCount(count);
      return fixedBytes + prefixAt(prefixBytes, count);
    };
  };
  meter.txBytes = (count: number): number => {
    assertCount(count);
    return prefixAt(prefixBytes, count);
  };
  return meter;
};

export const selectEntityFrameTxByteBudgetWithMeter = (
  txs: EntityTx[],
): Readonly<{ txs: EntityTx[]; meter: EntityFrameWirePrefixMeter }> => {
  const meter = createEntityFrameWirePrefixMeter(txs);
  if (meter.txBytes(txs.length) <= MAX_ENTITY_FRAME_TX_BYTES) return { txs, meter };
  const low = largestPrefixWithin(buildEntityFrameTxPrefixBytes(txs), MAX_ENTITY_FRAME_TX_BYTES);
  if (low === 0 && txs.length > 0) {
    throw new Error(
      `ENTITY_FRAME_HEAD_TX_BYTE_LIMIT_EXCEEDED:${meter.txBytes(1)}:${MAX_ENTITY_FRAME_TX_BYTES}`,
    );
  }
  return { txs: txs.slice(0, low), meter };
};

export const selectEntityFrameTxPrefixForWireBudget = (
  txs: EntityTx[],
  rest: Omit<EntityFrameWireBudgetInput, 'txs'>,
  maxBytes = LIMITS.MAX_FRAME_SIZE_BYTES - ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES,
): EntityTx[] => {
  if (txs.length === 0) return txs;
  const framingBytes = measureEntityFrameRestBytes(rest);
  const prefixBytes = buildEntityFrameTxPrefixBytes(txs).map(bytes => framingBytes + bytes);
  if (prefixAt(prefixBytes, txs.length) <= maxBytes) return txs;
  const low = largestPrefixWithin(prefixBytes, maxBytes);
  if (low === 0) {
    throw new Error(
      `ENTITY_FRAME_HEAD_WIRE_LIMIT_EXCEEDED:${prefixBytes[1]}:${maxBytes}`,
    );
  }
  return txs.slice(0, low);
};

/** Frame-hash preimage; throws when the frame would exceed the wire limit. */
export const assertEntityFrameTotalByteBudget = (input: EntityFrameWireBudgetInput): Uint8Array => {
  const frameTxs = canonicalFrameTxs(input.txs);
  const header = encodeEntityFrameHeader(input, frameTxs.length, frameTxs.digest);
  const frameBytes = header.byteLength
    + canonicalEntityContext(input.entityContext).byteLength
    + prefixAt(frameTxs.prefixBytes, frameTxs.length);
  if (frameBytes > LIMITS.MAX_FRAME_SIZE_BYTES) {
    // Failure path only: say which part is fat so the deferral log is actionable.
    const part = (value: unknown): number => {
      try { return encodeBinaryPayload(value).byteLength; } catch { return -1; }
    };
    throw new Error(
      `ENTITY_FRAME_TOTAL_BYTE_LIMIT_EXCEEDED:${frameBytes}:${LIMITS.MAX_FRAME_SIZE_BYTES}` +
      `:txs=${input.txs.length}/${frameTxs.prefixBytes[frameTxs.length]}` +
      `:events=${input.events.length}/${part(input.events)}` +
      `:context=${part(input.entityContext)}`,
    );
  }
  return header;
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
  const preimage = assertEntityFrameTotalByteBudget({
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
  });
  const hash = keccakBytesHash(preimage);
  if (frameHashDebugRecorder) {
    frameHashDebugRecorder({
      entityId,
      height,
      hash,
      payload: decodeBinaryPayload(preimage),
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
