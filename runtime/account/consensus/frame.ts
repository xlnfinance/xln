import { ethers } from 'ethers';

import type { AccountFrame, AccountTx } from '../../types';
import { assertAccountFrameDeltaIntegrity } from '../frame';
import { computeCanonicalMerkleRoot } from '../state-root';
import { canonicalJurisdictionEventsHash } from '../../j-event-observation';
import { normalizeJurisdictionEvents } from '../../j-event-normalization';
import { ACCOUNT_NETWORK_ALLOWANCE_MS } from './constants';

export const MAX_ACCOUNT_FRAME_TXS = 1000;
// A peer controls its proposed timestamp. Reject future time because it could
// prematurely satisfy payer-side deadlines. Do not reject old signed frames:
// exact retransmission must remain available after an arbitrary outage.
// Financial expiry decisions are separately checked against receiver-local
// Entity time/J-height before an incoming frame is applied.
export const MAX_FRAME_FUTURE_SKEW_MS = ACCOUNT_NETWORK_ALLOWANCE_MS;
export const MAX_FRAME_SIZE_BYTES = 10_000_000;

export function validateAccountFrame(
  frame: AccountFrame,
  currentTimestamp?: number,
  previousFrameTimestamp?: number,
): boolean {
  return getAccountFrameValidationError(frame, currentTimestamp, previousFrameTimestamp) === '';
}

export function getAccountFrameValidationError(
  frame: AccountFrame,
  currentTimestamp?: number,
  previousFrameTimestamp?: number,
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
  try {
    assertAccountFrameDeltaIntegrity(frame, `AccountFrame#${frame.height}`);
  } catch (error) {
    return `delta integrity failed: ${(error as Error).message}`;
  }

  if (currentTimestamp !== undefined) {
    const futureSkewMs = frame.timestamp - currentTimestamp;
    if (futureSkewMs > MAX_FRAME_FUTURE_SKEW_MS) {
      return `timestamp future skew ${futureSkewMs}ms > ${MAX_FRAME_FUTURE_SKEW_MS}ms`;
    }

    if (previousFrameTimestamp !== undefined && frame.timestamp < previousFrameTimestamp) {
      return `timestamp went backwards by ${previousFrameTimestamp - frame.timestamp}ms`;
    }
  }

  return '';
}

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const toInt = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.floor(n) : 0;
};

const canonicalJEventClaimForFrameHash = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  const events = normalizeJurisdictionEvents(Array.isArray(data['events']) ? data['events'] : []);

  // jBlockHash is external observation evidence, not bilateral account state.
  // The account frame commits to jHeight + canonical event bodies + eventsHash;
  // malformed or conflicting claims still fail in the j_event_claim handler
  // before this frame hash can be accepted by the counterparty.
  return {
    version: 'xln:account-j-event-claim-frame:v1',
    jHeight: toInt(data['jHeight']),
    eventsHash: canonicalJurisdictionEventsHash(events),
    events: events.map((event) => ({ type: event.type, data: event.data })),
    observedAt: toInt(data['observedAt']),
  };
};

export const canonicalAccountTxForFrameHash = (tx: AccountTx): Record<string, unknown> => {
  if (tx.type === 'j_event_claim') {
    return { type: tx.type, data: canonicalJEventClaimForFrameHash(tx.data) };
  }
  return {
    type: tx.type,
    data: tx.data,
  };
};

export async function createFrameHash(frame: AccountFrame): Promise<string> {
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
  ]);
}

export async function computeFrameHash(frame: AccountFrame): Promise<string> {
  return createFrameHash(frame);
}
