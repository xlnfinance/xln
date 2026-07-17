import type { EntityTx, JurisdictionEventData } from '../types';
import { encodeCanonicalEntityConsensusValue } from '../entity/consensus/state-root';

export const MAX_ENTITY_FRAME_J_RANGE_BYTES = 10 * 1024 * 1024;

const J_RANGE_FRAME_PAYLOAD_DOMAIN = 'xln.entity-frame.j-range-payload.v1';
const ZERO_ACCOUNT_SIGNATURE = `0x${'00'.repeat(65)}`;
const utf8Encoder = new TextEncoder();

export type JRangeBody = Pick<
  JurisdictionEventData,
  | 'jurisdictionRef'
  | 'baseHeight'
  | 'scannedThroughHeight'
  | 'tipBlockHash'
  | 'eventHistoryRoot'
  | 'rangeHash'
  | 'blocks'
>;

const jRangeBody = (data: JRangeBody): JRangeBody => ({
  jurisdictionRef: data.jurisdictionRef,
  baseHeight: data.baseHeight,
  scannedThroughHeight: data.scannedThroughHeight,
  tipBlockHash: data.tipBlockHash,
  eventHistoryRoot: data.eventHistoryRoot,
  rangeHash: data.rangeHash,
  blocks: data.blocks,
});

const jRangeTxs = (
  txs: readonly EntityTx[],
): Array<Extract<EntityTx, { type: 'j_event' }>> => txs.filter(
  (tx): tx is Extract<EntityTx, { type: 'j_event' }> => tx.type === 'j_event',
);

/** Body-only measurement is exposed for boundary tests and pre-sign analysis. */
export const canonicalJRangeBodiesByteLength = (
  ranges: readonly JRangeBody[],
): number => utf8Encoder.encode(encodeCanonicalEntityConsensusValue({
  domain: J_RANGE_FRAME_PAYLOAD_DOMAIN,
  version: 1,
  ranges: ranges.map(jRangeBody),
})).byteLength;

export const canonicalJEventDataPayloadByteLength = (
  ranges: readonly JurisdictionEventData[],
): number => utf8Encoder.encode(encodeCanonicalEntityConsensusValue({
  domain: J_RANGE_FRAME_PAYLOAD_DOMAIN,
  version: 1,
  ranges,
})).byteLength;

export const canonicalEntityFrameJRangePayloadByteLength = (
  txs: readonly EntityTx[],
): number => canonicalJEventDataPayloadByteLength(jRangeTxs(txs).map((tx) => tx.data));

const assertValidRangeSpan = (range: JRangeBody): void => {
  const baseHeight = Number(range.baseHeight);
  const scannedThroughHeight = Number(range.scannedThroughHeight);
  if (!Number.isSafeInteger(baseHeight) || baseHeight < 0) {
    throw new Error(`J_RANGE_FRAME_BASE_HEIGHT_INVALID:${String(range.baseHeight)}`);
  }
  if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight <= baseHeight) {
    throw new Error(`J_RANGE_FRAME_SCANNED_HEIGHT_INVALID:${String(range.scannedThroughHeight)}`);
  }
};

const assertValidRangeSpans = (ranges: readonly JRangeBody[]): void => {
  for (const range of ranges) {
    assertValidRangeSpan(range);
  }
};

export const getJEventDataBudgetError = (
  ranges: readonly JurisdictionEventData[],
): string | null => {
  assertValidRangeSpans(ranges);
  const byteLength = canonicalJEventDataPayloadByteLength(ranges);
  return byteLength > MAX_ENTITY_FRAME_J_RANGE_BYTES
    ? `J_RANGE_FRAME_BYTE_LIMIT_EXCEEDED:${byteLength}:${MAX_ENTITY_FRAME_J_RANGE_BYTES}`
    : null;
};

const signedRangeCandidate = (
  claim: JRangeBody,
  proposerSignerId: string,
): JurisdictionEventData => ({
  from: proposerSignerId.trim().toLowerCase(),
  signature: ZERO_ACCOUNT_SIGNATURE,
  observedAt: claim.scannedThroughHeight,
  ...jRangeBody(claim),
});

/**
 * Prefix voters do not yet know which board member will propose the frame.
 * Reserve the exact authentication envelope for every eligible proposer and
 * enforce the largest canonical encoding. Signature bytes are fixed-width;
 * their value cannot change the encoded length.
 */
export const getJRangeClaimsProposableBudgetError = (
  claims: readonly JRangeBody[],
  proposerSignerIds: readonly string[],
): string | null => {
  assertValidRangeSpans(claims);
  if (proposerSignerIds.length === 0) throw new Error('J_RANGE_FRAME_PROPOSER_SET_EMPTY');
  // Only `from` varies by proposer. Select its largest exact canonical string
  // once; re-encoding a near-10-MiB body for every validator is avoidable DoS.
  const signerByteLength = (signerId: string): number => utf8Encoder.encode(
    encodeCanonicalEntityConsensusValue(signerId.trim().toLowerCase()),
  ).byteLength;
  const longestSigner = proposerSignerIds.reduce((selected, candidate) =>
    signerByteLength(candidate) > signerByteLength(selected) ? candidate : selected);
  const maxByteLength = canonicalJEventDataPayloadByteLength(
    claims.map((claim) => signedRangeCandidate(claim, longestSigner)),
  );
  return maxByteLength > MAX_ENTITY_FRAME_J_RANGE_BYTES
    ? `J_RANGE_FRAME_BYTE_LIMIT_EXCEEDED:${maxByteLength}:${MAX_ENTITY_FRAME_J_RANGE_BYTES}`
    : null;
};

export const getEntityFrameJRangeBudgetError = (
  txs: readonly EntityTx[],
): string | null => getJEventDataBudgetError(jRangeTxs(txs).map((tx) => tx.data));

export const assertEntityFrameJRangeBudget = (txs: readonly EntityTx[]): void => {
  const error = getEntityFrameJRangeBudgetError(txs);
  if (error) throw new Error(error);
};

export type JRangeBudgetedEntityTxSelection = {
  txs: EntityTx[];
  deferredJRangeCount: number;
};

/**
 * Selects an atomic ordered prefix of the Entity mempool. A range is never
 * rewritten or split. Once a range exceeds the aggregate budget, the complete
 * transaction suffix stays queued: applying later transactions first would
 * reorder the WAL across frames and can change financial state. If one range
 * cannot fit an otherwise empty frame, retrying it can never make progress, so
 * fail loud.
 */
export const selectEntityTxsWithinJRangeBudget = (
  txs: readonly EntityTx[],
): JRangeBudgetedEntityTxSelection => {
  const selected: EntityTx[] = [];
  const selectedRanges: Array<Extract<EntityTx, { type: 'j_event' }>> = [];
  let deferTransactionSuffix = false;
  let deferredJRangeCount = 0;

  for (const tx of txs) {
    if (deferTransactionSuffix) {
      if (tx.type === 'j_event') deferredJRangeCount += 1;
      continue;
    }
    if (tx.type !== 'j_event') {
      selected.push(tx);
      continue;
    }
    const individualError = getEntityFrameJRangeBudgetError([tx]);
    if (individualError) throw new Error(`J_RANGE_SINGLE_RANGE_UNPROPOSABLE:${individualError}`);
    const aggregateError = getEntityFrameJRangeBudgetError([...selectedRanges, tx]);
    if (aggregateError) {
      deferTransactionSuffix = true;
      deferredJRangeCount += 1;
      continue;
    }
    selected.push(tx);
    selectedRanges.push(tx);
  }

  return { txs: selected, deferredJRangeCount };
};
