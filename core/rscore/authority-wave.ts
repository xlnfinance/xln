/**
 * One Runtime frame's raw work, collected as the authoritative engine would
 * receive it.
 *
 * The mirror (shadow.ts) follows TypeScript: it is handed committed frames and
 * reseeded from TypeScript state, so it can only ever agree with a history it
 * was told about. An authority is handed these same raw inputs before
 * TypeScript mutates anything and must reach the same result on its own —
 * which is the only arrangement where a disagreement means something.
 *
 * This module is the collector, not the driver: it captures what arrived, in
 * the order it arrived, with the clock each Entity used, and assembles the
 * grouped wave request. Whoever prepares, compares and commits that wave is a
 * separate concern.
 *
 * The counters it also keeps are the evidence behind the wave's shape: that a
 * Runtime frame carries one clock per Entity per role, and that admissions and
 * peer inputs interleave (measured: 10 of 40 same-jurisdiction swap frames).
 */

import { createStructuredLogger } from '../support/logger';
import {
  accountTxWire,
  hexToWireBytes,
  shadowOutputRows,
  waveAdmitOp,
  waveInputOp,
  type ShadowOutputRow,
} from './shadow-wire';
import type { RscoreWireValue } from './client';
import type { AccountFrame, AccountInput, AccountReplica, AccountTx } from '../types/account';
import type { ApplyAccountTxOk } from '../account/tx/apply-types';

const authorityLog = createStructuredLogger('rscore.authority');

/**
 * The counterparty's recovery proof as their message carried it. The hash they
 * claim is deliberately absent: the receiving side rebuilds it from the rest,
 * because a signature is over one exact message.
 */
export type PeerDispute = {
  hanko: string;
  proofBodyHash: string;
  proofNonce: number;
  proposerIsLeft: boolean;
};

export type RawAccountInputKind = 'enqueue' | 'frame' | 'ack' | 'frame_ack' | 'dispute'
  | 'external_finality' | 'other';

/** What arrived for one account, as the engine would be handed it. */
type RecordedPayload =
  | { kind: 'admit'; txs: readonly AccountTx[] }
  | { kind: 'frame'; frame: AccountFrame; hanko: string; dispute?: PeerDispute }
  | { kind: 'ack'; height: number; frameHash: string; hanko: string; dispute?: PeerDispute }
  /** Inputs no wave can carry: they are counted, and the frame is not driven. */
  | { kind: 'unsupported'; reason: string };

type RecordedInput = {
  ownerEntityId: string;
  counterpartyEntityId: string;
  kind: RawAccountInputKind;
  payloads: RecordedPayload[];
};

/**
 * A clock an Entity used inside this Runtime frame — the timestamp and
 * finalized J height a proposal was built with, or the enforcement clock a
 * received frame was judged against.
 */
/** One committed account frame's outputs, projected the way the engine's are. */
type RecordedOutputs = {
  ownerEntityId: string;
  counterpartyEntityId: string;
  rows: ShadowOutputRow[];
};

type RecordedClock = {
  ownerEntityId: string;
  role: 'propose' | 'enforce';
  clock: string;
  timestamp: number;
  finalizedJHeight: number;
};

/**
 * Observation only, and off by default: recording every input of every frame
 * costs allocations on the hub's hot path. The driver cannot run without it —
 * the wave it hands the engine is exactly what this collects — so turning the
 * driver on turns this on too, rather than leaving it silently collecting
 * nothing.
 */
export const authorityRecordEnabled = (): boolean =>
  process.env['XLN_RSCORE_AUTHORITY_RECORD'] === '1'
  || process.env['XLN_RSCORE_AUTHORITY'] === '1';

/**
 * The frame being recorded, and the Runtime it belongs to. A single process
 * hosts many Runtimes in HLT, so a shared buffer would mix their inputs; and a
 * frame abandoned by a throw would be attributed to whichever Runtime opened
 * the next one. Both are answered by keying the buffer and clearing it in the
 * same call that reads it.
 */
const frames = new Map<string, RecordedInput[]>();
const clocks = new Map<string, RecordedClock[]>();
/**
 * What TypeScript's own commits made observable in this frame, per account, in
 * commit order. The engine reports the same thing per verdict; comparing the
 * two is the only way a wave that agrees on every root can still be caught
 * publishing a different forward, secret or resting offer.
 */
const outputs = new Map<string, RecordedOutputs[]>();

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
    payloads: payloadsOf(input),
  });
};

/**
 * One TypeScript input can be two operations for the engine: a delivery may
 * acknowledge the previous frame and propose the next one, and TypeScript
 * applies the ack first (`handleAccountAckPhase` before
 * `handleAccountProposalPhase`). They are recorded in that same order.
 */
const payloadsOf = (input: AccountInput): RecordedPayload[] => {
  if (input.kind === 'enqueue') return [{ kind: 'admit', txs: input.txs }];
  if (input.kind === 'external_finality' || input.kind === 'dispute') {
    return [{ kind: 'unsupported', reason: input.kind }];
  }
  const payloads: RecordedPayload[] = [];
  const record = input as unknown as Record<string, unknown>;
  const ack = record['ack'] as {
    height?: number;
    frameHash?: string;
    frameHanko?: string;
    disputeHanko?: unknown;
  } | undefined;
  if (ack !== undefined) {
    const dispute = peerDispute(ack.disputeHanko);
    if (typeof ack.height !== 'number' || typeof ack.frameHash !== 'string'
      || typeof ack.frameHanko !== 'string' || dispute === 'invalid') {
      payloads.push({ kind: 'unsupported', reason: 'ackIncomplete' });
    } else {
      payloads.push({
        kind: 'ack',
        height: ack.height,
        frameHash: ack.frameHash,
        hanko: ack.frameHanko,
        ...(dispute === undefined ? {} : { dispute }),
      });
    }
  }
  const proposal = record['proposal'] as {
    frame?: AccountFrame;
    frameHanko?: string;
    disputeHanko?: unknown;
  } | undefined;
  if (proposal !== undefined) {
    const dispute = peerDispute(proposal.disputeHanko);
    if (!proposal.frame || typeof proposal.frameHanko !== 'string' || dispute === 'invalid') {
      payloads.push({ kind: 'unsupported', reason: 'proposalIncomplete' });
    } else {
      payloads.push({
        kind: 'frame',
        frame: proposal.frame,
        hanko: proposal.frameHanko,
        ...(dispute === undefined ? {} : { dispute }),
      });
    }
  }
  if (payloads.length === 0) payloads.push({ kind: 'unsupported', reason: input.kind });
  return payloads;
};

/**
 * The proof attached to a peer's message, refused rather than half-read: an
 * account that stored three of its four fields would commit a proof the
 * counterparty never sent.
 */
const peerDispute = (value: unknown): PeerDispute | undefined | 'invalid' => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return 'invalid';
  const row = value as Record<string, unknown>;
  const hanko = row['hanko'];
  const proofBodyHash = row['proofBodyHash'];
  const proofNonce = row['proofNonce'];
  const proposerIsLeft = row['proposerIsLeft'];
  if (typeof hanko !== 'string' || typeof proofBodyHash !== 'string'
    || typeof proofNonce !== 'number' || typeof proposerIsLeft !== 'boolean') {
    return 'invalid';
  }
  return { hanko, proofBodyHash, proofNonce, proposerIsLeft };
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
    timestamp,
    finalizedJHeight,
  });
};

/**
 * One account frame TypeScript just committed, with the outputs it produced.
 * Recorded per Runtime frame and per account; the driver holds the engine's
 * verdict outputs against this list before the wave is committed.
 */
export const noteAuthorityCommittedOutputs = (
  runtimeId: string | undefined,
  ownerEntityId: string,
  counterpartyEntityId: string,
  txResults: readonly ApplyAccountTxOk[],
): void => {
  if (!authorityRecordEnabled()) return;
  if (runtimeId === undefined) return;
  const open = outputs.get(runtimeId);
  if (open === undefined) return;
  const rows = txResults.flatMap(result => shadowOutputRows(result));
  if (rows.length === 0) return;
  open.push({
    ownerEntityId: ownerEntityId.trim().toLowerCase(),
    counterpartyEntityId: counterpartyEntityId.trim().toLowerCase(),
    rows,
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
  outputs.set(runtimeId, []);
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
  outputs.delete(runtimeId);
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

export type AuthorityWaveEntity = {
  ownerEntityId: string;
  timestamp: number;
  jHeight: number;
  entityTimestamp: number;
  finalizedJHeight: number;
  propose: boolean;
  ops: RscoreWireValue[];
  /**
   * Per counterparty, everything TypeScript's commits published in this frame,
   * in commit order. The engine must reproduce exactly this list from its own
   * execution; a root that matches while an output is missing is a hub that
   * agrees about money and disagrees about what it forwarded.
   */
  expectedOutputs: Map<string, ShadowOutputRow[]>;
};

/** One raw input, in the position the wave sends it, so a verdict can be paired back. */
export type AuthorityWaveInput = {
  /** Position in the request, which is what the engine numbers its verdicts by. */
  inputIndex: number;
  /**
   * Position in the order the authority actually received it, before grouping
   * by Entity. Verdicts and the effects they release are published in this
   * order: `A1, C1, A2` must not become `A1, A2, C1` on the way out.
   */
  arrivalIndex: number;
  ownerEntityId: string;
  accountId: string;
  kind: 'frame' | 'ack';
};

export type AuthorityWave =
  | { kind: 'wave'; entities: AuthorityWaveEntity[]; inputs: AuthorityWaveInput[] }
  | { kind: 'empty' }
  /** Something in this frame no wave can carry. The driver must not run it. */
  | { kind: 'ineligible'; reason: string };

/**
 * The Runtime frame as a grouped wave request: one group per owner Entity,
 * each with the clocks that Entity actually used and its operations in the
 * order they arrived.
 *
 * Grouping never reorders one account's operations — an account belongs to a
 * single Entity — so the sequence that decides its mempool is preserved.
 * Input indices are assigned in the order the request sends them, and the
 * paired `inputs` list is built in that same order.
 *
 * Reading does not clear: the frame is still open, and the reducer closes it.
 */
export const buildAuthorityWave = (runtimeId: string): AuthorityWave => {
  const frame = frames.get(runtimeId);
  if (frame === undefined || frame.length === 0) return { kind: 'empty' };
  const frameClocks = clocks.get(runtimeId) ?? [];
  const frameOutputs = outputs.get(runtimeId) ?? [];
  // Arrival order first, grouping second. The index is assigned while the
  // frame is still in the sequence the authority saw, so grouping can reorder
  // the request without reordering what comes out of it.
  type ArrivedOp = {
    arrivalIndex: number;
    ownerEntityId: string;
    accountId: string;
    payload: Exclude<RecordedPayload, { kind: 'unsupported' }>;
  };
  const arrived: ArrivedOp[] = [];
  for (const row of frame) {
    for (const payload of row.payloads) {
      // One thing this frame carries that no wave can express makes the whole
      // frame undrivable — never "skip this one and drive the rest".
      if (payload.kind === 'unsupported') {
        return { kind: 'ineligible', reason: `input:${payload.reason}` };
      }
      arrived.push({
        arrivalIndex: arrived.length,
        ownerEntityId: row.ownerEntityId,
        accountId: row.counterpartyEntityId,
        payload,
      });
    }
  }
  const byOwner = new Map<string, ArrivedOp[]>();
  for (const op of arrived) {
    const rows = byOwner.get(op.ownerEntityId) ?? [];
    rows.push(op);
    byOwner.set(op.ownerEntityId, rows);
  }
  const entities: AuthorityWaveEntity[] = [];
  const inputs: AuthorityWaveInput[] = [];
  let inputIndex = 0;
  for (const [ownerEntityId, rows] of byOwner) {
    const propose = soleClock(frameClocks, ownerEntityId, 'propose');
    const enforce = soleClock(frameClocks, ownerEntityId, 'enforce');
    // Two different clocks for one Entity in one frame means the Runtime frame
    // is not this Entity's wave unit. Taking the last one would sign some of
    // its work with a clock it never used.
    if (propose === 'conflict') return { kind: 'ineligible', reason: `clock:propose:${ownerEntityId}` };
    if (enforce === 'conflict') return { kind: 'ineligible', reason: `clock:enforce:${ownerEntityId}` };
    // Without the Entity's own clock there is nothing to judge expiry with,
    // and borrowing a neighbour's is exactly what the grouped wave exists to
    // prevent.
    const clock = enforce ?? propose;
    if (!clock) return { kind: 'ineligible', reason: `clock:missing:${ownerEntityId}` };
    const ops: RscoreWireValue[] = [];
    for (const row of rows) {
      const payload = row.payload;
      if (payload.kind === 'admit') {
        const txs: RscoreWireValue[] = [];
        for (const tx of payload.txs) {
          const wire = accountTxWire(tx);
          // A transaction outside the profile makes the whole frame
          // undrivable: the engine would build a different mempool.
          if (wire === null) return { kind: 'ineligible', reason: `tx:${tx.type}` };
          txs.push(wire);
        }
        ops.push(waveAdmitOp(row.accountId, txs));
        continue;
      }
      let encoded: RscoreWireValue;
      try {
        encoded = peerInputRow(inputIndex, row.accountId, payload);
      } catch (error) {
        // A malformed Hanko or hash is not something to drive around: the
        // engine would judge a different input than TypeScript did.
        return { kind: 'ineligible', reason: `input:${(error as Error).message}` };
      }
      ops.push(waveInputOp(encoded));
      inputs.push({
        inputIndex,
        arrivalIndex: row.arrivalIndex,
        ownerEntityId,
        accountId: row.accountId,
        kind: payload.kind,
      });
      inputIndex += 1;
    }
    const expectedOutputs = new Map<string, ShadowOutputRow[]>();
    for (const committed of frameOutputs) {
      if (committed.ownerEntityId !== ownerEntityId) continue;
      const rows = expectedOutputs.get(committed.counterpartyEntityId) ?? [];
      rows.push(...committed.rows);
      expectedOutputs.set(committed.counterpartyEntityId, rows);
    }
    entities.push({
      ownerEntityId,
      expectedOutputs,
      // An Entity that never proposed in this frame carries no proposal clock;
      // it must not stamp one from somewhere else, so it does not propose.
      timestamp: propose?.timestamp ?? clock.timestamp,
      jHeight: propose?.finalizedJHeight ?? clock.finalizedJHeight,
      entityTimestamp: clock.timestamp,
      finalizedJHeight: clock.finalizedJHeight,
      propose: propose !== undefined,
      ops,
    });
  }
  return { kind: 'wave', entities, inputs };
};

/**
 * The one clock this Entity used for this role, `undefined` if it used none,
 * and `'conflict'` if it used more than one — which the caller must refuse
 * rather than resolve.
 */
const soleClock = (
  rows: readonly RecordedClock[],
  ownerEntityId: string,
  role: 'propose' | 'enforce',
): RecordedClock | undefined | 'conflict' => {
  let found: RecordedClock | undefined;
  for (const row of rows) {
    if (row.ownerEntityId !== ownerEntityId || row.role !== role) continue;
    if (found !== undefined && found.clock !== row.clock) return 'conflict';
    found = row;
  }
  return found;
};

const peerInputRow = (
  inputIndex: number,
  counterpartyEntityId: string,
  payload: Extract<RecordedPayload, { kind: 'frame' | 'ack' }>,
): RscoreWireValue => {
  const accountId = hexToWireBytes(counterpartyEntityId, 32, 'AUTHORITY_ACCOUNT_ID');
  // The signer of this input is the counterparty; the engine authenticates it
  // against the account's own binding rather than trusting the label.
  const from = hexToWireBytes(counterpartyEntityId, 32, 'AUTHORITY_FROM_ENTITY');
  if (payload.kind === 'ack') {
    return [
      inputIndex,
      accountId,
      from,
      [
        1,
        payload.height,
        hexToWireBytes(payload.frameHash, 32, 'AUTHORITY_ACK_STATE_HASH'),
        hankoBytes(payload.hanko),
        peerDisputeWire(payload.dispute),
      ],
    ];
  }
  const frame = payload.frame;
  const txs: RscoreWireValue[] = [];
  for (const tx of frame.accountTxs) {
    const wire = accountTxWire(tx);
    if (wire === null) throw new Error(`RSCORE_AUTHORITY_FRAME_TX_UNSUPPORTED:${tx.type}`);
    txs.push(wire);
  }
  return [
    inputIndex,
    accountId,
    from,
    [
      0,
      frame.height,
      frame.timestamp,
      frame.jHeight ?? 0,
      txs,
      frame.prevFrameHash,
      hexToWireBytes(frame.accountStateRoot, 32, 'AUTHORITY_FRAME_STATE_ROOT'),
      frame.byLeft,
      hexToWireBytes(frame.stateHash ?? '', 32, 'AUTHORITY_FRAME_STATE_HASH'),
      hankoBytes(payload.hanko),
      peerDisputeWire(payload.dispute),
    ],
  ];
};

/** Their signature, and the three fields that say which proof it is. */
const peerDisputeWire = (dispute: PeerDispute | undefined): RscoreWireValue =>
  (dispute === undefined ? null : [
    hankoBytes(dispute.hanko),
    hexToWireBytes(dispute.proofBodyHash, 32, 'AUTHORITY_PEER_PROOF_BODY_HASH'),
    dispute.proofNonce,
    dispute.proposerIsLeft,
  ]);

/**
 * A Hanko as bytes, refusing anything that is not hex. `parseInt` reads
 * non-hex characters as `NaN` and writes them into a byte array as zero, which
 * would have handed the engine a signature nobody produced.
 */
const hankoBytes = (value: string): Uint8Array => {
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`hankoInvalid:${clean.length}`);
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
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
  outputs.clear();
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
