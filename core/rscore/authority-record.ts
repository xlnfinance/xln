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
 * A clock an Entity used inside this Runtime frame — the timestamp and
 * finalized J height a proposal was built with, or the enforcement clock a
 * received frame was judged against.
 */
type RecordedClock = { ownerEntityId: string; role: 'propose' | 'enforce'; clock: string };

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
const clocks = new Map<string, RecordedClock[]>();

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
  /**
   * Runtime frames whose inputs belong to more than one owner Entity. Each
   * Entity has its own enforcement clock, so such a frame cannot be one wave
   * with one clock: it is one wave per owner, prepared together and committed
   * together.
   */
  framesWithMultipleOwners: 0,
  /** The largest number of owner Entities seen in a single Runtime frame. */
  maxOwnersPerFrame: 0,
  /**
   * Owners that used more than one proposal clock inside a single Runtime
   * frame. One wave per owner per Runtime frame carries one clock; if this is
   * ever non-zero, the unit is the Entity frame, not the Runtime frame.
   */
  ownersWithMultipleProposeClocks: 0,
  /** The same question for the receiver's enforcement clock. */
  ownersWithMultipleEnforceClocks: 0,
  /** Clocks observed at all, so a zero above is not zero observations. */
  clocksObserved: 0,
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
export const noteRawAccountInput = (
  /** From the caller's own consensus context, never from module state. */
  runtimeId: string | undefined,
  account: AccountReplica,
  input: AccountInput,
): void => {
  if (!authorityRecordEnabled()) return;
  if (runtimeId === undefined) {
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
export const noteAuthorityEntityClock = (
  runtimeId: string | undefined,
  ownerEntityId: string,
  role: 'propose' | 'enforce',
  timestamp: number,
  finalizedJHeight: number,
): void => {
  if (!authorityRecordEnabled()) return;
  if (runtimeId === undefined) return;
  const open = clocks.get(runtimeId);
  if (open === undefined) return;
  open.push({
    ownerEntityId: ownerEntityId.trim().toLowerCase(),
    role,
    clock: `${timestamp}/${finalizedJHeight}`,
  });
};

export const beginAuthorityFrame = (runtimeId: string): void => {
  if (!authorityRecordEnabled()) return;
  if (frames.has(runtimeId)) {
    // The previous frame for this Runtime never closed: whatever it holds
    // cannot be attributed, so it is dropped and counted.
    report.abandonedFrames += 1;
  }
  frames.set(runtimeId, []);
  clocks.set(runtimeId, []);
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
  const frameClocks = clocks.get(runtimeId) ?? [];
  frames.delete(runtimeId);
  clocks.delete(runtimeId);
  recordClocks(frameClocks);
  if (frame.length === 0) return;
  report.frames += 1;
  report.inputs += frame.length;
  const seenPeerInput = new Set<string>();
  const interleaved = new Set<string>();
  const owners = new Set<string>();
  for (const row of frame) {
    const key = `${row.ownerEntityId}/${row.counterpartyEntityId}`;
    owners.add(row.ownerEntityId);
    report.byKind[row.kind] = (report.byKind[row.kind] ?? 0) + 1;
    if (row.kind === 'enqueue') {
      if (seenPeerInput.has(key)) interleaved.add(key);
      continue;
    }
    seenPeerInput.add(key);
  }
  if (owners.size > 1) report.framesWithMultipleOwners += 1;
  report.maxOwnersPerFrame = Math.max(report.maxOwnersPerFrame, owners.size);
  if (interleaved.size > 0) {
    report.framesWithInterleavedAccount += 1;
    report.interleavedAccounts += interleaved.size;
  }
};

/** One clock per owner per role, or the Runtime frame is not the wave unit. */
const recordClocks = (rows: readonly RecordedClock[]): void => {
  report.clocksObserved += rows.length;
  const byOwner = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.role}/${row.ownerEntityId}`;
    const seen = byOwner.get(key) ?? new Set<string>();
    seen.add(row.clock);
    byOwner.set(key, seen);
  }
  for (const [key, seen] of byOwner) {
    if (seen.size <= 1) continue;
    if (key.startsWith('propose/')) report.ownersWithMultipleProposeClocks += 1;
    else report.ownersWithMultipleEnforceClocks += 1;
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
  clocks.clear();
  report = {
    frames: 0,
    inputs: 0,
    framesWithInterleavedAccount: 0,
    interleavedAccounts: 0,
    skippedNoHeader: 0,
    skippedNoFrame: 0,
    abandonedFrames: 0,
    framesWithMultipleOwners: 0,
    maxOwnersPerFrame: 0,
    ownersWithMultipleProposeClocks: 0,
    ownersWithMultipleEnforceClocks: 0,
    clocksObserved: 0,
    byKind: {},
  };
};
