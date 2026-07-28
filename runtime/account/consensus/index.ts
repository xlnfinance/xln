/**
 * Bilateral account consensus: two entities agree on a frame chain for one
 * off-chain account, then bubble committed effects back to the entity runtime.
 */

import type {
  AccountMachine,
  AccountFrame,
  AccountTx,
  AccountInput,
  EntityCandidateEffect,
  Env,
  Delta,
  HankoString,
} from '../../types';
import {
  cloneAccountFrame,
  cloneAccountMachine,
  getAccountPerspective,
} from '../../state-helpers';
import { isLeft } from '../utils';
import { HEAVY_LOGS } from '../../utils';
import { safeStringify } from '../../protocol/serialization';
import { applyAccountTx } from '../tx/apply';
import { appendAccountFrameHistoryView, getAccountFrameHistoryView } from '../../runtime/env-events';
import { deriveAccountFrameTokenIds } from '../frame';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import {
  createFrameHash,
  getAccountFrameValidationError,
} from './frame';
import { normalizeAccountWatchSeed } from '../watch-seed';
import {
  assertNoUnilateralSettlementMutation,
  buildAccountProofBodyFromEnv,
  captureSettlementVector,
  getAccountStateDomain,
  prependUniqueMempoolTxs,
  runPostFrameAutoRebalanceCheck,
  shouldIncludeToken,
  summarizeDeltasForLog,
} from './helpers';
import { appendAccountMempoolTx, appendAccountMempoolTxs } from '../mempool';
import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../../protocol/dispute/arguments';
import type {
  AccountConsensusHashToSign,
  AccountSwapOfferCreated,
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from './types';
import { createDisputeProofHashWithNonce } from '../../protocol/dispute/proof-builder';
import { getMinimumSafeSettlementNonce } from '../../protocol/settlement/operations';
import { signEntityHashes, verifyHankoForHash } from '../../hanko/signing';
import { getReplicaByEntityId } from '../../entity/replica';
import {
  computeAccountCommitmentSectionDetail,
  computeAccountCommitmentSectionDetailCold,
  computeAccountStateRoot,
  computeAccountStateRootCold,
  computeAccountStateSectionHashes,
  computeAccountStateSectionHashesCold,
} from '../state-root';
import {
  commitStagedAccountCommitmentCache,
  discardStagedAccountCommitmentCache,
  forkAccountCommitmentCache,
} from '../map-commitment';
import { createAccountJClaimSession, type AccountJClaimSession } from '../j-claim-session';
import type { AccountJClaimNodeStore } from '../../types/account-j-claims';
import {
  getIncomingAccountDeadlineViolation,
  HTLC_ENFORCEMENT_RESERVE_MS,
  isHtlcSecretEnforcementWindowClosed,
  type AccountInputSecurityContext,
} from './deadline-policy';
import {
  accountInputAck,
  accountInputBoardReseal,
  accountInputDisputeSeal,
  accountInputProposal,
  accountInputReferenceHeight,
} from './flush';
export { proposeAccountFrame } from './propose';
export type {
  AccountConsensusFrameResult,
  AccountConsensusHashToSign,
  AccountSwapOfferCreated,
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from './types';

const accountLog = createStructuredLogger('account');
const STALE_ACCOUNT_FRAME_WARNING_MS = 5 * 60_000;

const assertLiveCommitMatchesFrame = (
  accountMachine: AccountMachine,
  expectedRoot: string,
  side: 'proposer' | 'receiver',
  height: number,
  validatedMachine?: AccountMachine,
): void => {
  const incrementalRoot = computeAccountStateRoot(accountMachine);
  const coldRoot = computeAccountStateRootCold(accountMachine);
  if (incrementalRoot === expectedRoot && coldRoot === expectedRoot) return;
  const details = {
    side,
    height,
    expectedRoot,
    incrementalRoot,
    coldRoot,
    incrementalSectionHashes: computeAccountStateSectionHashes(accountMachine),
    coldSectionHashes: computeAccountStateSectionHashesCold(accountMachine),
    incrementalCommitments: computeAccountCommitmentSectionDetail(accountMachine),
    coldCommitments: computeAccountCommitmentSectionDetailCold(accountMachine),
    pendingFrameTxTypes: accountMachine.pendingFrame?.accountTxs.map((tx) => tx.type) ?? [],
    commitmentEntryCounts: {
      locks: accountMachine.locks.size,
      pulls: accountMachine.pulls?.size ?? 0,
      swapOffers: accountMachine.swapOffers.size,
      subcontracts: accountMachine.subcontracts?.size ?? 0,
      lendingIntents: accountMachine.lendingIntents?.size ?? 0,
    },
    liveFinancial: {
      deltas: Array.from(accountMachine.deltas.entries()),
      globalCreditLimits: accountMachine.globalCreditLimits,
      jNonce: accountMachine.jNonce,
      disputeConfig: accountMachine.disputeConfig,
    },
    ...(validatedMachine ? {
      validatedFinancial: {
        deltas: Array.from(validatedMachine.deltas.entries()),
        globalCreditLimits: validatedMachine.globalCreditLimits,
        jNonce: validatedMachine.jNonce,
        disputeConfig: validatedMachine.disputeConfig,
      },
    } : {}),
  };
  accountLog.error('frame.live_commit_root_mismatch', details);
  throw new Error(`ACCOUNT_LIVE_COMMIT_ROOT_MISMATCH:${safeStringify(details)}`);
};

export {
  getIncomingAccountDeadlineViolation,
  HTLC_ENFORCEMENT_RESERVE_MS,
  isHtlcSecretEnforcementWindowClosed,
};
export type { AccountInputSecurityContext };

export { computeFrameHash, validateAccountFrame } from './frame';

// Counter-based replay protection was intentionally replaced by the frame chain
// (height + prevFrameHash). Nonces remain only for on-chain proof material.

type ValidatedCounterpartyDisputeSeal = {
  hanko: string;
  nonce: number;
  hash: string;
  proofBodyHash: string;
};

async function validateCounterpartyDisputeSeal(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  seal: ReturnType<typeof accountInputDisputeSeal>,
  context: string,
  securityContext: AccountInputSecurityContext,
  allowPreviousBoard = true,
): Promise<ValidatedCounterpartyDisputeSeal | undefined> {
  if (!seal) return undefined;
  if (!seal.hanko) {
    throw new Error(`${context}:DISPUTE_SEAL_HANKO_MISSING`);
  }

  const hankoDomain = getAccountStateDomain(accountMachine);

  // A dispute Hanko is only useful if it signs the exact Solidity message:
  // (MessageType.DisputeProof, chainId, depository, canonical accountKey, nonce,
  // proofbodyHash). Verifying a peer-supplied `newDisputeHash` alone is not
  // enough: a malicious peer can sign any random hash, attach a plausible
  // proofbodyHash, and make us store metadata that later fails on-chain.
  const expectedHash = createDisputeProofHashWithNonce(
    accountMachine,
    seal.proofBodyHash,
    hankoDomain,
    seal.proofNonce,
  );
  if (String(seal.hash).toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`${context}:DISPUTE_SEAL_HASH_MISMATCH:${safeStringify({
      kind: input.kind,
      currentHeight: accountMachine.currentHeight,
      pendingHeight: accountMachine.pendingFrame?.height ?? null,
      inputHeight: accountInputAck(input)?.height ?? null,
      newFrameHeight: accountInputProposal(input)?.frame.height ?? null,
      localNonce: accountMachine.proofHeader.nextProofNonce,
      signedNonce: seal.proofNonce,
      proofBodyHash: seal.proofBodyHash,
      expected: expectedHash,
      received: seal.hash,
      from: shortId(input.fromEntityId),
      to: shortId(input.toEntityId),
    })}`);
  }

  const { valid } = await verifyHankoForHash(
    seal.hanko,
    expectedHash,
    input.fromEntityId,
    env,
    securityContext.counterpartyCertifiedBoardHash
      ? {
          registeredBoardHash: securityContext.counterpartyCertifiedBoardHash,
          allowPreviousBoard,
        }
      : undefined,
  );
  if (!valid) {
    throw new Error(`${context}:DISPUTE_SEAL_HANKO_INVALID`);
  }

  return {
    hanko: seal.hanko,
    nonce: seal.proofNonce,
    hash: expectedHash,
    proofBodyHash: seal.proofBodyHash,
  };
}

type BoardResealPayload = NonNullable<ReturnType<typeof accountInputBoardReseal>>;
type ValidatedBoardResealMetadata = {
  expectedFrom: string;
  activationJHeight: number;
  activationLogIndex: number;
  frameHeight: number;
  currentFrameHash: string;
};

const rejectBoardReseal = (error: string, events: string[]): HandleAccountInputResult => ({
  success: false,
  error,
  events,
});

const validateBoardResealMetadata = (
  account: AccountMachine,
  input: AccountInput,
  reseal: BoardResealPayload,
  events: string[],
): HandleAccountInputResult | ValidatedBoardResealMetadata => {
  const expectedFrom = account.proofHeader.toEntity.toLowerCase();
  const expectedTo = account.proofHeader.fromEntity.toLowerCase();
  if (input.fromEntityId.toLowerCase() !== expectedFrom || input.toEntityId.toLowerCase() !== expectedTo) {
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
    activationJHeight < previous.activationJHeight ||
    (activationJHeight === previous.activationJHeight && activationLogIndex <= previous.activationLogIndex)
  );
  const exactRetry = previous && (
    activationJHeight === previous.activationJHeight &&
    activationLogIndex === previous.activationLogIndex &&
    frameHeight === previous.frameHeight &&
    String(reseal.frameHash).toLowerCase() === previous.frameHash
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
    !Number.isSafeInteger(frameHeight) ||
    frameHeight < 1 ||
    frameHeight !== currentHeight ||
    frameHeight !== Number(account.currentFrame.height)
  ) {
    return rejectBoardReseal(
      `ACCOUNT_BOARD_RESEAL_HEIGHT_MISMATCH:${frameHeight}:${currentHeight}`,
      events,
    );
  }
  const currentFrameHash = String(account.currentFrame.stateHash || '').toLowerCase();
  const resealFrameHash = String(reseal.frameHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(resealFrameHash) || resealFrameHash !== currentFrameHash) {
    return rejectBoardReseal(
      `ACCOUNT_BOARD_RESEAL_FRAME_HASH_MISMATCH:${resealFrameHash || 'missing'}:${currentFrameHash || 'missing'}`,
      events,
    );
  }
  if (!reseal.frameHanko) {
    return rejectBoardReseal('ACCOUNT_BOARD_RESEAL_FRAME_HANKO_MISSING', events);
  }
  return { expectedFrom, activationJHeight, activationLogIndex, frameHeight, currentFrameHash };
};

const verifyBoardResealWitnesses = async (
  env: Env,
  account: AccountMachine,
  input: AccountInput,
  reseal: BoardResealPayload,
  metadata: ValidatedBoardResealMetadata,
  securityContext: AccountInputSecurityContext,
  events: string[],
): Promise<HandleAccountInputResult | { verifiedDispute?: ValidatedCounterpartyDisputeSeal }> => {
  const frameAuthority = securityContext.counterpartyCertifiedBoardHash
    ? { registeredBoardHash: securityContext.counterpartyCertifiedBoardHash, allowPreviousBoard: false }
    : undefined;
  const verifiedFrame = await verifyHankoForHash(
    reseal.frameHanko!,
    metadata.currentFrameHash,
    input.fromEntityId,
    env,
    frameAuthority,
  );
  if (!verifiedFrame.valid || verifiedFrame.entityId?.toLowerCase() !== metadata.expectedFrom) {
    return rejectBoardReseal('ACCOUNT_BOARD_RESEAL_FRAME_HANKO_INVALID', events);
  }
  if (!reseal.disputeSeal) return {};

  const expectedDisputeHash = account.counterpartyDisputeHash?.toLowerCase();
  const expectedProofBodyHash = account.counterpartyDisputeProofBodyHash?.toLowerCase();
  const expectedProofNonce = account.counterpartyDisputeProofNonce;
  if (
    !expectedDisputeHash ||
    !expectedProofBodyHash ||
    expectedProofNonce === undefined ||
    reseal.disputeSeal.hash.toLowerCase() !== expectedDisputeHash ||
    reseal.disputeSeal.proofBodyHash.toLowerCase() !== expectedProofBodyHash ||
    reseal.disputeSeal.proofNonce !== expectedProofNonce
  ) {
    return rejectBoardReseal('ACCOUNT_BOARD_RESEAL_DISPUTE_MISMATCH', events);
  }
  try {
    const verifiedDispute = await validateCounterpartyDisputeSeal(
      env,
      account,
      input,
      reseal.disputeSeal,
      'ACCOUNT_BOARD_RESEAL',
      securityContext,
      false,
    );
    return {
      ...(verifiedDispute ? { verifiedDispute } : {}),
    };
  } catch (error) {
    return rejectBoardReseal((error as Error).message, events);
  }
};

const handleBoardReseal = async (
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult | undefined> => {
  const reseal = accountInputBoardReseal(input);
  if (!reseal) return undefined;
  const events: string[] = [];
  const metadata = validateBoardResealMetadata(accountMachine, input, reseal, events);
  if ('success' in metadata) return metadata;
  const witnesses = await verifyBoardResealWitnesses(
    env,
    accountMachine,
    input,
    reseal,
    metadata,
    securityContext,
    events,
  );
  if ('success' in witnesses) return witnesses;

  // The exact Account state and on-chain dispute nonce remain untouched. Only
  // replace cached authority witnesses after every supplied hash validates.
  accountMachine.counterpartyFrameHanko = reseal.frameHanko!;
  if (witnesses.verifiedDispute) {
    accountMachine.counterpartyDisputeProofHanko = witnesses.verifiedDispute.hanko;
  }
  accountMachine.counterpartyBoardReseal = {
    activationJHeight: metadata.activationJHeight,
    activationLogIndex: metadata.activationLogIndex,
    frameHeight: metadata.frameHeight,
    frameHash: metadata.currentFrameHash,
  };
  events.push(`🔐 Re-sealed Account frame ${metadata.frameHeight} under the current board`);
  return { success: true, events };
};

function storeCounterpartyDisputeSeal(
  accountMachine: AccountMachine,
  seal: ValidatedCounterpartyDisputeSeal | undefined,
): void {
  if (!seal) return;
  accountMachine.counterpartyDisputeProofHanko = seal.hanko;
  accountMachine.counterpartyDisputeProofNonce = seal.nonce;
  accountMachine.counterpartyDisputeHash = seal.hash;
  accountMachine.counterpartyDisputeProofBodyHash = seal.proofBodyHash;
  accountMachine.disputeProofNoncesByHash ??= {};
  accountMachine.disputeProofNoncesByHash[seal.proofBodyHash] = seal.nonce;
}

const disputeSealRequirementError = (
  expectedProofBodyHash: string | undefined,
  previousCounterpartyProofBodyHash: string | undefined,
  previousCounterpartyProofNonce: number | undefined,
  jNonce: number,
  seal: ValidatedCounterpartyDisputeSeal | undefined,
): string | undefined => {
  if (!expectedProofBodyHash) return seal ? 'DISPUTE_SEAL_UNEXPECTED_WITHOUT_LOCAL_PROOF' : undefined;
  if (seal && seal.proofBodyHash.toLowerCase() !== expectedProofBodyHash.toLowerCase()) {
    return `DISPUTE_SEAL_PROOFBODY_MISMATCH: expected=${expectedProofBodyHash} received=${seal.proofBodyHash}`;
  }
  const proofChanged = expectedProofBodyHash.toLowerCase() !== previousCounterpartyProofBodyHash?.toLowerCase();
  const proofNonceConsumed = Number(previousCounterpartyProofNonce ?? 0) <= jNonce;
  if ((proofChanged || proofNonceConsumed) && !seal) {
    return `DISPUTE_SEAL_REQUIRED: proofBodyHash=${expectedProofBodyHash} jNonce=${jNonce}`;
  }
  return undefined;
};

type AccountInputHeightNormalization =
  | { normalizedInputHeight: number | undefined; error?: undefined }
  | { normalizedInputHeight?: undefined; error: string };

function normalizeAccountInputHeight(input: AccountInput): AccountInputHeightNormalization {
  const referenceHeight = accountInputReferenceHeight(input);
  const normalizedInputHeight =
    referenceHeight === undefined || referenceHeight === null ? undefined : Number(referenceHeight);
  if (normalizedInputHeight !== undefined && !Number.isFinite(normalizedInputHeight)) {
    return { error: `Invalid account input height: ${String(referenceHeight)}` };
  }
  return { normalizedInputHeight };
}

function getDisputeHankoShapeError(input: AccountInput): string | undefined {
  const seals = [accountInputAck(input)?.disputeSeal, accountInputProposal(input)?.disputeSeal, accountInputDisputeSeal(input)];
  for (const seal of seals) {
    if (!seal) continue;
    if (typeof seal.hanko !== 'string') return 'Invalid dispute hanko type';
    const hankoHex = seal.hanko.toLowerCase();
    const normalized = hankoHex.startsWith('0x') ? hankoHex.slice(2) : hankoHex;
    if (normalized.length === 0) return 'Invalid dispute hanko (empty)';
    if (normalized.length % 2 !== 0) return 'Invalid dispute hanko (odd length)';
  }
  return undefined;
}

function describeAccountState(accountMachine: AccountMachine): Record<string, unknown> {
  return {
    currentHeight: Number(accountMachine.currentHeight ?? 0),
    currentHash: accountMachine.currentFrame?.stateHash ?? null,
    currentPrev: accountMachine.currentFrame?.prevFrameHash ?? null,
    currentTimestamp: Number(accountMachine.currentFrame?.timestamp ?? 0),
    pendingHeight: Number(accountMachine.pendingFrame?.height ?? 0),
    pendingHash: accountMachine.pendingFrame?.stateHash ?? null,
    pendingPrev: accountMachine.pendingFrame?.prevFrameHash ?? null,
    pendingTimestamp: Number(accountMachine.pendingFrame?.timestamp ?? 0),
    frameHistoryTail: getAccountFrameHistoryView(accountMachine).slice(-3).map((frame) => ({
      height: Number(frame?.height ?? 0),
      stateHash: frame?.stateHash ?? null,
      prevFrameHash: frame?.prevFrameHash ?? null,
    })),
  };
}

type AccountInputReplayClassification = {
  currentHeight: number;
  pendingHeight: number;
  inputHeight: number;
  newFrameHeight: number | undefined;
  ackIsStale: boolean;
  frameIsStale: boolean;
};

function classifyAccountInputReplay(
  accountMachine: AccountMachine,
  input: AccountInput,
): AccountInputReplayClassification {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const currentHeight = Number(accountMachine.currentHeight ?? 0);
  const pendingHeight = Number(accountMachine.pendingFrame?.height ?? 0);
  const inputHeight =
    ack?.height === undefined || ack.height === null
      ? 0
      : Number(ack.height);
  const newFrameHeight =
    proposal?.frame === undefined || proposal.frame === null
      ? undefined
      : Number(proposal.frame.height);
  const ackIsStale =
    Boolean(ack?.frameHanko) &&
    inputHeight > 0 &&
    (
      (pendingHeight > 0 && inputHeight < pendingHeight) ||
      (pendingHeight === 0 && inputHeight <= currentHeight)
    );
  const frameIsStale =
    newFrameHeight !== undefined &&
    newFrameHeight <= currentHeight;
  return {
    currentHeight,
    pendingHeight,
    inputHeight,
    newFrameHeight,
    ackIsStale,
    frameIsStale,
  };
}

async function buildDuplicateCommittedFrameAck(
  accountMachine: AccountMachine,
  input: AccountInput,
  events: string[],
  replayCurrentHeight: number,
  receivedFrame: AccountFrame,
): Promise<HandleAccountInputResult | null> {
  const receivedHeight = Number(receivedFrame.height ?? 0);
  if (
    receivedHeight !== replayCurrentHeight ||
    receivedFrame.stateHash !== accountMachine.currentFrame?.stateHash
  ) {
    return null;
  }
  const pendingResponse = accountMachine.pendingAccountInput;
  const pendingResponseAck = pendingResponse ? accountInputAck(pendingResponse) : undefined;
  if (
    pendingResponse &&
    pendingResponseAck &&
    Number(pendingResponseAck.height) === receivedHeight &&
    pendingResponse.toEntityId.toLowerCase() === input.fromEntityId.toLowerCase()
  ) {
    events.push(
      `↩️ Re-sent cached response for duplicate committed frame ${String(receivedHeight)}`,
    );
    return {
      success: true,
      response: structuredClone(pendingResponse),
      events,
    };
  }
  const cachedAck = accountMachine.lastOutboundFrameAck;
  if (
    cachedAck &&
    Number(cachedAck.height) === receivedHeight &&
    cachedAck.counterpartyEntityId.toLowerCase() === input.fromEntityId.toLowerCase()
  ) {
    events.push(
      `↩️ Re-sent ACK for duplicate committed frame ${String(receivedHeight)}`,
    );
    return {
      success: true,
      response: structuredClone(cachedAck.response),
      events,
    };
  }
  return {
    success: false,
    error: `DUPLICATE_ACK_CACHE_MISSING: height=${receivedHeight}`,
    events,
  };
}

async function handleReplayOrObsoleteAccountInput(
  accountMachine: AccountMachine,
  input: AccountInput,
  replay: AccountInputReplayClassification,
  events: string[],
): Promise<HandleAccountInputResult | undefined> {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  if (proposal) {
    // Network delivery is at-least-once. If the peer retries an already
    // committed frame because our ACK was lost, re-ACK before the generic stale
    // guards. The safety gate is exact: same height and same committed stateHash.
    const duplicateAck = await buildDuplicateCommittedFrameAck(
      accountMachine,
      input,
      events,
      replay.currentHeight,
      proposal.frame,
    );
    if (duplicateAck) return duplicateAck;
  }
  if (replay.ackIsStale && (replay.newFrameHeight === undefined || replay.frameIsStale)) {
    // Network delivery is at-least-once: a valid ACK/frame_ack can arrive after
    // the account has already advanced. Its dispute seal was signed for the old
    // account nonce, so validating it against the newer local nonce creates a
    // false DISPUTE_SEAL_HASH_MISMATCH. Classify pure stale traffic before seal
    // validation; any input that can still advance state falls through and must
    // pass the full dispute-seal checks below.
    accountLog.debug('input.stale_ack_ignored', {
      currentHeight: replay.currentHeight,
      pendingHeight: replay.pendingHeight,
      inputHeight: replay.inputHeight,
      newFrameHeight: replay.newFrameHeight ?? null,
      from: shortId(input.fromEntityId),
    });
    return { success: true, events };
  }
  if (!ack && replay.frameIsStale) {
    accountLog.debug('input.stale_frame_ignored', {
      currentHeight: replay.currentHeight,
      inputHeight: replay.inputHeight,
      newFrameHeight: replay.newFrameHeight ?? null,
      from: shortId(input.fromEntityId),
    });
    return { success: true, events };
  }
  if (
    ack &&
    !proposal &&
    !accountMachine.pendingFrame &&
    (accountMachine.status ?? 'active') !== 'active'
  ) {
    events.push(
      `ℹ️ Ignored obsolete ACK for frozen account frame ${String(replay.inputHeight ?? 'none')} ` +
      `(current=${String(accountMachine.currentHeight ?? 0)}, status=${String(accountMachine.status)})`,
    );
    accountLog.debug('input.frozen_ack_ignored', {
      currentHeight: replay.currentHeight,
      inputHeight: replay.inputHeight,
      status: accountMachine.status,
      from: shortId(input.fromEntityId),
    });
    return { success: true, events };
  }
  return undefined;
}

type PendingFrameAckResult =
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

async function verifyPendingAckCertificate(
  env: Env,
  accountMachine: AccountMachine,
  ack: AccountFrameAck,
  ackHeight: number,
  validatedSeal: ValidatedCounterpartyDisputeSeal | undefined,
  events: string[],
  securityContext: AccountInputSecurityContext,
): Promise<PendingAckCertificateResult> {
  const sealError = disputeSealRequirementError(
    accountMachine.currentDisputeProofBodyHash,
    accountMachine.counterpartyDisputeProofBodyHash,
    accountMachine.counterpartyDisputeProofNonce,
    Number(accountMachine.jNonce ?? 0),
    validatedSeal,
  );
  if (sealError) {
    return { kind: 'return', result: { success: false, error: sealError, events } };
  }

  const pendingFrame = accountMachine.pendingFrame!;
  const frameHash = pendingFrame.stateHash;
  if (typeof ack.frameHash !== 'string' || ack.frameHash.toLowerCase() !== frameHash.toLowerCase()) {
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

  const expectedEntity = accountMachine.proofHeader.toEntity;
  accountLog.debug('hanko.ack.verify', { height: ackHeight, frame: shortHash(frameHash) });
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
  if (!verified.entityId || verified.entityId.toLowerCase() !== expectedEntity.toLowerCase()) {
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
  accountLog.debug('hanko.ack.verified', {
    from: shortId(verified.entityId),
    height: ackHeight,
  });
  return { kind: 'continue', ack, ackHanko: ack.frameHanko, frameHash };
}

async function applyPendingFrameTransactions(
  env: Env,
  accountMachine: AccountMachine,
  pendingFrame: AccountFrame,
  committedJClaims: AccountJClaimSession,
  timedOutHashlocks: string[],
  candidateEffects: EntityCandidateEffect[],
): Promise<void> {
  const pendingJHeight = pendingFrame.jHeight ?? accountMachine.lastFinalizedJHeight ?? 0;
  for (const tx of pendingFrame.accountTxs) {
    const beforeSettlement = captureSettlementVector(accountMachine);
    const result = await applyAccountTx(
      accountMachine,
      tx,
      pendingFrame.byLeft!,
      pendingFrame.timestamp,
      pendingJHeight,
      false,
      env,
      committedJClaims,
    );
    candidateEffects.push(...(result.candidateEffects ?? []));
    if (!result.success) {
      accountLog.error('frame.commit.failed', {
        side: 'proposer',
        type: tx.type,
        error: result.error,
      });
      throw new Error(
        `Frame ${pendingFrame.height} commit failed: ${tx.type} - ${result.error}`,
      );
    }
    assertNoUnilateralSettlementMutation(
      accountMachine,
      beforeSettlement,
      tx,
      'proposer/commit',
    );
    if (result.timedOutHashlock) timedOutHashlocks.push(result.timedOutHashlock);
  }
  commitStagedAccountCommitmentCache(accountMachine);
  assertLiveCommitMatchesFrame(
    accountMachine,
    pendingFrame.accountStateRoot,
    'proposer',
    pendingFrame.height,
  );
}

function installPendingFrameCommit(
  accountMachine: AccountMachine,
  input: AccountInput,
  pendingFrame: AccountFrame,
  ack: AccountFrameAck,
  ackHanko: string,
  validatedSeal: ValidatedCounterpartyDisputeSeal | undefined,
  committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }>,
): number {
  accountMachine.currentFrame = structuredClone(pendingFrame);
  accountMachine.currentHeight = pendingFrame.height;
  // The peer ACK is the second half of this exact bilateral certificate.
  // Dropping it would make later board rotation unable to prove mutual commit.
  accountMachine.counterpartyFrameHanko = ackHanko;
  if (ack.disputeSeal) {
    storeCounterpartyDisputeSeal(accountMachine, validatedSeal);
    accountLog.debug('hanko.dispute_ack_stored', {
      nonce: ack.disputeSeal.proofNonce,
      from: shortId(input.fromEntityId),
    });
  }

  const committedFrame = cloneAccountFrame(pendingFrame);
  committedFrames.push({ frame: committedFrame, committedViaNewFrame: false });
  appendAccountFrameHistoryView(accountMachine, committedFrame);
  accountLog.debug('frame.indexed', {
    source: 'ackCommit',
    height: pendingFrame.height,
  });

  delete accountMachine.pendingFrame;
  delete accountMachine.pendingAccountInput;
  delete accountMachine.pendingAccountInputSignerId;
  delete accountMachine.clonedForValidation;
  discardStagedAccountCommitmentCache(accountMachine);
  if (
    accountMachine.lastOutboundFrameAck &&
    Number(accountMachine.lastOutboundFrameAck.height) < Number(pendingFrame.height)
  ) {
    delete accountMachine.lastOutboundFrameAck;
  }
  accountMachine.rollbackCount = Math.max(0, accountMachine.rollbackCount - 1);
  if (accountMachine.rollbackCount === 0) delete accountMachine.lastRollbackFrameHash;
  return pendingFrame.height;
}

async function queuePostAckWork(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  committedHeight: number,
  securityContext: AccountInputSecurityContext,
  candidateEffects: EntityCandidateEffect[],
  events: string[],
): Promise<void> {
  // Auto-rebalance must observe the committed state with pendingFrame cleared.
  // Running it earlier silently suppresses the check as "frame still pending".
  const txs = await runPostFrameAutoRebalanceCheck(
    env,
    accountMachine,
    accountMachine.proofHeader.fromEntity,
    input.fromEntityId,
    committedHeight,
    securityContext.owningEntityIsHub,
    candidateEffects,
  );
  if (txs.length === 0) return;
  appendAccountMempoolTxs(accountMachine, txs, 'accountConsensus:ackAutoRebalance');
  events.push(`🔄 Auto-rebalance queued ${txs.length} tx(s) after ACK commit`);
}

async function handlePendingFrameAck(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  ackHeight: number | undefined,
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }>,
  committedJClaims: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
  candidateEffects: EntityCandidateEffect[],
): Promise<PendingFrameAckResult> {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const pendingFrame = accountMachine.pendingFrame;
  if (!(pendingFrame && ackHeight === pendingFrame.height && ack)) {
    return { kind: 'not_applicable' };
  }
  if (HEAVY_LOGS) accountLog.debug('ack.debug', { from: shortId(input.fromEntityId), to: shortId(input.toEntityId) });
  const certificate = await verifyPendingAckCertificate(
    env,
    accountMachine,
    ack,
    ackHeight,
    validatedCounterpartyDisputeSeal,
    events,
    securityContext,
  );
  if (certificate.kind === 'return') return certificate;

  const tokenIds = deriveAccountFrameTokenIds(pendingFrame);
  accountLog.debug('frame.commit', {
    height: pendingFrame.height,
    txs: pendingFrame.accountTxs.map(tx => tx.type),
    tokens: tokenIds,
    state: shortHash(certificate.frameHash),
  });
  const { counterparty: cpForLog } = getAccountPerspective(accountMachine, accountMachine.proofHeader.fromEntity);
  accountLog.debug('frame.reexecute', {
    height: pendingFrame.height,
    counterparty: shortId(cpForLog),
    txs: pendingFrame.accountTxs.length,
  });
  await applyPendingFrameTransactions(
    env,
    accountMachine,
    pendingFrame,
    committedJClaims,
    timedOutHashlocks,
    candidateEffects,
  );
  accountLog.debug('frame.commit.complete', {
    side: 'proposer',
    counterparty: shortId(cpForLog),
    height: pendingFrame.height,
    tokens: accountMachine.deltas.size,
  });
  const committedHeight = installPendingFrameCommit(
    accountMachine,
    input,
    pendingFrame,
    ack,
    certificate.ackHanko,
    validatedCounterpartyDisputeSeal,
    committedFrames,
  );
  events.push(`✅ Frame ${ackHeight} confirmed and committed`);
  await queuePostAckWork(
    env,
    accountMachine,
    input,
    committedHeight,
    securityContext,
    candidateEffects,
    events,
  );
  // Entity consensus owns the only Account proposal flush. A pure ACK may
  // unlock queued work, but proposing here would expose a half-finalized
  // pendingFrame before the Entity pass binds its route and signer.
  if (!proposal) {
    if (HEAVY_LOGS) accountLog.debug('return.ack_only', { height: ackHeight });
    return {
      kind: 'return',
      result: { success: true, events, timedOutHashlocks, ...(committedFrames.length > 0 && { committedFrames }) },
    };
  }
  return { kind: 'fallthrough' };
}

type AccountCommittedFrame = NonNullable<HandleAccountInputResult['committedFrames']>[number];
type AccountRevealedSecret = { secret: string; hashlock: string };
type AccountSwapCancelRequest = { offerId: string; accountId: string };

type IncomingFramePreflightResult =
  | {
    kind: 'continue';
    receivedFrame: AccountFrame;
    ourEntityId: string;
    frameJHeight: number;
    rollbackPendingFrame: boolean;
  }
  | { kind: 'return'; result: HandleAccountInputResult };

type IncomingFrameValidation = {
  clonedMachine: AccountMachine;
  proofResult: ReturnType<typeof buildAccountProofBodyFromEnv>;
  processEvents: string[];
  revealedSecrets: AccountRevealedSecret[];
  swapOffersCreated: AccountSwapOfferCreated[];
  swapCancelRequests: AccountSwapCancelRequest[];
  swapOffersCancelled: AccountSwapCancelRequest[];
};

type IncomingFrameValidationResult =
  | { kind: 'continue'; validation: IncomingFrameValidation }
  | { kind: 'return'; result: HandleAccountInputResult };

type IncomingFrameResult =
  | { kind: 'not_applicable' }
  | { kind: 'return'; result: HandleAccountInputResult };

const isRefreshableStaleIncomingSettlementSeal = (
  account: AccountMachine,
  frame: AccountFrame,
  error: string | undefined,
): boolean => {
  const match = /^Frame application failed: SETTLEMENT_SEAL_NONCE_MISMATCH:(\d+):(\d+):j=\d+:next=\d+:local=\d+:peer=\d+$/
    .exec(error ?? '');
  if (!match) return false;

  const suppliedNonce = Number(match[1]);
  const requiredNonce = Number(match[2]);
  if (
    !Number.isSafeInteger(suppliedNonce) ||
    !Number.isSafeInteger(requiredNonce) ||
    suppliedNonce >= requiredNonce ||
    requiredNonce !== getMinimumSafeSettlementNonce(account)
  ) {
    return false;
  }

  const workspace = account.settlementWorkspace;
  if (!workspace || workspace.nonceAtSign !== undefined) return false;
  const matchingSeals = frame.accountTxs.filter((tx) =>
    tx.type === 'settle_transition' &&
    tx.data.kind === 'seal' &&
    tx.data.settlementNonce === suppliedNonce &&
    tx.data.version === workspace.version &&
    tx.data.workspaceHash.toLowerCase() === workspace.workspaceHash.toLowerCase()
  );
  return matchingSeals.length === 1;
};

type AccountAckTarget = {
  pendingHeight: number;
  bundledNewFrameHeight: number | undefined;
  ackHeight: number | undefined;
};

function resolveAccountAckTarget(
  accountMachine: AccountMachine,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
): AccountAckTarget {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const pendingHeight = Number(accountMachine.pendingFrame?.height ?? 0);
  const bundledNewFrameHeight =
    proposal?.frame === undefined || proposal.frame === null
      ? undefined
      : Number(proposal.frame.height);
  const ackTargetsPendingFrame =
    Boolean(ack) &&
    Boolean(accountMachine.pendingFrame) &&
    // Normal ACK-only message.
    (normalizedInputHeight === pendingHeight ||
      // BATCHED message: ACK for pending frame + next proposed frame.
      (bundledNewFrameHeight !== undefined && bundledNewFrameHeight === pendingHeight + 1));
  return {
    pendingHeight,
    bundledNewFrameHeight,
    ackHeight: ackTargetsPendingFrame ? pendingHeight : normalizedInputHeight,
  };
}

function isSameHeightSimultaneousProposalAck(
  accountMachine: AccountMachine,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
): boolean {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const pendingFrameHeight = Number(accountMachine.pendingFrame?.height ?? 0);
  return (
    Boolean(ack) &&
    Boolean(proposal) &&
    pendingFrameHeight > 0 &&
    Number(proposal?.frame.height ?? 0) === pendingFrameHeight &&
    Number(normalizedInputHeight ?? 0) === pendingFrameHeight - 1
  );
}

function handleUnmatchedAck(
  accountMachine: AccountMachine,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
  ackProcessed: boolean,
  events: string[],
  committedFrames: AccountCommittedFrame[],
  phase: 'before_frame' | 'after_frame',
): HandleAccountInputResult | undefined {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  if (!ack || ackProcessed) return undefined;
  if (phase === 'before_frame') {
    if (!accountMachine.pendingFrame || isSameHeightSimultaneousProposalAck(accountMachine, input, normalizedInputHeight)) {
      return undefined;
    }
    const pending = accountMachine.pendingFrame.height;
    const staleAck =
      normalizedInputHeight !== undefined &&
      Number(normalizedInputHeight) > 0 &&
      Number(normalizedInputHeight) <= Number(accountMachine.currentHeight ?? 0);
    if (staleAck) {
      events.push(
        `ℹ️ Ignored stale ACK for frame ${String(normalizedInputHeight)} (current=${String(accountMachine.currentHeight ?? 0)}, pending=${String(pending)})`,
      );
      return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
    }
    return {
      success: false,
      error:
        `Unmatched ACK with pending frame: ` +
        `inputHeight=${String(normalizedInputHeight ?? 'none')} ` +
        `pending=${String(pending)} ` +
        `newFrame=${String(proposal?.frame.height ?? 'none')}`,
      events,
    };
  }

  if (proposal) return undefined;
  const pending = accountMachine.pendingFrame?.height ?? 'none';
  const nextHeightAckWithoutPending =
    normalizedInputHeight !== undefined &&
    Number(normalizedInputHeight) === Number(accountMachine.currentHeight ?? 0) + 1 &&
    !accountMachine.pendingFrame;
  const staleAck =
    normalizedInputHeight !== undefined &&
    Number(normalizedInputHeight) > 0 &&
    Number(normalizedInputHeight) <= Number(accountMachine.currentHeight ?? 0);
  if (staleAck) {
    events.push(
      `ℹ️ Ignored stale ACK for frame ${String(normalizedInputHeight)} (current=${String(accountMachine.currentHeight ?? 0)}, pending=${String(pending)})`,
    );
    return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
  }
  if (nextHeightAckWithoutPending) {
    // Remote delivery is only ordered per transport, not across the local
    // frame-install tick. A pure ACK for the next frame cannot advance state
    // without the matching pending frame, so keep it non-mutating and rely on
    // the account pending resend path to recover the ACK deterministically.
    events.push(
      `Ignored early ACK for frame ${String(normalizedInputHeight)} (current=${String(accountMachine.currentHeight ?? 0)}, pending=none)`,
    );
    return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
  }
  return {
    success: false,
    error: `Unmatched ACK: height=${String(normalizedInputHeight ?? 'none')} pending=${String(pending)}`,
    events,
  };
}

function resolveSameHeightIncomingFrame(
  accountMachine: AccountMachine,
  receivedFrame: AccountFrame,
  events: string[],
  committedFrames: AccountCommittedFrame[],
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
): HandleAccountInputResult | true | undefined {
  if (!(accountMachine.pendingFrame && receivedFrame.height === accountMachine.pendingFrame.height)) {
    return undefined;
  }

  // Simultaneous proposal tiebreaker: left keeps its pending frame, right rolls back.
  const isLeftEntity = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
  if (HEAVY_LOGS) {
    accountLog.debug('frame.tiebreaker', {
      from: shortId(accountMachine.proofHeader.fromEntity),
      to: shortId(accountMachine.proofHeader.toEntity),
      isLeft: isLeftEntity,
    });
  }

  const pendingSettlementNonceConflict = validatedCounterpartyDisputeSeal
    ? accountMachine.pendingFrame.accountTxs.some((tx) =>
        tx.type === 'settle_transition' &&
        tx.data.kind === 'seal' &&
        tx.data.settlementNonce <= validatedCounterpartyDisputeSeal.nonce
      )
    : false;

  if (isLeftEntity && !pendingSettlementNonceConflict) {
    events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${receivedFrame.height} (waiting for their ACK)`);
    if (accountMachine.mempool.length > 0) {
      events.push(`⚠️ LEFT has ${accountMachine.mempool.length} pending txs while waiting for RIGHT's ACK`);
    }
    const pendingResponse = accountMachine.pendingAccountInput;
    const pendingProposal = pendingResponse ? accountInputProposal(pendingResponse) : undefined;
    if (
      !pendingResponse ||
      !pendingProposal ||
      pendingProposal.frame.stateHash !== accountMachine.pendingFrame.stateHash
    ) {
      throw new Error(`ACCOUNT_COLLISION_PENDING_RESPONSE_MISSING:${receivedFrame.height}`);
    }
    // LEFT did not accept the peer proposal, so it owes no ACK. It must resend
    // the exact already-signed proposal that won the deterministic collision;
    // rebuilding it would risk changing bytes, nonce, or Hanko.
    return {
      success: true,
      response: structuredClone(pendingResponse),
      events,
      ...(committedFrames.length > 0 && { committedFrames }),
    };
  }

  if (isLeftEntity) {
    // LEFT normally wins a same-height collision. A settlement authorization
    // cannot win after the peer has produced a valid dispute proof at the same
    // or a higher shared Account-contract nonce: the peer signature already
    // makes that nonce unsafe to reuse for settlement. Yield to the peer frame,
    // then restore and rebuild our pending transactions at the next nonce.
    events.push(
      `🔄 LEFT-YIELDS: peer proof nonce ${validatedCounterpartyDisputeSeal!.nonce} ` +
      `invalidated our pending settlement nonce`,
    );
  }

  const receivedHash = receivedFrame.stateHash;
  if (accountMachine.lastRollbackFrameHash === receivedHash) {
    accountLog.debug('rollback.duplicate', { frame: shortHash(receivedHash) });
    return undefined;
  }

  return true;
}

function applySameHeightIncomingFrameRollback(
  _env: Env,
  accountMachine: AccountMachine,
  _input: AccountInput,
  receivedFrame: AccountFrame,
  events: string[],
): void {
  const receivedHash = receivedFrame.stateHash;
  let restoredTxCount = 0;
  if (accountMachine.pendingFrame) {
    restoredTxCount = accountMachine.pendingFrame.accountTxs.length;
    const uniqueRestored = prependUniqueMempoolTxs(accountMachine, accountMachine.pendingFrame.accountTxs);

    events.push(
      `🔄 ROLLBACK: Discarded our frame ${accountMachine.pendingFrame.height}, restored ${uniqueRestored}/${restoredTxCount} txs to mempool`,
    );
  }

  delete accountMachine.pendingFrame;
  delete accountMachine.pendingAccountInput;
  delete accountMachine.pendingAccountInputSignerId;
  delete accountMachine.clonedForValidation;
  discardStagedAccountCommitmentCache(accountMachine);
  accountMachine.rollbackCount = Math.max(1, accountMachine.rollbackCount + 1);
  accountMachine.lastRollbackFrameHash = receivedHash; // Track this rollback
  if (accountMachine.rollbackCount > 1) {
    accountLog.warn('rollback.retry', { count: accountMachine.rollbackCount, frame: shortHash(receivedHash) });
  }

  events.push(`📥 Accepted LEFT's frame ${receivedFrame.height} (we are RIGHT, deterministic tiebreaker)`);
}

async function verifyIncomingFrameHanko(
  env: Env,
  input: AccountInput,
  receivedFrame: AccountFrame,
  events: string[],
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult | undefined> {
  const hankoToVerify = accountInputProposal(input)?.frameHanko;
  if (!hankoToVerify) {
    return { success: false, error: 'SECURITY: Frame must have hanko signature', events };
  }

  accountLog.debug('hanko.frame.verify', { height: receivedFrame.height, from: shortId(input.fromEntityId) });

  // Verify hanko - CRITICAL: Must verify fromEntityId is the signer with board validation
  const { valid, entityId: recoveredEntityId } = await verifyHankoForHash(
    hankoToVerify,
    receivedFrame.stateHash,
    input.fromEntityId,
    env,
    securityContext.counterpartyCertifiedBoardHash
      ? { registeredBoardHash: securityContext.counterpartyCertifiedBoardHash }
      : undefined,
  );

  if (!valid || !recoveredEntityId) {
    return { success: false, error: `Invalid hanko signature from ${input.fromEntityId.slice(-4)}`, events };
  }

  accountLog.debug('hanko.frame.verified', { height: receivedFrame.height, from: shortId(recoveredEntityId) });
  return undefined;
}

async function handleStaleIncomingFrame(
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  replayCurrentHeight: number,
  events: string[],
  committedFrames: AccountCommittedFrame[],
): Promise<HandleAccountInputResult | undefined> {
  if (Number(receivedFrame.height) > Number(accountMachine.currentHeight ?? 0)) {
    return undefined;
  }
  const duplicateAck = await buildDuplicateCommittedFrameAck(
    accountMachine,
    input,
    events,
    replayCurrentHeight,
    receivedFrame,
  );
  if (duplicateAck) return duplicateAck;
  events.push(
    `ℹ️ Ignored stale frame ${String(receivedFrame.height)} ` +
    `(current=${String(accountMachine.currentHeight ?? 0)})`,
  );
  return {
    success: true,
    events,
    ...(committedFrames.length > 0 && { committedFrames }),
  };
}

function validateIncomingFrameProposer(
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  events: string[],
): HandleAccountInputResult | undefined {
  const proposer = input.fromEntityId.toLowerCase();
  const proposerIsLeft = proposer === accountMachine.leftEntity.toLowerCase();
  if (!proposerIsLeft && proposer !== accountMachine.rightEntity.toLowerCase()) {
    return {
      success: false,
      error: `Frame proposer is not an account party: ${input.fromEntityId.slice(-8)}`,
      events,
    };
  }
  if (receivedFrame.byLeft === proposerIsLeft) return undefined;
  return {
    success: false,
    error:
      `Frame proposer side mismatch: expected byLeft=${String(proposerIsLeft)} ` +
      `for proposer ${input.fromEntityId.slice(-4)}, got ${String(receivedFrame.byLeft)}`,
    events,
  };
}

function validateIncomingFrameChain(
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  normalizedInputHeight: number | undefined,
  securityContext: AccountInputSecurityContext,
  events: string[],
): HandleAccountInputResult | undefined {
  const structureError = getAccountFrameValidationError(
    receivedFrame,
    securityContext.entityTimestamp,
  );
  if (structureError) {
    return {
      success: false,
      error: `Invalid frame structure: ${structureError}`,
      events,
    };
  }

  const previousTimestamp = accountMachine.currentFrame?.timestamp;
  if (previousTimestamp !== undefined && receivedFrame.timestamp < previousTimestamp) {
    accountLog.warn('frame.timestamp_regressed_accepted', {
      accountHeight: accountMachine.currentHeight,
      entityId: input.toEntityId,
      counterpartyEntityId: input.fromEntityId,
      previousTimestamp,
      proposedTimestamp: receivedFrame.timestamp,
      regressionMs: previousTimestamp - receivedFrame.timestamp,
      entityTimestamp: securityContext.entityTimestamp,
    });
  }

  const expectedPrevHash =
    accountMachine.currentHeight === 0 ? 'genesis' : accountMachine.currentFrame.stateHash || '';
  if (receivedFrame.prevFrameHash !== expectedPrevHash) {
    const mismatch = {
      inputFromEntityId: input.fromEntityId,
      inputToEntityId: input.toEntityId,
      inputHeight: normalizedInputHeight ?? null,
      receivedHeight: Number(receivedFrame.height ?? 0),
      receivedStateHash: receivedFrame.stateHash ?? null,
      receivedPrevFrameHash: receivedFrame.prevFrameHash ?? null,
      receivedTxTypes: receivedFrame.accountTxs.map((tx) => tx.type),
      expectedPrevFrameHash: expectedPrevHash,
      account: describeAccountState(accountMachine),
    };
    accountLog.warn('frame.prev_hash_mismatch', mismatch);
    return {
      success: false,
      error:
        `Frame chain broken: prevFrameHash mismatch ` +
        `(expected ${expectedPrevHash.slice(0, 16)}..., ` +
        `got ${String(receivedFrame.prevFrameHash).slice(0, 16)}..., ` +
        `current=${accountMachine.currentHeight}, ` +
        `pending=${Number(accountMachine.pendingFrame?.height ?? 0)})`,
      events,
    };
  }

  const expectedHeight = accountMachine.currentHeight + 1;
  if (HEAVY_LOGS) {
    accountLog.debug('frame.sequence_check', {
      receivedHeight: receivedFrame.height,
      currentHeight: accountMachine.currentHeight,
      expectedHeight,
    });
  }
  if (receivedFrame.height === expectedHeight) return undefined;
  accountLog.warn('frame.sequence_mismatch', {
    expectedHeight,
    receivedHeight: receivedFrame.height,
  });
  return {
    success: false,
    error: `Frame sequence mismatch: expected ${expectedHeight}, got ${receivedFrame.height}`,
    events,
  };
}

function validateIncomingFrameDeadline(
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  securityContext: AccountInputSecurityContext,
  events: string[],
): HandleAccountInputResult | undefined {
  const staleByMs = securityContext.entityTimestamp - receivedFrame.timestamp;
  const collateralPriorityRisk =
    staleByMs > 0 &&
    receivedFrame.accountTxs.some((tx) => tx.type === 'request_collateral');
  if (staleByMs > STALE_ACCOUNT_FRAME_WARNING_MS || collateralPriorityRisk) {
    accountLog.warn('frame.stale_accepted', {
      height: receivedFrame.height,
      staleByMs,
      txs: receivedFrame.accountTxs.map((tx) => tx.type),
      collateralPriorityRisk,
    });
  }

  const violation = getIncomingAccountDeadlineViolation(
    accountMachine,
    receivedFrame,
    securityContext,
  );
  if (!violation) return undefined;
  const proposal = accountInputProposal(input)!;
  if (!proposal.frameHanko) {
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
}

async function preflightIncomingAccountFrame(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
  replayCurrentHeight: number,
  events: string[],
  committedFrames: AccountCommittedFrame[],
  securityContext: AccountInputSecurityContext,
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
): Promise<IncomingFramePreflightResult> {
  const receivedFrame = accountInputProposal(input)?.frame;
  if (!receivedFrame) {
    throw new Error('preflightIncomingAccountFrame called without newAccountFrame');
  }

  const staleResult = await handleStaleIncomingFrame(
    accountMachine,
    input,
    receivedFrame,
    replayCurrentHeight,
    events,
    committedFrames,
  );
  if (staleResult) return { kind: 'return', result: staleResult };

  const proposerError = validateIncomingFrameProposer(
    accountMachine,
    input,
    receivedFrame,
    events,
  );
  if (proposerError) return { kind: 'return', result: proposerError };

  const chainError = validateIncomingFrameChain(
    accountMachine,
    input,
    receivedFrame,
    normalizedInputHeight,
    securityContext,
    events,
  );
  if (chainError) return { kind: 'return', result: chainError };

  const hankoError = await verifyIncomingFrameHanko(env, input, receivedFrame, events, securityContext);
  if (hankoError) return { kind: 'return', result: hankoError };

  const deadlineError = validateIncomingFrameDeadline(
    accountMachine,
    input,
    receivedFrame,
    securityContext,
    events,
  );
  if (deadlineError) return { kind: 'return', result: deadlineError };

  // Resolve simultaneous proposals only after every rejecting preflight has
  // authenticated the frame. RIGHT's rollback is deferred until deterministic
  // replay on a clone succeeds, so a rejected peer frame cannot mutate live
  // pending state or restore its transactions into the mempool.
  const sameHeightResolution = resolveSameHeightIncomingFrame(
    accountMachine,
    receivedFrame,
    events,
    committedFrames,
    validatedCounterpartyDisputeSeal,
  );
  if (sameHeightResolution !== true && sameHeightResolution) {
    return { kind: 'return', result: sameHeightResolution };
  }

  const ourEntityId = accountMachine.proofHeader.fromEntity;
  const currentJHeight = accountMachine.lastFinalizedJHeight ?? 0;
  const frameJHeight = receivedFrame.jHeight ?? currentJHeight;

  return {
    kind: 'continue',
    receivedFrame,
    ourEntityId,
    frameJHeight,
    rollbackPendingFrame: sameHeightResolution === true,
  };
}

function collectReceiverValidationDeltas(clonedMachine: AccountMachine): {
  tokenIds: number[];
  deltas: Delta[];
} {
  const tokenIds: number[] = [];
  const deltas: Delta[] = [];
  const sortedOurTokens = Array.from(clonedMachine.deltas.entries()).sort((a, b) => a[0] - b[0]);

  for (const [tokenId, delta] of sortedOurTokens) {
    // CRITICAL: Use offdelta ONLY for frame comparison (same as proposer).
    const totalDelta = delta.offdelta;

    if (!shouldIncludeToken(delta, totalDelta)) {
      if (HEAVY_LOGS) accountLog.debug('receiver.token.skip_unused', { tokenId });
      continue;
    }

    tokenIds.push(tokenId);
    deltas.push({ ...delta });
  }

  if (HEAVY_LOGS) {
    accountLog.debug('receiver.tokens.computed', { tokenIds });
  }
  return { tokenIds, deltas };
}

const accountFrameDeltasEqual = (left: readonly Delta[], right: readonly Delta[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((delta, index) => {
    const peer = right[index];
    return peer !== undefined &&
      delta.tokenId === peer.tokenId &&
      delta.collateral === peer.collateral &&
      delta.ondelta === peer.ondelta &&
      delta.offdelta === peer.offdelta &&
      delta.leftCreditLimit === peer.leftCreditLimit &&
      delta.rightCreditLimit === peer.rightCreditLimit &&
      delta.leftAllowance === peer.leftAllowance &&
      delta.rightAllowance === peer.rightAllowance &&
      delta.leftHold === peer.leftHold &&
      delta.rightHold === peer.rightHold;
  });
};

async function verifySenderFrameHash(
  receivedFrame: AccountFrame,
  events: string[],
): Promise<HandleAccountInputResult | undefined> {
  if (HEAVY_LOGS) accountLog.debug('frame.hash.verify_start', { height: receivedFrame.height });
  const senderHashFrame: AccountFrame = {
    height: receivedFrame.height,
    timestamp: receivedFrame.timestamp,
    jHeight: receivedFrame.jHeight,
    accountTxs: receivedFrame.accountTxs,
    prevFrameHash: receivedFrame.prevFrameHash,
    accountStateRoot: receivedFrame.accountStateRoot,
    deltas: receivedFrame.deltas,
    stateHash: '', // Computed by createFrameHash
    ...(receivedFrame.byLeft === undefined ? {} : { byLeft: receivedFrame.byLeft }),
  };
  const recomputedSenderHash = await createFrameHash(senderHashFrame);

  if (recomputedSenderHash !== receivedFrame.stateHash) {
    accountLog.warn('frame.hash_mismatch', {
      recomputed: shortHash(recomputedSenderHash),
      claimed: shortHash(receivedFrame.stateHash),
    });
    return { success: false, error: `Frame hash verification failed - dispute proof mismatch`, events };
  }
  return undefined;
}

async function validateIncomingFrameOnClone(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  frameJHeight: number,
  events: string[],
  timedOutHashlocks: string[],
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
  accountJClaimNodeStore: AccountJClaimNodeStore,
  securityContext: AccountInputSecurityContext,
): Promise<IncomingFrameValidationResult> {
  const clonedMachine = cloneAccountMachine(accountMachine);
  const jClaimSession = createAccountJClaimSession(env, accountJClaimNodeStore);
  const processEvents: string[] = [];
  const revealedSecrets: AccountRevealedSecret[] = [];
  const swapOffersCreated: AccountSwapOfferCreated[] = [];
  const swapCancelRequests: AccountSwapCancelRequest[] = [];
  const swapOffersCancelled: AccountSwapCancelRequest[] = [];

  accountLog.debug('frame.receiver_validate', {
    height: receivedFrame.height,
    txs: receivedFrame.accountTxs.map(tx => tx.type),
  });
  for (const accountTx of receivedFrame.accountTxs) {
    const beforeSettlement = captureSettlementVector(clonedMachine);
    const result = await applyAccountTx(
      clonedMachine,
      accountTx,
      receivedFrame.byLeft!,
      receivedFrame.timestamp,
      frameJHeight,
      true,
      env,
      jClaimSession,
      securityContext.counterpartyCertifiedBoardHash,
    );
    if (!result.success) {
      return { kind: 'return', result: { success: false, error: `Frame application failed: ${result.error}`, events } };
    }
    assertNoUnilateralSettlementMutation(clonedMachine, beforeSettlement, accountTx, 'receiver/validate');
    processEvents.push(...result.events);

    if (HEAVY_LOGS) accountLog.debug('receiver.tx.processed', { type: accountTx.type, success: result.success });
    if (result.secret && result.hashlock) {
      revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
    }
    if (result.timedOutHashlock) {
      timedOutHashlocks.push(result.timedOutHashlock);
    }
    if (result.swapOfferCreated) {
      swapOffersCreated.push(result.swapOfferCreated);
    }
    if (result.swapOfferCancelRequested) {
      swapCancelRequests.push({
        ...result.swapOfferCancelRequested,
        accountId: input.fromEntityId,
      });
    }
    if (result.swapOfferCancelled) {
      swapOffersCancelled.push(result.swapOfferCancelled);
    }
  }

  const frameHashMismatch = await verifySenderFrameHash(receivedFrame, events);
  if (frameHashMismatch) return { kind: 'return', result: frameHashMismatch };

  const { deltas: ourFinalDeltas } = collectReceiverValidationDeltas(clonedMachine);
  const localAccountStateRoot = computeAccountStateRoot(clonedMachine);
  if (
    localAccountStateRoot !== receivedFrame.accountStateRoot ||
    !accountFrameDeltasEqual(ourFinalDeltas, receivedFrame.deltas)
  ) {
    accountLog.warn('frame.state_root_mismatch', {
      height: receivedFrame.height,
      txs: receivedFrame.accountTxs.map(tx => tx.type),
      localAccountStateRoot,
      receivedAccountStateRoot: receivedFrame.accountStateRoot,
      localDeltas: summarizeDeltasForLog(new Map(ourFinalDeltas.map(delta => [delta.tokenId, delta]))),
      receivedDeltas: summarizeDeltasForLog(new Map(receivedFrame.deltas.map(delta => [delta.tokenId, delta]))),
      localAccountStateSectionHashes: computeAccountStateSectionHashes(clonedMachine),
      lastFinalizedJHeight: clonedMachine.lastFinalizedJHeight,
      leftPendingJClaims: clonedMachine.leftPendingJClaims,
      rightPendingJClaims: clonedMachine.rightPendingJClaims,
    });
    return { kind: 'return', result: { success: false, error: 'Bilateral account state root mismatch', events } };
  }
  const proofResult = buildAccountProofBodyFromEnv(env, clonedMachine);
  const localProofBodyHash = proofResult.proofBodyHash;
  const frameSealError = disputeSealRequirementError(
    localProofBodyHash,
    accountMachine.counterpartyDisputeProofBodyHash,
    accountMachine.counterpartyDisputeProofNonce,
    Number(clonedMachine.jNonce ?? accountMachine.jNonce ?? 0),
    validatedCounterpartyDisputeSeal,
  );
  if (frameSealError) {
    return { kind: 'return', result: { success: false, error: frameSealError, events } };
  }

  accountLog.debug('frame.accept', {
    height: receivedFrame.height,
    from: shortId(input.fromEntityId),
    txs: receivedFrame.accountTxs.map(tx => tx.type),
  });

  return {
    kind: 'continue',
    validation: {
      clonedMachine,
      proofResult,
      processEvents,
      revealedSecrets,
      swapOffersCreated,
      swapCancelRequests,
      swapOffersCancelled,
    },
  };
}

async function commitIncomingFrameOnRealState(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  frameJHeight: number,
  validation: IncomingFrameValidation,
  ourEntityId: string,
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
  events: string[],
  committedFrames: AccountCommittedFrame[],
  committedJClaims: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
  candidateEffects: EntityCandidateEffect[],
): Promise<void> {
  const { counterparty: cpForCommitLog } = getAccountPerspective(accountMachine, ourEntityId);
  if (HEAVY_LOGS) {
    accountLog.debug('receiver.commit.reexecute', {
      txs: receivedFrame.accountTxs.length,
      counterparty: shortId(cpForCommitLog),
    });
  }

  for (const tx of receivedFrame.accountTxs) {
    const beforeSettlement = captureSettlementVector(accountMachine);
    const commitResult = await applyAccountTx(
      accountMachine,
      tx,
      receivedFrame.byLeft!,
      receivedFrame.timestamp,
      frameJHeight,
      false,
      env,
      committedJClaims,
      securityContext.counterpartyCertifiedBoardHash,
    );
    candidateEffects.push(...(commitResult.candidateEffects ?? []));

    if (!commitResult.success) {
      accountLog.error('frame.commit.failed', { side: 'receiver', type: tx.type, error: commitResult.error });
      throw new Error(`Frame ${receivedFrame.height} commit failed: ${tx.type} - ${commitResult.error}`);
    }
    assertNoUnilateralSettlementMutation(accountMachine, beforeSettlement, tx, 'receiver/commit');
  }

  forkAccountCommitmentCache(validation.clonedMachine, accountMachine);
  assertLiveCommitMatchesFrame(
    accountMachine,
    receivedFrame.accountStateRoot,
    'receiver',
    receivedFrame.height,
    validation.clonedMachine,
  );

  accountLog.debug('frame.commit.complete', {
    side: 'receiver',
    counterparty: shortId(cpForCommitLog),
    height: receivedFrame.height,
    tokens: accountMachine.deltas.size,
  });
  if (validation.clonedMachine.pendingForwards?.length) {
    accountMachine.pendingForwards = validation.clonedMachine.pendingForwards;
    accountLog.debug('pending_forwards.copied', {
      count: validation.clonedMachine.pendingForwards.length,
      routes: validation.clonedMachine.pendingForwards.map(forward => forward.route.map(r => shortId(r))),
    });
  }

  accountMachine.currentFrame = structuredClone(receivedFrame);
  accountMachine.currentHeight = receivedFrame.height;
  const acceptedFrameHanko = accountInputProposal(input)?.frameHanko;
  if (!acceptedFrameHanko) throw new Error('ACCEPTED_ACCOUNT_FRAME_HANKO_MISSING');
  accountMachine.counterpartyFrameHanko = acceptedFrameHanko;
  if (accountInputProposal(input)?.disputeSeal) {
    storeCounterpartyDisputeSeal(accountMachine, validatedCounterpartyDisputeSeal);
    accountLog.debug('hanko.dispute_frame_stored', { height: receivedFrame.height, from: shortId(input.fromEntityId) });
  }

  const committedFrame = cloneAccountFrame(receivedFrame);
  committedFrames.push({ frame: committedFrame, committedViaNewFrame: true });
  appendAccountFrameHistoryView(accountMachine, committedFrame);
  accountLog.debug('frame.indexed', { source: 'peerCommit', height: receivedFrame.height });

  events.push(...validation.processEvents);
  events.push(`🤝 Accepted frame ${receivedFrame.height} from Entity ${input.fromEntityId.slice(-4)}`);

  const postCommitAutoRebalanceTxs = await runPostFrameAutoRebalanceCheck(
    env,
    accountMachine,
    ourEntityId,
    input.fromEntityId,
    receivedFrame.height,
    securityContext.owningEntityIsHub,
    candidateEffects,
  );
  if (postCommitAutoRebalanceTxs.length > 0) {
    appendAccountMempoolTxs(
      accountMachine,
      postCommitAutoRebalanceTxs,
      'accountConsensus:postCommitAutoRebalance',
    );
    events.push(`🔄 Auto-rebalance queued ${postCommitAutoRebalanceTxs.length} tx(s) after frame commit`);
  }
}

type IncomingFrameAckMaterial = {
  response: Extract<AccountInput, { kind: 'ack' }>;
  outboundAck: {
    height: number;
    counterpartyEntityId: string;
    response: Extract<AccountInput, { kind: 'ack' }>;
  };
  ackDisputeHash?: string;
  ackDisputeHanko: string | undefined;
  ackProofBodyHash: string;
  ackSignedNonce: number;
  proofChanged: boolean;
};

type IncomingFrameAckMaterialResult =
  | { kind: 'continue'; material: IncomingFrameAckMaterial }
  | { kind: 'return'; result: HandleAccountInputResult };

async function buildIncomingFrameAckMaterial(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  ackProofResult: ReturnType<typeof buildAccountProofBodyFromEnv>,
  events: string[],
): Promise<IncomingFrameAckMaterialResult> {
  const ackEntityId = accountMachine.proofHeader.fromEntity;
  const ackReplica = getReplicaByEntityId(env, ackEntityId);
  const ackSignerId = ackReplica?.state.config.validators[0];
  if (!ackSignerId) {
    return { kind: 'return', result: { success: false, error: `Cannot find signerId for ACK from ${ackEntityId.slice(-4)}`, events } };
  }

  const directSigner = ackReplica?.state.config.validators.length === 1 ? ackSignerId : undefined;
  accountLog.debug(directSigner ? 'hanko.ack.sign' : 'hanko.ack.defer_to_entity_quorum', {
    entity: shortId(ackEntityId),
    ...(directSigner ? { signer: shortId(directSigner) } : {}),
    height: receivedFrame.height,
  });

  const ackHankoDomain = getAccountStateDomain(accountMachine);
  const proofChanged =
    ackProofResult.proofBodyHash.toLowerCase() !== accountMachine.currentDisputeProofBodyHash?.toLowerCase() ||
    Number(accountMachine.currentDisputeProofNonce ?? 0) <= Number(accountMachine.jNonce ?? 0);
  const ackSignedNonce = Math.max(
    Number(accountMachine.proofHeader.nextProofNonce ?? 0),
    Number(accountMachine.jNonce ?? 0) + 1,
  );
  const ackDisputeHash = proofChanged
    ? createDisputeProofHashWithNonce(
      accountMachine,
      ackProofResult.proofBodyHash,
      ackHankoDomain,
      ackSignedNonce,
    )
    : undefined;
  let confirmationHanko: HankoString | undefined;
  let ackDisputeHanko: HankoString | undefined;
  if (directSigner) {
    [confirmationHanko, ackDisputeHanko] = await signEntityHashes(env, ackEntityId, directSigner, [
      receivedFrame.stateHash,
      ...(ackDisputeHash ? [ackDisputeHash] : []),
    ]);
    if (!confirmationHanko) {
      return { kind: 'return', result: { success: false, error: 'Failed to build ACK hanko', events } };
    }
  }

  if (proofChanged) {
    if (!ackDisputeHash || (directSigner && !ackDisputeHanko)) {
      return { kind: 'return', result: { success: false, error: 'Failed to build ACK dispute hanko', events } };
    }
    accountMachine.disputeProofNoncesByHash ??= {};
    accountMachine.disputeProofNoncesByHash[ackProofResult.proofBodyHash] = ackSignedNonce;
    accountMachine.disputeProofBodiesByHash ??= {};
    accountMachine.disputeProofBodiesByHash[ackProofResult.proofBodyHash] = ackProofResult.proofBodyStruct;
    storeDisputeArgumentSnapshot(
      accountMachine,
      captureDisputeArgumentSnapshot(
        accountMachine,
        ackProofResult.proofBodyHash,
        ackSignedNonce,
        ackProofResult.proofBodyStruct,
      ),
    );
  }

  const ackDisputeSeal = proofChanged && ackDisputeHash ? {
    ...(ackDisputeHanko ? { hanko: ackDisputeHanko } : {}),
    hash: ackDisputeHash,
    proofBodyHash: ackProofResult.proofBodyHash,
    proofNonce: ackSignedNonce,
  } : (
    accountMachine.currentDisputeProofHanko &&
    accountMachine.currentDisputeHash &&
    accountMachine.currentDisputeProofBodyHash?.toLowerCase() === ackProofResult.proofBodyHash.toLowerCase() &&
    Number(accountMachine.currentDisputeProofNonce ?? 0) > Number(accountMachine.jNonce ?? 0)
      ? {
          hanko: accountMachine.currentDisputeProofHanko,
          hash: accountMachine.currentDisputeHash,
          proofBodyHash: accountMachine.currentDisputeProofBodyHash,
          proofNonce: accountMachine.currentDisputeProofNonce!,
        }
      : undefined
  );

  const response: Extract<AccountInput, { kind: 'ack' }> = {
    kind: 'ack',
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: input.fromEntityId,
    domain: structuredClone(accountMachine.domain),
    watchSeed: accountMachine.watchSeed,
    ack: {
      height: receivedFrame.height,
      frameHash: receivedFrame.stateHash,
      ...(confirmationHanko ? { frameHanko: confirmationHanko } : {}),
      ...(ackDisputeSeal ? { disputeSeal: ackDisputeSeal } : {}),
    },
  };

  return {
    kind: 'continue',
    material: {
      response,
      outboundAck: {
        height: receivedFrame.height,
        counterpartyEntityId: input.fromEntityId,
        response: structuredClone(response),
      },
      ...(ackDisputeHash ? { ackDisputeHash } : {}),
      ackDisputeHanko,
      ackProofBodyHash: ackProofResult.proofBodyHash,
      ackSignedNonce,
      proofChanged,
    },
  };
}

function storeAckDisputeState(
  accountMachine: AccountMachine,
  material: IncomingFrameAckMaterial,
): void {
  if (material.proofChanged && material.ackDisputeHash) {
    if (material.ackDisputeHanko) {
      accountMachine.currentDisputeProofHanko = material.ackDisputeHanko;
    }
    accountMachine.currentDisputeProofNonce = material.ackSignedNonce;
    accountMachine.currentDisputeProofBodyHash = material.ackProofBodyHash;
    accountMachine.currentDisputeHash = material.ackDisputeHash;
  }
}

function buildIncomingFrameReturnPayload(
  input: AccountInput,
  receivedFrame: AccountFrame,
  response: AccountInput,
  validation: IncomingFrameValidation,
  proposeResult: ProposeAccountFrameResult | undefined,
  ackDisputeHash: string | undefined,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: AccountCommittedFrame[],
): HandleAccountInputResult {
  const allRevealedSecrets = [
    ...validation.revealedSecrets,
    ...(proposeResult?.revealedSecrets || []),
  ];
  const allSwapOffersCreated = [...validation.swapOffersCreated, ...(proposeResult?.swapOffersCreated || [])];
  const allSwapCancelRequests = [...validation.swapCancelRequests, ...(proposeResult?.swapCancelRequests || [])];
  const allSwapOffersCancelled = [...validation.swapOffersCancelled, ...(proposeResult?.swapOffersCancelled || [])];
  const hashesToSign: AccountConsensusHashToSign[] = [
    {
      hash: receivedFrame.stateHash,
      type: 'accountFrame',
      context: `account:${input.fromEntityId.slice(-8)}:ack:${receivedFrame.height}`,
    },
    ...(ackDisputeHash
      ? [{ hash: ackDisputeHash, type: 'dispute' as const, context: `account:${input.fromEntityId.slice(-8)}:ack-dispute` }]
      : []),
    ...(proposeResult?.hashesToSign || []),
  ];

  if (HEAVY_LOGS) {
    accountLog.debug('return.response', {
      height: accountInputReferenceHeight(response),
      prevHanko: Boolean(accountInputAck(response)?.frameHanko),
      newFrame: Boolean(accountInputProposal(response)),
    });
  }
  return {
    success: true,
    response,
    events,
    revealedSecrets: allRevealedSecrets,
    swapOffersCreated: allSwapOffersCreated,
    swapCancelRequests: allSwapCancelRequests,
    swapOffersCancelled: allSwapOffersCancelled,
    timedOutHashlocks,
    ...(committedFrames.length > 0 && { committedFrames }),
    ...(hashesToSign.length > 0 && { hashesToSign }),
  };
}

async function buildAckResponseForIncomingFrame(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  validation: IncomingFrameValidation,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: AccountCommittedFrame[],
): Promise<HandleAccountInputResult> {
  const ackMaterial = await buildIncomingFrameAckMaterial(
    env,
    accountMachine,
    input,
    receivedFrame,
    validation.proofResult,
    events,
  );
  if (ackMaterial.kind === 'return') return ackMaterial.result;
  const { material } = ackMaterial;
  storeAckDisputeState(accountMachine, material);
  if (material.proofChanged) accountMachine.proofHeader.nextProofNonce = material.ackSignedNonce + 1;
  // Install the reusable ACK before the final Entity flush. The flush may
  // combine it with a successor proposal, while retries retain these exact
  // ACK bytes independently of that successor.
  accountMachine.lastOutboundFrameAck = material.outboundAck;
  // Entity consensus owns the only Account-output flush point. Do not propose
  // here: later AccountInputs, matching, HTLC hooks, and cross-j hooks in the
  // same Entity frame may enqueue more work for this account. The final
  // proposableAccounts pass emits either ACK+proposal or the mandatory ACK.
  return buildIncomingFrameReturnPayload(
    input,
    receivedFrame,
    material.response,
    validation,
    undefined,
    material.ackDisputeHash,
    events,
    timedOutHashlocks,
    committedFrames,
  );
}

async function handleIncomingAccountFrame(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
  replayCurrentHeight: number,
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: AccountCommittedFrame[],
  committedJClaims: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
  candidateEffects: EntityCandidateEffect[],
): Promise<IncomingFrameResult> {
  if (!accountInputProposal(input)) {
    return { kind: 'not_applicable' };
  }

  const preflight = await preflightIncomingAccountFrame(
    env,
    accountMachine,
    input,
    normalizedInputHeight,
    replayCurrentHeight,
    events,
    committedFrames,
    securityContext,
    validatedCounterpartyDisputeSeal,
  );
  if (preflight.kind === 'return') {
    if (!preflight.result.success && !preflight.result.disputeRequired) {
      return {
        kind: 'return',
        result: {
          ...preflight.result,
          rejected: { reason: preflight.result.error ?? 'Incoming account frame rejected' },
        },
      };
    }
    return preflight;
  }

  const validationResult = await validateIncomingFrameOnClone(
    env,
    accountMachine,
    input,
    preflight.receivedFrame,
    preflight.frameJHeight,
    events,
    timedOutHashlocks,
    validatedCounterpartyDisputeSeal,
    committedJClaims.store,
    securityContext,
  );
  if (validationResult.kind === 'return') {
    if (!validationResult.result.success) {
      if (
        isRefreshableStaleIncomingSettlementSeal(
          accountMachine,
          preflight.receivedFrame,
          validationResult.result.error,
        )
      ) {
        accountLog.warn('frame.stale_settlement_seal_rejected', {
          height: preflight.receivedFrame.height,
          error: validationResult.result.error,
        });
        return {
          kind: 'return',
          result: {
            ...validationResult.result,
            rejected: {
              reason: validationResult.result.error ?? 'Stale settlement seal rejected',
            },
          },
        };
      }
      const proposal = accountInputProposal(input)!;
      if (!proposal.frameHanko) throw new Error('INBOUND_ACCOUNT_FRAME_HANKO_MISSING_AFTER_VALIDATION');
      return {
        kind: 'return',
        result: {
          ...validationResult.result,
          disputeRequired: {
            reason: validationResult.result.error ?? 'Signed account frame failed deterministic replay',
            evidenceSecrets: [],
            signedFrame: {
              frame: structuredClone(preflight.receivedFrame),
              frameHanko: proposal.frameHanko,
            },
          },
        },
      };
    }
    return validationResult;
  }

  if (preflight.rollbackPendingFrame) {
    applySameHeightIncomingFrameRollback(
      env,
      accountMachine,
      input,
      preflight.receivedFrame,
      events,
    );
  }

  await commitIncomingFrameOnRealState(
    env,
    accountMachine,
    input,
    preflight.receivedFrame,
    preflight.frameJHeight,
    validationResult.validation,
    preflight.ourEntityId,
    validatedCounterpartyDisputeSeal,
    events,
    committedFrames,
    committedJClaims,
    securityContext,
    candidateEffects,
  );

  return {
    kind: 'return',
    result: await buildAckResponseForIncomingFrame(
      env,
      accountMachine,
      input,
      preflight.receivedFrame,
      validationResult.validation,
      events,
      timedOutHashlocks,
      committedFrames,
    ),
  };
}

type AccountInputSession = {
  env: Env;
  accountMachine: AccountMachine;
  input: AccountInput;
  securityContext: AccountInputSecurityContext;
  normalizedInputHeight: number;
  replay: ReturnType<typeof classifyAccountInputReplay>;
  events: string[];
  timedOutHashlocks: string[];
  committedFrames: Array<{
    frame: AccountFrame;
    committedViaNewFrame: boolean;
  }>;
  committedJClaims: ReturnType<typeof createAccountJClaimSession>;
  candidateEffects: EntityCandidateEffect[];
};

const finishAccountInput = (
  session: AccountInputSession,
  result: HandleAccountInputResult,
): HandleAccountInputResult => {
  const accountJClaimNodeChanges = session.committedJClaims.changes();
  return {
    ...result,
    ...(session.candidateEffects.length > 0
      ? { candidateEffects: session.candidateEffects }
      : {}),
    ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
  };
};

const handleAccountAckPhase = async (
  session: AccountInputSession,
): Promise<
  | { kind: 'continue'; ackProcessed: boolean }
  | { kind: 'return'; result: HandleAccountInputResult }
> => {
  const {
    env,
    accountMachine,
    input,
    normalizedInputHeight,
    securityContext,
    events,
    timedOutHashlocks,
    committedFrames,
    committedJClaims,
    candidateEffects,
  } = session;
  let disputeSeal: ValidatedCounterpartyDisputeSeal | undefined;
  try {
    disputeSeal = await validateCounterpartyDisputeSeal(
      env,
      accountMachine,
      input,
      accountInputAck(input)?.disputeSeal,
      'ACCOUNT_ACK',
      securityContext,
    );
  } catch (error) {
    return {
      kind: 'return',
      result: { success: false, error: (error as Error).message, events },
    };
  }
  const { ackHeight } = resolveAccountAckTarget(
    accountMachine,
    input,
    normalizedInputHeight,
  );
  const pending = await handlePendingFrameAck(
    env,
    accountMachine,
    input,
    ackHeight,
    disputeSeal,
    events,
    timedOutHashlocks,
    committedFrames,
    committedJClaims,
    securityContext,
    candidateEffects,
  );
  if (pending.kind === 'return') return pending;
  const ackProcessed = pending.kind === 'fallthrough';
  const unmatched = handleUnmatchedAck(
    accountMachine,
    input,
    normalizedInputHeight,
    ackProcessed,
    events,
    committedFrames,
    'before_frame',
  );
  return unmatched
    ? { kind: 'return', result: unmatched }
    : { kind: 'continue', ackProcessed };
};

const handleStandaloneDispute = async (
  session: AccountInputSession,
): Promise<HandleAccountInputResult> => {
  const { env, accountMachine, input, securityContext, events } = session;
  if (input.kind !== 'dispute') {
    throw new Error(`ACCOUNT_DISPUTE_PHASE_KIND_INVALID:${input.kind}`);
  }
  try {
    const seal = await validateCounterpartyDisputeSeal(
      env,
      accountMachine,
      input,
      input.disputeSeal,
      'ACCOUNT_DISPUTE',
      securityContext,
    );
    storeCounterpartyDisputeSeal(accountMachine, seal);
    return { success: true, events };
  } catch (error) {
    return { success: false, error: (error as Error).message, events };
  }
};

const handleAccountProposalPhase = async (
  session: AccountInputSession,
  ackProcessed: boolean,
): Promise<HandleAccountInputResult | null> => {
  const {
    env,
    accountMachine,
    input,
    normalizedInputHeight,
    replay,
    securityContext,
    events,
    timedOutHashlocks,
    committedFrames,
    committedJClaims,
    candidateEffects,
  } = session;
  let disputeSeal: ValidatedCounterpartyDisputeSeal | undefined;
  try {
    disputeSeal = await validateCounterpartyDisputeSeal(
      env,
      accountMachine,
      input,
      accountInputProposal(input)?.disputeSeal,
      'ACCOUNT_PROPOSAL',
      securityContext,
    );
  } catch (error) {
    return { success: false, error: (error as Error).message, events };
  }
  if (input.kind === 'dispute') return handleStandaloneDispute(session);
  const incoming = await handleIncomingAccountFrame(
    env,
    accountMachine,
    input,
    normalizedInputHeight,
    replay.currentHeight,
    disputeSeal,
    events,
    timedOutHashlocks,
    committedFrames,
    committedJClaims,
    securityContext,
    candidateEffects,
  );
  if (incoming.kind === 'return') return incoming.result;
  return handleUnmatchedAck(
    accountMachine,
    input,
    normalizedInputHeight,
    ackProcessed,
    events,
    committedFrames,
    'after_frame',
  ) ?? null;
};

/**
 * Bilateral Account input composition root. Protocol-specific validation and
 * mutation remain in the phase handlers above.
 */
export async function applyAccountInput(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  securityContext: AccountInputSecurityContext = {
    entityTimestamp: env.timestamp,
    owningEntityIsHub: false,
    finalizedJHeight:
      getReplicaByEntityId(env, accountMachine.proofHeader.fromEntity)?.state
        .lastFinalizedJHeight ??
      accountMachine.lastFinalizedJHeight ??
      0,
  },
  accountJClaimNodeStore?: AccountJClaimNodeStore,
): Promise<HandleAccountInputResult> {
  if (input.watchSeed !== undefined) {
    const inputWatchSeed = normalizeAccountWatchSeed(input.watchSeed, 'ACCOUNT_INPUT');
    if (accountMachine.watchSeed.toLowerCase() !== inputWatchSeed) {
      return { success: false, error: `ACCOUNT_WATCH_SEED_MISMATCH:${input.fromEntityId}`, events: [] };
    }
  }
  const heightNormalization = normalizeAccountInputHeight(input);
  if (heightNormalization.error) {
    return { success: false, error: heightNormalization.error, events: [] };
  }
  const { normalizedInputHeight } = heightNormalization;
  if (normalizedInputHeight === undefined) {
    throw new Error('ACCOUNT_INPUT_HEIGHT_NORMALIZATION_INVARIANT');
  }
  const events: string[] = [];
  const disputeHankoShapeError = getDisputeHankoShapeError(input);
  if (disputeHankoShapeError) {
    return { success: false, error: disputeHankoShapeError, events };
  }
  const boardReseal = await handleBoardReseal(env, accountMachine, input, securityContext);
  if (boardReseal) {
    const session = {
      env,
      accountMachine,
      input,
      securityContext,
      normalizedInputHeight,
      replay: classifyAccountInputReplay(accountMachine, input),
      events,
      timedOutHashlocks: [],
      committedFrames: [],
      committedJClaims: createAccountJClaimSession(env, accountJClaimNodeStore),
      candidateEffects: [],
    };
    return finishAccountInput(session, boardReseal);
  }
  const replay = classifyAccountInputReplay(accountMachine, input);
  const replayGateResult = await handleReplayOrObsoleteAccountInput(
    accountMachine,
    input,
    replay,
    events,
  );
  if (replayGateResult) return replayGateResult;
  const session: AccountInputSession = {
    env,
    accountMachine,
    input,
    securityContext,
    normalizedInputHeight,
    replay,
    events,
    timedOutHashlocks: [],
    committedFrames: [],
    committedJClaims: createAccountJClaimSession(env, accountJClaimNodeStore),
    candidateEffects: [],
  };
  const ack = await handleAccountAckPhase(session);
  if (ack.kind === 'return') return finishAccountInput(session, ack.result);
  const proposalResult = await handleAccountProposalPhase(
    session,
    ack.ackProcessed,
  );
  if (proposalResult) return finishAccountInput(session, proposalResult);
  if (HEAVY_LOGS) accountLog.debug('return.no_response');
  return finishAccountInput(session, {
    success: true,
    events,
    swapOffersCreated: [],
    swapCancelRequests: [],
    swapOffersCancelled: [],
    timedOutHashlocks: session.timedOutHashlocks,
    ...(session.committedFrames.length > 0 && {
      committedFrames: session.committedFrames,
    }),
  });
}

// === E-MACHINE INTEGRATION ===

/**
 * Add transaction to account mempool with limits
 */
export function addToAccountMempool(accountMachine: AccountMachine, accountTx: AccountTx): boolean {
  appendAccountMempoolTx(accountMachine, accountTx, 'accountConsensus:externalAdmission');
  return true;
}
