/**
 * Bilateral account consensus: two entities agree on a frame chain for one
 * off-chain account, then bubble committed effects back to the entity runtime.
 */

import type { AccountReplica, AccountDisputeSeal, AccountFrame, AccountInput, AccountPeerInput, Delta } from '../../types/account';
import type { AccountOutput } from '../../types/account';
import type { AccountConsensusContext } from './context';
import { cloneAccountFrame, cloneAccountState } from '../state-clone';
import { getAccountPerspective } from '../perspective';
import { HEAVY_LOGS } from '../../infra/debug-flags';
import { applyAccountTx } from '../tx/apply';
import type { AccountTxRejection } from '../tx/apply-types';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import { createFrameHash } from './frame';
import { normalizeAccountWatchSeed } from '../../protocol/account-watch-seed';
import {
  assertNoUnilateralSettlementMutation,
  buildAccountProofBodyFromJurisdictions,
  captureSettlementVector,
  getAccountStateDomain,
  runPostFrameAutoRebalanceCheck,
  shouldIncludeToken,
  summarizeDeltasForLog,
} from './helpers';
import { appendAccountMempoolTxs } from '../mempool';
import {
  applyAccountDisputeFinality,
  applyAccountDisputeStarted,
} from '../j-finality';
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
import { computeAccountStateRoot, computeAccountStateSectionHashes } from '../state-root';
import { forkAccountCommitmentCache } from '../map-commitment';
import { createAccountJClaimSession, type AccountJClaimSession } from '../j-claim-session';
import type { AccountJClaimNodeStore } from '../../types/account-j-claims';
import {
  getIncomingAccountDeadlineViolation,
  HTLC_ENFORCEMENT_RESERVE_MS,
  isHtlcSecretEnforcementWindowClosed,
  type AccountInputSecurityContext,
} from './deadline-policy';
import { accountInputAck, accountInputProposal, accountInputReferenceHeight } from './flush';
import { handleBoardReseal } from './board-reseal';
import { handlePendingFrameAck } from './ack-commit';
import { assertLiveCommitMatchesFrame } from './commit-root';
import {
  getDisputeSealRequirementError,
  replaceLocalDisputeDraft,
  storeCounterpartyDisputeSeal,
  type ValidatedCounterpartyDisputeSeal,
  validateCounterpartyDisputeSeal,
} from './dispute-seal';
import {
  classifyAccountInputReplay,
  getDisputeHankoShapeError,
  handleReplayOrObsoleteAccountInput,
  normalizeAccountInputHeight,
} from './replay';
import { applySameHeightIncomingFrameRollback, handleUnmatchedAck, resolveAccountAckTarget } from './collision';
import { preflightIncomingAccountFrame } from './incoming-preflight';
export { proposeAccountFrame } from './propose';
export type {
  AccountConsensusFrameResult,
  AccountConsensusHashToSign,
  AccountSwapOfferCreated,
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from './types';

const accountLog = createStructuredLogger('account');

export { getIncomingAccountDeadlineViolation, HTLC_ENFORCEMENT_RESERVE_MS, isHtlcSecretEnforcementWindowClosed };
export type { AccountInputSecurityContext };

export { computeFrameHash, isWithinAccountFrameBounds } from './frame';

// Counter-based replay protection was intentionally replaced by the frame chain
// (height + prevFrameHash). Nonces remain only for on-chain proof material.

type AccountCommittedFrame = NonNullable<HandleAccountInputResult['committedFrames']>[number];
type AccountRevealedSecret = { secret: string; hashlock: string };
type AccountSwapCancelRequest = { offerId: string; accountId: string };

type IncomingFrameValidation = {
  clonedMachine: AccountReplica;
  proofResult: ReturnType<typeof buildAccountProofBodyFromJurisdictions>;
  processEvents: string[];
  revealedSecrets: AccountRevealedSecret[];
  swapOffersCreated: AccountSwapOfferCreated[];
  swapCancelRequests: AccountSwapCancelRequest[];
  swapOffersCancelled: AccountSwapCancelRequest[];
};

type IncomingFrameValidationResult =
  { kind: 'continue'; validation: IncomingFrameValidation } | { kind: 'return'; result: HandleAccountInputResult };

type IncomingFrameResult = { kind: 'not_applicable' } | { kind: 'return'; result: HandleAccountInputResult };

const isRefreshableStaleIncomingSettlementSeal = (
  account: AccountReplica,
  frame: AccountFrame,
  rejection: AccountTxRejection | undefined,
): boolean => {
  if (
    rejection?.kind !== 'settlement_seal_nonce_mismatch' ||
    rejection.basis !== 'account' ||
    rejection.suppliedNonce >= rejection.requiredNonce ||
    rejection.requiredNonce !== getMinimumSafeSettlementNonce(account)
  ) {
    return false;
  }

  const workspace = account.settlementWorkspace;
  if (!workspace || workspace.nonceAtSign !== undefined) return false;
  const matchingSeals = frame.accountTxs.filter(
    tx =>
      tx.type === 'settle_transition' &&
      tx.data.kind === 'seal' &&
      tx.data.settlementNonce === rejection.suppliedNonce &&
      tx.data.revision === workspace.revision &&
      tx.data.workspaceHash.toLowerCase() === workspace.workspaceHash.toLowerCase(),
  );
  return matchingSeals.length === 1;
};

function collectReceiverValidationDeltas(clonedMachine: AccountReplica): {
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
    return (
      peer !== undefined &&
      delta.tokenId === peer.tokenId &&
      delta.collateral === peer.collateral &&
      delta.ondelta === peer.ondelta &&
      delta.offdelta === peer.offdelta &&
      delta.leftCreditLimit === peer.leftCreditLimit &&
      delta.rightCreditLimit === peer.rightCreditLimit &&
      delta.leftAllowance === peer.leftAllowance &&
      delta.rightAllowance === peer.rightAllowance &&
      delta.leftHold === peer.leftHold &&
      delta.rightHold === peer.rightHold
    );
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
    byLeft: receivedFrame.byLeft,
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
  { kind: 'continue'; replay: IncomingFrameReplay } | { kind: 'return'; result: HandleAccountInputResult };

const replayIncomingFrameOnClone = async (
  context: AccountConsensusContext,
  clonedMachine: AccountReplica,
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
      receivedFrame.byLeft,
      receivedFrame.timestamp,
      frameJHeight,
      true,
      context,
      jClaimSession,
      securityContext.counterpartyCertifiedBoardHash,
    );
    if (!result.success) {
      return {
        kind: 'return',
        result: {
          success: false,
          error: `Frame application failed: ${result.error}`,
          events,
          ...(result.rejection ? { txRejection: result.rejection } : {}),
        },
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
  context: AccountConsensusContext,
  account: AccountReplica,
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
  const jClaimSession = createAccountJClaimSession(accountJClaimNodeStore);

  accountLog.debug('frame.receiver_validate', {
    height: receivedFrame.height,
    txs: receivedFrame.accountTxs.map(tx => tx.type),
  });
  const replayResult = await replayIncomingFrameOnClone(
    context,
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
  const proofResult = buildAccountProofBodyFromJurisdictions(context, clonedMachine);
  const localProofBodyHash = proofResult.proofBodyHash;
  const frameSealError = getDisputeSealRequirementError(
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
  context: AccountConsensusContext,
  account: AccountReplica,
  receivedFrame: AccountFrame,
  frameJHeight: number,
  committedJClaims: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
  candidateEffects: AccountOutput[],
): Promise<void> => {
  for (const tx of receivedFrame.accountTxs) {
    const beforeSettlement = captureSettlementVector(account);
    const commitResult = await applyAccountTx(
      account,
      tx,
      receivedFrame.byLeft,
      receivedFrame.timestamp,
      frameJHeight,
      false,
      context,
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
  context: AccountConsensusContext,
  account: AccountReplica,
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
  candidateEffects: AccountOutput[],
): Promise<void> {
  const { counterparty: cpForCommitLog } = getAccountPerspective(account, ourEntityId);
  if (HEAVY_LOGS) {
    accountLog.debug('receiver.commit.reexecute', {
      txs: receivedFrame.accountTxs.length,
      counterparty: shortId(cpForCommitLog),
    });
  }

  await reexecuteIncomingFrame(
    context,
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
    account,
    ourEntityId,
    input.fromEntityId,
    receivedFrame.height,
    securityContext.owningEntityIsHub,
    candidateEffects,
  );
  if (postCommitAutoRebalanceTxs.length > 0) {
    appendAccountMempoolTxs(account, postCommitAutoRebalanceTxs, 'accountConsensus:postCommitAutoRebalance');
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
  { kind: 'continue'; material: IncomingFrameAckMaterial } | { kind: 'return'; result: HandleAccountInputResult };

const storeAckProofSnapshot = (
  account: AccountReplica,
  proofResult: ReturnType<typeof buildAccountProofBodyFromJurisdictions>,
  signedNonce: number,
): void => {
  account.disputeProofNoncesByHash ??= {};
  account.disputeProofNoncesByHash[proofResult.proofBodyHash] = signedNonce;
  account.disputeProofBodiesByHash ??= {};
  account.disputeProofBodiesByHash[proofResult.proofBodyHash] = proofResult.proofBodyStruct;
  storeDisputeArgumentSnapshot(
    account,
    captureDisputeArgumentSnapshot(account, proofResult.proofBodyHash, signedNonce, proofResult.proofBodyStruct),
  );
};

const selectAckDisputeSeal = (
  account: AccountReplica,
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
  account: AccountReplica,
  input: AccountInput,
  receivedFrame: AccountFrame,
  ackProofResult: ReturnType<typeof buildAccountProofBodyFromJurisdictions>,
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
  const ackSignedNonce = Math.max(Number(account.proofHeader.nextProofNonce ?? 0), Number(account.jNonce ?? 0) + 1);
  const ackDisputeHash = proofChanged
    ? createDisputeProofHashWithNonce(account, ackProofResult.proofBodyHash, ackHankoDomain, ackSignedNonce)
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

function storeAckDisputeState(account: AccountReplica, material: IncomingFrameAckMaterial): void {
  if (material.proofChanged && material.ackDisputeHash) {
    replaceLocalDisputeDraft(account, {
      hash: material.ackDisputeHash,
      nonce: material.ackSignedNonce,
      proofBodyHash: material.ackProofBodyHash,
    });
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
  const allRevealedSecrets = [...validation.revealedSecrets, ...(proposeResult?.revealedSecrets || [])];
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
      ? [
          {
            hash: ackDisputeHash,
            type: 'dispute' as const,
            context: `account:${input.fromEntityId.slice(-8)}:ack-dispute`,
          },
        ]
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
  account: AccountReplica,
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

const classifyPreflightReturn = (result: HandleAccountInputResult): IncomingFrameResult => {
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
  account: AccountReplica,
  input: AccountInput,
  receivedFrame: AccountFrame,
  result: HandleAccountInputResult,
): IncomingFrameResult => {
  if (result.success) return { kind: 'return', result };
  if (
    isRefreshableStaleIncomingSettlementSeal(
      account,
      receivedFrame,
      result.txRejection,
    )
  ) {
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
  context: AccountConsensusContext,
  account: AccountReplica,
  input: AccountPeerInput,
  normalizedInputHeight: number | undefined,
  replayCurrentHeight: number,
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: AccountCommittedFrame[],
  committedJClaims: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
  candidateEffects: AccountOutput[],
): Promise<IncomingFrameResult> {
  if (!accountInputProposal(input)) {
    return { kind: 'not_applicable' };
  }

  const preflight = await preflightIncomingAccountFrame(
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
    context,
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
    return classifyIncomingValidationFailure(account, input, preflight.receivedFrame, validationResult.result);
  }

  if (preflight.rollbackPendingFrame) {
    applySameHeightIncomingFrameRollback(account, preflight.receivedFrame, events);
  }

  await commitIncomingFrameOnRealState(
    context,
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
  context: AccountConsensusContext;
  account: AccountReplica;
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
  candidateEffects: AccountOutput[];
};

const finishAccountInput = (
  session: AccountInputSession,
  result: HandleAccountInputResult,
): HandleAccountInputResult => {
  const accountJClaimNodeChanges = session.committedJClaims.changes();
  return {
    ...result,
    ...(session.candidateEffects.length > 0 ? { candidateEffects: session.candidateEffects } : {}),
    ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
  };
};

const handleAccountAckPhase = async (
  session: AccountInputSession,
): Promise<{ kind: 'continue'; ackProcessed: boolean } | { kind: 'return'; result: HandleAccountInputResult }> => {
  const {
    context,
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
  const { ackHeight } = resolveAccountAckTarget(account, input, normalizedInputHeight);
  const pending = await handlePendingFrameAck(
    context,
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
  return unmatched ? { kind: 'return', result: unmatched } : { kind: 'continue', ackProcessed };
};

const handleStandaloneDispute = async (session: AccountInputSession): Promise<HandleAccountInputResult> => {
  const { account, input, securityContext, events } = session;
  if (input.kind !== 'dispute') {
    throw new Error(`ACCOUNT_DISPUTE_PHASE_KIND_INVALID:${input.kind}`);
  }
  try {
    const seal = await validateCounterpartyDisputeSeal(
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
    context,
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
    context,
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
  return (
    handleUnmatchedAck(account, input, normalizedInputHeight, ackProcessed, events, committedFrames, 'after_frame') ??
    null
  );
};

/**
 * Bilateral Account input composition root. Protocol-specific validation and
 * mutation remain in the phase handlers above.
 */
const resolveAccountInputSecurityContext = (
  context: AccountConsensusContext,
  account: AccountReplica,
  provided: AccountInputSecurityContext | undefined,
): AccountInputSecurityContext =>
  ({
    ...(provided ?? {
      entityTimestamp: context.runtimeTimestamp,
      owningEntityIsHub: false,
      // Account never reaches upward into Entity replicas. Normal Entity
      // routing supplies the current certified height explicitly.
      finalizedJHeight: account.lastFinalizedJHeight ?? 0,
    }),
    verifyHanko: context.verifyHanko,
  });

const applyExternalFinalityInput = (
  account: AccountReplica,
  input: Extract<AccountInput, { kind: 'external_finality' }>,
): HandleAccountInputResult => {
  if (input.finality.kind === 'dispute_started') {
    applyAccountDisputeStarted(account, input.finality);
    return {
      success: true,
      events: ['ACCOUNT_DISPUTE_STARTED_APPLIED'],
    };
  }
  const { finalizedJNonce, finalizedTokenIds } = input.finality;
  return {
    success: true,
    events: ['ACCOUNT_DISPUTE_FINALITY_APPLIED'],
    externalFinality: applyAccountDisputeFinality(
      account,
      finalizedJNonce,
      finalizedTokenIds,
    ),
  };
};

export async function applyAccountInput(
  context: AccountConsensusContext,
  account: AccountReplica,
  input: AccountInput,
  providedSecurityContext?: AccountInputSecurityContext,
): Promise<HandleAccountInputResult> {
  const envelopeError = getAccountInputEnvelopeError(account, input);
  if (envelopeError) {
    return { success: false, error: envelopeError, events: [] };
  }
  if (input.kind === 'txs') return applyLocalAccountInput(account, input);
  if (input.kind === 'external_finality') {
    return applyExternalFinalityInput(account, input);
  }
  const accountJClaimNodeStore = context.jClaimNodeStore;
  const securityContext = resolveAccountInputSecurityContext(context, account, providedSecurityContext);
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
  const boardReseal = await handleBoardReseal(account, input, securityContext);
  if (boardReseal) {
    const session = {
      context,
      account,
      input,
      securityContext,
      normalizedInputHeight,
      replay: classifyAccountInputReplay(account, input),
      events,
      timedOutHashlocks: [],
      committedFrames: [],
      committedJClaims: createAccountJClaimSession(accountJClaimNodeStore),
      candidateEffects: [],
    };
    return finishAccountInput(session, boardReseal);
  }
  const replay = classifyAccountInputReplay(account, input);
  const replayGateResult = await handleReplayOrObsoleteAccountInput(account, input, replay, events);
  if (replayGateResult) return replayGateResult;
  const session: AccountInputSession = {
    context,
    account,
    input,
    securityContext,
    normalizedInputHeight,
    replay,
    events,
    timedOutHashlocks: [],
    committedFrames: [],
    committedJClaims: createAccountJClaimSession(accountJClaimNodeStore),
    candidateEffects: [],
  };
  const ack = await handleAccountAckPhase(session);
  if (ack.kind === 'return') return finishAccountInput(session, ack.result);
  const proposalResult = await handleAccountProposalPhase(session, ack.ackProcessed);
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
