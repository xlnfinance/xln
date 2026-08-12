import type { AccountInput, AccountPeerInput, AccountReplica } from '../../../types/account';
import type { AccountInputSecurityContext } from '../dispute/deadline-policy';
import { accountInputBoardReseal } from '../flush';
import type { HandleAccountInputResult } from '../types';
import {
  rejectAccountPeerEvidenceError,
  rejectAccountPeerInput,
} from '../../input/peer-rejection';
import {
  type ValidatedCounterpartyDisputeSeal,
  validateCounterpartyDisputeSeal,
} from '../dispute/seal';

type BoardResealPayload = NonNullable<ReturnType<typeof accountInputBoardReseal>>;

type ValidatedBoardResealMetadata = {
  expectedFrom: string;
  activationJHeight: number;
  activationLogIndex: number;
  frameHeight: number;
  currentFrameHash: string;
};

const rejectBoardReseal = (
  error: string,
  events: string[],
): HandleAccountInputResult =>
  rejectAccountPeerInput('ACCOUNT_PEER_BOARD_RESEAL_INVALID', error, events);

const validateBoardResealMetadata = (
  account: AccountReplica,
  input: AccountInput,
  reseal: BoardResealPayload,
  events: string[],
): HandleAccountInputResult | ValidatedBoardResealMetadata => {
  const expectedFrom = account.proofHeader.toEntity.toLowerCase();
  const expectedTo = account.proofHeader.fromEntity.toLowerCase();
  if (
    input.fromEntityId.toLowerCase() !== expectedFrom
    || input.toEntityId.toLowerCase() !== expectedTo
  ) {
    return rejectBoardReseal(
      `ACCOUNT_BOARD_RESEAL_PARTY_MISMATCH:${input.fromEntityId}:${input.toEntityId}`,
      events,
    );
  }
  const activationJHeight = Number(reseal.boardActivationJHeight);
  const activationLogIndex = Number(reseal.boardActivationLogIndex);
  if (!Number.isSafeInteger(activationJHeight) || activationJHeight < 1) {
    return rejectBoardReseal(
      `ACCOUNT_BOARD_RESEAL_ACTIVATION_HEIGHT_INVALID:${activationJHeight}`,
      events,
    );
  }
  if (!Number.isSafeInteger(activationLogIndex) || activationLogIndex < 0) {
    return rejectBoardReseal(
      `ACCOUNT_BOARD_RESEAL_ACTIVATION_LOG_INDEX_INVALID:${activationLogIndex}`,
      events,
    );
  }

  const frameHeight = Number(reseal.height);
  const previous = account.counterpartyBoardReseal;
  const notNewer = previous && (
    activationJHeight < previous.activationJHeight
    || (
      activationJHeight === previous.activationJHeight
      && activationLogIndex <= previous.activationLogIndex
    )
  );
  const exactRetry = previous && (
    activationJHeight === previous.activationJHeight
    && activationLogIndex === previous.activationLogIndex
    && frameHeight === previous.frameHeight
    && String(reseal.frameHash).toLowerCase() === previous.frameHash
  );
  if (notNewer && !exactRetry) {
    return rejectBoardReseal(
      `ACCOUNT_BOARD_RESEAL_ACTIVATION_ORDER_INVALID:` +
        `${activationJHeight}:${activationLogIndex}:` +
        `${previous.activationJHeight}:${previous.activationLogIndex}`,
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
    return rejectBoardReseal(
      `ACCOUNT_BOARD_RESEAL_HEIGHT_MISMATCH:${frameHeight}:${currentHeight}`,
      events,
    );
  }
  const currentFrameHash = String(account.currentFrame.stateHash || '').toLowerCase();
  const resealFrameHash = String(reseal.frameHash || '').toLowerCase();
  if (
    !/^0x[0-9a-f]{64}$/.test(resealFrameHash)
    || resealFrameHash !== currentFrameHash
  ) {
    return rejectBoardReseal(
      `ACCOUNT_BOARD_RESEAL_FRAME_HASH_MISMATCH:` +
        `${resealFrameHash || 'missing'}:${currentFrameHash || 'missing'}`,
      events,
    );
  }
  if (!reseal.frameHanko) {
    return rejectBoardReseal('ACCOUNT_BOARD_RESEAL_FRAME_HANKO_MISSING', events);
  }
  return {
    expectedFrom,
    activationJHeight,
    activationLogIndex,
    frameHeight,
    currentFrameHash,
  };
};

const verifyBoardResealWitnesses = async (
  account: AccountReplica,
  input: AccountPeerInput,
  reseal: BoardResealPayload,
  metadata: ValidatedBoardResealMetadata,
  securityContext: AccountInputSecurityContext,
  events: string[],
): Promise<
  HandleAccountInputResult
  | { verifiedDispute?: ValidatedCounterpartyDisputeSeal }
> => {
  const frameAuthority = securityContext.counterpartyCertifiedBoardHash
    ? {
        registeredBoardHash: securityContext.counterpartyCertifiedBoardHash,
        allowPreviousBoard: false,
      }
    : undefined;
  const verifiedFrame = await securityContext.verifyHanko(
    reseal.frameHanko!,
    metadata.currentFrameHash,
    input.fromEntityId,
    frameAuthority,
  );
  if (
    !verifiedFrame.valid
    || verifiedFrame.entityId?.toLowerCase() !== metadata.expectedFrom
  ) {
    return rejectBoardReseal('ACCOUNT_BOARD_RESEAL_FRAME_HANKO_INVALID', events);
  }
  if (!reseal.disputeSeal) return {};

  const expectedHash = account.counterpartyDisputeHash?.toLowerCase();
  const expectedBodyHash = account.counterpartyDisputeProofBodyHash?.toLowerCase();
  const expectedNonce = account.counterpartyDisputeProofNonce;
  const expectedProposerIsLeft = account.counterpartyDisputeProofProposerIsLeft;
  if (
    !expectedHash
    || !expectedBodyHash
    || expectedNonce === undefined
    || expectedProposerIsLeft === undefined
    || reseal.disputeSeal.hash.toLowerCase() !== expectedHash
    || reseal.disputeSeal.proofBodyHash.toLowerCase() !== expectedBodyHash
    || reseal.disputeSeal.proofNonce !== expectedNonce
    || reseal.disputeSeal.proposerIsLeft !== expectedProposerIsLeft
  ) {
    return rejectBoardReseal('ACCOUNT_BOARD_RESEAL_DISPUTE_MISMATCH', events);
  }
  try {
    const verifiedDispute = await validateCounterpartyDisputeSeal(
      account,
      input,
      reseal.disputeSeal,
      'ACCOUNT_BOARD_RESEAL',
      securityContext,
      false,
    );
    return verifiedDispute ? { verifiedDispute } : {};
  } catch (error) {
    return rejectAccountPeerEvidenceError(error, events);
  }
};

export const handleBoardReseal = async (
  account: AccountReplica,
  input: AccountPeerInput,
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult | undefined> => {
  const reseal = accountInputBoardReseal(input);
  if (!reseal) return undefined;
  const events: string[] = [];
  const metadata = validateBoardResealMetadata(account, input, reseal, events);
  if ('success' in metadata) return metadata;
  const witnesses = await verifyBoardResealWitnesses(
    account,
    input,
    reseal,
    metadata,
    securityContext,
    events,
  );
  if ('success' in witnesses) return witnesses;

  // Witness rotation never changes bilateral money or the on-chain nonce.
  // Install authority metadata only after every supplied hash is verified.
  account.counterpartyFrameHanko = reseal.frameHanko!;
  if (witnesses.verifiedDispute) {
    account.counterpartyDisputeProofHanko = witnesses.verifiedDispute.hanko;
  }
  account.counterpartyBoardReseal = {
    activationJHeight: metadata.activationJHeight,
    activationLogIndex: metadata.activationLogIndex,
    frameHeight: metadata.frameHeight,
    frameHash: metadata.currentFrameHash,
  };
  events.push(`🔐 Re-sealed Account frame ${metadata.frameHeight} under the current board`);
  return { success: true, events };
};
