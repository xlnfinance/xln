/**
 * Hand one Account operation to the engine and publish what it did.
 *
 * This is the cutover boundary. TypeScript does not execute the transition:
 * it names the operation, and then reads back the exact post-state row, the
 * verdict, the events the frame commits, and the outputs it publishes. The
 * Account replica the Entity keeps is rebuilt from that row, so the mempool,
 * the pending frame, the acknowledgement and the dispute drafts all live in
 * the engine and are mirrored here only as the Entity's read of them.
 *
 * Anything the profile cannot express refuses loudly. A cutover that guessed
 * would sign a frame nobody executed.
 */
import { publishAccountOverlay } from '../../account/state/candidate-overlay';
import {
  accountInputApplied,
  proposeAccountFrameIdle,
  proposeAccountFrameProposed,
} from '../../account/consensus/result';
import type {
  AccountCommittedFrame,
  AccountConsensusHashToSign,
  HandleAccountInputResult,
  ProposeAccountFrameResult,
  ProposalDroppedTransaction,
} from '../../account/consensus/types';
import type { AccountFrame, AccountPeerInput, AccountReplica } from '../../types/account';
import {
  materializeRscoreAccountReplica,
  planRscoreLocalWitnesses,
  type RscoreAccountMaterializerBinding,
} from '../checkpoint/account-materializer';
import type { RscoreAccountCheckpointRow } from '../checkpoint/wave-checkpoint-decode';
import type { Wave, WaveOutput } from '../wave-decode';

/** One applied operation's verdict, as the wave reports it. */
export type CutoverVerdict = Wave['applied'][number]['verdict'];
import { cutoverAccountEffects } from './effects';

const fail = (code: string, detail: Readonly<Record<string, unknown>> = {}): never => {
  throw new Error(`RSCORE_CUTOVER_${code}:${JSON.stringify(detail, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value)}`);
};

/** One operation's answer: the engine's verdicts plus its post-state row. */
export type CutoverWaveResult = Readonly<{ wave: Wave; row: RscoreAccountCheckpointRow | null }>;

export type CutoverInputRequest = Readonly<{
  binding: RscoreAccountMaterializerBinding;
  account: AccountReplica;
  accountId: string;
  /** The peer this input arrived from, as TypeScript names it in its events. */
  fromEntityId: string;
  operationIndex: number;
}>;

type MaterializedOperation = Readonly<{
  account: AccountReplica;
  hashesToSign: AccountConsensusHashToSign[];
}>;

/**
 * Rebuild the replica the engine now holds and publish it in place.
 *
 * The live object identity is preserved: the Entity holds this exact
 * reference in its accounts forest, and the Account's committed root is
 * recomputed from the published state, not copied from the engine.
 */
const materialize = (
  request: Pick<CutoverInputRequest, 'binding' | 'account' | 'accountId'>,
  row: RscoreAccountCheckpointRow,
): MaterializedOperation => {
  const prior = request.account;
  const plan = planRscoreLocalWitnesses(request.accountId, row, prior);
  const materialized = materializeRscoreAccountReplica(
    request.binding,
    request.accountId,
    row,
    prior,
    plan,
  );
  publishAccountOverlay(prior, materialized.account);
  for (const key of ['mempool', 'currentFrame', 'currentHeight', 'rollbackCount'] as const) {
    Reflect.set(prior, key, materialized.account[key]);
  }
  for (const key of [
    'pendingFrame',
    'pendingAccountInput',
    'lastOutboundFrameAck',
    'currentFrameHanko',
    'counterpartyFrameHanko',
    'lastRollbackFrameHash',
  ] as const) {
    const value = materialized.account[key];
    if (value === undefined) Reflect.deleteProperty(prior, key);
    else Reflect.set(prior, key, value);
  }
  return {
    account: prior,
    hashesToSign: materialized.hashesToSign.map(entry => ({ ...entry })),
  };
};

const requireRow = (
  result: CutoverWaveResult,
  accountId: string,
): RscoreAccountCheckpointRow =>
  result.row ?? fail('POST_ACCOUNT_ROW_MISSING', { account: accountId });

const verdictOf = (result: CutoverWaveResult, accountId: string, operationIndex: number) => {
  const rows = result.wave.applied.filter(row => row.accountId === accountId);
  if (rows.length !== 1) {
    return fail('VERDICT_ARITY', { account: accountId, operationIndex, rows: rows.length });
  }
  return rows[0]!.verdict;
};

const committedFrame = (
  evidence: Readonly<{ frame: AccountFrame; committedViaNewFrame: boolean }>,
): AccountCommittedFrame => ({
  frame: evidence.frame,
  committedViaNewFrame: evidence.committedViaNewFrame,
});

const outboundAck = (
  account: AccountReplica,
  accountId: string,
  height: number,
): AccountPeerInput => {
  const ack = account.lastOutboundFrameAck;
  if (ack === undefined || ack.height !== height) {
    return fail('OUTBOUND_ACK_MISSING', { account: accountId, height, held: ack?.height ?? null });
  }
  return ack.response;
};

/**
 * The engine publishes one flat output list per committed window; TypeScript
 * publishes different halves of it at different moments. A frame this side
 * receives publishes all of it at once, which is this call.
 */
const appliedFromCommit = (
  prior: AccountReplica | null,
  accountId: string,
  outputs: readonly WaveOutput[],
) => cutoverAccountEffects(prior, accountId, outputs);

/**
 * The exact event strings TypeScript publishes for one peer input.
 *
 * The Entity frame hashes these, so the cutover cannot approximate them. It
 * is checked against TypeScript's own list on every parity run, which is the
 * only place both engines produce one.
 */
export const cutoverAccountInputEvents = (
  verdict: CutoverVerdict,
  fromEntityId: string,
): string[] => {
  const events: string[] = [];
  const ack = verdict.kind === 'frameAckApplied' ? verdict.ackVerdict : verdict;
  const frame = verdict.kind === 'frameAckApplied' ? verdict.frameVerdict : verdict;
  if (ack.kind === 'ackCommitted') {
    events.push(`✅ Frame ${ack.height} confirmed and committed`);
  }
  if (frame.kind === 'frameCommitted') {
    events.push(...frame.events);
    events.push(`🤝 Accepted frame ${frame.height} from Entity ${fromEntityId.slice(-4)}`);
  } else if (frame.kind === 'frameDuplicate') {
    events.push(`↩️ Re-sent ACK for duplicate committed frame ${frame.height}`);
  } else if (frame.kind === 'frameCollisionIgnored') {
    events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${frame.height} (waiting for their ACK)`);
  }
  return events;
};

export const cutoverAccountInputResult = (
  request: CutoverInputRequest,
  result: CutoverWaveResult,
): HandleAccountInputResult => {
  const accountId = request.accountId;
  const verdict = verdictOf(result, accountId, request.operationIndex);
  const priorSnapshot = request.account;
  const row = requireRow(result, accountId);
  const events: string[] = [];
  const committedFrames: AccountCommittedFrame[] = [];
  const revealedSecrets: Array<{ secret: string; hashlock: string }> = [];
  const timedOutHashlocks: string[] = [];
  const candidateEffects = [];
  const swapOffersCreated = [];
  const swapCancelRequests = [];
  const swapOffersCancelled = [];
  let ackHeight: number | null = null;

  const ackPart = verdict.kind === 'frameAckApplied' ? verdict.ackVerdict : verdict;
  const framePart = verdict.kind === 'frameAckApplied' ? verdict.frameVerdict : verdict;

  if (ackPart.kind === 'ackCommitted') {
    // Our own frame came back acknowledged. TypeScript releases the frame's
    // candidate effects here, having already published its typed outcomes
    // when it proposed.
    const effects = appliedFromCommit(priorSnapshot, accountId, ackPart.outputs);
    candidateEffects.push(...effects.candidateEffects);
    timedOutHashlocks.push(...effects.timedOutHashlocks);
    committedFrames.push(committedFrame(ackPart.committedFrame));
  } else if (ackPart.kind === 'ackStale') {
    // Nothing to publish: the peer acknowledged a height we already passed.
  } else if (ackPart.kind === 'ackRejected') {
    return fail('ACK_REJECTED', { account: accountId, reason: ackPart.reason });
  }

  if (framePart.kind === 'frameCommitted') {
    if (framePart.rolledBackTxs !== 0) {
      return fail('FRAME_COLLISION_ROLLBACK', {
        account: accountId,
        height: framePart.height,
        rolledBack: framePart.rolledBackTxs,
      });
    }
    const effects = appliedFromCommit(priorSnapshot, accountId, framePart.outputs);
    candidateEffects.push(...effects.candidateEffects);
    revealedSecrets.push(...effects.revealedSecrets);
    timedOutHashlocks.push(...effects.timedOutHashlocks);
    swapOffersCreated.push(...effects.swapOffersCreated);
    swapCancelRequests.push(...effects.swapCancelRequests);
    swapOffersCancelled.push(...effects.swapOffersCancelled);
    committedFrames.push(committedFrame(framePart.committedFrame));
    ackHeight = framePart.height;
  } else if (framePart.kind === 'frameDuplicate') {
    ackHeight = framePart.height;
  } else if (framePart.kind === 'frameCollisionIgnored') {
    // Nothing was committed; the event list still records the decision.
  } else if (framePart.kind === 'frameStale') {
    return fail('FRAME_STALE', {
      account: accountId,
      height: framePart.height,
      current: framePart.currentHeight,
    });
  } else if (framePart.kind === 'frameRejected') {
    return fail('FRAME_REJECTED', { account: accountId, reason: framePart.reason });
  } else if (framePart.kind === 'frameAckRejected') {
    return fail('FRAME_ACK_REJECTED', {
      account: accountId,
      phase: framePart.phase,
      reason: framePart.reason,
    });
  } else if (framePart.kind === 'failed') {
    return fail('OPERATION_FAILED', { account: accountId, message: framePart.message });
  }

  events.push(...cutoverAccountInputEvents(verdict, request.fromEntityId));
  const materialized = materialize(request, row);
  const response = ackHeight === null
    ? undefined
    : outboundAck(materialized.account, accountId, ackHeight);
  return accountInputApplied({
    events,
    ...(response === undefined ? {} : { response }),
    revealedSecrets,
    swapOffersCreated,
    swapCancelRequests,
    swapOffersCancelled,
    timedOutHashlocks,
    ...(candidateEffects.length > 0 ? { candidateEffects } : {}),
    ...(committedFrames.length > 0 ? { committedFrames } : {}),
    ...(materialized.hashesToSign.length > 0 ? { hashesToSign: materialized.hashesToSign } : {}),
  });
};

export const cutoverAccountAdmissionResult = (
  request: Pick<CutoverInputRequest, 'binding' | 'account' | 'accountId'>,
  result: CutoverWaveResult,
): HandleAccountInputResult => {
  const accountId = request.accountId;
  const rows = result.wave.admissions.filter(row => row.accountId === accountId);
  if (rows.length !== 1) {
    return fail('ADMISSION_ARITY', { account: accountId, rows: rows.length });
  }
  const verdict = rows[0]!.verdict;
  if (verdict.kind !== 'admitted') {
    return fail('ADMISSION_REJECTED', {
      account: accountId,
      code: verdict.code,
      message: verdict.message,
    });
  }
  materialize(request, requireRow(result, accountId));
  return accountInputApplied({ events: [], admittedAccountTxCount: verdict.count });
};

export const cutoverAccountProposalResult = (
  request: Pick<CutoverInputRequest, 'binding' | 'account' | 'accountId'>,
  result: CutoverWaveResult,
): ProposeAccountFrameResult => {
  const accountId = request.accountId;
  const rows = result.wave.proposals.filter(row => row.accountId === accountId);
  if (rows.length !== 1) {
    return fail('PROPOSAL_ARITY', { account: accountId, rows: rows.length });
  }
  const proposal = rows[0]!;
  const dropped: ProposalDroppedTransaction[] = proposal.dropped.map(row => ({
    index: row.index,
    txDigest: row.txDigest,
    code: row.code,
    message: row.message,
    disposition: row.disposition,
  }));
  const priorSnapshot = request.account;
  if (proposal.frame === null) {
    // The window produced no frame. The mempool still moved when something was
    // dropped, so the row is materialized either way.
    const row = result.row;
    if (row !== null) materialize(request, row);
    return proposeAccountFrameIdle({
      message: dropped.length > 0
        ? 'Proposal window produced no frame'
        : 'No transactions to propose',
      events: [],
      proposalDroppedTransactions: dropped,
      ...(dropped.length > 0 ? { accountChanged: true as const } : {}),
    });
  }
  const row = requireRow(result, accountId);
  const effects = cutoverAccountEffects(priorSnapshot, accountId, proposal.outputs);
  if (effects.candidateEffects.length > 0 && effects.timedOutHashlocks.length > 0) {
    // Both halves are released with the peer's acknowledgement, never here.
    return fail('PROPOSAL_EFFECT_TIMING', { account: accountId });
  }
  const materialized = materialize(request, row);
  const accountInput = materialized.account.pendingAccountInput;
  if (accountInput === undefined) {
    return fail('PENDING_INPUT_MISSING', { account: accountId });
  }
  // Only the proposal's own line. A proposer does not publish its window's
  // transaction events: they are published where the frame commits, which for
  // the proposer's own frame is the peer's side.
  const events = [
    `🚀 Proposed frame ${proposal.frame.height} with ${proposal.frame.accountTxs.length} transactions`,
  ];
  return proposeAccountFrameProposed({
    accountChanged: true,
    accountInput,
    events,
    proposalDroppedTransactions: dropped,
    revealedSecrets: effects.revealedSecrets,
    swapOffersCreated: effects.swapOffersCreated,
    swapCancelRequests: effects.swapCancelRequests,
    swapOffersCancelled: effects.swapOffersCancelled,
    hashesToSign: materialized.hashesToSign,
  });
};
