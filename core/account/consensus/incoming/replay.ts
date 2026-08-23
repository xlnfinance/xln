import type { AccountDisputeHanko, AccountFrame, AccountPeerInput, AccountReplica } from '../../../types/account';
import { createStructuredLogger, shortId } from '../../../support/logger';
import {
  copyAccountDisputeConfig,
  copyAccountStateDomain,
} from '../../../protocol/state/account-input-clone';
import {
  accountInputAck,
  accountInputDisputeHanko,
  accountInputProposal,
  accountInputReferenceHeight,
} from '../flush';
import { hasLocalCertifiedDisputeProof } from '../dispute/proof-views';
import type { AccountConsensusHashToSign, HandleAccountInputResult } from '../types';
import { accountInputApplied, accountInputValidationRejected } from '../result';

const replayLog = createStructuredLogger('account.replay');

export type AccountInputHeightNormalization =
  | { ok: true; normalizedInputHeight: number | undefined }
  | { ok: false; message: string };

export const normalizeAccountInputHeight = (
  input: AccountPeerInput,
): AccountInputHeightNormalization => {
  const referenceHeight = accountInputReferenceHeight(input);
  const normalizedInputHeight = referenceHeight === undefined || referenceHeight === null
    ? undefined
    : Number(referenceHeight);
  if (
    normalizedInputHeight !== undefined
    && !Number.isFinite(normalizedInputHeight)
  ) {
    return { ok: false, message: `Invalid account input height: ${String(referenceHeight)}` };
  }
  return { ok: true, normalizedInputHeight };
};

export const getDisputeHankoShapeError = (
  input: AccountPeerInput,
): string | undefined => {
  const disputeHankos = [
    accountInputAck(input)?.disputeHanko,
    accountInputProposal(input)?.disputeHanko,
    accountInputDisputeHanko(input),
  ];
  for (const disputeHanko of disputeHankos) {
    if (!disputeHanko) continue;
    if (typeof disputeHanko.hanko !== 'string') return 'Invalid dispute hanko type';
    const hankoHex = disputeHanko.hanko.toLowerCase();
    const normalized = hankoHex.startsWith('0x') ? hankoHex.slice(2) : hankoHex;
    if (normalized.length === 0) return 'Invalid dispute hanko (empty)';
    if (normalized.length % 2 !== 0) return 'Invalid dispute hanko (odd length)';
  }
  return undefined;
};

export const describeAccountState = (
  account: AccountReplica,
): Record<string, unknown> => ({
  currentHeight: Number(account.currentHeight ?? 0),
  currentHash: account.currentFrame?.stateHash ?? null,
  currentPrev: account.currentFrame?.prevFrameHash ?? null,
  currentTimestamp: Number(account.currentFrame?.timestamp ?? 0),
  pendingHeight: Number(account.pendingFrame?.height ?? 0),
  pendingHash: account.pendingFrame?.stateHash ?? null,
  pendingPrev: account.pendingFrame?.prevFrameHash ?? null,
  pendingTimestamp: Number(account.pendingFrame?.timestamp ?? 0),
});

export type AccountInputReplayClassification = {
  currentHeight: number;
  pendingHeight: number;
  inputHeight: number;
  newFrameHeight: number | undefined;
  ackIsStale: boolean;
  frameIsStale: boolean;
};

export const classifyAccountInputReplay = (
  account: AccountReplica,
  input: AccountPeerInput,
): AccountInputReplayClassification => {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const currentHeight = Number(account.currentHeight ?? 0);
  const pendingHeight = Number(account.pendingFrame?.height ?? 0);
  const inputHeight = ack?.height === undefined || ack.height === null
    ? 0
    : Number(ack.height);
  const newFrameHeight = proposal?.frame === undefined || proposal.frame === null
    ? undefined
    : Number(proposal.frame.height);
  const ackIsStale = Boolean(ack?.frameHanko)
    && inputHeight > 0
    && (
      (pendingHeight > 0 && inputHeight < pendingHeight)
      || (pendingHeight === 0 && inputHeight <= currentHeight)
    );
  return {
    currentHeight,
    pendingHeight,
    inputHeight,
    newFrameHeight,
    ackIsStale,
    // Equal height is a duplicate of the committed frame, not a stale ancestor.
    // Hash mismatch at this height must reach preflight/collision, not silent ignore.
    frameIsStale: newFrameHeight !== undefined && newFrameHeight < currentHeight,
  };
};

const sameAccountStateHash = (left: string | undefined, right: string | undefined): boolean =>
  typeof left === 'string'
  && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();

const duplicateAckHashesToSign = (
  input: AccountPeerInput,
  receivedFrame: AccountFrame,
  response: AccountPeerInput,
): AccountConsensusHashToSign[] | undefined => {
  if (accountInputAck(response)?.frameHanko) return undefined;
  return [{
    hash: receivedFrame.stateHash,
    type: 'accountFrame',
    context: `account:${input.fromEntityId.slice(-8)}:ack:${receivedFrame.height}`,
  }];
};

const applyDuplicateAck = (
  input: AccountPeerInput,
  receivedFrame: AccountFrame,
  response: AccountPeerInput,
  events: string[],
): HandleAccountInputResult => {
  const hashesToSign = duplicateAckHashesToSign(input, receivedFrame, response);
  return accountInputApplied({
    response: structuredClone(response),
    events,
    ...(hashesToSign ? { hashesToSign } : {}),
  });
};

const cacheAckOnlyResponse = (
  account: AccountReplica,
  pendingResponse: AccountPeerInput,
  input: AccountPeerInput,
  receivedHeight: number,
): Extract<AccountPeerInput, { kind: 'ack' }> => {
  const pendingAck = accountInputAck(pendingResponse);
  if (!pendingAck) {
    throw new Error(`DUPLICATE_ACK_PENDING_RESPONSE_MISSING_ACK:${receivedHeight}`);
  }
  const response: Extract<AccountPeerInput, { kind: 'ack' }> = {
    kind: 'ack',
    fromEntityId: pendingResponse.fromEntityId,
    toEntityId: pendingResponse.toEntityId,
    domain: copyAccountStateDomain(pendingResponse.domain),
    disputeConfig: copyAccountDisputeConfig(pendingResponse.disputeConfig),
    ...(pendingResponse.watchSeed !== undefined ? { watchSeed: pendingResponse.watchSeed } : {}),
    ack: structuredClone(pendingAck),
  };
  account.lastOutboundFrameAck = {
    height: receivedHeight,
    counterpartyEntityId: input.fromEntityId,
    response: structuredClone(response),
  };
  return response;
};

const reusableCertifiedAckHanko = (account: AccountReplica): AccountDisputeHanko | undefined => {
  if (!hasLocalCertifiedDisputeProof(account)) return undefined;
  if (Number(account.currentDisputeProofNonce) <= Number(account.state.jNonce ?? 0)) return undefined;
  return {
    hanko: account.currentDisputeProofHanko,
    hash: account.currentDisputeHash,
    proofBodyHash: account.currentDisputeProofBodyHash,
    proofNonce: account.currentDisputeProofNonce,
    proposerIsLeft: account.currentDisputeProofProposerIsLeft,
  };
};

const rebuildDuplicateCommittedFrameAck = (
  account: AccountReplica,
  input: AccountPeerInput,
  receivedFrame: AccountFrame,
  receivedHeight: number,
  events: string[],
): HandleAccountInputResult => {
  const disputeHanko = reusableCertifiedAckHanko(account);
  const response: Extract<AccountPeerInput, { kind: 'ack' }> = {
    kind: 'ack',
    fromEntityId: account.proofHeader.fromEntity,
    toEntityId: input.fromEntityId,
    domain: copyAccountStateDomain(account.state.domain),
    disputeConfig: copyAccountDisputeConfig(account.state.disputeConfig),
    ...(account.state.watchSeed !== undefined ? { watchSeed: account.state.watchSeed } : {}),
    ack: {
      height: receivedHeight,
      frameHash: account.currentFrame.stateHash,
      ...(disputeHanko ? { disputeHanko } : {}),
    },
  };
  account.lastOutboundFrameAck = {
    height: receivedHeight,
    counterpartyEntityId: input.fromEntityId,
    response: structuredClone(response),
  };
  events.push(`↩️ Rebuilt ACK for duplicate committed frame ${receivedHeight}`);
  replayLog.warn('input.duplicate_ack_rebuilt', {
    height: receivedHeight,
    from: shortId(input.fromEntityId),
    currentHeight: account.currentHeight,
  });
  return applyDuplicateAck(input, receivedFrame, response, events);
};

export const buildDuplicateCommittedFrameAck = (
  account: AccountReplica,
  input: AccountPeerInput,
  events: string[],
  replayCurrentHeight: number,
  receivedFrame: AccountFrame,
): HandleAccountInputResult | null => {
  const receivedHeight = Number(receivedFrame.height ?? 0);
  if (receivedHeight !== replayCurrentHeight) return null;
  if (!sameAccountStateHash(receivedFrame.stateHash, account.currentFrame?.stateHash)) {
    replayLog.warn('input.duplicate_height_hash_mismatch', {
      height: receivedHeight,
      receivedHash: receivedFrame.stateHash ?? null,
      currentHash: account.currentFrame?.stateHash ?? null,
      from: shortId(input.fromEntityId),
    });
    return null;
  }
  const pendingResponse = account.pendingAccountInput;
  const pendingAck = pendingResponse
    ? accountInputAck(pendingResponse)
    : undefined;
  if (
    pendingResponse
    && pendingAck
    && Number(pendingAck.height) === receivedHeight
    && pendingResponse.toEntityId.toLowerCase() === input.fromEntityId.toLowerCase()
  ) {
    const response = cacheAckOnlyResponse(
      account,
      pendingResponse,
      input,
      receivedHeight,
    );
    events.push(`↩️ Re-sent ACK for duplicate committed frame ${receivedHeight}`);
    replayLog.debug('input.duplicate_ack_cached_pending', {
      height: receivedHeight,
      from: shortId(input.fromEntityId),
      currentHeight: account.currentHeight,
    });
    return applyDuplicateAck(input, receivedFrame, response, events);
  }
  const cachedAck = account.lastOutboundFrameAck;
  if (
    cachedAck
    && Number(cachedAck.height) === receivedHeight
    && cachedAck.counterpartyEntityId.toLowerCase() === input.fromEntityId.toLowerCase()
  ) {
    events.push(`↩️ Re-sent ACK for duplicate committed frame ${receivedHeight}`);
    replayLog.debug('input.duplicate_ack_cached', {
      height: receivedHeight,
      from: shortId(input.fromEntityId),
      currentHeight: account.currentHeight,
      hasHanko: Boolean(accountInputAck(cachedAck.response)?.frameHanko),
    });
    return applyDuplicateAck(input, receivedFrame, cachedAck.response, events);
  }
  if (!account.currentFrame?.stateHash || !account.proofHeader.fromEntity) {
    return accountInputValidationRejected(
      `DUPLICATE_ACK_CACHE_MISSING: height=${receivedHeight}`,
      events,
    );
  }
  return rebuildDuplicateCommittedFrameAck(account, input, receivedFrame, receivedHeight, events);
};

export const handleReplayOrObsoleteAccountInput = (
  account: AccountReplica,
  input: AccountPeerInput,
  replay: AccountInputReplayClassification,
  events: string[],
): HandleAccountInputResult | undefined => {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  if (proposal) {
    // At-least-once delivery may retry an exact committed frame after ACK loss.
    const duplicateAck = buildDuplicateCommittedFrameAck(
      account,
      input,
      events,
      replay.currentHeight,
      proposal.frame,
    );
    if (duplicateAck) return duplicateAck;
  }
  if (
    replay.ackIsStale
    && (replay.newFrameHeight === undefined || replay.frameIsStale)
  ) {
    replayLog.debug('input.stale_ack_ignored', {
      currentHeight: replay.currentHeight,
      pendingHeight: replay.pendingHeight,
      inputHeight: replay.inputHeight,
      newFrameHeight: replay.newFrameHeight ?? null,
      from: shortId(input.fromEntityId),
    });
    return accountInputApplied({ events });
  }
  if (!ack && replay.frameIsStale) {
    replayLog.warn('input.stale_frame_ignored', {
      currentHeight: replay.currentHeight,
      inputHeight: replay.inputHeight,
      newFrameHeight: replay.newFrameHeight ?? null,
      currentHash: account.currentFrame?.stateHash ?? null,
      receivedHash: proposal?.frame.stateHash ?? null,
      from: shortId(input.fromEntityId),
    });
    return accountInputApplied({ events });
  }
  if (
    ack
    && !proposal
    && !account.pendingFrame
    && (account.status ?? 'active') !== 'active'
  ) {
    events.push(
      `ℹ️ Ignored obsolete ACK for frozen account frame ${String(replay.inputHeight ?? 'none')} ` +
        `(current=${String(account.currentHeight ?? 0)}, status=${String(account.status)})`,
    );
    replayLog.debug('input.frozen_ack_ignored', {
      currentHeight: replay.currentHeight,
      inputHeight: replay.inputHeight,
      status: account.status,
      from: shortId(input.fromEntityId),
    });
    return accountInputApplied({ events });
  }
  return undefined;
};
