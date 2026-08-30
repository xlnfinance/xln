import { ethers } from 'ethers';

import type { AccountFrame, AccountTx } from '../../../types/account';
import { computeCanonicalMerkleRoot } from '../../commitment/state-root';
import { canonicalJurisdictionEventsHash } from '../../../jurisdiction/machine/event-observation';
import { requireCanonicalJurisdictionEvents } from '../../../jurisdiction/machine/events/event-normalization';
import { ACCOUNT_NETWORK_ALLOWANCE_MS } from '../constants';
import { LIMITS } from '../../../config/constants';
import { accountTxWithoutPostCommitHankos } from '../../settlement/witness-projection';
import { policyVersionOutOfRangeError } from '../../tx/admission-policy';
import { countOp, OP_COUNTERS_ENABLED } from '../../../support/performance/op-counters';
import { getPerfMs } from '../../../support/time';

export const MAX_ACCOUNT_FRAME_TXS = LIMITS.ACCOUNT_MEMPOOL_SIZE;
// A peer controls its proposed timestamp. Reject future time because it could
// prematurely satisfy payer-side deadlines. Do not reject old signed frames:
// exact retransmission must remain available after an arbitrary outage.
// Financial expiry decisions are separately checked against receiver-local
// Entity time/J-height before an incoming frame is applied.
const MAX_FRAME_FUTURE_SKEW_MS = ACCOUNT_NETWORK_ALLOWANCE_MS;

/**
 * Cheap shape checks used by inbound Account consensus before signature work.
 *
 * The containing Entity frame has already canonicalized and capped all txs at
 * 5 MB, which is stricter than the 10 MB Account-frame cap. Re-serializing the
 * same nested Account frame here only to rediscover that bound doubled the hot
 * inbound canonicalization cost. Delta integrity remains part of the one
 * authoritative `assertAccountFrameHash` pass before replay.
 */
export function getAccountFrameStructuralError(
  frame: AccountFrame,
  currentTimestamp?: number,
): string {
  if (!Number.isSafeInteger(frame.height) || frame.height < 0) return `height ${frame.height} is invalid`;
  if (!Number.isSafeInteger(frame.jHeight) || frame.jHeight < 0) {
    return `jHeight ${String(frame.jHeight)} is invalid`;
  }
  if (!Number.isSafeInteger(frame.timestamp) || frame.timestamp < 0) {
    return `timestamp ${String(frame.timestamp)} is invalid`;
  }
  if (frame.accountTxs.length > MAX_ACCOUNT_FRAME_TXS) {
    return `tx count ${frame.accountTxs.length} > ${MAX_ACCOUNT_FRAME_TXS}`;
  }
  if (!ethers.isHexString(frame.accountStateRoot, 32)) {
    return `accountStateRoot ${String(frame.accountStateRoot)} is invalid`;
  }

  if (currentTimestamp !== undefined) {
    const futureSkewMs = frame.timestamp - currentTimestamp;
    if (futureSkewMs > MAX_FRAME_FUTURE_SKEW_MS) {
      return `timestamp future skew ${futureSkewMs}ms > ${MAX_FRAME_FUTURE_SKEW_MS}ms`;
    }

  }

  // A later Entity frame may legitimately carry an older proposer clock.
  // Preserve the signed waterfall timestamp and surface the regression at
  // the consensus boundary; rewriting or rejecting it would make peers
  // disagree about the exact Account frame that was proposed.

  return '';
}

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const requireNonNegativeSafeInteger = (value: unknown, label: string): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`ACCOUNT_FRAME_${label}_INVALID:${String(value)}`);
  }
  return number;
};

const canonicalJEventClaimForFrameHash = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  const events = requireCanonicalJurisdictionEvents(Array.isArray(data['events']) ? data['events'] : []);

  // The signed Account frame binds the exact chain block, full canonical body,
  // and both independently verified Patricia witnesses. None are local hints.
  return {
    version: 'xln:account-j-event-claim-frame:v1',
    jHeight: requireNonNegativeSafeInteger(data['jHeight'], 'J_EVENT_CLAIM_HEIGHT'),
    jBlockHash: String(data['jBlockHash'] ?? '').toLowerCase(),
    eventsHash: canonicalJurisdictionEventsHash(events),
    events,
    leftProof: data['leftProof'],
    rightProof: data['rightProof'],
  };
};

export const canonicalAccountTxForFrameHash = (tx: AccountTx): Record<string, unknown> => {
  // FX-1 tripwire: an out-of-range policyVersion here means admission let a
  // value through that TypeScript would hash distorted (silent 2^53 rounding)
  // while Rust refuses it as an unsafe integer. Hashing it anyway would sign a
  // frame the other engine can never reproduce, so this is an admission bug:
  // throw, never hash. Scoped to policyVersion only — out-of-profile kinds
  // stay hashable here so committed historical frames remain verifiable.
  const rangeError = policyVersionOutOfRangeError(tx);
  if (rangeError) throw rangeError;
  if (tx.type === 'j_event_claim') {
    return { type: tx.type, data: canonicalJEventClaimForFrameHash(tx.data) };
  }
  const unsigned = accountTxWithoutPostCommitHankos(tx);
  return {
    type: unsigned.type,
    data: unsigned.data,
  };
};

const computeCanonicalAccountFrameHash = (frame: AccountFrame): string => {
  const startedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  const hash = computeCanonicalMerkleRoot('account.frame', [
    ['transition', {
      height: frame.height,
      timestamp: frame.timestamp,
      jHeight: frame.jHeight,
      prevFrameHash: frame.prevFrameHash,
    }],
    ['transactions', frame.accountTxs.map(canonicalAccountTxForFrameHash)],
    ['accountStateRoot', frame.accountStateRoot],
  ], 'integrity');
  countOp(
    'account.frame.hash',
    0,
    OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - startedAt) * 1_000) : 0,
  );
  return hash;
};

/** Verify the signed frame envelope; J-finality may advance newer live state. */
export function assertAccountFrameHash(frame: AccountFrame, code: string): void {
  if (computeCanonicalAccountFrameHash(frame) !== frame.stateHash) throw new Error(code);
}

export const computeFrameHash = computeCanonicalAccountFrameHash;
