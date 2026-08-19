import type { AccountFrame, AccountInput, AccountOutput, AccountReplica } from '../../../types/account';
import type { AccountConsensusContext } from '../context';
import { HEAVY_LOGS } from '../../../support/debug-flags';
import { createStructuredLogger, shortHash, shortId } from '../../../support/logger';
import { cloneAccountFrame } from '../../state/state-clone';
import { getAccountPerspective } from '../../state/perspective';
import { deriveAccountFrameTokenIds } from '../../state/frame';
import { appendAccountMempoolTxs } from '../../input/mempool';
import type { AccountJClaimSession } from '../../j-claims/j-claim-session';
import type { AccountInputSecurityContext } from '../dispute/deadline-policy';
import { accountInputAck, accountInputProposal } from '../flush';
import { runPostFrameAutoRebalanceCheck } from '../helpers';
import { assertLiveCommitMatchesFrame } from './commit-root';
import {
  getDisputeSealRequirementError,
  storeCounterpartyDisputeSeal,
  type ValidatedCounterpartyDisputeSeal,
} from '../dispute/seal';
import type { HandleAccountInputResult } from '../types';
import { accountInputApplied, rejectAccountPeerInput } from '../result';
import { commitAccountFrameTransition } from '../frame/commit-transition';

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
  validatedSeal: ValidatedCounterpartyDisputeSeal | undefined,
  events: string[],
  securityContext: AccountInputSecurityContext,
): Promise<PendingAckCertificateResult> => {
  const sealError = getDisputeSealRequirementError(
    account.currentDisputeProofBodyHash,
    account.counterpartyDisputeProofBodyHash,
    account.counterpartyDisputeProofNonce,
    Number(account.state.jNonce ?? 0),
    validatedSeal,
  );
  if (sealError) {
    return {
      kind: 'return',
      result: rejectAccountPeerInput('ACCOUNT_PEER_ACK_CERTIFICATE_INVALID', sealError, events),
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

  const expectedEntity = account.proofHeader.toEntity;
  ackLog.debug('hanko.verify', { height: ackHeight, frame: shortHash(frameHash) });
  const verified = await securityContext.verifyHanko(
    ack.frameHanko,
    frameHash,
    expectedEntity,
    securityContext.counterpartyCertifiedBoard
      ? {
          registeredBoardHash: securityContext.counterpartyCertifiedBoard.boardHash,
          allowPreviousBoard: false,
        }
      : { allowPreviousBoard: false },
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
  return { kind: 'continue', ack, ackHanko: ack.frameHanko, frameHash };
};

const applyPendingFrameTransactions = async (
  context: AccountConsensusContext,
  account: AccountReplica,
  pendingFrame: AccountFrame,
  committedJClaims: AccountJClaimSession,
  timedOutHashlocks: string[],
  candidateEffects: AccountOutput[],
): Promise<void> => {
  const committed = await commitAccountFrameTransition({
    context,
    account,
    frame: pendingFrame,
    jClaimSession: committedJClaims,
    role: 'proposer/commit',
  });
  candidateEffects.push(...committed.candidateEffects);
  timedOutHashlocks.push(...committed.timedOutHashlocks);
  assertLiveCommitMatchesFrame(
    account,
    pendingFrame.accountStateRoot,
    'proposer',
    pendingFrame.height,
  );
};

const installPendingFrameCommit = (
  account: AccountReplica,
  input: AccountInput,
  pendingFrame: AccountFrame,
  ack: AccountFrameAck,
  ackHanko: string,
  validatedSeal: ValidatedCounterpartyDisputeSeal | undefined,
  committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }>,
): number => {
  account.currentFrame = cloneAccountFrame(pendingFrame);
  account.currentHeight = pendingFrame.height;
  // The ACK is the second half of this bilateral certificate. It must survive
  // so a later board rotation can prove that both parties committed the frame.
  account.counterpartyFrameHanko = ackHanko;
  if (ack.disputeSeal) {
    storeCounterpartyDisputeSeal(account, validatedSeal);
    ackLog.debug('hanko.dispute_stored', {
      nonce: ack.disputeSeal.proofNonce,
      from: shortId(input.fromEntityId),
    });
  }
  committedFrames.push({
    frame: cloneAccountFrame(pendingFrame),
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
  input: AccountInput,
  committedHeight: number,
  securityContext: AccountInputSecurityContext,
  candidateEffects: AccountOutput[],
  events: string[],
): Promise<void> => {
  // Rebalance sees committed state only after pendingFrame has been cleared.
  const txs = await runPostFrameAutoRebalanceCheck(
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
  input: AccountInput,
  ackHeight: number | undefined,
  validatedSeal: ValidatedCounterpartyDisputeSeal | undefined,
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
    validatedSeal,
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
    validatedSeal,
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
