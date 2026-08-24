/**
 * Authoritative Rust account engine, strict-dual mode.
 *
 * The mirror (shadow.ts) follows TypeScript: it is handed committed frames and
 * reseeded from TypeScript state, so it can only ever agree with a history it
 * was told about. An authority is handed the same raw inputs TypeScript gets,
 * before TypeScript mutates anything, and must reach the same result on its
 * own — which is the only arrangement where a disagreement means something.
 *
 * This module is being built in that direction. Today it records the raw
 * account inputs of each Runtime frame, in the order TypeScript consumed them,
 * and reports what that order actually looks like. The wave protocol applies a
 * frame's admissions before its peer inputs; whether that is faithful to
 * TypeScript is a question about real traffic, not one to assume an answer to.
 */

import { createStructuredLogger } from '../support/logger';
import type { AccountInput, AccountReplica } from '../types/account';

const authorityLog = createStructuredLogger('rscore.authority');

export type RawAccountInputKind = 'enqueue' | 'frame' | 'ack' | 'frame_ack' | 'dispute'
  | 'external_finality' | 'other';

type RecordedInput = {
  ownerEntityId: string;
  counterpartyEntityId: string;
  kind: RawAccountInputKind;
};

/**
 * Observation only, and off by default: recording every input of every frame
 * costs allocations on the hub's hot path.
 */
export const authorityRecordEnabled = (): boolean =>
  process.env['XLN_RSCORE_AUTHORITY_RECORD'] === '1';

const frame: RecordedInput[] = [];

let report = {
  frames: 0,
  inputs: 0,
  /** Frames where a peer input for an account preceded an admission to it. */
  framesWithInterleavedAccount: 0,
  /** Accounts whose admissions did not all precede their peer inputs. */
  interleavedAccounts: 0,
  /** Inputs seen with no proof header to name the two parties from. */
  skippedNoHeader: 0,
  byKind: {} as Record<string, number>,
};

const classify = (input: AccountInput): RawAccountInputKind => {
  if (input.kind === 'enqueue') return 'enqueue';
  if (input.kind === 'external_finality') return 'external_finality';
  if (input.kind === 'dispute') return 'dispute';
  const record = input as unknown as Record<string, unknown>;
  const hasFrame = record['proposal'] !== undefined || record['frame'] !== undefined;
  const hasAck = record['ack'] !== undefined;
  if (hasFrame && hasAck) return 'frame_ack';
  if (hasFrame) return 'frame';
  if (hasAck) return 'ack';
  return 'other';
};

/**
 * One raw account input, recorded before TypeScript executes it. The owner is
 * the Entity whose account map holds this replica — the same key the engine
 * process is bound to.
 */
export const noteRawAccountInput = (account: AccountReplica, input: AccountInput): void => {
  if (!authorityRecordEnabled()) return;
  const owner = account.proofHeader?.fromEntity;
  const counterparty = account.proofHeader?.toEntity;
  if (!owner || !counterparty) {
    // Counted, never silently dropped: an input the recorder cannot attribute
    // is an input the authority would not receive.
    report.skippedNoHeader += 1;
    return;
  }
  frame.push({
    ownerEntityId: owner.trim().toLowerCase(),
    counterpartyEntityId: counterparty.trim().toLowerCase(),
    kind: classify(input),
  });
};

/**
 * Runtime frame boundary. Answers the question the wave protocol depends on:
 * within one Runtime frame, does every admission to an account precede every
 * peer input to that same account? If not, a wave that admits first and
 * applies second is not replaying what TypeScript did, and the two engines
 * would build different frames out of identical inputs.
 */
export const flushAuthorityFrame = (): void => {
  if (!authorityRecordEnabled()) return;
  if (frame.length === 0) return;
  report.frames += 1;
  report.inputs += frame.length;
  const seenPeerInput = new Set<string>();
  const interleaved = new Set<string>();
  for (const row of frame) {
    const key = `${row.ownerEntityId}/${row.counterpartyEntityId}`;
    report.byKind[row.kind] = (report.byKind[row.kind] ?? 0) + 1;
    if (row.kind === 'enqueue') {
      if (seenPeerInput.has(key)) interleaved.add(key);
      continue;
    }
    seenPeerInput.add(key);
  }
  if (interleaved.size > 0) {
    report.framesWithInterleavedAccount += 1;
    report.interleavedAccounts += interleaved.size;
  }
  frame.length = 0;
};

export const authorityRecordReport = (): typeof report => ({ ...report, byKind: { ...report.byKind } });

export const printAuthorityRecordReport = (): void => {
  if (!authorityRecordEnabled()) return;
  authorityLog.error('authority.record', authorityRecordReport());
  // Structured logs are filtered in most harnesses; this line is the record.
  console.error(`RSCORE_AUTHORITY_RECORD ${JSON.stringify(authorityRecordReport())}`);
};

export const resetAuthorityRecordForTests = (): void => {
  frame.length = 0;
  report = {
    frames: 0,
    inputs: 0,
    framesWithInterleavedAccount: 0,
    interleavedAccounts: 0,
    skippedNoHeader: 0,
    byKind: {},
  };
};
