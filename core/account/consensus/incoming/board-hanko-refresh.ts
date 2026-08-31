import type { AccountInput, AccountReplica } from '../../../types/account';
import type { AccountInputSecurityContext } from '../dispute/deadline-policy';
import { accountInputBoardHankoRefresh } from '../flush';
import type { HandleAccountInputResult } from '../types';
import { accountInputApplied, rejectAccountInputEvidenceError, rejectAccountInput } from '../result';
import {
  type ValidatedCounterpartyDisputeHanko,
  validateCounterpartyDisputeHanko,
} from '../dispute/hanko';

type BoardHankoRefreshPayload = NonNullable<ReturnType<typeof accountInputBoardHankoRefresh>>;

type ValidatedBoardHankoRefreshMetadata = {
  expectedFrom: string;
  activationJHeight: number;
  activationLogIndex: number;
  frameHeight: number;
  currentFrameHash: string;
};

const rejectBoardHankoRefresh = (
  error: string,
  events: string[],
): HandleAccountInputResult =>
  rejectAccountInput('ACCOUNT_INPUT_BOARD_HANKO_REFRESH_INVALID', error, events);

type BoardHankoRefreshActivation = Pick<
  ValidatedBoardHankoRefreshMetadata,
  'activationJHeight' | 'activationLogIndex'
>;

const validateBoardHankoRefreshActivation = (
  boardHankoRefresh: BoardHankoRefreshPayload,
  securityContext: AccountInputSecurityContext,
  events: string[],
): HandleAccountInputResult | BoardHankoRefreshActivation => {
  const activationJHeight = Number(boardHankoRefresh.boardActivationJHeight);
  const activationLogIndex = Number(boardHankoRefresh.boardActivationLogIndex);
  if (!Number.isSafeInteger(activationJHeight) || activationJHeight < 1) {
    return rejectBoardHankoRefresh(
      `ACCOUNT_BOARD_HANKO_REFRESH_ACTIVATION_HEIGHT_INVALID:${activationJHeight}`,
      events,
    );
  }
  if (!Number.isSafeInteger(activationLogIndex) || activationLogIndex < 0) {
    return rejectBoardHankoRefresh(
      `ACCOUNT_BOARD_HANKO_REFRESH_ACTIVATION_LOG_INDEX_INVALID:${activationLogIndex}`,
      events,
    );
  }
  const certifiedBoard = securityContext.counterpartyCertifiedBoard;
  if (!certifiedBoard) {
    return rejectBoardHankoRefresh('ACCOUNT_BOARD_HANKO_REFRESH_CERTIFIED_BOARD_MISSING', events);
  }
  if (
    activationJHeight !== certifiedBoard.activatedAtJHeight
    || activationLogIndex !== certifiedBoard.logIndex
  ) {
    return rejectBoardHankoRefresh(
      `ACCOUNT_BOARD_HANKO_REFRESH_ACTIVATION_MISMATCH:`
        + `${activationJHeight}:${activationLogIndex}:`
        + `${certifiedBoard.activatedAtJHeight}:${certifiedBoard.logIndex}`,
      events,
    );
  }
  return { activationJHeight, activationLogIndex };
};

const validateBoardHankoRefreshFrame = (
  account: AccountReplica,
  boardHankoRefresh: BoardHankoRefreshPayload,
  activation: BoardHankoRefreshActivation,
  events: string[],
): HandleAccountInputResult | Pick<ValidatedBoardHankoRefreshMetadata, 'frameHeight' | 'currentFrameHash'> => {
  const { activationJHeight, activationLogIndex } = activation;
  const frameHeight = Number(boardHankoRefresh.height);
  const previous = account.counterpartyBoardHankoRefresh;
  const notNewer = previous && (
    activationJHeight < previous.activationJHeight
    || (activationJHeight === previous.activationJHeight && activationLogIndex <= previous.activationLogIndex)
  );
  const exactRetry = previous && (
    activationJHeight === previous.activationJHeight
    && activationLogIndex === previous.activationLogIndex
    && frameHeight === previous.frameHeight
    && String(boardHankoRefresh.frameHash).toLowerCase() === previous.frameHash
  );
  if (notNewer && !exactRetry) {
    return rejectBoardHankoRefresh(
      `ACCOUNT_BOARD_HANKO_REFRESH_ACTIVATION_ORDER_INVALID:`
        + `${activationJHeight}:${activationLogIndex}:`
        + `${previous.activationJHeight}:${previous.activationLogIndex}`,
      events,
    );
  }
  const currentHeight = Number(account.currentHeight);
  if (
    !Number.isSafeInteger(frameHeight)
    || frameHeight < 1
    || frameHeight !== currentHeight
    || frameHeight !== Number(account.currentFrame.height)
  ) {
    return rejectBoardHankoRefresh(
      `ACCOUNT_BOARD_HANKO_REFRESH_HEIGHT_MISMATCH:${frameHeight}:${currentHeight}`,
      events,
    );
  }
  const currentFrameHash = String(account.currentFrame.stateHash || '').toLowerCase();
  const boardHankoRefreshFrameHash = String(boardHankoRefresh.frameHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(boardHankoRefreshFrameHash) || boardHankoRefreshFrameHash !== currentFrameHash) {
    return rejectBoardHankoRefresh(
      `ACCOUNT_BOARD_HANKO_REFRESH_FRAME_HASH_MISMATCH:`
        + `${boardHankoRefreshFrameHash || 'missing'}:${currentFrameHash || 'missing'}`,
      events,
    );
  }
  if (!boardHankoRefresh.frameHanko) {
    return rejectBoardHankoRefresh('ACCOUNT_BOARD_HANKO_REFRESH_FRAME_HANKO_MISSING', events);
  }
  return { frameHeight, currentFrameHash };
};

const validateBoardHankoRefreshMetadata = (
  account: AccountReplica,
  input: AccountInput,
  boardHankoRefresh: BoardHankoRefreshPayload,
  securityContext: AccountInputSecurityContext,
  events: string[],
): HandleAccountInputResult | ValidatedBoardHankoRefreshMetadata => {
  const expectedFrom = account.proofHeader.toEntity.toLowerCase();
  const expectedTo = account.proofHeader.fromEntity.toLowerCase();
  if (
    input.fromEntityId.toLowerCase() !== expectedFrom
    || input.toEntityId.toLowerCase() !== expectedTo
  ) {
    return rejectBoardHankoRefresh(
      `ACCOUNT_BOARD_HANKO_REFRESH_PARTY_MISMATCH:${input.fromEntityId}:${input.toEntityId}`,
      events,
    );
  }
  const activation = validateBoardHankoRefreshActivation(boardHankoRefresh, securityContext, events);
  if ('ok' in activation) return activation;
  const frame = validateBoardHankoRefreshFrame(account, boardHankoRefresh, activation, events);
  if ('ok' in frame) return frame;
  return {
    expectedFrom,
    ...activation,
    ...frame,
  };
};

const verifyBoardHankoRefreshWitnesses = async (
  account: AccountReplica,
  input: AccountInput,
  boardHankoRefresh: BoardHankoRefreshPayload,
  metadata: ValidatedBoardHankoRefreshMetadata,
  securityContext: AccountInputSecurityContext,
  events: string[],
): Promise<
  HandleAccountInputResult
  | { verifiedDispute?: ValidatedCounterpartyDisputeHanko }
> => {
  const frameAuthority = {
    ...(securityContext.counterpartyCertifiedBoard
      ? { registeredBoardHash: securityContext.counterpartyCertifiedBoard.boardHash }
      : {}),
    allowPreviousBoard: false,
  };
  const verifiedFrame = await securityContext.verifyHanko(
    boardHankoRefresh.frameHanko!,
    metadata.currentFrameHash,
    input.fromEntityId,
    frameAuthority,
  );
  if (
    !verifiedFrame.valid
    || verifiedFrame.entityId?.toLowerCase() !== metadata.expectedFrom
  ) {
    return rejectBoardHankoRefresh('ACCOUNT_BOARD_HANKO_REFRESH_FRAME_HANKO_INVALID', events);
  }
  if (!boardHankoRefresh.disputeHanko) return {};

  const expectedHash = account.counterpartyDisputeHash?.toLowerCase();
  const expectedBodyHash = account.counterpartyDisputeProofBodyHash?.toLowerCase();
  const expectedNonce = account.counterpartyDisputeProofNonce;
  const expectedProposerIsLeft = account.counterpartyDisputeProofProposerIsLeft;
  if (
    !expectedHash
    || !expectedBodyHash
    || expectedNonce === undefined
    || expectedProposerIsLeft === undefined
    || boardHankoRefresh.disputeHanko.hash.toLowerCase() !== expectedHash
    || boardHankoRefresh.disputeHanko.proofBodyHash.toLowerCase() !== expectedBodyHash
    || boardHankoRefresh.disputeHanko.proofNonce !== expectedNonce
    || boardHankoRefresh.disputeHanko.proposerIsLeft !== expectedProposerIsLeft
  ) {
    return rejectBoardHankoRefresh('ACCOUNT_BOARD_HANKO_REFRESH_DISPUTE_MISMATCH', events);
  }
  try {
    const verifiedDispute = await validateCounterpartyDisputeHanko(
      account,
      input,
      boardHankoRefresh.disputeHanko,
      'ACCOUNT_BOARD_HANKO_REFRESH',
      securityContext,
      false,
    );
    return verifiedDispute ? { verifiedDispute } : {};
  } catch (error) {
    return rejectAccountInputEvidenceError(error, events);
  }
};

export const handleBoardHankoRefresh = async (
  account: AccountReplica,
  input: AccountInput,
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult | undefined> => {
  const boardHankoRefresh = accountInputBoardHankoRefresh(input);
  if (!boardHankoRefresh) return undefined;
  const events: string[] = [];
  const metadata = validateBoardHankoRefreshMetadata(account, input, boardHankoRefresh, securityContext, events);
  if ('ok' in metadata) return metadata;
  const witnesses = await verifyBoardHankoRefreshWitnesses(
    account,
    input,
    boardHankoRefresh,
    metadata,
    securityContext,
    events,
  );
  if ('ok' in witnesses) return witnesses;

  // Witness rotation never changes bilateral money or the on-chain nonce.
  // Install authority metadata only after every supplied hash is verified.
  account.counterpartyFrameHanko = boardHankoRefresh.frameHanko!;
  if (witnesses.verifiedDispute) {
    account.counterpartyDisputeProofHanko = witnesses.verifiedDispute.hanko;
  }
  account.counterpartyBoardHankoRefresh = {
    activationJHeight: metadata.activationJHeight,
    activationLogIndex: metadata.activationLogIndex,
    frameHeight: metadata.frameHeight,
    frameHash: metadata.currentFrameHash,
  };
  events.push(`🔐 Refreshed Account frame ${metadata.frameHeight} Hankos under the current board`);
  return accountInputApplied({ events });
};
