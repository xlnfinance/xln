import { ethers } from 'ethers';

import type { AccountFrame, AccountTx } from '../../../types/account';
import { assertAccountFrameDeltaIntegrity } from '../../state/frame';
import { computeCanonicalMerkleRoot } from '../../commitment/state-root';
import { canonicalJurisdictionEventsHash } from '../../../jurisdiction/machine/event-observation';
import { requireCanonicalJurisdictionEvents } from '../../../jurisdiction/machine/events/event-normalization';
import { ACCOUNT_NETWORK_ALLOWANCE_MS } from '../constants';
import { LIMITS } from '../../../config/constants';
import { accountTxWithoutPostCommitHankos } from '../../settlement/witness-projection';

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
  assertAccountFrameDeltaIntegrity(frame, `AccountFrame#${frame.height}`);
  return computeCanonicalMerkleRoot('account.frame', [
    ['transition', {
      height: frame.height,
      timestamp: frame.timestamp,
      jHeight: frame.jHeight,
      prevFrameHash: frame.prevFrameHash,
      byLeft: frame.byLeft,
    }],
    ['transactions', frame.accountTxs.map(canonicalAccountTxForFrameHash)],
    ['deltas', frame.deltas],
    ['accountStateRoot', frame.accountStateRoot],
  ], 'integrity');
};

/** Verify the signed frame envelope; J-finality may advance newer live state. */
export function assertAccountFrameHash(frame: AccountFrame, code: string): void {
  if (computeCanonicalAccountFrameHash(frame) !== frame.stateHash) throw new Error(code);
}

export const computeFrameHash = computeCanonicalAccountFrameHash;
