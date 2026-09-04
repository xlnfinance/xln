import type { AccountFrame, AccountOutput, AccountInput, AccountReplica } from '../../../types/account';
import type { AccountConsensusContext } from '../context';
import { createStructuredLogger, shortHash, shortId } from '../../../support/logger';
import { appendAccountMempoolTxs } from '../../input/mempool';
import type { AccountJClaimSession } from '../../j-claims/j-claim-session';
import type { AccountInputSecurityContext } from '../dispute/deadline-policy';
import { accountInputAck, accountInputProposal } from '../flush';
import { runPostFrameAutoRebalanceCheck } from '../helpers';
import {
  getDisputeHankoRequirementError,
  storeCounterpartyDisputeHanko,
  type ValidatedCounterpartyDisputeHanko,
} from '../dispute/hanko';
import type { AccountCommittedFrame, HandleAccountInputResult } from '../types';
import { accountInputApplied, rejectAccountInput } from '../result';
import { commitAccountFrameTransition } from '../frame/commit-transition';
import { preparedCommitKey, takePreparedProposalCommit } from '../proposal/prepared-commit';
import { noteAccountFrameForShadow, shadowPreFrameState } from '../../../rscore/shadow-hook';
import { publishAccountOverlay } from '../../state/candidate-overlay';
import { assertLiveCommitMatchesFrame } from './commit-root';
import { countOp } from '../../../support/performance/op-counters';
import { timePerfPhase } from '../../../support/performance/profile';
import { installCommittedAccountFrameHead } from '../frame/committed-envelope';

const ackLog = createStructuredLogger('account.ack');

export type PendingAckFrameResult =
  | { kind: 'not_applicable' }
  | { kind: 'fallthrough' }
  | { kind: 'return'; result: HandleAccountInputResult };

type AccountAckFrame = NonNullable<ReturnType<typeof accountInputAck>>;

type PendingAckCertificateResult =
  | {
    kind: 'continue';
    ack: AccountAckFrame;
    ackHanko: string;
    frameHash: string;
  }
  | { kind: 'return'; result: HandleAccountInputResult };

type RepeatedAckMaterial =
  | { ok: true; currentHash: string; frameHanko: string }
  | { ok: false; error: string };

const repeatedAckMaterial = (
  account: AccountReplica,
  ack: AccountAckFrame,
  dispute: ValidatedCounterpartyDisputeHanko | undefined,
): RepeatedAckMaterial => {
  const currentHash = account.currentFrame?.stateHash;
  if (!currentHash || ack.frameHash.toLowerCase() !== currentHash.toLowerCase()) {
    return { ok: false, error: 'ACK current frameHash mismatch' };
  }
  if (!ack.frameHanko || ack.frameHanko.toLowerCase() !== account.counterpartyFrameHanko?.toLowerCase()) {
    return { ok: false, error: 'ACK current Hanko conflict' };
  }
  if (dispute && (
    dispute.hanko.toLowerCase() !== account.counterpartyDisputeProofHanko?.toLowerCase()
    || dispute.hash.toLowerCase() !== account.counterpartyDisputeHash?.toLowerCase()
    || dispute.proofBodyHash.toLowerCase() !== account.counterpartyDisputeProofBodyHash?.toLowerCase()
    || dispute.nonce !== account.counterpartyDisputeProofNonce
    || dispute.proposerIsLeft !== account.counterpartyDisputeProofProposerIsLeft
  )) return { ok: false, error: 'ACK current dispute Hanko conflict' };
  return { ok: true, currentHash, frameHanko: ack.frameHanko };
};

const handleRepeatedCurrentAck = async (
  account: AccountReplica,
  input: AccountInput,
  ack: AccountAckFrame,
  ackHeight: number | undefined,
  validatedDisputeHanko: ValidatedCounterpartyDisputeHanko | undefined,
  events: string[],
  securityContext: AccountInputSecurityContext,
): Promise<PendingAckFrameResult | undefined> => {
  if (ackHeight !== Number(account.currentHeight ?? 0) || ackHeight <= 0) return undefined;
  const material = repeatedAckMaterial(account, ack, validatedDisputeHanko);
  if (!material.ok) return {
    kind: 'return',
    result: rejectAccountInput('ACCOUNT_INPUT_ACK_CERTIFICATE_INVALID', material.error, events),
  };
  const verified = await securityContext.verifyHanko(
    material.frameHanko,
    material.currentHash,
    input.fromEntityId,
    securityContext.counterpartyCertifiedBoard
      ? {
          registeredBoardHash: securityContext.counterpartyCertifiedBoard.boardHash,
          allowPreviousBoard: true,
        }
      : { allowPreviousBoard: true },
  );
  if (!verified.valid || verified.entityId?.toLowerCase() !== input.fromEntityId.toLowerCase()) {
    return {
      kind: 'return',
      result: rejectAccountInput('ACCOUNT_INPUT_ACK_CERTIFICATE_INVALID', 'ACK current Hanko invalid', events),
    };
  }
  return { kind: 'fallthrough' };
};

const handleObsoleteAck = (
  account: AccountReplica,
  input: AccountInput,
  ackHeight: number | undefined,
  events: string[],
): PendingAckFrameResult | undefined => {
  const currentHeight = Number(account.currentHeight ?? 0);
  if (ackHeight === undefined || ackHeight >= currentHeight - 1) return undefined;
  events.push(`ℹ️ Ignored stale ACK ${ackHeight} (current=${currentHeight})`);
  countOp('account.ack.staleIgnored');
  ackLog.debug('frame.stale_ignored', {
    height: ackHeight,
    currentHeight,
    from: shortId(input.fromEntityId),
  });
  // An ancestor ACK cannot identify or mutate any live proposal. At-least-once
  // transport may deliver it after several newer frames have committed, so it
  // is a deterministic no-op. A bundled fresh proposal still continues below.
  return accountInputProposal(input)
    ? { kind: 'fallthrough' }
    : { kind: 'return', result: accountInputApplied({ events }) };
};

export const immediatePredecessorAckError = async (
  account: AccountReplica,
  input: AccountInput,
  securityContext: AccountInputSecurityContext,
): Promise<string | undefined> => {
  const ack = accountInputAck(input);
  if (!ack) return 'Missing ACK immediate predecessor certificate';
  const expectedHash = account.currentFrame?.prevFrameHash;
  if (!expectedHash || ack.frameHash.toLowerCase() !== expectedHash.toLowerCase()) {
    return 'ACK immediate predecessor frameHash mismatch';
  }
  if (!ack.frameHanko) return 'Missing ACK immediate predecessor Hanko';
  const verified = await securityContext.verifyHanko(
    ack.frameHanko,
    expectedHash,
    input.fromEntityId,
    securityContext.counterpartyCertifiedBoard
      ? { registeredBoardHash: securityContext.counterpartyCertifiedBoard.boardHash, allowPreviousBoard: true }
      : { allowPreviousBoard: true },
  );
  return verified.valid && verified.entityId?.toLowerCase() === input.fromEntityId.toLowerCase()
    ? undefined
    : 'ACK immediate predecessor Hanko invalid';
};

export const handleImmediatePredecessorAck = async (
  account: AccountReplica,
  input: AccountInput,
  securityContext: AccountInputSecurityContext,
  events: string[],
): Promise<HandleAccountInputResult | undefined> => {
  if (input.kind !== 'ack') return undefined;
  const currentHeight = Number(account.currentHeight ?? 0);
  if (currentHeight <= 1 || Number(input.ack.height) !== currentHeight - 1) return undefined;
  const error = await immediatePredecessorAckError(account, input, securityContext);
  if (error) return rejectAccountInput('ACCOUNT_INPUT_ACK_CERTIFICATE_INVALID', error, events);
  // The dispute witness was fully authenticated by the caller, but belongs
  // to the predecessor and must not replace current Account dispute evidence.
  return accountInputApplied({ events });
};

const verifyPendingAckCertificate = async (
  account: AccountReplica,
  ack: AccountAckFrame,
  ackHeight: number,
  validatedDisputeHanko: ValidatedCounterpartyDisputeHanko | undefined,
  events: string[],
  securityContext: AccountInputSecurityContext,
): Promise<PendingAckCertificateResult> => {
  const hankoError = getDisputeHankoRequirementError(
    account.currentDisputeProofBodyHash,
    account.counterpartyDisputeProofBodyHash,
    account.counterpartyDisputeProofNonce,
    Number(account.state.jNonce ?? 0),
    validatedDisputeHanko,
  );
  if (hankoError) {
    return {
      kind: 'return',
      result: rejectAccountInput('ACCOUNT_INPUT_ACK_CERTIFICATE_INVALID', hankoError, events),
    };
  }

  const pendingFrame = account.pendingFrame!;
  const frameHash = pendingFrame.stateHash;
  if (
    typeof ack.frameHash !== 'string'
    || ack.frameHash.toLowerCase() !== frameHash.toLowerCase()
  ) {
    return {
      kind: 'return',
      result: rejectAccountInput(
        'ACCOUNT_INPUT_ACK_CERTIFICATE_INVALID',
        `ACK frameHash mismatch: got ${String(ack.frameHash)}, expected ${frameHash}`,
        events,
      ),
    };
  }
  if (!ack.frameHanko) {
    return {
      kind: 'return',
      result: rejectAccountInput(
        'ACCOUNT_INPUT_ACK_CERTIFICATE_INVALID',
        'Missing ACK hanko',
        events,
      ),
    };
  }
  const ackHanko = ack.frameHanko;

  const expectedEntity = account.proofHeader.toEntity;
  ackLog.debug('hanko.verify', { height: ackHeight, frame: shortHash(frameHash) });
  // An ACK is the second half of the certificate for an already-authored
  // pending frame, not authority to propose fresh financial movement. A lost
  // ACK may cross a board rotation; rejecting its exact previous-board Hanko
  // would strand the proposer even though the peer committed these bytes.
  // Fresh frame proposals remain current-board-only in preflight.ts.
  const verified = await timePerfPhase(
    'account.verify.ackHanko',
    () => securityContext.verifyHanko(
      ackHanko,
      frameHash,
      expectedEntity,
      securityContext.counterpartyCertifiedBoard
        ? {
            registeredBoardHash: securityContext.counterpartyCertifiedBoard.boardHash,
            allowPreviousBoard: true,
          }
        : { allowPreviousBoard: true },
    ),
  );
  if (!verified.valid) {
    return {
      kind: 'return',
      result: rejectAccountInput(
        'ACCOUNT_INPUT_ACK_CERTIFICATE_INVALID',
        'Invalid ACK hanko signature',
        events,
      ),
    };
  }
  if (
    !verified.entityId
    || verified.entityId.toLowerCase() !== expectedEntity.toLowerCase()
  ) {
    return {
      kind: 'return',
      result: rejectAccountInput(
        'ACCOUNT_INPUT_ACK_CERTIFICATE_INVALID',
        `ACK hanko entityId mismatch: got ${verified.entityId?.slice(-4)}, ` +
          `expected ${expectedEntity.slice(-4)}`,
        events,
      ),
    };
  }
  ackLog.debug('hanko.verified', {
    from: shortId(verified.entityId),
    height: ackHeight,
  });
  return { kind: 'continue', ack, ackHanko, frameHash };
};

const applyPendingFrameTransactions = async (
  context: AccountConsensusContext,
  account: AccountReplica,
  pendingFrame: AccountFrame,
  committedJClaims: AccountJClaimSession,
  timedOutHashlocks: string[],
  candidateEffects: AccountOutput[],
  frameHash: string,
): Promise<void> => {
  const prepared = takePreparedProposalCommit(preparedCommitKey(account, frameHash), account.state);
  // Same derivation commitAccountFrameTransition uses, so both commit paths
  // hand the mirror the identical execution clock.
  const preparedJHeight = pendingFrame.jHeight ?? account.state.lastFinalizedJHeight ?? 0;
  const preFrameState = shadowPreFrameState(account.state);
  if (prepared) {
    // Only the bilateral transition is replayed. Everything Entity-private on
    // the live replica (shadow, dispute draft, proof nonce) kept moving while
    // the ACK was outstanding and stays as it is.
    publishAccountOverlay(account, { ...account, state: prepared.state });
    assertLiveCommitMatchesFrame(
      account,
      pendingFrame.accountStateRoot,
      'proposer',
      pendingFrame.height,
      undefined,
      prepared.accountStateRoot,
    );
    candidateEffects.push(...prepared.candidateEffects);
    timedOutHashlocks.push(...prepared.timedOutHashlocks);
    countOp('account.ack.preparedCommit');
    // This path commits a frame without going through
    // commitAccountFrameTransition, so it must mirror it itself: otherwise
    // every proposer-side frame that hits the prepared cache is invisible to
    // the shadow engine and its account silently falls behind.
    noteAccountFrameForShadow({
      ...(context.runtimeId === undefined ? {} : { runtimeId: context.runtimeId }),
      ...(context.accountAuthorityFrameId === undefined
        ? {}
        : { accountAuthorityFrameId: context.accountAuthorityFrameId }),
      ownerEntityId: account.proofHeader.fromEntity,
      counterpartyEntityId: account.proofHeader.toEntity,
      frameHeight: pendingFrame.height,
      byLeft: account.proofHeader.fromEntity.toLowerCase() === account.state.leftEntity.toLowerCase(),
      timestamp: pendingFrame.timestamp,
      jHeight: preparedJHeight,
      enforcementTimestamp: pendingFrame.timestamp,
      enforcementJHeight: preparedJHeight,
      accountTxs: pendingFrame.accountTxs,
      txResults: prepared.txResults,
      tsApplyUs: prepared.applyUs,
      committedStateRoot: prepared.accountStateRoot,
      account,
      ...(preFrameState ? { preFrameState } : {}),
    });
    return;
  }
  const committed = await commitAccountFrameTransition({
    context,
    account,
    frame: pendingFrame,
    proposerIsLeft: account.proofHeader.fromEntity.toLowerCase() === account.state.leftEntity.toLowerCase(),
    jClaimSession: committedJClaims,
    role: 'proposer/commit',
  });
  candidateEffects.push(...committed.candidateEffects);
  timedOutHashlocks.push(...committed.timedOutHashlocks);
};

const installPendingFrameCommit = (
  account: AccountReplica,
  input: AccountInput,
  pendingFrame: AccountFrame,
  ack: AccountAckFrame,
  ackHanko: string,
  validatedDisputeHanko: ValidatedCounterpartyDisputeHanko | undefined,
  committedFrames: AccountCommittedFrame[],
): number => {
  installCommittedAccountFrameHead(account, pendingFrame);
  // The ACK is the second half of this bilateral certificate. It must survive
  // so a later board rotation can prove that both parties committed the frame.
  account.counterpartyFrameHanko = ackHanko;
  if (ack.disputeHanko) {
    storeCounterpartyDisputeHanko(account, validatedDisputeHanko);
    ackLog.debug('hanko.dispute_stored', {
      nonce: ack.disputeHanko.proofNonce,
      from: shortId(input.fromEntityId),
    });
  }
  committedFrames.push({
    frame: account.currentFrame,
    proposerIsLeft: account.proofHeader.fromEntity.toLowerCase() === account.state.leftEntity.toLowerCase(),
    committedViaNewFrame: false,
  });

  delete account.pendingFrame;
  delete account.pendingAccountInput;
  if (
    account.lastOutboundAckFrame
    && Number(account.lastOutboundAckFrame.height) < Number(pendingFrame.height)
  ) {
    delete account.lastOutboundAckFrame;
  }
  account.rollbackCount = Math.max(0, account.rollbackCount - 1);
  if (account.rollbackCount === 0) delete account.lastRollbackFrameHash;
  return pendingFrame.height;
};

const queuePostAckWork = async (
  account: AccountReplica,
  input: AccountInput,
  committedHeight: number,
  securityContext: AccountInputSecurityContext,
  candidateEffects: AccountOutput[],
  events: string[],
): Promise<void> => {
  // Rebalance sees committed state only after pendingFrame has been cleared.
  const txs = runPostFrameAutoRebalanceCheck(
    account,
    account.proofHeader.fromEntity,
    input.fromEntityId,
    committedHeight,
    securityContext.owningEntityIsHub,
    candidateEffects,
  );
  if (txs.length === 0) return;
  appendAccountMempoolTxs(account, txs, 'accountConsensus:ackAutoRebalance');
  events.push(`🔄 Auto-rebalance queued ${txs.length} tx(s) after ACK commit`);
};

export const handlePendingAckFrame = async (
  context: AccountConsensusContext,
  account: AccountReplica,
  input: AccountInput,
  ackHeight: number | undefined,
  validatedDisputeHanko: ValidatedCounterpartyDisputeHanko | undefined,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: AccountCommittedFrame[],
  committedJClaims: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
  candidateEffects: AccountOutput[],
): Promise<PendingAckFrameResult> => {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const obsolete = handleObsoleteAck(account, input, ackHeight, events);
  if (obsolete) return obsolete;
  if (ack) {
    const repeated = await handleRepeatedCurrentAck(
      account,
      input,
      ack,
      ackHeight,
      validatedDisputeHanko,
      events,
      securityContext,
    );
    if (repeated) return repeated;
  }
  const pendingFrame = account.pendingFrame;
  if (!(pendingFrame && ackHeight === pendingFrame.height && ack)) {
    return { kind: 'not_applicable' };
  }
  const certificate = await verifyPendingAckCertificate(
    account,
    ack,
    ackHeight,
    validatedDisputeHanko,
    events,
    securityContext,
  );
  if (certificate.kind === 'return') return certificate;

  ackLog.debug('frame.commit', {
    height: pendingFrame.height,
    txs: pendingFrame.accountTxs.map(tx => tx.type),
    state: shortHash(certificate.frameHash),
  });
  await applyPendingFrameTransactions(
    context,
    account,
    pendingFrame,
    committedJClaims,
    timedOutHashlocks,
    candidateEffects,
    certificate.frameHash,
  );
  const committedHeight = installPendingFrameCommit(
    account,
    input,
    pendingFrame,
    ack,
    certificate.ackHanko,
    validatedDisputeHanko,
    committedFrames,
  );
  events.push(`✅ Frame ${ackHeight} confirmed and committed`);
  await queuePostAckWork(
    account,
    input,
    committedHeight,
    securityContext,
    candidateEffects,
    events,
  );
  // Entity consensus owns proposal flushing; ACK commit never creates a second
  // proposal path while the parent frame is still being finalized.
  if (!proposal) {
    return {
      kind: 'return',
      result: accountInputApplied({
        events,
        timedOutHashlocks,
        ...(committedFrames.length > 0 && { committedFrames }),
      }),
    };
  }
  return { kind: 'fallthrough' };
};
