/**
 * Bilateral account consensus: two entities agree on a frame chain for one
 * off-chain account, then bubble committed effects back to the entity runtime.
 */

import type {
  AccountState,
  AccountDisputeSeal,
  AccountFrame,
  AccountInput,
  AccountPeerInput,
  EntityCandidateEffect,
  RuntimeState,
  Delta,
} from '../../types';
import {
  cloneAccountFrame,
  cloneAccountState,
  getAccountPerspective,
} from '../../state-helpers';
import { isLeft } from '../utils';
import { HEAVY_LOGS } from '../../utils';
import { safeStringify } from '../../protocol/serialization';
import { applyAccountTx } from '../tx/apply';
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
import { appendAccountMempoolTxs } from '../mempool';
import { applyLocalAccountInput } from '../local-tx-admission';
import { getAccountInputEnvelopeError } from '../input';
import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../../protocol/dispute/arguments';
import type {
  AccountConsensusHashToSign,
  AccountSwapOfferCreated,
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from './types';
import { createDisputeProofHashWithNonce } from '../../protocol/dispute/proof-builder';
import { getMinimumSafeSettlementNonce } from '../../protocol/settlement/operations';
import { verifyHankoForHash } from '../../hanko/signing';
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
  account: AccountState,
  expectedRoot: string,
  side: 'proposer' | 'receiver',
  height: number,
  validatedMachine?: AccountState,
): void => {
  const incrementalRoot = computeAccountStateRoot(account);
  // The signed frame root is the commit criterion. Every AccountTx variant is
  // compile-time-exhaustive about commitment-cache invalidation, so a matching
  // incremental root is sufficient on the hot path. Rebuilding every map here
  // made one-leaf commits scale with the entire Account and erased the cache's
  // benefit. We still run the independent cold oracle on any mismatch so the
  // failure report identifies stale cache data versus a real state divergence.
  if (incrementalRoot === expectedRoot) return;
  const coldRoot = computeAccountStateRootCold(account);
  const details = {
    side,
    height,
    expectedRoot,
    incrementalRoot,
    coldRoot,
    incrementalSectionHashes: computeAccountStateSectionHashes(account),
    coldSectionHashes: computeAccountStateSectionHashesCold(account),
    incrementalCommitments: computeAccountCommitmentSectionDetail(account),
    coldCommitments: computeAccountCommitmentSectionDetailCold(account),
    pendingFrameTxTypes: account.pendingFrame?.accountTxs.map((tx) => tx.type) ?? [],
    commitmentEntryCounts: {
      locks: account.locks.size,
      pulls: account.pulls?.size ?? 0,
      swapOffers: account.swapOffers.size,
      subcontracts: account.subcontracts?.size ?? 0,
      lendingIntents: account.lendingIntents?.size ?? 0,
    },
    liveFinancial: {
      deltas: Array.from(account.deltas.entries()),
      globalCreditLimits: account.globalCreditLimits,
      jNonce: account.jNonce,
      disputeConfig: account.disputeConfig,
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
  env: RuntimeState,
  account: AccountState,
  input: AccountPeerInput,
  seal: ReturnType<typeof accountInputDisputeSeal>,
  context: string,
  securityContext: AccountInputSecurityContext,
  allowPreviousBoard = true,
): Promise<ValidatedCounterpartyDisputeSeal | undefined> {
  if (!seal) return undefined;
  if (!seal.hanko) {
    throw new Error(`${context}:DISPUTE_SEAL_HANKO_MISSING`);
  }

  const hankoDomain = getAccountStateDomain(account);

  // A dispute Hanko is only useful if it signs the exact Solidity message:
  // (MessageType.DisputeProof, chainId, depository, canonical accountKey, nonce,
  // proofbodyHash). Verifying a peer-supplied `newDisputeHash` alone is not
  // enough: a malicious peer can sign any random hash, attach a plausible
  // proofbodyHash, and make us store metadata that later fails on-chain.
  const expectedHash = createDisputeProofHashWithNonce(
    account,
    seal.proofBodyHash,
    hankoDomain,
    seal.proofNonce,
  );
  if (String(seal.hash).toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`${context}:DISPUTE_SEAL_HASH_MISMATCH:${safeStringify({
      kind: input.kind,
      currentHeight: account.currentHeight,
      pendingHeight: account.pendingFrame?.height ?? null,
      inputHeight: accountInputAck(input)?.height ?? null,
      newFrameHeight: accountInputProposal(input)?.frame.height ?? null,
      localNonce: account.proofHeader.nextProofNonce,
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
  account: AccountState,
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
  env: RuntimeState,
  account: AccountState,
  input: AccountPeerInput,
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
  env: RuntimeState,
  account: AccountState,
  input: AccountPeerInput,
  securityContext: AccountInputSecurityContext,
): Promise<HandleAccountInputResult | undefined> => {
  const reseal = accountInputBoardReseal(input);
  if (!reseal) return undefined;
  const events: string[] = [];
  const metadata = validateBoardResealMetadata(account, input, reseal, events);
  if ('success' in metadata) return metadata;
  const witnesses = await verifyBoardResealWitnesses(
    env,
    account,
    input,
    reseal,
    metadata,
    securityContext,
    events,
  );
  if ('success' in witnesses) return witnesses;

  // The exact Account state and on-chain dispute nonce remain untouched. Only
  // replace cached authority witnesses after every supplied hash validates.
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

function storeCounterpartyDisputeSeal(
  account: AccountState,
  seal: ValidatedCounterpartyDisputeSeal | undefined,
): void {
  if (!seal) return;
  account.counterpartyDisputeProofHanko = seal.hanko;
  account.counterpartyDisputeProofNonce = seal.nonce;
  account.counterpartyDisputeHash = seal.hash;
  account.counterpartyDisputeProofBodyHash = seal.proofBodyHash;
  account.disputeProofNoncesByHash ??= {};
  account.disputeProofNoncesByHash[seal.proofBodyHash] = seal.nonce;
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

function describeAccountState(account: AccountState): Record<string, unknown> {
  return {
    currentHeight: Number(account.currentHeight ?? 0),
    currentHash: account.currentFrame?.stateHash ?? null,
    currentPrev: account.currentFrame?.prevFrameHash ?? null,
    currentTimestamp: Number(account.currentFrame?.timestamp ?? 0),
    pendingHeight: Number(account.pendingFrame?.height ?? 0),
    pendingHash: account.pendingFrame?.stateHash ?? null,
    pendingPrev: account.pendingFrame?.prevFrameHash ?? null,
    pendingTimestamp: Number(account.pendingFrame?.timestamp ?? 0),
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
  account: AccountState,
  input: AccountInput,
): AccountInputReplayClassification {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const currentHeight = Number(account.currentHeight ?? 0);
  const pendingHeight = Number(account.pendingFrame?.height ?? 0);
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
  account: AccountState,
  input: AccountInput,
  events: string[],
  replayCurrentHeight: number,
  receivedFrame: AccountFrame,
): Promise<HandleAccountInputResult | null> {
  const receivedHeight = Number(receivedFrame.height ?? 0);
  if (
    receivedHeight !== replayCurrentHeight ||
    receivedFrame.stateHash !== account.currentFrame?.stateHash
  ) {
    return null;
  }
  const pendingResponse = account.pendingAccountInput;
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
  const cachedAck = account.lastOutboundFrameAck;
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
  account: AccountState,
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
      account,
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
    !account.pendingFrame &&
    (account.status ?? 'active') !== 'active'
  ) {
    events.push(
      `ℹ️ Ignored obsolete ACK for frozen account frame ${String(replay.inputHeight ?? 'none')} ` +
      `(current=${String(account.currentHeight ?? 0)}, status=${String(account.status)})`,
    );
    accountLog.debug('input.frozen_ack_ignored', {
      currentHeight: replay.currentHeight,
      inputHeight: replay.inputHeight,
      status: account.status,
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
  env: RuntimeState,
  account: AccountState,
  ack: AccountFrameAck,
  ackHeight: number,
  validatedSeal: ValidatedCounterpartyDisputeSeal | undefined,
  events: string[],
  securityContext: AccountInputSecurityContext,
): Promise<PendingAckCertificateResult> {
  const sealError = disputeSealRequirementError(
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

  const expectedEntity = account.proofHeader.toEntity;
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
  env: RuntimeState,
  account: AccountState,
  pendingFrame: AccountFrame,
  committedJClaims: AccountJClaimSession,
  timedOutHashlocks: string[],
  candidateEffects: EntityCandidateEffect[],
): Promise<void> {
  const pendingJHeight = pendingFrame.jHeight ?? account.lastFinalizedJHeight ?? 0;
  for (const tx of pendingFrame.accountTxs) {
    const beforeSettlement = captureSettlementVector(account);
    const result = await applyAccountTx(
      account,
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
}

function installPendingFrameCommit(
  account: AccountState,
  input: AccountInput,
  pendingFrame: AccountFrame,
  ack: AccountFrameAck,
  ackHanko: string,
  validatedSeal: ValidatedCounterpartyDisputeSeal | undefined,
  committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }>,
): number {
  account.currentFrame = structuredClone(pendingFrame);
  account.currentHeight = pendingFrame.height;
  // The peer ACK is the second half of this exact bilateral certificate.
  // Dropping it would make later board rotation unable to prove mutual commit.
  account.counterpartyFrameHanko = ackHanko;
  if (ack.disputeSeal) {
    storeCounterpartyDisputeSeal(account, validatedSeal);
    accountLog.debug('hanko.dispute_ack_stored', {
      nonce: ack.disputeSeal.proofNonce,
      from: shortId(input.fromEntityId),
    });
  }

  const committedFrame = cloneAccountFrame(pendingFrame);
  committedFrames.push({ frame: committedFrame, committedViaNewFrame: false });
  accountLog.debug('frame.indexed', {
    source: 'ackCommit',
    height: pendingFrame.height,
  });

  delete account.pendingFrame;
  delete account.pendingAccountInput;
  delete account.pendingAccountInputSignerId;
  discardStagedAccountCommitmentCache(account);
  if (
    account.lastOutboundFrameAck &&
    Number(account.lastOutboundFrameAck.height) < Number(pendingFrame.height)
  ) {
    delete account.lastOutboundFrameAck;
  }
  account.rollbackCount = Math.max(0, account.rollbackCount - 1);
  if (account.rollbackCount === 0) delete account.lastRollbackFrameHash;
  return pendingFrame.height;
}

async function queuePostAckWork(
  env: RuntimeState,
  account: AccountState,
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
}

async function handlePendingFrameAck(
  env: RuntimeState,
  account: AccountState,
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
  const pendingFrame = account.pendingFrame;
  if (!(pendingFrame && ackHeight === pendingFrame.height && ack)) {
    return { kind: 'not_applicable' };
  }
  if (HEAVY_LOGS) accountLog.debug('ack.debug', { from: shortId(input.fromEntityId), to: shortId(input.toEntityId) });
  const certificate = await verifyPendingAckCertificate(
    env,
    account,
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
  const { counterparty: cpForLog } = getAccountPerspective(account, account.proofHeader.fromEntity);
  accountLog.debug('frame.reexecute', {
    height: pendingFrame.height,
    counterparty: shortId(cpForLog),
    txs: pendingFrame.accountTxs.length,
  });
  await applyPendingFrameTransactions(
    env,
    account,
    pendingFrame,
    committedJClaims,
    timedOutHashlocks,
    candidateEffects,
  );
  accountLog.debug('frame.commit.complete', {
    side: 'proposer',
    counterparty: shortId(cpForLog),
    height: pendingFrame.height,
    tokens: account.deltas.size,
  });
  const committedHeight = installPendingFrameCommit(
    account,
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
    account,
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
  clonedMachine: AccountState;
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
  account: AccountState,
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
    tx.data.revision === workspace.revision &&
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
  account: AccountState,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
): AccountAckTarget {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const pendingHeight = Number(account.pendingFrame?.height ?? 0);
  const bundledNewFrameHeight =
    proposal?.frame === undefined || proposal.frame === null
      ? undefined
      : Number(proposal.frame.height);
  const ackTargetsPendingFrame =
    Boolean(ack) &&
    Boolean(account.pendingFrame) &&
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
  account: AccountState,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
): boolean {
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  const pendingFrameHeight = Number(account.pendingFrame?.height ?? 0);
  return (
    Boolean(ack) &&
    Boolean(proposal) &&
    pendingFrameHeight > 0 &&
    Number(proposal?.frame.height ?? 0) === pendingFrameHeight &&
    Number(normalizedInputHeight ?? 0) === pendingFrameHeight - 1
  );
}

function handleUnmatchedAck(
  account: AccountState,
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
    if (!account.pendingFrame || isSameHeightSimultaneousProposalAck(account, input, normalizedInputHeight)) {
      return undefined;
    }
    const pending = account.pendingFrame.height;
    const staleAck =
      normalizedInputHeight !== undefined &&
      Number(normalizedInputHeight) > 0 &&
      Number(normalizedInputHeight) <= Number(account.currentHeight ?? 0);
    if (staleAck) {
      events.push(
        `ℹ️ Ignored stale ACK for frame ${String(normalizedInputHeight)} (current=${String(account.currentHeight ?? 0)}, pending=${String(pending)})`,
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
  const pending = account.pendingFrame?.height ?? 'none';
  const nextHeightAckWithoutPending =
    normalizedInputHeight !== undefined &&
    Number(normalizedInputHeight) === Number(account.currentHeight ?? 0) + 1 &&
    !account.pendingFrame;
  const staleAck =
    normalizedInputHeight !== undefined &&
    Number(normalizedInputHeight) > 0 &&
    Number(normalizedInputHeight) <= Number(account.currentHeight ?? 0);
  if (staleAck) {
    events.push(
      `ℹ️ Ignored stale ACK for frame ${String(normalizedInputHeight)} (current=${String(account.currentHeight ?? 0)}, pending=${String(pending)})`,
    );
    return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
  }
  if (nextHeightAckWithoutPending) {
    // Remote delivery is only ordered per transport, not across the local
    // frame-install tick. A pure ACK for the next frame cannot advance state
    // without the matching pending frame, so keep it non-mutating and rely on
    // the account pending resend path to recover the ACK deterministically.
    events.push(
      `Ignored early ACK for frame ${String(normalizedInputHeight)} (current=${String(account.currentHeight ?? 0)}, pending=none)`,
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
  account: AccountState,
  receivedFrame: AccountFrame,
  events: string[],
  committedFrames: AccountCommittedFrame[],
): HandleAccountInputResult | true | undefined {
  if (!(account.pendingFrame && receivedFrame.height === account.pendingFrame.height)) {
    return undefined;
  }

  /*
   * One Account height permits one proposal from each side. If both proposals
   * race, the valid LEFT proposal is canonical.
   *
   * Why fixed LEFT:
   * - Depository.sol uses the same equal-height winner, so off-chain recovery
   *   and an adversarial on-chain dispute cannot disagree.
   * - A selected proposer would need timeout/view-change state when it is
   *   offline, turning bilateral consensus into a leader-election protocol.
   * - Alternating LEFT/RIGHT by height would either disagree with Depository
   *   or require a contract-level protocol migration.
   *
   * Time, retry count, HTLC expiry and settlement evidence deliberately do
   * not affect this choice. They cannot create a higher Account proposal in
   * the same round.
   */
  const isLeftEntity = isLeft(account.proofHeader.fromEntity, account.proofHeader.toEntity);
  if (HEAVY_LOGS) {
    accountLog.debug('frame.tiebreaker', {
      from: shortId(account.proofHeader.fromEntity),
      to: shortId(account.proofHeader.toEntity),
      isLeft: isLeftEntity,
    });
  }

  if (isLeftEntity) {
    events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${receivedFrame.height} (waiting for their ACK)`);
    if (account.mempool.length > 0) {
      events.push(`⚠️ LEFT has ${account.mempool.length} pending txs while waiting for RIGHT's ACK`);
    }
    const pendingResponse = account.pendingAccountInput;
    const pendingProposal = pendingResponse ? accountInputProposal(pendingResponse) : undefined;
    if (
      !pendingResponse ||
      !pendingProposal ||
      pendingProposal.frame.stateHash !== account.pendingFrame.stateHash
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

  const receivedHash = receivedFrame.stateHash;
  if (account.lastRollbackFrameHash === receivedHash) {
    accountLog.debug('rollback.duplicate', { frame: shortHash(receivedHash) });
    return undefined;
  }

  return true;
}

function applySameHeightIncomingFrameRollback(
  _env: RuntimeState,
  account: AccountState,
  _input: AccountInput,
  receivedFrame: AccountFrame,
  events: string[],
): void {
  /*
   * Only RIGHT reaches this rollback. Its signed frame was never committed,
   * and the contract-level LEFT tie-break proves it cannot beat the accepted
   * frame at this height. Restore the losing intentions exactly once so the
   * normal proposer can apply them above the newly committed frame.
   *
   * Never call this because a clock elapsed. A Hanko already sent to the peer
   * does not expire, and deleting it locally would create two incompatible
   * views of still-valid signed evidence.
   */
  const receivedHash = receivedFrame.stateHash;
  let restoredTxCount = 0;
  if (account.pendingFrame) {
    restoredTxCount = account.pendingFrame.accountTxs.length;
    const uniqueRestored = prependUniqueMempoolTxs(account, account.pendingFrame.accountTxs);

    events.push(
      `🔄 ROLLBACK: Discarded our frame ${account.pendingFrame.height}, restored ${uniqueRestored}/${restoredTxCount} txs to mempool`,
    );
  }

  delete account.pendingFrame;
  delete account.pendingAccountInput;
  delete account.pendingAccountInputSignerId;
  discardStagedAccountCommitmentCache(account);
  account.rollbackCount = Math.max(1, account.rollbackCount + 1);
  account.lastRollbackFrameHash = receivedHash; // Track this rollback
  if (account.rollbackCount > 1) {
    accountLog.warn('rollback.retry', { count: account.rollbackCount, frame: shortHash(receivedHash) });
  }

  events.push(`📥 Accepted LEFT's frame ${receivedFrame.height} (we are RIGHT, deterministic tiebreaker)`);
}

async function verifyIncomingFrameHanko(
  env: RuntimeState,
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
  account: AccountState,
  input: AccountInput,
  receivedFrame: AccountFrame,
  replayCurrentHeight: number,
  events: string[],
  committedFrames: AccountCommittedFrame[],
): Promise<HandleAccountInputResult | undefined> {
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
    `ℹ️ Ignored stale frame ${String(receivedFrame.height)} ` +
    `(current=${String(account.currentHeight ?? 0)})`,
  );
  return {
    success: true,
    events,
    ...(committedFrames.length > 0 && { committedFrames }),
  };
}

function validateIncomingFrameProposer(
  account: AccountState,
  input: AccountInput,
  receivedFrame: AccountFrame,
  events: string[],
): HandleAccountInputResult | undefined {
  const proposer = input.fromEntityId.toLowerCase();
  const proposerIsLeft = proposer === account.leftEntity.toLowerCase();
  if (!proposerIsLeft && proposer !== account.rightEntity.toLowerCase()) {
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
  account: AccountState,
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

  const previousTimestamp = account.currentFrame?.timestamp;
  if (previousTimestamp !== undefined && receivedFrame.timestamp < previousTimestamp) {
    accountLog.warn('frame.timestamp_regressed_accepted', {
      accountHeight: account.currentHeight,
      entityId: input.toEntityId,
      counterpartyEntityId: input.fromEntityId,
      previousTimestamp,
      proposedTimestamp: receivedFrame.timestamp,
      regressionMs: previousTimestamp - receivedFrame.timestamp,
      entityTimestamp: securityContext.entityTimestamp,
    });
  }

  const expectedPrevHash =
    account.currentHeight === 0 ? 'genesis' : account.currentFrame.stateHash || '';
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
      account: describeAccountState(account),
    };
    accountLog.warn('frame.prev_hash_mismatch', mismatch);
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
    accountLog.debug('frame.sequence_check', {
      receivedHeight: receivedFrame.height,
      currentHeight: account.currentHeight,
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
  account: AccountState,
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
    account,
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
  env: RuntimeState,
  account: AccountState,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
  replayCurrentHeight: number,
  events: string[],
  committedFrames: AccountCommittedFrame[],
  securityContext: AccountInputSecurityContext,
): Promise<IncomingFramePreflightResult> {
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

  const proposerError = validateIncomingFrameProposer(
    account,
    input,
    receivedFrame,
    events,
  );
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

  const hankoError = await verifyIncomingFrameHanko(env, input, receivedFrame, events, securityContext);
  if (hankoError) return { kind: 'return', result: hankoError };

  const deadlineError = validateIncomingFrameDeadline(
    account,
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
    account,
    receivedFrame,
    events,
    committedFrames,
  );
  if (sameHeightResolution !== true && sameHeightResolution) {
    return { kind: 'return', result: sameHeightResolution };
  }

  const ourEntityId = account.proofHeader.fromEntity;
  const currentJHeight = account.lastFinalizedJHeight ?? 0;
  const frameJHeight = receivedFrame.jHeight ?? currentJHeight;

  return {
    kind: 'continue',
    receivedFrame,
    ourEntityId,
    frameJHeight,
    rollbackPendingFrame: sameHeightResolution === true,
  };
}

function collectReceiverValidationDeltas(clonedMachine: AccountState): {
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

type IncomingFrameReplay = Omit<IncomingFrameValidation, 'clonedMachine' | 'proofResult'>;
type IncomingFrameReplayResult =
  | { kind: 'continue'; replay: IncomingFrameReplay }
  | { kind: 'return'; result: HandleAccountInputResult };

const replayIncomingFrameOnClone = async (
  env: RuntimeState,
  clonedMachine: AccountState,
  input: AccountInput,
  receivedFrame: AccountFrame,
  frameJHeight: number,
  events: string[],
  timedOutHashlocks: string[],
  jClaimSession: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
): Promise<IncomingFrameReplayResult> => {
  const replay: IncomingFrameReplay = {
    processEvents: [],
    revealedSecrets: [],
    swapOffersCreated: [],
    swapCancelRequests: [],
    swapOffersCancelled: [],
  };
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
      return {
        kind: 'return',
        result: { success: false, error: `Frame application failed: ${result.error}`, events },
      };
    }
    assertNoUnilateralSettlementMutation(clonedMachine, beforeSettlement, accountTx, 'receiver/validate');
    if (HEAVY_LOGS) {
      accountLog.debug('receiver.tx.processed', { type: accountTx.type, success: true });
    }
    replay.processEvents.push(...result.events);
    if (result.secret && result.hashlock) {
      replay.revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
    }
    if (result.timedOutHashlock) timedOutHashlocks.push(result.timedOutHashlock);
    if (result.swapOfferCreated) replay.swapOffersCreated.push(result.swapOfferCreated);
    if (result.swapOfferCancelRequested) {
      replay.swapCancelRequests.push({
        ...result.swapOfferCancelRequested,
        accountId: input.fromEntityId,
      });
    }
    if (result.swapOfferCancelled) replay.swapOffersCancelled.push(result.swapOfferCancelled);
  }
  return { kind: 'continue', replay };
};

async function validateIncomingFrameOnClone(
  env: RuntimeState,
  account: AccountState,
  input: AccountInput,
  receivedFrame: AccountFrame,
  frameJHeight: number,
  events: string[],
  timedOutHashlocks: string[],
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
  accountJClaimNodeStore: AccountJClaimNodeStore,
  securityContext: AccountInputSecurityContext,
): Promise<IncomingFrameValidationResult> {
  const clonedMachine = cloneAccountState(account);
  const jClaimSession = createAccountJClaimSession(env, accountJClaimNodeStore);

  accountLog.debug('frame.receiver_validate', {
    height: receivedFrame.height,
    txs: receivedFrame.accountTxs.map(tx => tx.type),
  });
  const replayResult = await replayIncomingFrameOnClone(
    env,
    clonedMachine,
    input,
    receivedFrame,
    frameJHeight,
    events,
    timedOutHashlocks,
    jClaimSession,
    securityContext,
  );
  if (replayResult.kind === 'return') return replayResult;

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
    account.counterpartyDisputeProofBodyHash,
    account.counterpartyDisputeProofNonce,
    Number(clonedMachine.jNonce ?? account.jNonce ?? 0),
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
      ...replayResult.replay,
    },
  };
}

const reexecuteIncomingFrame = async (
  env: RuntimeState,
  account: AccountState,
  receivedFrame: AccountFrame,
  frameJHeight: number,
  committedJClaims: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
  candidateEffects: EntityCandidateEffect[],
): Promise<void> => {
  for (const tx of receivedFrame.accountTxs) {
    const beforeSettlement = captureSettlementVector(account);
    const commitResult = await applyAccountTx(
      account,
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
      accountLog.error('frame.commit.failed', {
        side: 'receiver',
        type: tx.type,
        error: commitResult.error,
      });
      throw new Error(`Frame ${receivedFrame.height} commit failed: ${tx.type} - ${commitResult.error}`);
    }
    assertNoUnilateralSettlementMutation(account, beforeSettlement, tx, 'receiver/commit');
  }
};

async function commitIncomingFrameOnRealState(
  env: RuntimeState,
  account: AccountState,
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
  const { counterparty: cpForCommitLog } = getAccountPerspective(account, ourEntityId);
  if (HEAVY_LOGS) {
    accountLog.debug('receiver.commit.reexecute', {
      txs: receivedFrame.accountTxs.length,
      counterparty: shortId(cpForCommitLog),
    });
  }

  await reexecuteIncomingFrame(
    env,
    account,
    receivedFrame,
    frameJHeight,
    committedJClaims,
    securityContext,
    candidateEffects,
  );

  forkAccountCommitmentCache(validation.clonedMachine, account);
  assertLiveCommitMatchesFrame(
    account,
    receivedFrame.accountStateRoot,
    'receiver',
    receivedFrame.height,
    validation.clonedMachine,
  );

  accountLog.debug('frame.commit.complete', {
    side: 'receiver',
    counterparty: shortId(cpForCommitLog),
    height: receivedFrame.height,
    tokens: account.deltas.size,
  });
  if (validation.clonedMachine.pendingForwards?.length) {
    account.pendingForwards = validation.clonedMachine.pendingForwards;
    accountLog.debug('pending_forwards.copied', {
      count: validation.clonedMachine.pendingForwards.length,
      routes: validation.clonedMachine.pendingForwards.map(forward => forward.route.map(r => shortId(r))),
    });
  }

  account.currentFrame = structuredClone(receivedFrame);
  account.currentHeight = receivedFrame.height;
  const acceptedFrameHanko = accountInputProposal(input)?.frameHanko;
  if (!acceptedFrameHanko) throw new Error('ACCEPTED_ACCOUNT_FRAME_HANKO_MISSING');
  account.counterpartyFrameHanko = acceptedFrameHanko;
  if (accountInputProposal(input)?.disputeSeal) {
    storeCounterpartyDisputeSeal(account, validatedCounterpartyDisputeSeal);
    accountLog.debug('hanko.dispute_frame_stored', { height: receivedFrame.height, from: shortId(input.fromEntityId) });
  }

  const committedFrame = cloneAccountFrame(receivedFrame);
  committedFrames.push({ frame: committedFrame, committedViaNewFrame: true });
  accountLog.debug('frame.indexed', { source: 'peerCommit', height: receivedFrame.height });

  events.push(...validation.processEvents);
  events.push(`🤝 Accepted frame ${receivedFrame.height} from Entity ${input.fromEntityId.slice(-4)}`);

  const postCommitAutoRebalanceTxs = await runPostFrameAutoRebalanceCheck(
    env,
    account,
    ourEntityId,
    input.fromEntityId,
    receivedFrame.height,
    securityContext.owningEntityIsHub,
    candidateEffects,
  );
  if (postCommitAutoRebalanceTxs.length > 0) {
    appendAccountMempoolTxs(
      account,
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
  ackProofBodyHash: string;
  ackSignedNonce: number;
  proofChanged: boolean;
};

type IncomingFrameAckMaterialResult =
  | { kind: 'continue'; material: IncomingFrameAckMaterial }
  | { kind: 'return'; result: HandleAccountInputResult };

const storeAckProofSnapshot = (
  account: AccountState,
  proofResult: ReturnType<typeof buildAccountProofBodyFromEnv>,
  signedNonce: number,
): void => {
  account.disputeProofNoncesByHash ??= {};
  account.disputeProofNoncesByHash[proofResult.proofBodyHash] = signedNonce;
  account.disputeProofBodiesByHash ??= {};
  account.disputeProofBodiesByHash[proofResult.proofBodyHash] = proofResult.proofBodyStruct;
  storeDisputeArgumentSnapshot(
    account,
    captureDisputeArgumentSnapshot(
      account,
      proofResult.proofBodyHash,
      signedNonce,
      proofResult.proofBodyStruct,
    ),
  );
};

const selectAckDisputeSeal = (
  account: AccountState,
  proofBodyHash: string,
  signedNonce: number,
  proofChanged: boolean,
  disputeHash: string | undefined,
): AccountDisputeSeal | undefined => {
  if (proofChanged && disputeHash) {
    return {
      hash: disputeHash,
      proofBodyHash,
      proofNonce: signedNonce,
    };
  }
  const reusable =
    account.currentDisputeProofHanko &&
    account.currentDisputeHash &&
    account.currentDisputeProofBodyHash?.toLowerCase() === proofBodyHash.toLowerCase() &&
    Number(account.currentDisputeProofNonce ?? 0) > Number(account.jNonce ?? 0);
  if (!reusable) return undefined;
  return {
    hanko: account.currentDisputeProofHanko!,
    hash: account.currentDisputeHash!,
    proofBodyHash: account.currentDisputeProofBodyHash!,
    proofNonce: account.currentDisputeProofNonce!,
  };
};

async function buildIncomingFrameAckMaterial(
  account: AccountState,
  input: AccountInput,
  receivedFrame: AccountFrame,
  ackProofResult: ReturnType<typeof buildAccountProofBodyFromEnv>,
  events: string[],
): Promise<IncomingFrameAckMaterialResult> {
  const ackEntityId = account.proofHeader.fromEntity;
  accountLog.debug('hanko.ack.defer_to_entity_consensus', {
    entity: shortId(ackEntityId),
    height: receivedFrame.height,
  });

  const ackHankoDomain = getAccountStateDomain(account);
  const proofChanged =
    ackProofResult.proofBodyHash.toLowerCase() !== account.currentDisputeProofBodyHash?.toLowerCase() ||
    Number(account.currentDisputeProofNonce ?? 0) <= Number(account.jNonce ?? 0);
  const ackSignedNonce = Math.max(
    Number(account.proofHeader.nextProofNonce ?? 0),
    Number(account.jNonce ?? 0) + 1,
  );
  const ackDisputeHash = proofChanged
    ? createDisputeProofHashWithNonce(
      account,
      ackProofResult.proofBodyHash,
      ackHankoDomain,
      ackSignedNonce,
    )
    : undefined;
  if (proofChanged) {
    if (!ackDisputeHash) {
      return { kind: 'return', result: { success: false, error: 'Failed to build ACK dispute hanko', events } };
    }
    storeAckProofSnapshot(account, ackProofResult, ackSignedNonce);
  }

  const ackDisputeSeal = selectAckDisputeSeal(
    account,
    ackProofResult.proofBodyHash,
    ackSignedNonce,
    proofChanged,
    ackDisputeHash,
  );

  const response: Extract<AccountInput, { kind: 'ack' }> = {
    kind: 'ack',
    fromEntityId: account.proofHeader.fromEntity,
    toEntityId: input.fromEntityId,
    domain: structuredClone(account.domain),
    watchSeed: account.watchSeed,
    ack: {
      height: receivedFrame.height,
      frameHash: receivedFrame.stateHash,
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
      ackProofBodyHash: ackProofResult.proofBodyHash,
      ackSignedNonce,
      proofChanged,
    },
  };
}

function storeAckDisputeState(
  account: AccountState,
  material: IncomingFrameAckMaterial,
): void {
  if (material.proofChanged && material.ackDisputeHash) {
    account.currentDisputeProofNonce = material.ackSignedNonce;
    account.currentDisputeProofBodyHash = material.ackProofBodyHash;
    account.currentDisputeHash = material.ackDisputeHash;
  }
}

function buildIncomingFrameReturnPayload(
  input: AccountPeerInput,
  receivedFrame: AccountFrame,
  response: Extract<AccountPeerInput, { kind: 'ack' }>,
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
  account: AccountState,
  input: AccountPeerInput,
  receivedFrame: AccountFrame,
  validation: IncomingFrameValidation,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: AccountCommittedFrame[],
): Promise<HandleAccountInputResult> {
  const ackMaterial = await buildIncomingFrameAckMaterial(
    account,
    input,
    receivedFrame,
    validation.proofResult,
    events,
  );
  if (ackMaterial.kind === 'return') return ackMaterial.result;
  const { material } = ackMaterial;
  storeAckDisputeState(account, material);
  if (material.proofChanged) account.proofHeader.nextProofNonce = material.ackSignedNonce + 1;
  // Install the reusable ACK before the final Entity flush. The flush may
  // combine it with a successor proposal, while retries retain these exact
  // ACK bytes independently of that successor.
  account.lastOutboundFrameAck = material.outboundAck;
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

const classifyPreflightReturn = (
  result: HandleAccountInputResult,
): IncomingFrameResult => {
  if (result.success || result.disputeRequired) return { kind: 'return', result };
  return {
    kind: 'return',
    result: {
      ...result,
      rejected: { reason: result.error ?? 'Incoming account frame rejected' },
    },
  };
};

const classifyIncomingValidationFailure = (
  account: AccountState,
  input: AccountInput,
  receivedFrame: AccountFrame,
  result: HandleAccountInputResult,
): IncomingFrameResult => {
  if (result.success) return { kind: 'return', result };
  if (isRefreshableStaleIncomingSettlementSeal(account, receivedFrame, result.error)) {
    accountLog.warn('frame.stale_settlement_seal_rejected', {
      height: receivedFrame.height,
      error: result.error,
    });
    return {
      kind: 'return',
      result: {
        ...result,
        rejected: { reason: result.error ?? 'Stale settlement seal rejected' },
      },
    };
  }
  const proposal = accountInputProposal(input)!;
  if (!proposal.frameHanko) {
    throw new Error('INBOUND_ACCOUNT_FRAME_HANKO_MISSING_AFTER_VALIDATION');
  }
  return {
    kind: 'return',
    result: {
      ...result,
      disputeRequired: {
        reason: result.error ?? 'Signed account frame failed deterministic replay',
        evidenceSecrets: [],
        signedFrame: {
          frame: structuredClone(receivedFrame),
          frameHanko: proposal.frameHanko,
        },
      },
    },
  };
};

async function handleIncomingAccountFrame(
  env: RuntimeState,
  account: AccountState,
  input: AccountPeerInput,
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
    account,
    input,
    normalizedInputHeight,
    replayCurrentHeight,
    events,
    committedFrames,
    securityContext,
  );
  if (preflight.kind === 'return') {
    return classifyPreflightReturn(preflight.result);
  }

  const validationResult = await validateIncomingFrameOnClone(
    env,
    account,
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
    return classifyIncomingValidationFailure(
      account,
      input,
      preflight.receivedFrame,
      validationResult.result,
    );
  }

  if (preflight.rollbackPendingFrame) {
    applySameHeightIncomingFrameRollback(
      env,
      account,
      input,
      preflight.receivedFrame,
      events,
    );
  }

  await commitIncomingFrameOnRealState(
    env,
    account,
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
      account,
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
  env: RuntimeState;
  account: AccountState;
  input: AccountPeerInput;
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
    account,
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
      account,
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
    account,
    input,
    normalizedInputHeight,
  );
  const pending = await handlePendingFrameAck(
    env,
    account,
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
    account,
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
  const { env, account, input, securityContext, events } = session;
  if (input.kind !== 'dispute') {
    throw new Error(`ACCOUNT_DISPUTE_PHASE_KIND_INVALID:${input.kind}`);
  }
  try {
    const seal = await validateCounterpartyDisputeSeal(
      env,
      account,
      input,
      input.disputeSeal,
      'ACCOUNT_DISPUTE',
      securityContext,
    );
    storeCounterpartyDisputeSeal(account, seal);
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
    account,
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
      account,
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
    account,
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
    account,
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
const resolveAccountInputSecurityContext = (
  env: RuntimeState,
  account: AccountState,
  provided: AccountInputSecurityContext | undefined,
): AccountInputSecurityContext => provided ?? {
  entityTimestamp: env.timestamp,
  owningEntityIsHub: false,
  // Account never reaches upward into Entity replicas. Normal Entity routing
  // supplies the current certified height explicitly; direct Account tooling
  // can only rely on this Account's own committed observation.
  finalizedJHeight: account.lastFinalizedJHeight ?? 0,
};

export async function applyAccountInput(
  env: RuntimeState,
  account: AccountState,
  input: AccountInput,
  providedSecurityContext?: AccountInputSecurityContext,
  accountJClaimNodeStore?: AccountJClaimNodeStore,
): Promise<HandleAccountInputResult> {
  const envelopeError = getAccountInputEnvelopeError(account, input);
  if (envelopeError) {
    return { success: false, error: envelopeError, events: [] };
  }
  if (input.kind === 'txs') return applyLocalAccountInput(account, input);
  const securityContext = resolveAccountInputSecurityContext(
    env,
    account,
    providedSecurityContext,
  );
  if (input.watchSeed !== undefined) {
    const inputWatchSeed = normalizeAccountWatchSeed(input.watchSeed, 'ACCOUNT_INPUT');
    if (account.watchSeed.toLowerCase() !== inputWatchSeed) {
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
  const boardReseal = await handleBoardReseal(env, account, input, securityContext);
  if (boardReseal) {
    const session = {
      env,
      account,
      input,
      securityContext,
      normalizedInputHeight,
      replay: classifyAccountInputReplay(account, input),
      events,
      timedOutHashlocks: [],
      committedFrames: [],
      committedJClaims: createAccountJClaimSession(env, accountJClaimNodeStore),
      candidateEffects: [],
    };
    return finishAccountInput(session, boardReseal);
  }
  const replay = classifyAccountInputReplay(account, input);
  const replayGateResult = await handleReplayOrObsoleteAccountInput(
    account,
    input,
    replay,
    events,
  );
  if (replayGateResult) return replayGateResult;
  const session: AccountInputSession = {
    env,
    account,
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
