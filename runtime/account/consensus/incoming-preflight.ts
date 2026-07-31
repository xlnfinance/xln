/**
 * Authenticate and structurally validate an incoming Account frame before
 * replaying any transaction. This phase never mutates live Account state.
 */

import type { AccountFrame, AccountInput, AccountReplica } from '../../types/account';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { HEAVY_LOGS } from '../../infra/debug-flags';
import { getAccountFrameBoundsError } from './frame';
import { accountInputProposal } from './flush';
import { getIncomingAccountDeadlineViolation, type AccountInputSecurityContext } from './deadline-policy';
import { resolveSameHeightIncomingFrame } from './collision';
import { buildDuplicateCommittedFrameAck, describeAccountState } from './replay';
import type { HandleAccountInputResult } from './types';

const preflightLog = createStructuredLogger('account.preflight');
const STALE_ACCOUNT_FRAME_WARNING_MS = 5 * 60_000;

type AccountCommittedFrame = NonNullable<HandleAccountInputResult['committedFrames']>[number];

export type IncomingFramePreflightResult =
  | {
      kind: 'continue';
      receivedFrame: AccountFrame;
      ourEntityId: string;
      frameJHeight: number;
      rollbackPendingFrame: boolean;
    }
  | { kind: 'return'; result: HandleAccountInputResult };

const verifyIncomingFrameHanko = async (
  input: AccountInput,
  receivedFrame: AccountFrame,
  events: string[],
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult | undefined> => {
  const hankoToVerify = accountInputProposal(input)?.frameHanko;
  if (!hankoToVerify) {
    return {
      success: false,
      error: 'SECURITY: Frame must have hanko signature',
      events,
    };
  }

  preflightLog.debug('hanko.frame.verify', {
    height: receivedFrame.height,
    from: shortId(input.fromEntityId),
  });
  const { valid, entityId: recoveredEntityId } = await securityContext.verifyHanko(
    hankoToVerify,
    receivedFrame.stateHash,
    input.fromEntityId,
    securityContext.counterpartyCertifiedBoardHash
      ? { registeredBoardHash: securityContext.counterpartyCertifiedBoardHash }
      : undefined,
  );
  if (!valid || !recoveredEntityId) {
    return {
      success: false,
      error: `Invalid hanko signature from ${input.fromEntityId.slice(-4)}`,
      events,
    };
  }
  preflightLog.debug('hanko.frame.verified', {
    height: receivedFrame.height,
    from: shortId(recoveredEntityId),
  });
  return undefined;
};

const handleStaleIncomingFrame = async (
  account: AccountReplica,
  input: AccountInput,
  receivedFrame: AccountFrame,
  replayCurrentHeight: number,
  events: string[],
  committedFrames: AccountCommittedFrame[],
): Promise<HandleAccountInputResult | undefined> => {
  if (Number(receivedFrame.height) > Number(account.currentHeight ?? 0)) {
    return undefined;
  }
  const duplicateAck = await buildDuplicateCommittedFrameAck(
    account,
    input,
    events,
    replayCurrentHeight,
    receivedFrame,
  );
  if (duplicateAck) return duplicateAck;
  events.push(
    `ℹ️ Ignored stale frame ${String(receivedFrame.height)} ` + `(current=${String(account.currentHeight ?? 0)})`,
  );
  return {
    success: true,
    events,
    ...(committedFrames.length > 0 && { committedFrames }),
  };
};

const validateIncomingFrameProposer = (
  account: AccountReplica,
  input: AccountInput,
  receivedFrame: AccountFrame,
  events: string[],
): HandleAccountInputResult | undefined => {
  const proposer = input.fromEntityId.toLowerCase();
  const proposerIsLeft = proposer === account.state.leftEntity.toLowerCase();
  if (!proposerIsLeft && proposer !== account.state.rightEntity.toLowerCase()) {
    return {
      success: false,
      error: `Frame proposer is not an account party: ` + input.fromEntityId.slice(-8),
      events,
    };
  }
  if (receivedFrame.byLeft === proposerIsLeft) return undefined;
  return {
    success: false,
    error:
      `Frame proposer side mismatch: expected byLeft=${String(proposerIsLeft)} ` +
      `for proposer ${input.fromEntityId.slice(-4)}, ` +
      `got ${String(receivedFrame.byLeft)}`,
    events,
  };
};

const validateIncomingFrameChain = (
  account: AccountReplica,
  input: AccountInput,
  receivedFrame: AccountFrame,
  normalizedInputHeight: number | undefined,
  securityContext: AccountInputSecurityContext,
  events: string[],
): HandleAccountInputResult | undefined => {
  const structureError = getAccountFrameBoundsError(receivedFrame, securityContext.entityTimestamp);
  if (structureError) {
    return {
      success: false,
      error: `Invalid frame structure: ${structureError}`,
      events,
    };
  }

  const previousTimestamp = account.currentFrame?.timestamp;
  if (previousTimestamp !== undefined && receivedFrame.timestamp < previousTimestamp) {
    preflightLog.warn('frame.timestamp_regressed_accepted', {
      accountHeight: account.currentHeight,
      entityId: input.toEntityId,
      counterpartyEntityId: input.fromEntityId,
      previousTimestamp,
      proposedTimestamp: receivedFrame.timestamp,
      regressionMs: previousTimestamp - receivedFrame.timestamp,
      entityTimestamp: securityContext.entityTimestamp,
    });
  }

  const expectedPrevHash = account.currentHeight === 0 ? 'genesis' : account.currentFrame.stateHash || '';
  if (receivedFrame.prevFrameHash !== expectedPrevHash) {
    preflightLog.warn('frame.prev_hash_mismatch', {
      inputFromEntityId: input.fromEntityId,
      inputToEntityId: input.toEntityId,
      inputHeight: normalizedInputHeight ?? null,
      receivedHeight: Number(receivedFrame.height ?? 0),
      receivedStateHash: receivedFrame.stateHash ?? null,
      receivedPrevFrameHash: receivedFrame.prevFrameHash ?? null,
      receivedTxTypes: receivedFrame.accountTxs.map(tx => tx.type),
      expectedPrevFrameHash: expectedPrevHash,
      account: describeAccountState(account),
    });
    return {
      success: false,
      error:
        `Frame chain broken: prevFrameHash mismatch ` +
        `(expected ${expectedPrevHash.slice(0, 16)}..., ` +
        `got ${String(receivedFrame.prevFrameHash).slice(0, 16)}..., ` +
        `current=${account.currentHeight}, ` +
        `pending=${Number(account.pendingFrame?.height ?? 0)})`,
      events,
    };
  }

  const expectedHeight = account.currentHeight + 1;
  if (HEAVY_LOGS) {
    preflightLog.debug('frame.sequence_check', {
      receivedHeight: receivedFrame.height,
      currentHeight: account.currentHeight,
      expectedHeight,
    });
  }
  if (receivedFrame.height === expectedHeight) return undefined;
  preflightLog.warn('frame.sequence_mismatch', {
    expectedHeight,
    receivedHeight: receivedFrame.height,
  });
  return {
    success: false,
    error: `Frame sequence mismatch: expected ${expectedHeight}, ` + `got ${receivedFrame.height}`,
    events,
  };
};

const validateIncomingFrameDeadline = (
  account: AccountReplica,
  input: AccountInput,
  receivedFrame: AccountFrame,
  securityContext: AccountInputSecurityContext,
  events: string[],
): HandleAccountInputResult | undefined => {
  const staleByMs = securityContext.entityTimestamp - receivedFrame.timestamp;
  const collateralPriorityRisk = staleByMs > 0 && receivedFrame.accountTxs.some(tx => tx.type === 'request_collateral');
  if (staleByMs > STALE_ACCOUNT_FRAME_WARNING_MS || collateralPriorityRisk) {
    preflightLog.warn('frame.stale_accepted', {
      height: receivedFrame.height,
      staleByMs,
      txs: receivedFrame.accountTxs.map(tx => tx.type),
      collateralPriorityRisk,
    });
  }

  const violation = getIncomingAccountDeadlineViolation(account.state, receivedFrame, securityContext);
  if (!violation) return undefined;
  const proposal = accountInputProposal(input);
  if (!proposal?.frameHanko) {
    throw new Error('INBOUND_ACCOUNT_FRAME_HANKO_MISSING_AFTER_PREFLIGHT');
  }
  return {
    success: false,
    error: violation.reason,
    events,
    disputeRequired: {
      ...violation,
      signedFrame: {
        frame: structuredClone(receivedFrame),
        frameHanko: proposal.frameHanko,
      },
    },
  };
};

export const preflightIncomingAccountFrame = async (
  account: AccountReplica,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
  replayCurrentHeight: number,
  events: string[],
  committedFrames: AccountCommittedFrame[],
  securityContext: AccountInputSecurityContext,
): Promise<IncomingFramePreflightResult> => {
  const receivedFrame = accountInputProposal(input)?.frame;
  if (!receivedFrame) {
    throw new Error('preflightIncomingAccountFrame called without newAccountFrame');
  }

  const staleResult = await handleStaleIncomingFrame(
    account,
    input,
    receivedFrame,
    replayCurrentHeight,
    events,
    committedFrames,
  );
  if (staleResult) return { kind: 'return', result: staleResult };

  const proposerError = validateIncomingFrameProposer(account, input, receivedFrame, events);
  if (proposerError) return { kind: 'return', result: proposerError };

  const chainError = validateIncomingFrameChain(
    account,
    input,
    receivedFrame,
    normalizedInputHeight,
    securityContext,
    events,
  );
  if (chainError) return { kind: 'return', result: chainError };

  const hankoError = await verifyIncomingFrameHanko(input, receivedFrame, events, securityContext);
  if (hankoError) return { kind: 'return', result: hankoError };

  const deadlineError = validateIncomingFrameDeadline(account, input, receivedFrame, securityContext, events);
  if (deadlineError) return { kind: 'return', result: deadlineError };

  /*
   * Resolve collisions only after authenticating the peer frame. RIGHT's live
   * rollback remains deferred until deterministic clone replay also succeeds.
   */
  const sameHeightResolution = resolveSameHeightIncomingFrame(account, receivedFrame, events, committedFrames);
  if (sameHeightResolution !== true && sameHeightResolution) {
    return { kind: 'return', result: sameHeightResolution };
  }

  return {
    kind: 'continue',
    receivedFrame,
    ourEntityId: account.proofHeader.fromEntity,
    frameJHeight: receivedFrame.jHeight ?? account.state.lastFinalizedJHeight ?? 0,
    rollbackPendingFrame: sameHeightResolution === true,
  };
};
