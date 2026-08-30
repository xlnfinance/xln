import type {
  AccountDisputeHanko,
  AccountFrame,
  AccountAckFrame,
  AccountPeerInput,
  AccountReplica,
} from '../../../types/account';
import type { HankoString } from '../../../types/hanko';
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
import type { HandleAccountInputResult } from '../types';
import { accountInputApplied } from '../result';
import type { AccountInputSecurityContext } from '../dispute/deadline-policy';

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

const sameAccountFrameHash = (left: string | undefined, right: string | undefined): boolean =>
  typeof left === 'string'
  && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();

const applyDuplicateAck = (
  response: AccountPeerInput,
  events: string[],
): HandleAccountInputResult => accountInputApplied({
  response: structuredClone(response),
  events,
});

const requireVerifiedDuplicateAckHanko = async (
  account: AccountReplica,
  ack: AccountAckFrame,
  frameHash: string,
  receivedHeight: number,
  securityContext: AccountInputSecurityContext,
  source: 'CACHED' | 'CURRENT_FRAME',
): Promise<HankoString> => {
  if (!sameAccountFrameHash(ack.frameHash, frameHash)) {
    throw new Error(
      `DUPLICATE_ACK_${source}_FRAME_HASH_MISMATCH:`
      + `height=${receivedHeight}:cached=${String(ack.frameHash)}:current=${frameHash}`,
    );
  }
  const hanko = ack.frameHanko;
  if (!hanko) {
    throw new Error(`DUPLICATE_ACK_${source}_HANKO_MISSING:height=${receivedHeight}`);
  }
  const ownEntityId = account.proofHeader.fromEntity;
  if (!ownEntityId) {
    throw new Error(`DUPLICATE_ACK_LOCAL_ENTITY_MISSING:height=${receivedHeight}`);
  }
  // Both sources are persisted evidence for an already-committed frame. They
  // may legitimately have been signed by the immediately previous board when
  // the original ACK crossed a board rotation. The verifier still binds the
  // bytes to this exact frame hash and enforces the exclusive grace deadline;
  // this mode is never used for a fresh proposal.
  const verified = await securityContext.verifyHanko(
    hanko,
    frameHash,
    ownEntityId,
    { allowPreviousBoard: true },
  );
  if (
    !verified.valid
    || verified.entityId?.toLowerCase() !== ownEntityId.toLowerCase()
  ) {
    throw new Error(`DUPLICATE_ACK_${source}_HANKO_INVALID:height=${receivedHeight}`);
  }
  return hanko;
};

const requireCurrentFrameHanko = async (
  account: AccountReplica,
  frameHash: string,
  receivedHeight: number,
  securityContext: AccountInputSecurityContext,
): Promise<HankoString> => requireVerifiedDuplicateAckHanko(
  account,
  {
    height: receivedHeight,
    frameHash,
    ...(account.currentFrameHanko ? { frameHanko: account.currentFrameHanko } : {}),
  },
  frameHash,
  receivedHeight,
  securityContext,
  'CURRENT_FRAME',
);

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
  account.lastOutboundAckFrame = {
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

const rebuildDuplicateCommittedAckFrame = async (
  account: AccountReplica,
  input: AccountPeerInput,
  frameHash: string,
  receivedHeight: number,
  events: string[],
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult> => {
  const frameHanko = await requireCurrentFrameHanko(
    account,
    frameHash,
    receivedHeight,
    securityContext,
  );
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
      frameHash,
      frameHanko,
      ...(disputeHanko ? { disputeHanko } : {}),
    },
  };
  account.lastOutboundAckFrame = {
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
  return applyDuplicateAck(response, events);
};

const isDuplicateAckTarget = (
  candidateHeight: number,
  candidateEntityId: string,
  receivedHeight: number,
  fromEntityId: string,
): boolean => Number(candidateHeight) === receivedHeight
  && candidateEntityId.toLowerCase() === fromEntityId.toLowerCase();

const reuseLastOutboundDuplicateAck = async (
  account: AccountReplica,
  input: AccountPeerInput,
  receivedHeight: number,
  events: string[],
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult | null> => {
  const cached = account.lastOutboundAckFrame;
  if (!cached || !isDuplicateAckTarget(
    cached.height,
    cached.counterpartyEntityId,
    receivedHeight,
    input.fromEntityId,
  )) return null;
  const ack = accountInputAck(cached.response);
  if (!ack) throw new Error(`DUPLICATE_ACK_CACHED_RESPONSE_MISSING_ACK:${receivedHeight}`);
  await requireVerifiedDuplicateAckHanko(
    account,
    ack,
    account.currentFrame.stateHash,
    receivedHeight,
    securityContext,
    'CACHED',
  );
  events.push(`↩️ Re-sent ACK for duplicate committed frame ${receivedHeight}`);
  replayLog.debug('input.duplicate_ack_cached', {
    height: receivedHeight,
    from: shortId(input.fromEntityId),
    currentHeight: account.currentHeight,
    hasHanko: Boolean(ack.frameHanko),
  });
  return applyDuplicateAck(cached.response, events);
};

export const buildDuplicateCommittedAckFrame = async (
  account: AccountReplica,
  input: AccountPeerInput,
  events: string[],
  replayCurrentHeight: number,
  receivedFrame: AccountFrame,
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult | null> => {
  const receivedHeight = Number(receivedFrame.height ?? 0);
  if (receivedHeight !== replayCurrentHeight) return null;
  const receivedFrameHash = receivedFrame.stateHash;
  if (!sameAccountFrameHash(receivedFrameHash, account.currentFrame?.stateHash)) {
    replayLog.warn('input.duplicate_height_hash_mismatch', {
      height: receivedHeight,
      receivedHash: receivedFrameHash ?? null,
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
    && isDuplicateAckTarget(pendingAck.height, pendingResponse.toEntityId, receivedHeight, input.fromEntityId)
  ) {
    await requireVerifiedDuplicateAckHanko(
      account,
      pendingAck,
      account.currentFrame.stateHash,
      receivedHeight,
      securityContext,
      'CACHED',
    );
    const retainedAck = account.lastOutboundAckFrame
      && Number(account.lastOutboundAckFrame.height) === receivedHeight
      && account.lastOutboundAckFrame.counterpartyEntityId.toLowerCase() === input.fromEntityId.toLowerCase()
      ? accountInputAck(account.lastOutboundAckFrame.response)
      : undefined;
    if (retainedAck) {
      if (!retainedAck.frameHanko) {
        throw new Error(`DUPLICATE_ACK_CACHED_HANKO_MISSING:height=${receivedHeight}`);
      }
      if (
        !sameAccountFrameHash(retainedAck.frameHash, pendingAck.frameHash)
        || retainedAck.frameHanko.toLowerCase() !== pendingAck.frameHanko?.toLowerCase()
      ) {
        throw new Error(`DUPLICATE_ACK_CACHED_HANKO_CONFLICT:height=${receivedHeight}`);
      }
    }
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
    return applyDuplicateAck(response, events);
  }
  const cachedAck = await reuseLastOutboundDuplicateAck(
    account,
    input,
    receivedHeight,
    events,
    securityContext,
  );
  if (cachedAck) return cachedAck;
  if (!account.currentFrame?.stateHash || !account.proofHeader.fromEntity) {
    throw new Error(`DUPLICATE_ACK_CURRENT_FRAME_BINDING_MISSING:height=${receivedHeight}`);
  }
  return rebuildDuplicateCommittedAckFrame(
    account,
    input,
    account.currentFrame.stateHash,
    receivedHeight,
    events,
    securityContext,
  );
};

export const handleReplayOrObsoleteAccountInput = async (
  account: AccountReplica,
  input: AccountPeerInput,
  replay: AccountInputReplayClassification,
  events: string[],
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult | undefined> => {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  if (proposal) {
    // At-least-once delivery may retry an exact committed frame after ACK loss.
    const duplicateAck = await buildDuplicateCommittedAckFrame(
      account,
      input,
      events,
      replay.currentHeight,
      proposal.frame,
      securityContext,
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
