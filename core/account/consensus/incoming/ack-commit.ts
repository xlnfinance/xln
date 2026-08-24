import type { AccountFrame, AccountOutput, AccountPeerInput, AccountReplica } from '../../../types/account';
import type { AccountConsensusContext } from '../context';
import { HEAVY_LOGS } from '../../../support/debug-flags';
import { createStructuredLogger, shortHash, shortId } from '../../../support/logger';
import { cloneIsolatedAccountFrame } from '../../../protocol/state/account-input-clone';
import { getAccountPerspective } from '../../state/perspective';
import { deriveAccountFrameTokenIds } from '../../state/frame';
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
import type { HandleAccountInputResult } from '../types';
import { accountInputApplied, rejectAccountPeerInput } from '../result';
import { commitAccountFrameTransition } from '../frame/commit-transition';
import { preparedCommitKey, takePreparedProposalCommit } from '../proposal/prepared-commit';
import { noteAccountFrameForShadow } from '../../../rscore/shadow-hook';
import { publishAccountOverlay } from '../../state/candidate-overlay';
import { assertLiveCommitMatchesFrame } from './commit-root';
import { countOp } from '../../../support/performance/op-counters';
import { timePerfPhase } from '../../../support/performance/profile';

const ackLog = createStructuredLogger('account.ack');

export type PendingFrameAckResult =
  | { kind: 'not_applicable' }
  | { kind: 'fallthrough' }
  | { kind: 'return'; result: HandleAccountInputResult };

type AccountFrameAck = NonNullable<ReturnType<typeof accountInputAck>>;

type PendingAckCertificateResult =
  | {
    kind: 'continue';
    ack: AccountFrameAck;
    ackHanko: string;
    frameHash: string;
  }
  | { kind: 'return'; result: HandleAccountInputResult };

const verifyPendingAckCertificate = async (
  account: AccountReplica,
  ack: AccountFrameAck,
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
      result: rejectAccountPeerInput('ACCOUNT_PEER_ACK_CERTIFICATE_INVALID', hankoError, events),
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
      result: rejectAccountPeerInput(
        'ACCOUNT_PEER_ACK_CERTIFICATE_INVALID',
        `ACK frameHash mismatch: got ${String(ack.frameHash)}, expected ${frameHash}`,
        events,
      ),
    };
  }
  if (!ack.frameHanko) {
    return {
      kind: 'return',
      result: rejectAccountPeerInput(
        'ACCOUNT_PEER_ACK_CERTIFICATE_INVALID',
        'Missing ACK hanko',
        events,
      ),
    };
  }
  const ackHanko = ack.frameHanko;

  const expectedEntity = account.proofHeader.toEntity;
  ackLog.debug('hanko.verify', { height: ackHeight, frame: shortHash(frameHash) });
  const verified = await timePerfPhase(
    'account.verify.ackHanko',
    () => securityContext.verifyHanko(
      ackHanko,
      frameHash,
      expectedEntity,
      securityContext.counterpartyCertifiedBoard
        ? {
            registeredBoardHash: securityContext.counterpartyCertifiedBoard.boardHash,
            allowPreviousBoard: false,
          }
        : { allowPreviousBoard: false },
    ),
  );
  if (!verified.valid) {
    return {
      kind: 'return',
      result: rejectAccountPeerInput(
        'ACCOUNT_PEER_ACK_CERTIFICATE_INVALID',
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
      result: rejectAccountPeerInput(
        'ACCOUNT_PEER_ACK_CERTIFICATE_INVALID',
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
): Promise<void> => {
  const prepared = takePreparedProposalCommit(preparedCommitKey(account, pendingFrame.stateHash), account.state);
  // Same derivation commitAccountFrameTransition uses, so both commit paths
  // hand the mirror the identical execution clock.
  const preparedJHeight = pendingFrame.jHeight ?? account.state.lastFinalizedJHeight ?? 0;
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
      ownerEntityId: account.proofHeader.fromEntity,
      counterpartyEntityId: account.proofHeader.toEntity,
      frameHeight: pendingFrame.height,
      byLeft: pendingFrame.byLeft,
      timestamp: pendingFrame.timestamp,
      jHeight: preparedJHeight,
      enforcementTimestamp: pendingFrame.timestamp,
      enforcementJHeight: preparedJHeight,
      accountTxs: pendingFrame.accountTxs,
      outputs: prepared.candidateEffects,
      committedStateRoot: prepared.accountStateRoot,
      account,
    });
    return;
  }
  const committed = await commitAccountFrameTransition({
    context,
    account,
    frame: pendingFrame,
    jClaimSession: committedJClaims,
    role: 'proposer/commit',
  });
  candidateEffects.push(...committed.candidateEffects);
  timedOutHashlocks.push(...committed.timedOutHashlocks);
};

const installPendingFrameCommit = (
  account: AccountReplica,
  input: AccountPeerInput,
  pendingFrame: AccountFrame,
  ack: AccountFrameAck,
  ackHanko: string,
  validatedDisputeHanko: ValidatedCounterpartyDisputeHanko | undefined,
  committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }>,
): number => {
  account.currentFrame = cloneIsolatedAccountFrame(pendingFrame);
  account.currentHeight = pendingFrame.height;
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
    committedViaNewFrame: false,
  });

  delete account.pendingFrame;
  delete account.pendingAccountInput;
  if (
    account.lastOutboundFrameAck
    && Number(account.lastOutboundFrameAck.height) < Number(pendingFrame.height)
  ) {
    delete account.lastOutboundFrameAck;
  }
  account.rollbackCount = Math.max(0, account.rollbackCount - 1);
  if (account.rollbackCount === 0) delete account.lastRollbackFrameHash;
  return pendingFrame.height;
};

const queuePostAckWork = async (
  account: AccountReplica,
  input: AccountPeerInput,
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

export const handlePendingFrameAck = async (
  context: AccountConsensusContext,
  account: AccountReplica,
  input: AccountPeerInput,
  ackHeight: number | undefined,
  validatedDisputeHanko: ValidatedCounterpartyDisputeHanko | undefined,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }>,
  committedJClaims: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
  candidateEffects: AccountOutput[],
): Promise<PendingFrameAckResult> => {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const pendingFrame = account.pendingFrame;
  if (!(pendingFrame && ackHeight === pendingFrame.height && ack)) {
    return { kind: 'not_applicable' };
  }
  if (HEAVY_LOGS) {
    ackLog.debug('input', {
      from: shortId(input.fromEntityId),
      to: shortId(input.toEntityId),
    });
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

  const tokenIds = deriveAccountFrameTokenIds(pendingFrame);
  ackLog.debug('frame.commit', {
    height: pendingFrame.height,
    txs: pendingFrame.accountTxs.map(tx => tx.type),
    tokens: tokenIds,
    state: shortHash(certificate.frameHash),
  });
  const { counterparty } = getAccountPerspective(
    account.state,
    account.proofHeader.fromEntity,
  );
  await applyPendingFrameTransactions(
    context,
    account,
    pendingFrame,
    committedJClaims,
    timedOutHashlocks,
    candidateEffects,
  );
  ackLog.debug('frame.commit.complete', {
    side: 'proposer',
    counterparty: shortId(counterparty),
    height: pendingFrame.height,
    tokens: account.state.deltas.size,
  });
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
