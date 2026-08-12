import type { AccountFrame, AccountInput, AccountReplica } from '../../../types/account';
import { createStructuredLogger, shortId } from '../../../infra/logger';
import {
  accountInputAck,
  accountInputDisputeSeal,
  accountInputProposal,
  accountInputReferenceHeight,
} from '../flush';
import type { HandleAccountInputResult } from '../types';

const replayLog = createStructuredLogger('account.replay');

export type AccountInputHeightNormalization =
  | { normalizedInputHeight: number | undefined; error?: undefined }
  | { normalizedInputHeight?: undefined; error: string };

export const normalizeAccountInputHeight = (
  input: AccountInput,
): AccountInputHeightNormalization => {
  const referenceHeight = accountInputReferenceHeight(input);
  const normalizedInputHeight = referenceHeight === undefined || referenceHeight === null
    ? undefined
    : Number(referenceHeight);
  if (
    normalizedInputHeight !== undefined
    && !Number.isFinite(normalizedInputHeight)
  ) {
    return { error: `Invalid account input height: ${String(referenceHeight)}` };
  }
  return { normalizedInputHeight };
};

export const getDisputeHankoShapeError = (
  input: AccountInput,
): string | undefined => {
  const seals = [
    accountInputAck(input)?.disputeSeal,
    accountInputProposal(input)?.disputeSeal,
    accountInputDisputeSeal(input),
  ];
  for (const seal of seals) {
    if (!seal) continue;
    if (typeof seal.hanko !== 'string') return 'Invalid dispute hanko type';
    const hankoHex = seal.hanko.toLowerCase();
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
  input: AccountInput,
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
    frameIsStale: newFrameHeight !== undefined && newFrameHeight <= currentHeight,
  };
};

export const buildDuplicateCommittedFrameAck = (
  account: AccountReplica,
  input: AccountInput,
  events: string[],
  replayCurrentHeight: number,
  receivedFrame: AccountFrame,
): HandleAccountInputResult | null => {
  const receivedHeight = Number(receivedFrame.height ?? 0);
  if (
    receivedHeight !== replayCurrentHeight
    || receivedFrame.stateHash !== account.currentFrame?.stateHash
  ) {
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
    events.push(`↩️ Re-sent cached response for duplicate committed frame ${receivedHeight}`);
    return { success: true, response: structuredClone(pendingResponse), events };
  }
  const cachedAck = account.lastOutboundFrameAck;
  if (
    cachedAck
    && Number(cachedAck.height) === receivedHeight
    && cachedAck.counterpartyEntityId.toLowerCase() === input.fromEntityId.toLowerCase()
  ) {
    events.push(`↩️ Re-sent ACK for duplicate committed frame ${receivedHeight}`);
    return { success: true, response: structuredClone(cachedAck.response), events };
  }
  return {
    success: false,
    error: `DUPLICATE_ACK_CACHE_MISSING: height=${receivedHeight}`,
    events,
  };
};

export const handleReplayOrObsoleteAccountInput = (
  account: AccountReplica,
  input: AccountInput,
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
    return { success: true, events };
  }
  if (!ack && replay.frameIsStale) {
    replayLog.debug('input.stale_frame_ignored', {
      currentHeight: replay.currentHeight,
      inputHeight: replay.inputHeight,
      newFrameHeight: replay.newFrameHeight ?? null,
      from: shortId(input.fromEntityId),
    });
    return { success: true, events };
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
    return { success: true, events };
  }
  return undefined;
};
