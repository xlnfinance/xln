/**
 * What an authoritative engine would be handed, recorded — and nothing else.
 *
 * This is not the authority driver. It answers one question the driver cannot
 * be written without: the wave protocol applies a Runtime frame's admissions
 * before its peer inputs, and whether that matches the order TypeScript
 * consumed them in is a fact about real traffic, not something to assume. It
 * is named for what it does so it cannot be mistaken for the integration.
 *
 * The mirror (shadow.ts) follows TypeScript: it is handed committed frames and
 * reseeded from TypeScript state, so it can only ever agree with a history it
 * was told about. An authority is handed these same raw inputs before
 * TypeScript mutates anything, and must reach the same result on its own —
 * which is the only arrangement where a disagreement means something.
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

/**
 * The frame being recorded, and the Runtime it belongs to. A single process
 * hosts many Runtimes in HLT, so a shared buffer would mix their inputs; and a
 * frame abandoned by a throw would be attributed to whichever Runtime opened
 * the next one. Both are answered by keying the buffer and clearing it in the
 * same call that reads it.
 */
const frames = new Map<string, RecordedInput[]>();

/** The Runtime whose frame is open, set by the reducer around each frame. */
let openRuntimeId: string | null = null;

let report = {
  frames: 0,
  inputs: 0,
  /** Frames where a peer input for an account preceded an admission to it. */
  framesWithInterleavedAccount: 0,
  /** Accounts whose admissions did not all precede their peer inputs. */
  interleavedAccounts: 0,
  /** Inputs seen with no proof header to name the two parties from. */
  skippedNoHeader: 0,
  /** Inputs seen while no Runtime frame was open. */
  skippedNoFrame: 0,
  /** Frames left open by a throw, dropped rather than merged into the next. */
  abandonedFrames: 0,
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
  const runtimeId = openRuntimeId;
  if (runtimeId === null) {
    // An input outside any Runtime frame belongs to no wave. Counted, because
    // an authority that never saw it would diverge and this is where that
    // would first be visible.
    report.skippedNoFrame += 1;
    return;
  }
  const owner = account.proofHeader?.fromEntity;
  const counterparty = account.proofHeader?.toEntity;
  if (!owner || !counterparty) {
    // Counted, never silently dropped: an input the recorder cannot attribute
    // is an input the authority would not receive.
    report.skippedNoHeader += 1;
    return;
  }
  const open = frames.get(runtimeId);
  if (open === undefined) {
    report.skippedNoFrame += 1;
    return;
  }
  open.push({
    ownerEntityId: owner.trim().toLowerCase(),
    counterpartyEntityId: counterparty.trim().toLowerCase(),
    kind: classify(input),
  });
};

/**
 * Open the frame for one Runtime. The reducer calls this before it applies
 * anything and closes it in a `finally`, so a frame that throws is discarded
 * rather than merged into the next one.
 */
export const beginAuthorityFrame = (runtimeId: string): void => {
  if (!authorityRecordEnabled()) return;
  if (frames.has(runtimeId)) {
    // The previous frame for this Runtime never closed: whatever it holds
    // cannot be attributed, so it is dropped and counted.
    report.abandonedFrames += 1;
  }
  frames.set(runtimeId, []);
  openRuntimeId = runtimeId;
};

/**
 * Runtime frame boundary. Answers the question the wave protocol depends on:
 * within one Runtime frame, does every admission to an account precede every
 * peer input to that same account? If not, a wave that admits first and
 * applies second is not replaying what TypeScript did, and the two engines
 * would build different frames out of identical inputs.
 */
export const flushAuthorityFrame = (runtimeId: string): void => {
  if (!authorityRecordEnabled()) return;
  const frame = frames.get(runtimeId) ?? [];
  frames.delete(runtimeId);
  if (openRuntimeId === runtimeId) openRuntimeId = null;
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
};

export const authorityRecordReport = (): typeof report => ({ ...report, byKind: { ...report.byKind } });

export const printAuthorityRecordReport = (): void => {
  if (!authorityRecordEnabled()) return;
  authorityLog.error('authority.record', authorityRecordReport());
  // Structured logs are filtered in most harnesses; this line is the record.
  console.error(`RSCORE_AUTHORITY_RECORD ${JSON.stringify(authorityRecordReport())}`);
};

export const resetAuthorityRecordForTests = (): void => {
  frames.clear();
  openRuntimeId = null;
  report = {
    frames: 0,
    inputs: 0,
    framesWithInterleavedAccount: 0,
    interleavedAccounts: 0,
    skippedNoHeader: 0,
    skippedNoFrame: 0,
    abandonedFrames: 0,
    byKind: {},
  };
};
