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
  accountPeerFrameWire,
  accountTxWire,
  accountEnvelopeWire,
  accountSeedWire,
  hexToWireBytes,
  shadowOutputRows,
  waveAdmitOp,
  waveCreateOp,
  waveInputOp,
  type ShadowOutputRow,
} from './shadow-wire';
import type { RscoreWireValue } from './client';
import type {
  AccountDisputeHanko,
  AccountFrame,
  AccountFrameAck,
  AccountFrameProposal,
  AccountInput,
  AccountPeerInput,
  AccountReplica,
  AccountTx,
} from '../types/account';
import type { ApplyAccountTxOk } from '../account/tx/apply-types';
import type {
  HandleAccountInputResult,
  ProposalDroppedTransaction,
  ProposeAccountFrameResult,
} from '../account/consensus/types';
import { safeStringify } from '../protocol/serialization';
import { decodeAccountPeerInput } from '../account/validation/input-validation';
import type { CertifiedBoardRecord } from '../types/entity-board-registry';

const authorityLog = createStructuredLogger('rscore.authority');

type RawAccountInputKind = 'create' | 'enqueue' | 'frame' | 'ack' | 'frame_ack' | 'dispute'
  | 'external_finality' | 'other';

type AuthorityPeerInput = Extract<
  AccountPeerInput,
  { kind: 'frame' | 'ack' | 'frame_ack' }
>;

/** What arrived for one account, as the engine would be handed it. */
type RecordedPayload =
  | { kind: 'create'; seed: RscoreWireValue }
  | { kind: 'admit'; txs: readonly AccountTx[] }
  | { kind: 'frame'; input: Extract<AccountPeerInput, { kind: 'frame' }> }
  | { kind: 'ack'; input: Extract<AccountPeerInput, { kind: 'ack' }> }
  | { kind: 'frame_ack'; input: Extract<AccountPeerInput, { kind: 'frame_ack' }> }
  /** Inputs no wave can carry: they are counted, and the frame is not driven. */
  | { kind: 'unsupported'; reason: string };

type RecordedInput = {
  ownerEntityId: string;
  counterpartyEntityId: string;
  kind: RawAccountInputKind;
  payloads: RecordedPayload[];
  expectedVerdict?: AuthorityExpectedOperationVerdict;
};

/** Opaque, frame-local binding between one raw Account input and its result. */
export type AuthorityRecordedAccountInput = Readonly<{
  row: RecordedInput;
}>;

type AuthorityExpectedOperationVerdict =
  | Readonly<{ kind: 'create' }>
  | Readonly<{ kind: 'admission'; admittedCount: number }>
  | Readonly<{
      kind: 'peer';
      outcome: 'applied' | 'rejected' | 'dispute';
      /** Exact Account certificate evidence, in ACK-then-frame order. */
      committedFrames: readonly Readonly<{
        frame: AccountFrame;
        committedViaNewFrame: boolean;
      }>[];
      /** ACK Hanko TypeScript produced for an accepted or duplicate frame. */
      responseAckHanko: string | null;
      /**
       * The exact strings TypeScript published. The Entity frame hashes
       * these, so an engine that executes the transition has to produce the
       * same list, and this is the only place both lists exist at once.
       */
      events: readonly string[];
    }>;

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

/** One Account the canonical Entity worklist actually sent to proposeAccountFrame. */
type RecordedProposalSelection = {
  ownerEntityId: string;
  accountId: string;
  timestamp: number;
  finalizedJHeight: number;
  /** Current Rust Propose consumes the whole mempool, never a TS subset. */
  selectionIsWholeMempool: boolean;
  expected?: AuthorityExpectedProposalAttempt;
};

type AuthorityExpectedProposalAttempt = Readonly<{
  accountId: string;
  outcome: 'proposed' | 'idle';
  frame: AccountFrame | null;
  dropped: readonly ProposalDroppedTransaction[];
}>;

/** Opaque binding from the exact worklist selection to its TS result. */
export type AuthorityRecordedAccountProposal = Readonly<{
  row: RecordedProposalSelection;
}>;

/**
 * Observation only, and off by default: recording every input of every frame
 * costs allocations on the hub's hot path. The driver cannot run without it —
 * the wave it hands the engine is exactly what this collects — so turning the
 * driver on turns this on too, rather than leaving it silently collecting
 * nothing.
 */
export const authorityRecordEnabled = (
  authorityEnabled = process.env['XLN_RSCORE_AUTHORITY'] === '1',
): boolean =>
  process.env['XLN_RSCORE_AUTHORITY_RECORD'] === '1'
  || authorityEnabled;

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
const proposalSelections = new Map<string, RecordedProposalSelection[]>();
let frameSequence = 0;

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
  switch (input.kind) {
    case 'enqueue': return 'enqueue';
    case 'external_finality': return 'external_finality';
    case 'dispute': return 'dispute';
    case 'frame': return 'frame';
    case 'ack': return 'ack';
    case 'frame_ack': return 'frame_ack';
    case 'board_hanko_refresh': return 'other';
  }
};

/**
 * One raw account input, recorded before TypeScript executes it. The owner is
 * the Entity whose account map holds this replica — the same key the engine
 * process is bound to.
 */
export const noteRawAccountInput = (
  /** From the caller's own consensus context, never from module state. */
  frameId: string | null | undefined,
  account: AccountReplica,
  input: AccountInput,
): AuthorityRecordedAccountInput | null => {
  if (!authorityRecordEnabled()) return null;
  // `null` is an explicit detached/read-only scope. It is not a gap and must
  // not touch or poison the live replica's collector even if runtimeIds match.
  if (frameId === null) return null;
  if (frameId === undefined) {
    // An input outside any Runtime frame belongs to no wave. Counted, because
    // an authority that never saw it would diverge and this is where that
    // would first be visible.
    report.skippedNoFrame += 1;
    return null;
  }
  const owner = account.proofHeader?.fromEntity;
  const counterparty = account.proofHeader?.toEntity;
  if (!owner || !counterparty) {
    // Counted, never silently dropped: an input the recorder cannot attribute
    // is an input the authority would not receive.
    report.skippedNoHeader += 1;
    return null;
  }
  const open = frames.get(frameId);
  if (open === undefined) {
    report.skippedNoFrame += 1;
    return null;
  }
  const row: RecordedInput = {
    ownerEntityId: owner.trim().toLowerCase(),
    counterpartyEntityId: counterparty.trim().toLowerCase(),
    kind: classify(input),
    payloads: payloadsOf(input),
  };
  open.push(row);
  return { row };
};

const responseAckHanko = (result: HandleAccountInputResult): string | null => {
  if (!result.ok || result.response === undefined) return null;
  const response = result.response;
  if (response.kind !== 'ack' && response.kind !== 'frame_ack') return null;
  return response.ack.frameHanko ?? null;
};

/**
 * Bind the exact TypeScript terminal and committed certificate evidence to the
 * raw operation recorded immediately before execution. This is observation,
 * not re-execution or inference from the final Account forest.
 */
export const noteAuthorityAccountInputResult = (
  recorded: AuthorityRecordedAccountInput | null,
  result: HandleAccountInputResult,
): void => {
  if (recorded === null) return;
  if (recorded.row.expectedVerdict !== undefined) {
    throw new Error('AUTHORITY_ACCOUNT_RESULT_DUPLICATE');
  }
  const payload = recorded.row.payloads[0];
  if (payload === undefined || recorded.row.payloads.length !== 1) {
    throw new Error('AUTHORITY_ACCOUNT_RESULT_PAYLOAD_ARITY');
  }
  if (payload.kind === 'admit') {
    if (!result.ok || result.admittedAccountTxCount === undefined) {
      throw new Error('AUTHORITY_ACCOUNT_ADMISSION_RESULT_INVALID');
    }
    recorded.row.expectedVerdict = {
      kind: 'admission',
      admittedCount: result.admittedAccountTxCount,
    };
    return;
  }
  if (payload.kind === 'unsupported') return;
  if (payload.kind === 'create') {
    throw new Error(`AUTHORITY_ACCOUNT_RESULT_KIND:${payload.kind}`);
  }
  recorded.row.expectedVerdict = {
    kind: 'peer',
    outcome: result.ok ? 'applied' : result.disposition,
    committedFrames: result.ok
      ? (result.committedFrames ?? []).map(committed => ({
          frame: structuredClone(committed.frame),
          committedViaNewFrame: committed.committedViaNewFrame,
        }))
      : [],
    responseAckHanko: responseAckHanko(result),
    events: [...result.events],
  };
};

/**
 * Record the exact H=0 replica before its first admission or peer input.
 *
 * Create is a candidate operation, not a recovery seed: consensus is null,
 * the complete Entity envelope is present, and the replica must still be a
 * pristine genesis. Encoding happens here so later TypeScript mutation cannot
 * change the snapshot already assigned an arrival position.
 */
export const noteAuthorityAccountCreate = (
  frameId: string | null | undefined,
  ownerEntityId: string,
  counterpartyEntityId: string,
  account: AccountReplica,
  deltaTransformer: string,
): void => {
  if (!authorityRecordEnabled()) return;
  if (frameId === null) return;
  if (frameId === undefined) {
    report.skippedNoFrame += 1;
    return;
  }
  const open = frames.get(frameId);
  if (open === undefined) {
    report.skippedNoFrame += 1;
    return;
  }
  const owner = ownerEntityId.trim().toLowerCase();
  const counterparty = counterpartyEntityId.trim().toLowerCase();
  if (
    account.proofHeader?.fromEntity.trim().toLowerCase() !== owner
    || account.proofHeader?.toEntity.trim().toLowerCase() !== counterparty
  ) {
    throw new Error(`AUTHORITY_CREATE_PARTIES:${owner}:${counterparty}`);
  }
  if (
    account.currentHeight !== 0
    || account.currentFrame.height !== 0
    || account.currentFrame.stateHash !== ''
    || account.mempool.length !== 0
    || account.pendingFrame !== undefined
  ) {
    throw new Error(`AUTHORITY_CREATE_NOT_H0:${owner}:${counterparty}`);
  }
  const seed = accountSeedWire(
    owner,
    counterparty,
    account.state,
    accountEnvelopeWire(account),
    null,
    deltaTransformer,
  );
  open.push({
    ownerEntityId: owner,
    counterpartyEntityId: counterparty,
    kind: 'create',
    payloads: [{ kind: 'create', seed }],
  });
};

/**
 * Preserve one canonical peer envelope as one authority operation. A
 * `frame_ack` still has ACK-before-proposal semantics, but the order lives
 * inside its composite kind instead of inventing two arrivals and two result
 * rows for the one AccountInput TypeScript received.
 */
const payloadsOf = (input: AccountInput): RecordedPayload[] => {
  switch (input.kind) {
    case 'enqueue':
      return [{ kind: 'admit', txs: input.txs }];
    case 'frame':
      return [{ kind: 'frame', input }];
    case 'ack':
      return [{ kind: 'ack', input }];
    case 'frame_ack':
      return [{ kind: 'frame_ack', input }];
    case 'external_finality':
    case 'dispute':
    case 'board_hanko_refresh':
      return [{ kind: 'unsupported', reason: input.kind }];
  }
};

/**
 * Open the frame for one Runtime. The reducer calls this before it applies
 * anything and closes it in a `finally`, so a frame that throws is discarded
 * rather than merged into the next one.
 */
export const noteAuthorityEntityClock = (
  frameId: string | null | undefined,
  ownerEntityId: string,
  role: 'propose' | 'enforce',
  timestamp: number,
  finalizedJHeight: number,
): void => {
  if (!authorityRecordEnabled()) return;
  if (frameId === null || frameId === undefined) return;
  const open = clocks.get(frameId);
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
 * Record the exact Account selected by the Entity proposal worklist.
 *
 * A zero-op flush can propose a mempool entry admitted by an earlier Entity
 * input, so the stage cannot infer this set from its own operations. The hook
 * lives immediately before the canonical proposeAccountFrame call and binds
 * the selection to the same clock that call receives.
 */
export const noteAuthorityAccountProposal = (
  frameId: string | null | undefined,
  ownerEntityId: string,
  accountId: string,
  timestamp: number,
  finalizedJHeight: number,
  selectionIsWholeMempool = true,
): AuthorityRecordedAccountProposal | null => {
  if (!authorityRecordEnabled()) return null;
  noteAuthorityEntityClock(
    frameId,
    ownerEntityId,
    'propose',
    timestamp,
    finalizedJHeight,
  );
  if (frameId === null || frameId === undefined) return null;
  const open = proposalSelections.get(frameId);
  if (open === undefined) return null;
  const row: RecordedProposalSelection = {
    ownerEntityId: ownerEntityId.trim().toLowerCase(),
    accountId: accountId.trim().toLowerCase(),
    timestamp,
    finalizedJHeight,
    selectionIsWholeMempool,
  };
  open.push(row);
  return { row };
};

/** Bind the selected Account to the exact result of its single TS proposal. */
export const noteAuthorityAccountProposalResult = (
  recorded: AuthorityRecordedAccountProposal | null,
  result: ProposeAccountFrameResult,
): void => {
  if (recorded === null) return;
  if (!result.ok) {
    throw new Error(
      `RSCORE_AUTHORITY_PROPOSAL_REJECTED:${recorded.row.ownerEntityId}/${recorded.row.accountId}:` +
      result.rejection.message,
    );
  }
  let frame: AccountFrame | null = null;
  if (result.outcome === 'proposed') {
    const outbound = result.accountInput;
    if (outbound.kind !== 'frame' && outbound.kind !== 'frame_ack') {
      throw new Error(`RSCORE_AUTHORITY_PROPOSAL_INPUT_KIND:${outbound.kind}`);
    }
    frame = outbound.proposal.frame;
  }
  recorded.row.expected = {
    accountId: recorded.row.accountId,
    outcome: result.outcome,
    frame,
    dropped: result.proposalDroppedTransactions,
  };
};

/**
 * One account frame TypeScript just committed, with the outputs it produced.
 * Recorded per Runtime frame and per account; the driver holds the engine's
 * verdict outputs against this list before the wave is committed.
 */
export const noteAuthorityCommittedOutputs = (
  frameId: string | null | undefined,
  ownerEntityId: string,
  counterpartyEntityId: string,
  txResults: readonly ApplyAccountTxOk[],
): void => {
  if (!authorityRecordEnabled()) return;
  if (frameId === null || frameId === undefined) return;
  const open = outputs.get(frameId);
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
  proposalSelections.set(runtimeId, []);
};

/**
 * Instance-scoped recorder boundary. The frame id lives on the Runtime
 * replica envelope and is copied into AccountConsensusContext. This stays
 * browser-safe and makes a detached replay with the same runtimeId a distinct
 * object rather than implicit process-global state.
 */
export const runAuthorityFrameScope = async <T>(
  env: { accountAuthorityFrameId?: string | null | undefined },
  runtimeId: string,
  enabled: boolean,
  work: (frameId: string | null) => Promise<T>,
): Promise<T> => {
  const previousFrameId = env.accountAuthorityFrameId;
  const frameId = enabled ? `${runtimeId}\u0000${++frameSequence}` : null;
  env.accountAuthorityFrameId = frameId;
  if (frameId !== null) beginAuthorityFrame(frameId);
  try {
    return await work(frameId);
  } finally {
    if (frameId !== null) flushAuthorityFrame(frameId);
    if (previousFrameId === undefined) delete env.accountAuthorityFrameId;
    else env.accountAuthorityFrameId = previousFrameId;
  }
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
  proposalSelections.delete(runtimeId);
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
    if (row.kind === 'create' || row.kind === 'enqueue') {
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

type AuthorityWaveOperationResultKind = 'admission' | 'applied' | 'none';

/**
 * One operation actually encoded into an Entity's Rust request.
 *
 * `resultKind` names the only result collection allowed to answer it. Create
 * mutates the candidate but deliberately has no verdict, so it is recorded as
 * `none` rather than disappearing from the coverage ledger.
 */
export type AuthorityWaveOperation = {
  operationIndex: number;
  accountId: string;
  resultKind: AuthorityWaveOperationResultKind;
  /** Global position before grouping the Runtime frame by owner Entity. */
  arrivalIndex: number;
  /** Absent only in cutover, where TypeScript produces no result to compare. */
  expectedVerdict?: AuthorityExpectedOperationVerdict;
};

type AuthorityWaveEntity = {
  ownerEntityId: string;
  timestamp: number;
  jHeight: number;
  entityTimestamp: number;
  finalizedJHeight: number;
  propose: boolean;
  /** Exact observed worklist order immediately before proposeAccountFrame. */
  proposalAccountIds: string[];
  /** Exact TS terminal row for every selected Account, in that same order. */
  expectedProposals: readonly AuthorityExpectedProposalAttempt[];
  ops: RscoreWireValue[];
  /** Exact bijection target for the admissions/applied rows Rust returns. */
  operations: AuthorityWaveOperation[];
  /**
   * Per counterparty, everything TypeScript's commits published in this frame,
   * in commit order. The engine must reproduce exactly this list from its own
   * execution; a root that matches while an output is missing is a hub that
   * agrees about money and disagrees about what it forwarded.
   */
  expectedOutputs: Map<string, ShadowOutputRow[]>;
};

/** One raw input, in the position the wave sends it, so a verdict can be paired back. */
type AuthorityWaveInput = {
  /** Candidate-global position in the grouped request. Admissions consume one too. */
  operationIndex: number;
  /**
   * Position in the order the authority actually received it, before grouping
   * by Entity. Verdicts and the effects they release are published in this
   * order: `A1, C1, A2` must not become `A1, A2, C1` on the way out.
   */
  arrivalIndex: number;
  ownerEntityId: string;
  accountId: string;
  kind: AuthorityPeerInput['kind'];
};

export type AuthorityWave =
  | { kind: 'wave'; entities: AuthorityWaveEntity[]; inputs: AuthorityWaveInput[] }
  | { kind: 'empty' }
  /** Something in this frame no wave can carry. The driver must not run it. */
  | { kind: 'ineligible'; reason: string };

export type AuthorityWaveBuildOptions = Readonly<{
  operationIndexStart?: number;
  arrivalIndexStart?: number;
  /**
   * Recorded payload rows already staged in this Entity input. The cutover
   * driver stages one operation at a time, so each call must encode only what
   * arrived since the previous one.
   */
  payloadSkip?: number;
  /**
   * `absent` when TypeScript will not execute this operation at all. Parity
   * mode compares Rust against a TypeScript result and refuses a row that has
   * none; the cutover has no such row to compare, by construction.
  */
  expectations?: 'required' | 'absent';
}>;

/**
 * Classify the three candidate-operation variants without executing them.
 * This stays next to their encoder rather than the Rust reply decoder: its
 * purpose is to prove that every submitted operation entered the coverage
 * ledger, including Create which produces no result row.
 */
export const describeAuthorityWaveOperation = (
  value: RscoreWireValue,
): Omit<AuthorityWaveOperation, 'arrivalIndex' | 'expectedVerdict'> => {
  if (!Array.isArray(value)) throw new Error('AUTHORITY_OPERATION_NOT_LIST');
  const tag = value[0];
  let operationIndex: unknown;
  let accountIdValue: unknown;
  let resultKind: AuthorityWaveOperationResultKind;
  if (tag === 0 && value.length === 4) {
    operationIndex = value[1];
    accountIdValue = value[2];
    resultKind = 'admission';
  } else if (
    tag === 1
    && value.length === 2
    && Array.isArray(value[1])
    && value[1].length === 5
  ) {
    const input = value[1];
    operationIndex = input[0];
    accountIdValue = input[1];
    resultKind = 'applied';
  } else if (tag === 2 && value.length === 3 && Array.isArray(value[2])) {
    const seed = value[2];
    operationIndex = value[1];
    accountIdValue = seed[0];
    resultKind = 'none';
  } else {
    throw new Error(`AUTHORITY_OPERATION_SHAPE:${String(tag)}:${value.length}`);
  }
  if (!Number.isSafeInteger(operationIndex) || (operationIndex as number) < 0) {
    throw new Error(`AUTHORITY_OPERATION_INDEX:${String(operationIndex)}`);
  }
  if (!(accountIdValue instanceof Uint8Array) || accountIdValue.byteLength !== 32) {
    throw new Error('AUTHORITY_OPERATION_ACCOUNT_ID');
  }
  return {
    operationIndex: operationIndex as number,
    accountId: `0x${Buffer.from(accountIdValue).toString('hex')}`,
    resultKind,
  };
};

type ArrivedAuthorityOperation = Readonly<{
  arrivalIndex: number;
  ownerEntityId: string;
  accountId: string;
  payload: Exclude<RecordedPayload, { kind: 'unsupported' }>;
  expectedVerdict?: AuthorityExpectedOperationVerdict;
}>;

type AuthorityOwnerBuildRequest = Readonly<{
  ownerEntityId: string;
  rows: readonly ArrivedAuthorityOperation[];
  frameClocks: readonly RecordedClock[];
  frameOutputs: readonly RecordedOutputs[];
  frameProposals: readonly RecordedProposalSelection[];
  operationIndexStart: number;
  expectations: 'required' | 'absent';
}>;

type AuthorityOwnerBuildResult =
  | Readonly<{ kind: 'built'; entity: AuthorityWaveEntity; inputs: AuthorityWaveInput[] }>
  | Readonly<{ kind: 'ineligible'; reason: string }>;

const buildAuthorityOwnerWave = (
  request: AuthorityOwnerBuildRequest,
): AuthorityOwnerBuildResult => {
  const {
    ownerEntityId,
    rows,
    frameClocks,
    frameOutputs,
    frameProposals,
    expectations,
  } = request;
  let operationIndex = request.operationIndexStart;
  const propose = soleClock(frameClocks, ownerEntityId, 'propose');
  const enforce = soleClock(frameClocks, ownerEntityId, 'enforce');
  if (propose === 'conflict') return { kind: 'ineligible', reason: `clock:propose:${ownerEntityId}` };
  if (enforce === 'conflict') return { kind: 'ineligible', reason: `clock:enforce:${ownerEntityId}` };
  const clock = enforce ?? propose;
  if (!clock) return { kind: 'ineligible', reason: `clock:missing:${ownerEntityId}` };
  const selected = frameProposals
    .filter(row => row.ownerEntityId === ownerEntityId)
    .map(row => row.accountId);
  if (frameProposals.some(row =>
    row.ownerEntityId === ownerEntityId && !row.selectionIsWholeMempool)) {
    return { kind: 'ineligible', reason: `proposal:subset-unsupported:${ownerEntityId}` };
  }
  const expectedProposals = frameProposals
    .filter(row => row.ownerEntityId === ownerEntityId)
    .map(row => row.expected);
  if (expectations === 'required' && expectedProposals.some(row => row === undefined)) {
    return { kind: 'ineligible', reason: `proposal:result-missing:${ownerEntityId}` };
  }
  if (new Set(selected).size !== selected.length) {
    return { kind: 'ineligible', reason: `proposal:duplicate:${ownerEntityId}` };
  }
  if ((propose === undefined) !== (selected.length === 0)) {
    return { kind: 'ineligible', reason: `proposal:clock-selection:${ownerEntityId}` };
  }
  const ops: RscoreWireValue[] = [];
  const operations: AuthorityWaveOperation[] = [];
  const inputs: AuthorityWaveInput[] = [];
  for (const row of rows) {
    const payload = row.payload;
    if (payload.kind === 'create') {
      const encoded = waveCreateOp(operationIndex, payload.seed);
      ops.push(encoded);
      operations.push({
        ...describeAuthorityWaveOperation(encoded),
        arrivalIndex: row.arrivalIndex,
        expectedVerdict: { kind: 'create' },
      });
      operationIndex += 1;
      continue;
    }
    if (payload.kind === 'admit') {
      if (expectations === 'required' && row.expectedVerdict?.kind !== 'admission') {
        return { kind: 'ineligible', reason: `result:admission:${row.ownerEntityId}/${row.accountId}` };
      }
      const txs: RscoreWireValue[] = [];
      for (const tx of payload.txs) {
        const wire = accountTxWire(tx);
        if (wire === null) return { kind: 'ineligible', reason: `tx:${tx.type}` };
        txs.push(wire);
      }
      const encoded = waveAdmitOp(operationIndex, row.accountId, txs);
      ops.push(encoded);
      operations.push({
        ...describeAuthorityWaveOperation(encoded),
        arrivalIndex: row.arrivalIndex,
        ...(row.expectedVerdict === undefined ? {} : { expectedVerdict: row.expectedVerdict }),
      });
      operationIndex += 1;
      continue;
    }
    if (expectations === 'required' && row.expectedVerdict?.kind !== 'peer') {
      return { kind: 'ineligible', reason: `result:peer:${row.ownerEntityId}/${row.accountId}` };
    }
    let encoded: RscoreWireValue;
    try {
      encoded = authorityPeerInputRow(operationIndex, row.accountId, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'ineligible', reason: `input:${message}` };
    }
    const operation = waveInputOp(encoded);
    ops.push(operation);
    operations.push({
      ...describeAuthorityWaveOperation(operation),
      arrivalIndex: row.arrivalIndex,
      ...(row.expectedVerdict === undefined ? {} : { expectedVerdict: row.expectedVerdict }),
    });
    inputs.push({
      operationIndex,
      arrivalIndex: row.arrivalIndex,
      ownerEntityId,
      accountId: row.accountId,
      kind: payload.kind,
    });
    operationIndex += 1;
  }
  const expectedOutputs = new Map<string, ShadowOutputRow[]>();
  for (const committed of frameOutputs) {
    if (committed.ownerEntityId !== ownerEntityId) continue;
    const outputRows = expectedOutputs.get(committed.counterpartyEntityId) ?? [];
    outputRows.push(...committed.rows);
    expectedOutputs.set(committed.counterpartyEntityId, outputRows);
  }
  return {
    kind: 'built',
    inputs,
    entity: {
      ownerEntityId,
      expectedOutputs,
      timestamp: propose?.timestamp ?? clock.timestamp,
      jHeight: propose?.finalizedJHeight ?? clock.finalizedJHeight,
      entityTimestamp: clock.timestamp,
      finalizedJHeight: clock.finalizedJHeight,
      propose: selected.length > 0,
      proposalAccountIds: selected,
      expectedProposals: expectations === 'required'
        ? (expectedProposals as AuthorityExpectedProposalAttempt[])
        : [],
      ops,
      operations,
    },
  };
};

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
export const buildAuthorityWave = (
  runtimeId: string,
  options: AuthorityWaveBuildOptions = {},
): AuthorityWave => {
  const frame = frames.get(runtimeId) ?? [];
  const frameClocks = clocks.get(runtimeId) ?? [];
  const frameOutputs = outputs.get(runtimeId) ?? [];
  const frameProposals = proposalSelections.get(runtimeId) ?? [];
  const operationIndexStart = options.operationIndexStart ?? 0;
  const arrivalIndexStart = options.arrivalIndexStart ?? 0;
  const payloadSkip = options.payloadSkip ?? 0;
  const expectations = options.expectations ?? 'required';
  if (
    !Number.isSafeInteger(operationIndexStart)
    || operationIndexStart < 0
    || !Number.isSafeInteger(arrivalIndexStart)
    || arrivalIndexStart < 0
  ) {
    return { kind: 'ineligible', reason: 'index:start' };
  }
  // Arrival order first, grouping second. The index is assigned while the
  // frame is still in the sequence the authority saw, so grouping can reorder
  // the request without reordering what comes out of it.
  const arrived: ArrivedAuthorityOperation[] = [];
  const accountActivity = new Set<string>();
  const createdAccounts = new Set<string>();
  let payloadOrdinal = 0;
  for (const row of frame) {
    for (const payload of row.payloads) {
      // Rows this Entity input already staged. Their side effects on the
      // create/activity guards stay recorded; only the encoding is skipped.
      const alreadyStaged = payloadOrdinal < payloadSkip;
      payloadOrdinal += 1;
      // One thing this frame carries that no wave can express makes the whole
      // frame undrivable — never "skip this one and drive the rest".
      if (payload.kind === 'unsupported') {
        return { kind: 'ineligible', reason: `input:${payload.reason}` };
      }
      const accountKey = `${row.ownerEntityId}/${row.counterpartyEntityId}`;
      if (payload.kind === 'create') {
        if (createdAccounts.has(accountKey)) {
          return { kind: 'ineligible', reason: `create:duplicate:${accountKey}` };
        }
        if (accountActivity.has(accountKey)) {
          return { kind: 'ineligible', reason: `create:late:${accountKey}` };
        }
        createdAccounts.add(accountKey);
      } else {
        accountActivity.add(accountKey);
      }
      if (alreadyStaged) continue;
      arrived.push({
        arrivalIndex: arrivalIndexStart + arrived.length,
        ownerEntityId: row.ownerEntityId,
        accountId: row.counterpartyEntityId,
        payload,
        ...(row.expectedVerdict === undefined
          ? {}
          : { expectedVerdict: row.expectedVerdict }),
      });
    }
  }
  const byOwner = new Map<string, ArrivedAuthorityOperation[]>();
  for (const op of arrived) {
    const rows = byOwner.get(op.ownerEntityId) ?? [];
    rows.push(op);
    byOwner.set(op.ownerEntityId, rows);
  }
  for (const row of frameClocks) {
    if (!byOwner.has(row.ownerEntityId)) byOwner.set(row.ownerEntityId, []);
  }
  for (const row of frameProposals) {
    if (!byOwner.has(row.ownerEntityId)) byOwner.set(row.ownerEntityId, []);
  }
  for (const row of frameOutputs) {
    if (!byOwner.has(row.ownerEntityId)) byOwner.set(row.ownerEntityId, []);
  }
  if (byOwner.size === 0) return { kind: 'empty' };
  const entities: AuthorityWaveEntity[] = [];
  const inputs: AuthorityWaveInput[] = [];
  for (const [ownerEntityId, rows] of byOwner) {
    const built = buildAuthorityOwnerWave({
      ownerEntityId,
      rows,
      frameClocks,
      frameOutputs,
      frameProposals,
      operationIndexStart,
      expectations,
    });
    if (built.kind === 'ineligible') return built;
    entities.push(built.entity);
    inputs.push(...built.inputs);
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

/**
 * One arrival as the engine reads it: its index, the account it moves, and
 * the exact envelope the peer sent.
 */
export type AuthorityCertifiedBoard = Readonly<Pick<
  CertifiedBoardRecord,
  | 'boardHash'
  | 'previousBoardHash'
  | 'previousBoardValidUntil'
  | 'activatedAtJHeight'
  | 'logIndex'
>>;

const authorityBoardWire = (
  authority: AuthorityCertifiedBoard | undefined,
  role: 'PEER' | 'LOCAL',
): RscoreWireValue => {
  if (authority === undefined) return null;
  for (const [field, value] of [
    ['previousBoardValidUntil', authority.previousBoardValidUntil],
    ['activatedAtJHeight', authority.activatedAtJHeight],
    ['logIndex', authority.logIndex],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`AUTHORITY_${role}_${field.toUpperCase()}_INVALID:${String(value)}`);
    }
  }
  return [
    hexToWireBytes(authority.boardHash, 32, `AUTHORITY_${role}_BOARD_HASH`),
    hexToWireBytes(authority.previousBoardHash, 32, `AUTHORITY_${role}_PREVIOUS_BOARD_HASH`),
    authority.previousBoardValidUntil,
    authority.activatedAtJHeight,
    authority.logIndex,
  ];
};

export const authorityPeerInputRow = (
  operationIndex: number,
  counterpartyEntityId: string,
  payload: Extract<RecordedPayload, { kind: 'frame' | 'ack' | 'frame_ack' }>,
  genesisPolicy?: Readonly<{
    expectedDomain: Readonly<{ chainId: number; depositoryAddress: string }>;
    shadowPolicyRoot: string;
    deltaTransformer: string;
    publicPinned: false;
  }>,
  peerBoardAuthority?: AuthorityCertifiedBoard,
  localBoardAuthority?: AuthorityCertifiedBoard,
): RscoreWireValue => {
  const accountId = hexToWireBytes(counterpartyEntityId, 32, 'AUTHORITY_ACCOUNT_ID');
  const decoded = decodeAccountPeerInput(payload.input, 'RSCORE_AUTHORITY_PEER_INPUT');
  if (decoded.kind !== payload.kind) {
    throw new Error(`RSCORE_AUTHORITY_PEER_KIND_CHANGED:${payload.kind}:${decoded.kind}`);
  }
  switch (decoded.kind) {
    case 'frame':
    case 'ack':
    case 'frame_ack':
      return [
        operationIndex,
        accountId,
        peerEnvelopeWire(decoded),
        genesisPolicy === undefined
          ? null
          : [
              [
                genesisPolicy.expectedDomain.chainId,
                hexToWireBytes(
                  genesisPolicy.expectedDomain.depositoryAddress,
                  20,
                  'AUTHORITY_GENESIS_DEPOSITORY',
                ),
              ],
              hexToWireBytes(genesisPolicy.shadowPolicyRoot, 32, 'AUTHORITY_GENESIS_POLICY_ROOT'),
              hexToWireBytes(genesisPolicy.deltaTransformer, 20, 'AUTHORITY_GENESIS_TRANSFORMER'),
              genesisPolicy.publicPinned,
            ],
        [
          authorityBoardWire(peerBoardAuthority, 'PEER'),
          authorityBoardWire(localBoardAuthority, 'LOCAL'),
        ],
      ];
  }
};

/**
 * Exact canonical Account peer envelope. Identity, jurisdiction, timeout and
 * watch-seed values come from the received input itself; the local Account is
 * only the row address and must never be used to fill a missing peer value.
 */
const peerEnvelopeWire = (input: AuthorityPeerInput): RscoreWireValue => [
  hexToWireBytes(input.fromEntityId, 32, 'AUTHORITY_FROM_ENTITY'),
  hexToWireBytes(input.toEntityId, 32, 'AUTHORITY_TO_ENTITY'),
  [
    input.domain.chainId,
    hexToWireBytes(input.domain.depositoryAddress, 20, 'AUTHORITY_DEPOSITORY'),
  ],
  [
    input.disputeConfig.leftResponseSeconds,
    input.disputeConfig.rightResponseSeconds,
  ],
  input.watchSeed === undefined
    ? null
    : hexToWireBytes(input.watchSeed, 32, 'AUTHORITY_WATCH_SEED'),
  peerKindWire(input),
];

/** Tags 0/1/2 are Frame/Ack/FrameAck; composite order is ACK then proposal. */
const peerKindWire = (input: AuthorityPeerInput): RscoreWireValue => {
  switch (input.kind) {
    case 'frame':
      return [0, peerProposalWire(input.proposal)];
    case 'ack':
      return [1, peerAckWire(input.ack)];
    case 'frame_ack':
      return [2, peerAckWire(input.ack), peerProposalWire(input.proposal)];
  }
};

const peerProposalWire = (proposal: AccountFrameProposal): RscoreWireValue => [
  accountPeerFrameWire(proposal.frame),
  optionalHankoWire(proposal.frameHanko),
  peerDisputeWire(proposal.disputeHanko),
];

const peerAckWire = (ack: AccountFrameAck): RscoreWireValue => [
  ack.height,
  hexToWireBytes(ack.frameHash, 32, 'AUTHORITY_ACK_FRAME_HASH'),
  optionalHankoWire(ack.frameHanko),
  peerDisputeWire(ack.disputeHanko),
];

/** The supplied dispute hash is signed evidence; Rust must recompute and compare it. */
const peerDisputeWire = (dispute: AccountDisputeHanko | undefined): RscoreWireValue =>
  (dispute === undefined ? null : [
    optionalHankoWire(dispute.hanko),
    hexToWireBytes(dispute.hash, 32, 'AUTHORITY_PEER_DISPUTE_HASH'),
    hexToWireBytes(dispute.proofBodyHash, 32, 'AUTHORITY_PEER_PROOF_BODY_HASH'),
    dispute.proofNonce,
    dispute.proposerIsLeft,
  ]);

const optionalHankoWire = (value: string | undefined): RscoreWireValue =>
  value === undefined ? null : hankoBytes(value);

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
  console.error(`RSCORE_AUTHORITY_RECORD ${safeStringify(authorityRecordReport())}`);
};

export const resetAuthorityRecordForTests = (): void => {
  frames.clear();
  clocks.clear();
  outputs.clear();
  proposalSelections.clear();
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
