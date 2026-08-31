/**
 * Authenticate and structurally validate an incoming Account frame before
 * replaying any transaction. This phase never mutates live Account state.
 */

import type { AccountFrame, AccountInput, AccountReplica } from '../../../types/account';
import { createStructuredLogger, shortId } from '../../../support/logger';
import { HEAVY_LOGS } from '../../../support/debug-flags';
import { getAccountFrameStructuralError } from '../frame/hash';
import {
  accountTxAdmissionError,
  accountTxAdmissionInputCode,
} from '../../tx/admission-policy';
import { accountInputProposal } from '../flush';
import { getIncomingAccountDeadlineViolation, type AccountInputSecurityContext } from '../dispute/deadline-policy';
import { resolveSameHeightIncomingFrame } from './collision';
import { buildDuplicateCommittedAckFrame, describeAccountState } from './replay';
import type { AccountCommittedFrame, HandleAccountInputResult } from '../types';
import { accountInputApplied, accountInputDisputeRequired, rejectAccountInput } from '../result';
import { timePerfPhase } from '../../../support/performance/profile';

const preflightLog = createStructuredLogger('account.preflight');
const STALE_ACCOUNT_FRAME_WARNING_MS = 5 * 60_000;

export type IncomingFramePreflightResult =
  | {
      kind: 'continue';
      receivedFrame: AccountFrame;
      proposerIsLeft: boolean;
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
  const proposal = accountInputProposal(input);
  const hankoToVerify = proposal?.frameHanko;
  if (!hankoToVerify) {
    return rejectAccountInput(
      'ACCOUNT_INPUT_FRAME_HANKO_INVALID',
      'SECURITY: Frame must have hanko signature',
      events,
    );
  }

  preflightLog.debug('hanko.frame.verify', {
    height: receivedFrame.height,
    from: shortId(input.fromEntityId),
  });
  const { valid, entityId: recoveredEntityId } = await timePerfPhase(
    'account.verify.frameHanko',
    () => securityContext.verifyHanko(
      hankoToVerify,
      receivedFrame.stateHash,
      input.fromEntityId,
      securityContext.counterpartyCertifiedBoard
        ? {
            registeredBoardHash: securityContext.counterpartyCertifiedBoard.boardHash,
            allowPreviousBoard: false,
          }
        : { allowPreviousBoard: false },
    ),
  );
  if (!valid || !recoveredEntityId) {
    return rejectAccountInput(
      'ACCOUNT_INPUT_FRAME_HANKO_INVALID',
      `Invalid hanko signature from ${input.fromEntityId.slice(-4)}`,
      events,
    );
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
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult | undefined> => {
  if (Number(receivedFrame.height) >= Number(account.currentHeight ?? 0)) {
    return undefined;
  }
  const duplicateAck = await buildDuplicateCommittedAckFrame(
    account,
    input,
    events,
    replayCurrentHeight,
    receivedFrame,
    securityContext,
  );
  if (duplicateAck) return duplicateAck;
  preflightLog.warn('frame.stale_ignored', {
    receivedHeight: receivedFrame.height,
    currentHeight: account.currentHeight ?? 0,
    receivedHash: receivedFrame.stateHash,
    currentHash: account.currentFrame.stateHash,
    from: shortId(input.fromEntityId),
  });
  events.push(
    `ℹ️ Ignored stale frame ${String(receivedFrame.height)} ` + `(current=${String(account.currentHeight ?? 0)})`,
  );
  return accountInputApplied({
    events,
    ...(committedFrames.length > 0 && { committedFrames }),
  });
};

const validateIncomingFrameProposer = (
  account: AccountReplica,
  input: AccountInput,
  events: string[],
): { proposerIsLeft: boolean } | HandleAccountInputResult => {
  const proposer = input.fromEntityId.toLowerCase();
  const proposerIsLeft = proposer === account.state.leftEntity.toLowerCase();
  if (!proposerIsLeft && proposer !== account.state.rightEntity.toLowerCase()) {
    return rejectAccountInput(
      'ACCOUNT_INPUT_FRAME_PROPOSER_INVALID',
      `Frame proposer is not an account party: ` + input.fromEntityId.slice(-8),
      events,
    );
  }
  return { proposerIsLeft };
};

const validateIncomingFrameChain = (
  account: AccountReplica,
  input: AccountInput,
  receivedFrame: AccountFrame,
  normalizedInputHeight: number | undefined,
  securityContext: AccountInputSecurityContext,
  events: string[],
): HandleAccountInputResult | undefined => {
  const structureError = getAccountFrameStructuralError(receivedFrame, securityContext.entityTimestamp);
  if (structureError) {
    return rejectAccountInput(
      'ACCOUNT_INPUT_FRAME_STRUCTURE_INVALID',
      `Invalid frame structure: ${structureError}`,
      events,
    );
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

  const expectedPrevHash = account.currentHeight === 0 ? 'genesis' : account.currentFrame.stateHash;
  if (receivedFrame.prevFrameHash !== expectedPrevHash) {
    preflightLog.warn('frame.prev_hash_mismatch', {
      inputFromEntityId: input.fromEntityId,
      inputToEntityId: input.toEntityId,
      inputHeight: normalizedInputHeight ?? null,
      receivedHeight: Number(receivedFrame.height ?? 0),
      receivedFrameHash: receivedFrame.stateHash,
      receivedPrevFrameHash: receivedFrame.prevFrameHash ?? null,
      receivedTxTypes: receivedFrame.accountTxs.map(tx => tx.type),
      expectedPrevFrameHash: expectedPrevHash,
      account: describeAccountState(account),
    });
    return rejectAccountInput(
      'ACCOUNT_INPUT_FRAME_CHAIN_INVALID',
      `Frame chain broken: prevFrameHash mismatch ` +
        `(expected ${expectedPrevHash.slice(0, 16)}..., ` +
        `got ${String(receivedFrame.prevFrameHash).slice(0, 16)}..., ` +
        `current=${account.currentHeight}, ` +
        `pending=${Number(account.pendingFrame?.height ?? 0)})`,
      events,
    );
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
  return rejectAccountInput(
    'ACCOUNT_INPUT_FRAME_CHAIN_INVALID',
    `Frame sequence mismatch: expected ${expectedHeight}, ` + `got ${receivedFrame.height}`,
    events,
  );
};

const validateIncomingFrameTxAdmission = (
  receivedFrame: AccountFrame,
  events: string[],
): HandleAccountInputResult | undefined => {
  // FX-1/FX-2 incoming direction: an out-of-profile kind or an out-of-range
  // policyVersion can never become a valid frame regardless of who signed it,
  // so it is rejected as deterministic Account input evidence before any signature
  // work, replay, or state mutation. The message names the offending kind or
  // version; Rust reaches the same verdict when `AccountFrame::hash` refuses
  // the transaction its canonical form cannot express.
  for (const tx of receivedFrame.accountTxs) {
    const error = accountTxAdmissionError(tx);
    if (error) {
      return rejectAccountInput(accountTxAdmissionInputCode(error), error.message, events);
    }
  }
  return undefined;
};

const validateIncomingFrameDeadline = (
  account: AccountReplica,
  input: AccountInput,
  receivedFrame: AccountFrame,
  proposerIsLeft: boolean,
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

  const violation = getIncomingAccountDeadlineViolation(
    account.state,
    receivedFrame,
    proposerIsLeft,
    securityContext,
  );
  if (!violation) return undefined;
  if (violation.disposition === 'reject') {
    return rejectAccountInput(
      'ACCOUNT_INPUT_FRAME_DEADLINE_INVALID',
      violation.reason,
      events,
    );
  }
  const proposal = accountInputProposal(input);
  if (!proposal?.frameHanko) {
    throw new Error('INBOUND_ACCOUNT_FRAME_HANKO_MISSING_AFTER_PREFLIGHT');
  }
  return accountInputDisputeRequired(
    {
      reason: violation.reason,
      evidenceSecrets: violation.evidenceSecrets,
      signedFrame: {
        frame: structuredClone(receivedFrame),
        frameHanko: proposal.frameHanko,
      },
    },
    events,
  );
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
  const proposal = accountInputProposal(input);
  const receivedFrame = proposal?.frame;
  if (!proposal || !receivedFrame) {
    throw new Error('preflightIncomingAccountFrame called without newAccountFrame');
  }

  const staleResult = await handleStaleIncomingFrame(
    account,
    input,
    receivedFrame,
    replayCurrentHeight,
    events,
    committedFrames,
    securityContext,
  );
  if (staleResult) return { kind: 'return', result: staleResult };

  const proposer = validateIncomingFrameProposer(account, input, events);
  if (!('proposerIsLeft' in proposer)) return { kind: 'return', result: proposer };

  const chainError = validateIncomingFrameChain(
    account,
    input,
    receivedFrame,
    normalizedInputHeight,
    securityContext,
    events,
  );
  if (chainError) return { kind: 'return', result: chainError };

  const txAdmissionError = validateIncomingFrameTxAdmission(receivedFrame, events);
  if (txAdmissionError) return { kind: 'return', result: txAdmissionError };

  const hankoError = await verifyIncomingFrameHanko(input, receivedFrame, events, securityContext);
  if (hankoError) return { kind: 'return', result: hankoError };

  const deadlineError = validateIncomingFrameDeadline(
    account,
    input,
    receivedFrame,
    proposer.proposerIsLeft,
    securityContext,
    events,
  );
  if (deadlineError) return { kind: 'return', result: deadlineError };

  /*
   * Resolve collisions only after authenticating the peer frame. RIGHT's live
   * rollback remains deferred until deterministic clone replay also succeeds.
   */
  const sameHeightResolution = resolveSameHeightIncomingFrame(
    account,
    receivedFrame,
    receivedFrame.stateHash,
    events,
    committedFrames,
  );
  if (sameHeightResolution !== true && sameHeightResolution) {
    return { kind: 'return', result: sameHeightResolution };
  }

  return {
    kind: 'continue',
    receivedFrame,
    proposerIsLeft: proposer.proposerIsLeft,
    ourEntityId: account.proofHeader.fromEntity,
    frameJHeight: receivedFrame.jHeight ?? account.state.lastFinalizedJHeight ?? 0,
    rollbackPendingFrame: sameHeightResolution === true,
  };
};
