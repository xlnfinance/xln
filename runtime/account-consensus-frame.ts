import { ethers } from 'ethers';

import type { AccountFrame, AccountTx } from './types';
import { assertAccountFrameDeltaIntegrity } from './account-frame';
import { computeCanonicalMerkleRoot } from './account-state-root';
import { canonicalJurisdictionEventsHash } from './j-event-observation';
import { normalizeJurisdictionEvents } from './j-event-normalization';

export const MAX_ACCOUNT_FRAME_TXS = 1000;
export const MAX_FRAME_TIMESTAMP_DRIFT_MS = 300_000;
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
  if (frame.height < 0) return `height ${frame.height} < 0`;
  if (typeof frame.jHeight !== 'number' || frame.jHeight < 0) {
    return `jHeight ${String(frame.jHeight)} is invalid`;
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
    if (Math.abs(frame.timestamp - currentTimestamp) > MAX_FRAME_TIMESTAMP_DRIFT_MS) {
      return `timestamp drift ${Math.abs(frame.timestamp - currentTimestamp)}ms > ${MAX_FRAME_TIMESTAMP_DRIFT_MS}ms`;
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
