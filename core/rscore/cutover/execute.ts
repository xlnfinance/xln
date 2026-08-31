/**
 * Publish one Account result from a bulk Rust round.
 *
 * This is the cutover boundary. TypeScript does not execute the transition:
 * one resident EntityRound applies Account inputs, Entity financial work and
 * Account proposals. Its cached result carries the exact final post-state rows
 * once; those rebuild the Entity's Account read models after all same-frame
 * Entity work has run.
 *
 * Anything the profile cannot express refuses loudly. A cutover that guessed
 * would sign a frame nobody executed.
 */
import { rememberEngineAccountLeaf } from './leaf-registry';
import { publishAccountOverlay } from '../../account/state/candidate-overlay';
import {
  accountInputApplied,
  accountInputDisputeRequired,
  proposeAccountFrameIdle,
  proposeAccountFrameProposed,
  rejectAccountInput,
} from '../../account/consensus/result';
import type {
  AccountCommittedFrame,
  AccountConsensusHashToSign,
  HandleAccountInputResult,
  ProposeAccountFrameResult,
  ProposalDroppedTransaction,
} from '../../account/consensus/types';
import type { AccountFrame, AccountReplica } from '../../types/account';
import { isLeftEntity } from '../../account/utils';
import { safeStringify } from '../../protocol/serialization';
import {
  materializeRscoreAccountReplica,
  planRscoreLocalWitnesses,
  type RscoreAccountMaterializerBinding,
} from '../checkpoint/account-materializer';
import {
  resolveRscoreWaveAccount,
  type RscoreAccountCheckpointRow,
} from '../checkpoint/wave-checkpoint-decode';
import type { Wave, WaveDisputeDraft, WaveOutput } from '../wave-decode';

/** One applied operation's verdict, as the wave reports it. */
type CutoverVerdict = Wave['applied'][number]['verdict'];
import { cutoverAccountEffects, type CutoverAccountEffects } from './effects';
import {
  cutoverAck,
  cutoverAckHashes,
  cutoverEnvelope,
} from './outbound';

const fail = (code: string, detail: Readonly<Record<string, unknown>> = {}): never => {
  throw new Error(`RSCORE_CUTOVER_${code}:${safeStringify(detail)}`);
};

/** One operation's sliced verdict plus its optional final post-state row. */
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
export const materializeCutoverAccount = (
  request: Pick<CutoverInputRequest, 'binding' | 'account' | 'accountId'>,
  row: RscoreAccountCheckpointRow,
  publishPostState = true,
): MaterializedOperation => {
  const prior = request.account;
  const resolved = resolveRscoreWaveAccount(row, prior);
  const plan = planRscoreLocalWitnesses(request.accountId, resolved, prior);
  const materialized = materializeRscoreAccountReplica(
    request.binding,
    request.accountId,
    resolved,
    prior,
    plan,
  );
  if (publishPostState) {
    publishAccountOverlay(prior, materialized.account);
    // The fold that computes the Entity root will ask for this leaf next; the
    // engine already sealed it over the very bytes just published.
    rememberEngineAccountLeaf(
      request.binding.sessionOwnerEntityId,
      request.accountId,
      row.entityAccountLeaf,
    );
  }
  const account = publishPostState ? prior : materialized.account;
  for (const key of ['mempool', 'currentFrame', 'currentHeight', 'rollbackCount'] as const) {
    if (publishPostState) Reflect.set(prior, key, materialized.account[key]);
  }
  for (const key of [
    'pendingFrame',
    'pendingAccountInput',
    'lastOutboundAckFrame',
    'currentFrameHanko',
    'counterpartyFrameHanko',
    'lastRollbackFrameHash',
  ] as const) {
    const value = materialized.account[key];
    if (!publishPostState) continue;
    if (value === undefined) Reflect.deleteProperty(prior, key);
    else Reflect.set(prior, key, value);
  }
  return {
    account,
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
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    return fail('VERDICT_ARITY', { account: accountId, operationIndex, rows: rows.length });
  }
  return row.verdict;
};

const committedFrame = (
  evidence: Readonly<{ frame: AccountFrame; committedViaNewFrame: boolean }>,
  proposerIsLeft: boolean,
): AccountCommittedFrame => ({
  frame: evidence.frame,
  proposerIsLeft,
  committedViaNewFrame: evidence.committedViaNewFrame,
});

/**
 * The engine publishes one flat output list per committed window; TypeScript
 * publishes different halves of it at different moments. A frame this side
 * receives publishes all of it at once, which is this call.
 */
const appliedFromCommit = (
  prior: AccountReplica | null,
  ownerEntityId: string,
  accountId: string,
  outputs: readonly WaveOutput[],
) => cutoverAccountEffects(prior, ownerEntityId, accountId, outputs);

/**
 * The exact event strings TypeScript publishes for one Account input.
 *
 * The Entity frame hashes these, so the cutover cannot approximate them. It
 * is checked against TypeScript's own list on every parity run, which is the
 * only place both engines produce one.
 */
const cutoverAccountInputEvents = (
  verdict: CutoverVerdict,
  fromEntityId: string,
): string[] => {
  const events: string[] = [];
  const ack = verdict.kind === 'ackFrameApplied' ? verdict.ackVerdict : verdict;
  const frame = verdict.kind === 'ackFrameApplied' ? verdict.frameVerdict : verdict;
  if (ack.kind === 'ackCommitted') {
    events.push(`✅ Frame ${ack.height} confirmed and committed`);
  }
  if (frame.kind === 'frameCommitted') {
    // A lost collision is announced before the winning frame is accepted: our
    // own proposal gave way, and its transactions went back on the queue.
    if (frame.rolledBack !== null) {
      events.push(
        `🔄 ROLLBACK: Discarded our frame ${frame.rolledBack.height}, `
        + `restored ${frame.rolledBack.restored}/${frame.rolledBack.proposed} txs to mempool`,
      );
      events.push(
        `📥 Accepted LEFT's frame ${frame.height} (we are RIGHT, deterministic tiebreaker)`,
      );
    }
    events.push(...frame.events);
    events.push(`🤝 Accepted frame ${frame.height} from Entity ${fromEntityId.slice(-4)}`);
  } else if (frame.kind === 'frameDuplicate') {
    events.push(`↩️ Re-sent ACK for duplicate committed frame ${frame.height}`);
  } else if (frame.kind === 'frameCollisionIgnored') {
    events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${frame.height} (waiting for their ACK)`);
    if (frame.queued > 0) {
      events.push(`⚠️ LEFT has ${frame.queued} pending txs while waiting for RIGHT's ACK`);
    }
  }
  return events;
};

type CutoverOutboundAck = Readonly<{
  height: number;
  frameHash: string;
  dispute: WaveDisputeDraft | null;
}>;

type CutoverInputAccumulator = {
  events: string[];
  effects: {
    [K in keyof CutoverAccountEffects]: CutoverAccountEffects[K];
  };
  committedFrames: AccountCommittedFrame[];
  outbound: CutoverOutboundAck | null;
};

const createCutoverInputAccumulator = (): CutoverInputAccumulator => ({
  events: [],
  effects: {
    candidateEffects: [],
    revealedSecrets: [],
    timedOutHashlocks: [],
    swapOffersCreated: [],
    swapCancelRequests: [],
    swapOffersCancelled: [],
  },
  committedFrames: [],
  outbound: null,
});

const standaloneInputResult = (
  request: CutoverInputRequest,
  result: CutoverWaveResult,
  verdict: CutoverVerdict,
  publishPostState: boolean,
): HandleAccountInputResult | null => {
  if (verdict.kind === 'disputeRejected') {
    return rejectAccountInput('ACCOUNT_INPUT_DISPUTE_HANKO_INVALID', verdict.reason, []);
  }
  if (verdict.kind === 'boardHankoRefreshRejected') {
    return rejectAccountInput('ACCOUNT_INPUT_BOARD_HANKO_REFRESH_INVALID', verdict.reason, []);
  }
  if (verdict.kind !== 'disputeApplied' && verdict.kind !== 'boardHankoRefreshApplied') return null;
  if (publishPostState) materializeCutoverAccount(request, requireRow(result, request.accountId));
  return accountInputApplied({
    events: verdict.kind === 'boardHankoRefreshApplied' ? verdict.events : [],
    revealedSecrets: [],
    swapOffersCreated: [],
    swapCancelRequests: [],
    swapOffersCancelled: [],
    timedOutHashlocks: [],
  });
};

const collectAckCommit = (
  request: CutoverInputRequest,
  verdict: CutoverVerdict,
  accumulator: CutoverInputAccumulator,
): void => {
  const ack = verdict.kind === 'ackFrameApplied' ? verdict.ackVerdict : verdict;
  if (ack.kind === 'ackCommitted') {
    const effects = appliedFromCommit(
      request.account,
      request.binding.sessionOwnerEntityId,
      request.accountId,
      ack.outputs,
    );
    accumulator.effects.candidateEffects.push(...effects.candidateEffects);
    accumulator.effects.timedOutHashlocks.push(...effects.timedOutHashlocks);
    accumulator.committedFrames.push(committedFrame(
      ack.committedFrame,
      isLeftEntity(request.binding.sessionOwnerEntityId, request.accountId),
    ));
  } else if (ack.kind === 'ackRejected') {
    fail('ACK_REJECTED', { account: request.accountId, reason: ack.reason });
  }
};

const collectFrameCommit = (
  request: CutoverInputRequest,
  result: CutoverWaveResult,
  verdict: CutoverVerdict,
  publishPostState: boolean,
  accumulator: CutoverInputAccumulator,
): HandleAccountInputResult | null => {
  const frame = verdict.kind === 'ackFrameApplied' ? verdict.frameVerdict : verdict;
  if (frame.kind === 'frameCommitted') {
    const effects = appliedFromCommit(
      request.account,
      request.binding.sessionOwnerEntityId,
      request.accountId,
      frame.outputs,
    );
    accumulator.effects.candidateEffects.push(...effects.candidateEffects);
    accumulator.effects.revealedSecrets.push(...effects.revealedSecrets);
    accumulator.effects.timedOutHashlocks.push(...effects.timedOutHashlocks);
    accumulator.effects.swapOffersCreated.push(...effects.swapOffersCreated);
    accumulator.effects.swapCancelRequests.push(...effects.swapCancelRequests);
    accumulator.effects.swapOffersCancelled.push(...effects.swapOffersCancelled);
    accumulator.committedFrames.push(committedFrame(
      frame.committedFrame,
      isLeftEntity(request.fromEntityId, request.binding.sessionOwnerEntityId),
    ));
    accumulator.outbound = {
      height: frame.height,
      frameHash: frame.stateHash,
      dispute: frame.ackDispute,
    };
  } else if (frame.kind === 'frameDuplicate') {
    accumulator.outbound = {
      height: frame.height,
      frameHash: frame.stateHash,
      dispute: frame.ackDispute,
    };
  } else if (frame.kind === 'frameStale') {
    fail('FRAME_STALE', {
      account: request.accountId,
      height: frame.height,
      current: frame.currentHeight,
    });
  } else if (frame.kind === 'frameDisputeRequired') {
    accumulator.events.push(...cutoverAccountInputEvents(verdict, request.fromEntityId));
    if (publishPostState) materializeCutoverAccount(request, requireRow(result, request.accountId));
    const { hanko, ...signedFrame } = frame.signedFrame;
    return accountInputDisputeRequired({
      reason: frame.reason,
      evidenceSecrets: frame.evidenceSecrets,
      signedFrame: { frame: signedFrame, frameHanko: hanko },
    }, accumulator.events);
  } else if (frame.kind === 'frameRejected') {
    fail('FRAME_REJECTED', { account: request.accountId, reason: frame.reason });
  } else if (frame.kind === 'ackFrameRejected') {
    fail('ACK_FRAME_REJECTED', {
      account: request.accountId,
      phase: frame.phase,
      reason: frame.reason,
    });
  } else if (frame.kind === 'failed') {
    fail('OPERATION_FAILED', { account: request.accountId, message: frame.message });
  }
  return null;
};

const finishAppliedInput = (
  request: CutoverInputRequest,
  result: CutoverWaveResult,
  publishPostState: boolean,
  accumulator: CutoverInputAccumulator,
): HandleAccountInputResult => {
  const { effects, committedFrames, outbound } = accumulator;
  const { candidateEffects, ...typedEffects } = effects;
  const hashesToSign = outbound === null
    ? []
    : cutoverAckHashes(request.accountId, outbound.height, outbound.frameHash, outbound.dispute);
  if (publishPostState) materializeCutoverAccount(request, requireRow(result, request.accountId));
  const response = outbound === null
    ? undefined
    : cutoverAck(cutoverEnvelope(request.account), outbound.height, outbound.frameHash, outbound.dispute);
  return accountInputApplied({
    events: accumulator.events,
    ...(response === undefined ? {} : { response }),
    ...typedEffects,
    ...(candidateEffects.length > 0 ? { candidateEffects } : {}),
    ...(committedFrames.length > 0 ? { committedFrames } : {}),
    ...(hashesToSign.length > 0 ? { hashesToSign } : {}),
  });
};

export const cutoverAccountInputResult = (
  request: CutoverInputRequest,
  result: CutoverWaveResult,
  publishPostState = true,
): HandleAccountInputResult => {
  const verdict = verdictOf(result, request.accountId, request.operationIndex);
  const standalone = standaloneInputResult(request, result, verdict, publishPostState);
  if (standalone !== null) return standalone;
  const accumulator = createCutoverInputAccumulator();
  collectAckCommit(request, verdict, accumulator);
  const terminal = collectFrameCommit(request, result, verdict, publishPostState, accumulator);
  if (terminal !== null) return terminal;
  accumulator.events.push(...cutoverAccountInputEvents(verdict, request.fromEntityId));
  return finishAppliedInput(request, result, publishPostState, accumulator);
};

export const cutoverAccountProposalResult = (
  request: Pick<CutoverInputRequest, 'binding' | 'account' | 'accountId'>,
  result: CutoverWaveResult,
  proposal: Wave['proposals'][number],
  publishPostState = true,
): ProposeAccountFrameResult => {
  const accountId = request.accountId;
  if (proposal.accountId !== accountId) {
    return fail('PROPOSAL_BINDING', { account: accountId, proposal: proposal.accountId });
  }
  const dropped: ProposalDroppedTransaction[] = proposal.dropped.map(row => ({
    index: row.index,
    txDigest: row.txDigest,
    code: row.code,
    message: row.message,
    disposition: row.disposition,
  }));
  const failedHtlcLocks = proposal.failedHtlcLocks.map(failed => ({
    hashlock: failed.hashlock,
    reason: failed.reason,
  }));
  const priorSnapshot = request.account;
  if (proposal.frame === null) {
    // The window produced no frame. The mempool still moved when something was
    // dropped, so the row is materialized either way.
    const row = result.row;
    if (publishPostState && row !== null) materializeCutoverAccount(request, row);
    return proposeAccountFrameIdle({
      message: dropped.length > 0
        ? 'Proposal window produced no frame'
        : 'No transactions to propose',
      events: [],
      proposalDroppedTransactions: dropped,
      ...(failedHtlcLocks.length > 0 ? { failedHtlcLocks } : {}),
      ...(dropped.length > 0 ? { accountChanged: true as const } : {}),
    });
  }
  const row = requireRow(result, accountId);
  const effects = cutoverAccountEffects(
    priorSnapshot,
    request.binding.sessionOwnerEntityId,
    accountId,
    proposal.outputs,
  );
  if (effects.candidateEffects.length > 0 && effects.timedOutHashlocks.length > 0) {
    // Both halves are released with the peer's acknowledgement, never here.
    return fail('PROPOSAL_EFFECT_TIMING', { account: accountId });
  }
  const materialized = materializeCutoverAccount(request, row, publishPostState);
  const accountInput = materialized.account.pendingAccountInput
    ?? fail('PROPOSAL_ACCOUNT_INPUT_MISSING', { account: accountId });
  const proposalHashes = new Set([
    proposal.frame.stateHash.toLowerCase(),
    ...(proposal.dispute === null ? [] : [proposal.dispute.hash.toLowerCase()]),
  ]);
  const hashesToSign = materialized.hashesToSign.filter(entry =>
    proposalHashes.has(entry.hash.toLowerCase()));
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
    hashesToSign,
    ...(failedHtlcLocks.length > 0 ? { failedHtlcLocks } : {}),
  });
};
