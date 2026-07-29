import type {
  AccountFrame,
  AccountInput,
  AccountReplica,
  EntityCandidateEffect,
  RuntimeState,
} from '../../types';
import { HEAVY_LOGS } from '../../infra/debug-flags';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import { verifyHankoForHash } from '../../hanko/signing';
import { cloneAccountFrame } from '../state-clone';
import { getAccountPerspective } from '../perspective';
import { applyAccountTx } from '../tx/apply';
import { deriveAccountFrameTokenIds } from '../frame';
import { appendAccountMempoolTxs } from '../mempool';
import {
  commitStagedAccountCommitmentCache,
  discardStagedAccountCommitmentCache,
} from '../map-commitment';
import type { AccountJClaimSession } from '../j-claim-session';
import type { AccountInputSecurityContext } from './deadline-policy';
import { accountInputAck, accountInputProposal } from './flush';
import {
  assertNoUnilateralSettlementMutation,
  captureSettlementVector,
  runPostFrameAutoRebalanceCheck,
} from './helpers';
import { assertLiveCommitMatchesFrame } from './commit-root';
import {
  getDisputeSealRequirementError,
  storeCounterpartyDisputeSeal,
  type ValidatedCounterpartyDisputeSeal,
} from './dispute-seal';
import type { HandleAccountInputResult } from './types';

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
  env: RuntimeState,
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
    Number(account.jNonce ?? 0),
    validatedSeal,
  );
  if (sealError) {
    return { kind: 'return', result: { success: false, error: sealError, events } };
  }

  const pendingFrame = account.pendingFrame!;
  const frameHash = pendingFrame.stateHash;
  if (
    typeof ack.frameHash !== 'string'
    || ack.frameHash.toLowerCase() !== frameHash.toLowerCase()
  ) {
    return {
      kind: 'return',
      result: {
        success: false,
        error: `ACK frameHash mismatch: got ${String(ack.frameHash)}, expected ${frameHash}`,
        events,
      },
    };
  }
  if (!ack.frameHanko) {
    return {
      kind: 'return',
      result: { success: false, error: 'Missing ACK hanko', events },
    };
  }

  const expectedEntity = account.proofHeader.toEntity;
  ackLog.debug('hanko.verify', { height: ackHeight, frame: shortHash(frameHash) });
  const verified = await verifyHankoForHash(
    ack.frameHanko,
    frameHash,
    expectedEntity,
    env,
    securityContext.counterpartyCertifiedBoardHash
      ? { registeredBoardHash: securityContext.counterpartyCertifiedBoardHash }
      : undefined,
  );
  if (!verified.valid) {
    return {
      kind: 'return',
      result: { success: false, error: 'Invalid ACK hanko signature', events },
    };
  }
  if (
    !verified.entityId
    || verified.entityId.toLowerCase() !== expectedEntity.toLowerCase()
  ) {
    return {
      kind: 'return',
      result: {
        success: false,
        error:
          `ACK hanko entityId mismatch: got ${verified.entityId?.slice(-4)}, ` +
          `expected ${expectedEntity.slice(-4)}`,
        events,
      },
    };
  }
  ackLog.debug('hanko.verified', {
    from: shortId(verified.entityId),
    height: ackHeight,
  });
  return { kind: 'continue', ack, ackHanko: ack.frameHanko, frameHash };
};

const applyPendingFrameTransactions = async (
  env: RuntimeState,
  account: AccountReplica,
  pendingFrame: AccountFrame,
  committedJClaims: AccountJClaimSession,
  timedOutHashlocks: string[],
  candidateEffects: EntityCandidateEffect[],
): Promise<void> => {
  const jHeight = pendingFrame.jHeight ?? account.lastFinalizedJHeight ?? 0;
  for (const tx of pendingFrame.accountTxs) {
    const beforeSettlement = captureSettlementVector(account);
    const result = await applyAccountTx(
      account,
      tx,
      pendingFrame.byLeft!,
      pendingFrame.timestamp,
      jHeight,
      false,
      env,
      committedJClaims,
    );
    candidateEffects.push(...(result.candidateEffects ?? []));
    if (!result.success) {
      ackLog.error('frame.commit.failed', {
        side: 'proposer',
        type: tx.type,
        error: result.error,
      });
      throw new Error(
        `Frame ${pendingFrame.height} commit failed: ${tx.type} - ${result.error}`,
      );
    }
    assertNoUnilateralSettlementMutation(
      account,
      beforeSettlement,
      tx,
      'proposer/commit',
    );
    if (result.timedOutHashlock) timedOutHashlocks.push(result.timedOutHashlock);
  }
  commitStagedAccountCommitmentCache(account);
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
  account.currentFrame = structuredClone(pendingFrame);
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
  discardStagedAccountCommitmentCache(account);
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
  env: RuntimeState,
  account: AccountReplica,
  input: AccountInput,
  committedHeight: number,
  securityContext: AccountInputSecurityContext,
  candidateEffects: EntityCandidateEffect[],
  events: string[],
): Promise<void> => {
  // Rebalance sees committed state only after pendingFrame has been cleared.
  const txs = await runPostFrameAutoRebalanceCheck(
    env,
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
  env: RuntimeState,
  account: AccountReplica,
  input: AccountInput,
  ackHeight: number | undefined,
  validatedSeal: ValidatedCounterpartyDisputeSeal | undefined,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }>,
  committedJClaims: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
  candidateEffects: EntityCandidateEffect[],
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
    env,
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
    account,
    account.proofHeader.fromEntity,
  );
  await applyPendingFrameTransactions(
    env,
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
    tokens: account.deltas.size,
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
    env,
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
      result: {
        success: true,
        events,
        timedOutHashlocks,
        ...(committedFrames.length > 0 && { committedFrames }),
      },
    };
  }
  return { kind: 'fallthrough' };
};
