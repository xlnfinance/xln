import type { AccountFrame, AccountInput, AccountReplica } from '../../types/account';
import { HEAVY_LOGS } from '../../infra/debug-flags';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import { isLeftEntity } from '../utils';
import { discardStagedAccountCommitmentCache } from '../commitment/map-commitment';
import { accountInputAck, accountInputProposal } from './flush';
import { prependUniqueMempoolTxs } from './helpers';
import type { HandleAccountInputResult } from './types';
import { rejectAccountPeerInput } from '../input/peer-rejection';

const collisionLog = createStructuredLogger('account.collision');

type AccountCommittedFrame = NonNullable<HandleAccountInputResult['committedFrames']>[number];

export type AccountAckTarget = {
  pendingHeight: number;
  bundledNewFrameHeight: number | undefined;
  ackHeight: number | undefined;
};

export const resolveAccountAckTarget = (
  account: AccountReplica,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
): AccountAckTarget => {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const pendingHeight = Number(account.pendingFrame?.height ?? 0);
  const bundledNewFrameHeight =
    proposal?.frame === undefined || proposal.frame === null ? undefined : Number(proposal.frame.height);
  const ackTargetsPendingFrame =
    Boolean(ack) &&
    Boolean(account.pendingFrame) &&
    (normalizedInputHeight === pendingHeight ||
      (bundledNewFrameHeight !== undefined && bundledNewFrameHeight === pendingHeight + 1));
  return {
    pendingHeight,
    bundledNewFrameHeight,
    ackHeight: ackTargetsPendingFrame ? pendingHeight : normalizedInputHeight,
  };
};

const isSameHeightSimultaneousProposalAck = (
  account: AccountReplica,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
): boolean => {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const pendingHeight = Number(account.pendingFrame?.height ?? 0);
  return (
    Boolean(ack) &&
    Boolean(proposal) &&
    pendingHeight > 0 &&
    Number(proposal?.frame.height ?? 0) === pendingHeight &&
    Number(normalizedInputHeight ?? 0) === pendingHeight - 1
  );
};

export const handleUnmatchedAck = (
  account: AccountReplica,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
  ackProcessed: boolean,
  events: string[],
  committedFrames: AccountCommittedFrame[],
  phase: 'before_frame' | 'after_frame',
): HandleAccountInputResult | undefined => {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  if (!ack || ackProcessed) return undefined;

  if (phase === 'before_frame') {
    if (!account.pendingFrame || isSameHeightSimultaneousProposalAck(account, input, normalizedInputHeight)) {
      return undefined;
    }
    const pending = account.pendingFrame.height;
    const stale =
      normalizedInputHeight !== undefined &&
      normalizedInputHeight > 0 &&
      normalizedInputHeight <= Number(account.currentHeight ?? 0);
    if (stale) {
      events.push(
        `ℹ️ Ignored stale ACK for frame ${String(normalizedInputHeight)} ` +
          `(current=${String(account.currentHeight ?? 0)}, pending=${pending})`,
      );
      return {
        success: true,
        events,
        ...(committedFrames.length > 0 && { committedFrames }),
      };
    }
    return rejectAccountPeerInput(
      'ACCOUNT_PEER_ACK_UNMATCHED',
      `Unmatched ACK with pending frame: ` +
        `inputHeight=${String(normalizedInputHeight ?? 'none')} ` +
        `pending=${pending} ` +
        `newFrame=${String(proposal?.frame.height ?? 'none')}`,
      events,
    );
  }

  if (proposal) return undefined;
  const pending = account.pendingFrame?.height ?? 'none';
  const stale =
    normalizedInputHeight !== undefined &&
    normalizedInputHeight > 0 &&
    normalizedInputHeight <= Number(account.currentHeight ?? 0);
  if (stale) {
    events.push(
      `ℹ️ Ignored stale ACK for frame ${String(normalizedInputHeight)} ` +
        `(current=${String(account.currentHeight ?? 0)}, pending=${String(pending)})`,
    );
    return {
      success: true,
      events,
      ...(committedFrames.length > 0 && { committedFrames }),
    };
  }
  const earlyNextAck =
    normalizedInputHeight !== undefined &&
    normalizedInputHeight === Number(account.currentHeight ?? 0) + 1 &&
    !account.pendingFrame;
  if (earlyNextAck) {
    // A pure ACK cannot advance without its pending frame. The durable resend
    // path will recover it after the local frame-install tick.
    events.push(
      `Ignored early ACK for frame ${String(normalizedInputHeight)} ` +
        `(current=${String(account.currentHeight ?? 0)}, pending=none)`,
    );
    return {
      success: true,
      events,
      ...(committedFrames.length > 0 && { committedFrames }),
    };
  }
  return rejectAccountPeerInput(
    'ACCOUNT_PEER_ACK_UNMATCHED',
    `Unmatched ACK: height=${String(normalizedInputHeight ?? 'none')} ` + `pending=${String(pending)}`,
    events,
  );
};

export const resolveSameHeightIncomingFrame = (
  account: AccountReplica,
  receivedFrame: AccountFrame,
  events: string[],
  committedFrames: AccountCommittedFrame[],
): HandleAccountInputResult | true | undefined => {
  if (!account.pendingFrame || receivedFrame.height !== account.pendingFrame.height) {
    return undefined;
  }

  /*
   * Each side may propose once at a height. If both race, valid LEFT wins.
   *
   * This is an off-chain Account-frame rule: Depository never compares frame
   * heights. On-chain it binds the same canonical left/right account identity,
   * requires the counterparty Hanko, and accepts only a strictly newer nonce.
   * A unilateral same-height proposal therefore cannot become enforceable;
   * only the collision winner can acquire both parties' authorization.
   *
   * Selected-proposer or alternating designs would add view state without
   * improving this invariant. Wall time, retries, HTLC expiry and settlement
   * evidence never participate in collision resolution.
   */
  const localIsLeft = isLeftEntity(account.proofHeader.fromEntity, account.proofHeader.toEntity);
  if (HEAVY_LOGS) {
    collisionLog.debug('frame.tiebreaker', {
      from: shortId(account.proofHeader.fromEntity),
      to: shortId(account.proofHeader.toEntity),
      isLeft: localIsLeft,
    });
  }
  if (localIsLeft) {
    events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${receivedFrame.height} ` + `(waiting for their ACK)`);
    if (account.mempool.length > 0) {
      events.push(`⚠️ LEFT has ${account.mempool.length} pending txs while waiting for RIGHT's ACK`);
    }
    const response = account.pendingAccountInput;
    const proposal = response ? accountInputProposal(response) : undefined;
    if (!response || !proposal || proposal.frame.stateHash !== account.pendingFrame.stateHash) {
      throw new Error(`ACCOUNT_COLLISION_PENDING_RESPONSE_MISSING:${receivedFrame.height}`);
    }
    // Resend exact signed bytes. Rebuilding could change nonce, body or Hanko.
    return {
      success: true,
      response: structuredClone(response),
      events,
      ...(committedFrames.length > 0 && { committedFrames }),
    };
  }
  if (account.lastRollbackFrameHash === receivedFrame.stateHash) {
    collisionLog.debug('rollback.duplicate', {
      frame: shortHash(receivedFrame.stateHash),
    });
    return undefined;
  }
  return true;
};

export const applySameHeightIncomingFrameRollback = (
  account: AccountReplica,
  receivedFrame: AccountFrame,
  events: string[],
): void => {
  /*
   * Only RIGHT reaches rollback. Its signed proposal never became bilateral,
   * so it lacks the counterparty Hanko required for on-chain enforcement.
   * Restore its intentions once so they can be proposed above the accepted
   * LEFT frame.
   *
   * Never invoke this because time elapsed: a sent Hanko does not expire.
   */
  let restoredCount = 0;
  if (account.pendingFrame) {
    const pendingTxs = account.pendingFrame.accountTxs;
    restoredCount = prependUniqueMempoolTxs(account, pendingTxs);
    events.push(
      `🔄 ROLLBACK: Discarded our frame ${account.pendingFrame.height}, ` +
        `restored ${restoredCount}/${pendingTxs.length} txs to mempool`,
    );
  }
  delete account.pendingFrame;
  delete account.pendingAccountInput;
  discardStagedAccountCommitmentCache(account.state);
  account.rollbackCount = Math.max(1, account.rollbackCount + 1);
  account.lastRollbackFrameHash = receivedFrame.stateHash;
  if (account.rollbackCount > 1) {
    collisionLog.warn('rollback.retry', {
      count: account.rollbackCount,
      frame: shortHash(receivedFrame.stateHash),
    });
  }
  events.push(`📥 Accepted LEFT's frame ${receivedFrame.height} ` + `(we are RIGHT, deterministic tiebreaker)`);
};
