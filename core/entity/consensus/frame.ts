import { encodeCanonicalConsensusValue, rememberCanonicalArrayEncoding } from '../../protocol/serialization/canonical-consensus-value';
import { keccakTextHash, utf8ByteLength } from '../../protocol/crypto/keccak-text';
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

const encodeEntityFrameTxsPayload = (canonicalTxs: unknown[]): string =>
  encodeCanonicalConsensusValue({
    domain: 'xln:entity-frame-txs:v1',
    txs: canonicalTxs,
  });

// Sealed frame txs are immutable; the commitment projection and its canonical
// bytes are computed once per tx array and reused by every meter and hash.
type CanonicalFrameTxs = { length: number; canonical: unknown[]; perTxBytes: number[] };
const canonicalTxsByFrameTxs = new WeakMap<EntityTx[], CanonicalFrameTxs>();
const canonicalFrameTxs = (txs: EntityTx[]): CanonicalFrameTxs => {
  const hit = canonicalTxsByFrameTxs.get(txs);
  if (hit && hit.length === txs.length) return hit;
  const canonical = txs.map(canonicalEntityTxForFrameHash);
  const perTx = canonical.map(tx => encodeCanonicalConsensusValue(tx));
  // Canonical arrays are exactly '["Array",[' + children joined by ',' + ']]'.
  rememberCanonicalArrayEncoding(canonical, `["Array",[${perTx.join(',')}]]`);
  const entry = { length: txs.length, canonical, perTxBytes: perTx.map(utf8ByteLength) };
  canonicalTxsByFrameTxs.set(txs, entry);
  return entry;
};
const canonicalEntityTxsForFrameHash = (txs: EntityTx[]): unknown[] => canonicalFrameTxs(txs).canonical;

const getEntityFrameTxByteLengthFromCanonical = (canonicalTxs: unknown[]): number =>
  utf8ByteLength(encodeEntityFrameTxsPayload(canonicalTxs));

const buildCanonicalArrayPayloadPrefixBytes = (canonicalTxs: unknown[], perTxBytes?: number[]): number[] => {
  const prefixBytes = [0];
  for (const [index, tx] of canonicalTxs.entries()) {
    const bytes = perTxBytes?.[index] ?? utf8ByteLength(encodeCanonicalConsensusValue(tx));
    const previousBytes = prefixBytes[index];
    if (previousBytes === undefined) throw new Error('ENTITY_FRAME_TX_PREFIX_GAP');
    prefixBytes.push(previousBytes + bytes + (index === 0 ? 0 : 1));
  }
  return prefixBytes;
};

const buildEntityFrameTxPrefixBytes = (canonicalTxs: unknown[], perTxBytes?: number[]): number[] => {
  const payloadPrefixBytes = buildCanonicalArrayPayloadPrefixBytes(canonicalTxs, perTxBytes);
  // Encode only the constant empty envelope. Canonical arrays are exactly
  // '[' + child encodings separated by ',' + ']', so encoding the complete
  // multi-megabyte tx array merely to rediscover this constant was duplicate
  // O(frame bytes) work on every proposal.
  const framingBytes = getEntityFrameTxByteLengthFromCanonical([]);
  const prefixBytes = payloadPrefixBytes.map(bytes => framingBytes + bytes);
  return prefixBytes;
};

const getEntityFrameTxByteLength = (txs: EntityTx[]): number =>
  getEntityFrameTxByteLengthFromCanonical(canonicalEntityTxsForFrameHash(txs));

export const assertEntityFrameTxByteBudget = (txs: EntityTx[]): void => {
  const byteLength = getEntityFrameTxByteLength(txs);
  if (byteLength > MAX_ENTITY_FRAME_TX_BYTES) {
    throw new Error(`ENTITY_FRAME_TX_BYTE_LIMIT_EXCEEDED:${byteLength}:${MAX_ENTITY_FRAME_TX_BYTES}`);
  }
};

export const selectEntityFrameTxByteBudget = (txs: EntityTx[]): EntityTx[] => {
  const frameTxs = canonicalFrameTxs(txs);
  const prefixBytes = buildEntityFrameTxPrefixBytes(frameTxs.canonical, frameTxs.perTxBytes);
  const fullBytes = prefixBytes[prefixBytes.length - 1];
  if (fullBytes === undefined) throw new Error('ENTITY_FRAME_TX_PREFIX_EMPTY');
  if (fullBytes <= MAX_ENTITY_FRAME_TX_BYTES) return txs;
  let low = 0;
  let high = txs.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (prefixBytes[mid]! <= MAX_ENTITY_FRAME_TX_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  if (low === 0 && txs.length > 0) {
    throw new Error(
      `ENTITY_FRAME_HEAD_TX_BYTE_LIMIT_EXCEEDED:${prefixBytes[1]}:${MAX_ENTITY_FRAME_TX_BYTES}`,
    );
  }
  return txs.slice(0, low);
};

// Events are not known before apply. 500 users needed 1.7 MB beyond a 256 KB
// slack. Mixed 1000e sealed 11.5 MB at 208 txs after a 2 MB event reserve —
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

export const measureEntityFrameWireBytes = (input: EntityFrameWireBudgetInput): number =>
  measureEntityFrameWireBytesFromCanonical(
    canonicalEntityTxsForFrameHash(input.txs),
    input,
  );

const measureEntityFrameWireBytesFromCanonical = (
  canonicalTxs: unknown[],
  input: Omit<EntityFrameWireBudgetInput, 'txs'>,
): number =>
  utf8ByteLength(encodeCanonicalConsensusValue({
    domain: 'xln:entity-frame',
    ...input,
    txs: canonicalTxs,
    jPrefixCertificate: input.jPrefixCertificate ?? null,
  }));

/** Reuses exact canonical AccountInput child bytes while tx-dependent infra
 *  context is rematerialized during proposal fitting. */
export type EntityFrameWirePrefixMeter = ((
  rest: Omit<EntityFrameWireBudgetInput, 'txs'>,
  count: number,
) => number) & {
  /** Bind one immutable proposal context and encode its fixed bytes once. */
  forRest: (rest: Omit<EntityFrameWireBudgetInput, 'txs'>) => (count: number) => number;
  /** Exact standalone tx-envelope bytes for the same canonical prefix. */
  txBytes: (count: number) => number;
};

export const createEntityFrameWirePrefixMeter = (txs: EntityTx[]): EntityFrameWirePrefixMeter => {
  const frameTxs = canonicalFrameTxs(txs);
  const payloadPrefixBytes = buildCanonicalArrayPayloadPrefixBytes(frameTxs.canonical, frameTxs.perTxBytes);
  const assertCount = (count: number): void => {
    if (!Number.isSafeInteger(count) || count < 0 || count >= payloadPrefixBytes.length) {
      throw new Error('ENTITY_FRAME_WIRE_PREFIX_COUNT_INVALID:' + count + ':' + txs.length);
    }
  };
  const meter = ((
    rest: Omit<EntityFrameWireBudgetInput, 'txs'>,
    count: number,
  ): number => {
    assertCount(count);
    return measureEntityFrameWireBytesFromCanonical([], rest) + payloadPrefixBytes[count]!;
  }) as EntityFrameWirePrefixMeter;
  meter.forRest = (rest) => {
    // The exact proposal template is immutable for one fit attempt. Measuring
    // its multi-megabyte HTLC/profile context per candidate was pure duplicate
    // work because only the tx-array prefix changes.
    const fixedBytes = measureEntityFrameWireBytesFromCanonical([], rest);
    return (count: number): number => {
      assertCount(count);
      return fixedBytes + payloadPrefixBytes[count]!;
    };
  };
  const txFramingBytes = getEntityFrameTxByteLengthFromCanonical([]);
  meter.txBytes = (count: number): number => {
    assertCount(count);
    return txFramingBytes + payloadPrefixBytes[count]!;
  };
  return meter;
};

export const selectEntityFrameTxByteBudgetWithMeter = (
  txs: EntityTx[],
): Readonly<{ txs: EntityTx[]; meter: EntityFrameWirePrefixMeter }> => {
  const meter = createEntityFrameWirePrefixMeter(txs);
  if (meter.txBytes(txs.length) <= MAX_ENTITY_FRAME_TX_BYTES) return { txs, meter };
  let low = 0;
  let high = txs.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (meter.txBytes(mid) <= MAX_ENTITY_FRAME_TX_BYTES) low = mid;
    else high = mid - 1;
  }
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
  const canonical = canonicalEntityTxsForFrameHash(txs);
  const payloadPrefixBytes = buildCanonicalArrayPayloadPrefixBytes(canonical);
  const framingBytes = measureEntityFrameWireBytesFromCanonical([], rest);
  const prefixBytes = payloadPrefixBytes.map(bytes => framingBytes + bytes);
  const fullBytes = prefixBytes.at(-1);
  if (fullBytes === undefined) throw new Error('ENTITY_FRAME_WIRE_PREFIX_EMPTY');
  if (fullBytes <= maxBytes) return txs;
  let low = 0;
  let high = txs.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (prefixBytes[mid]! <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  if (low === 0) {
    throw new Error(
      `ENTITY_FRAME_HEAD_WIRE_LIMIT_EXCEEDED:${prefixBytes[1]}:${maxBytes}`,
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
    // Failure path only: say which part is fat so the deferral log is actionable.
    const part = (value: unknown): number => {
      try { return utf8ByteLength(encodeCanonicalConsensusValue(value)); } catch { return -1; }
    };
    throw new Error(
      `ENTITY_FRAME_TOTAL_BYTE_LIMIT_EXCEEDED:${frameBytes}:${LIMITS.MAX_FRAME_SIZE_BYTES}` +
      `:txs=${input.txs.length}/${part(canonicalEntityTxsForFrameHash(input.txs))}` +
      `:events=${input.events.length}/${part(input.events)}` +
      `:context=${part(input.entityContext)}`,
    );
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
