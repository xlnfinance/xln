/**
 * Bilateral account consensus: two entities agree on a frame chain for one
 * off-chain account, then bubble committed effects back to the entity runtime.
 */

import type {
  AccountReplica,
  AccountDisputeSeal,
  AccountFrame,
  AccountInput,
  AccountOutput,
  AccountPeerInput,
  Delta,
} from '../../types/account';
import type { AccountConsensusContext } from './context';
import {
  cloneIsolatedAccountFrame,
  copyAccountDisputeConfig,
  copyAccountStateDomain,
} from '../../protocol/state/account-input-clone';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  discardAccountTransition,
  publishAccountOverlay,
} from '../state/candidate-overlay';
import { getAccountPerspective } from '../state/perspective';
import { HEAVY_LOGS } from '../../support/debug-flags';
import { applyAccountTx } from '../tx/apply';
import type { AccountDraftReplica } from '../state/account-state-draft';
import type { AccountTxRejection, ApplyAccountTxOk } from '../tx/apply-types';
import { accountTxFailureMessage, assertNever } from '../tx/apply-result';
import { createStructuredLogger, shortHash, shortId } from '../../support/logger';
import { assertAccountFrameHash } from './frame/hash';
import {
  assertNoUnilateralSettlementMutation,
  buildAccountProofBodyFromJurisdictions,
  captureSettlementVector,
  getAccountStateDomain,
  runPostFrameAutoRebalanceCheck,
  shouldIncludeToken,
  summarizeDeltasForLog,
} from './helpers';
import { appendAccountMempoolTxs } from '../input/mempool';
import {
  applyAccountDisputeFinality,
  applyAccountDisputeStarted,
} from '../settlement/j-finality';
import { applyAccountEnqueue } from '../input/local-tx-admission';
import { getAccountInputEnvelopeError } from '../input';
import type {
  AccountCommittedFrame,
  AccountConsensusHashToSign,
  AccountSwapOfferCreated,
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from './types';
import { createDisputeProofHashWithNonce } from '../../protocol/dispute/proof-builder';
import { getMinimumSafeSettlementNonce } from '../../protocol/settlement/operations';
import { computeAccountStateSectionHashes } from '../commitment/state-root';
import { createAccountJClaimSession, type AccountJClaimSession } from '../j-claims/j-claim-session';
import type {
  AccountJClaimNodeChanges,
  AccountJClaimNodeStore,
} from '../../types/finance/account-j-claims';
import {
  getIncomingAccountDeadlineViolation,
  HTLC_ENFORCEMENT_RESERVE_MS,
  isHtlcSecretEnforcementWindowClosed,
  type AccountInputSecurityContext,
} from './dispute/deadline-policy';
import { accountInputAck, accountInputProposal, accountInputReferenceHeight } from './flush';
import { handleBoardReseal } from './incoming/board-reseal';
import { handlePendingFrameAck } from './incoming/ack-commit';
import {
  getDisputeSealRequirementError,
  replaceLocalDisputeDraft,
  storeCounterpartyDisputeSeal,
  type ValidatedCounterpartyDisputeSeal,
  validateCounterpartyDisputeSeal,
} from './dispute/seal';
import {
  classifyAccountInputReplay,
  getDisputeHankoShapeError,
  handleReplayOrObsoleteAccountInput,
  normalizeAccountInputHeight,
} from './incoming/replay';
import { applySameHeightIncomingFrameRollback, handleUnmatchedAck, resolveAccountAckTarget } from './incoming/collision';
import { preflightIncomingAccountFrame } from './incoming/preflight';
import {
  accountInputApplied,
  accountInputDisputeRequired,
  accountInputFailureMessage,
  accountInputTxRejected,
  accountInputValidationRejected,
  isProposedAccountFrame,
  rejectAccountPeerEvidenceError,
  rejectAccountPeerInput,
} from './result';
import { timePerfPhase } from '../../support/performance/profile';
import { countOp } from '../../support/performance/op-counters';
export { proposeAccountFrame } from './proposal/propose';
export type { HandleAccountInputResult } from './types';

const accountLog = createStructuredLogger('account');

export { getIncomingAccountDeadlineViolation, HTLC_ENFORCEMENT_RESERVE_MS, isHtlcSecretEnforcementWindowClosed };
export type { AccountInputSecurityContext };
export { computeFrameHash } from './frame/hash';

// Counter-based replay protection was intentionally replaced by the frame chain
// (height + prevFrameHash). Nonces remain only for on-chain proof material.

type AccountRevealedSecret = { secret: string; hashlock: string };
type AccountSwapCancelRequest = { offerId: string; accountId: string };

type IncomingFrameValidation = {
  clonedMachine: AccountReplica;
  proofResult: ReturnType<typeof buildAccountProofBodyFromJurisdictions>;
  candidateEffects: AccountOutput[];
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  processEvents: string[];
  revealedSecrets: AccountRevealedSecret[];
  swapOffersCreated: AccountSwapOfferCreated[];
  swapCancelRequests: AccountSwapCancelRequest[];
  swapOffersCancelled: AccountSwapCancelRequest[];
  timedOutHashlocks: string[];
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

  const workspace = account.state.settlementWorkspace;
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
  const sortedOurTokens = Array.from(clonedMachine.state.deltas.entries()).sort((a, b) => a[0] - b[0]);

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
  try {
    assertAccountFrameHash(receivedFrame, 'ACCOUNT_PEER_FRAME_HASH_INVALID');
  } catch {
    accountLog.warn('frame.hash_mismatch', {
      claimed: shortHash(receivedFrame.stateHash),
    });
    return rejectAccountPeerInput(
      'ACCOUNT_PEER_FRAME_HASH_INVALID',
      'Frame hash verification failed - claimed stateHash is not the merkle of this body',
      events,
    );
  }
  return undefined;
}

type IncomingFrameReplay = Omit<
  IncomingFrameValidation,
  'clonedMachine' | 'proofResult'
>;
type IncomingFrameReplayResult =
  { kind: 'continue'; replay: IncomingFrameReplay } | { kind: 'return'; result: HandleAccountInputResult };

const collectIncomingOkOutcome = (
  result: ApplyAccountTxOk,
  replay: IncomingFrameReplay,
  fromEntityId: string,
): void => {
  switch (result.outcome) {
    case 'applied':
      return;
    case 'htlc_secret':
      replay.revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
      return;
    case 'htlc_error':
      replay.timedOutHashlocks.push(result.hashlock);
      return;
    case 'swap_offer_created':
      replay.swapOffersCreated.push(result.swapOfferCreated);
      return;
    case 'swap_cancel_requested':
      replay.swapCancelRequests.push({
        ...result.swapOfferCancelRequested,
        accountId: fromEntityId,
      });
      return;
    case 'swap_cancelled':
      replay.swapOffersCancelled.push(result.swapOfferCancelled);
      return;
    default:
      assertNever(result);
  }
};

const replayIncomingFrameOnClone = async (
  context: AccountConsensusContext,
  clonedMachine: AccountDraftReplica,
  input: AccountPeerInput,
  receivedFrame: AccountFrame,
  frameJHeight: number,
  events: string[],
  jClaimSession: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
): Promise<IncomingFrameReplayResult> => {
  const replay: IncomingFrameReplay = {
    processEvents: [],
    revealedSecrets: [],
    swapOffersCreated: [],
    swapCancelRequests: [],
    swapOffersCancelled: [],
    candidateEffects: [],
    timedOutHashlocks: [],
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
      securityContext.counterpartyCertifiedBoard?.boardHash,
      {
        timestamp: securityContext.entityTimestamp,
        jHeight: securityContext.finalizedJHeight,
      },
    );
    if (!result.ok) {
      return {
        kind: 'return',
        result: accountInputTxRejected(
          result.rejection,
          events,
          `Frame application failed: ${accountTxFailureMessage(result)}`,
        ),
      };
    }
    assertNoUnilateralSettlementMutation(clonedMachine, beforeSettlement, accountTx, 'receiver/validate');
    if (HEAVY_LOGS) {
      accountLog.debug('receiver.tx.processed', { type: accountTx.type, success: true });
    }
    replay.processEvents.push(...result.events);
    replay.candidateEffects.push(...(result.candidateEffects ?? []));
    collectIncomingOkOutcome(result, replay, input.fromEntityId);
  }
  return { kind: 'continue', replay };
};

const validateIncomingCommittedState = (
  account: AccountReplica,
  accountStateRoot: string,
  receivedFrame: AccountFrame,
  events: string[],
): HandleAccountInputResult | undefined => {
  const { deltas } = collectReceiverValidationDeltas(account);
  if (
    accountStateRoot === receivedFrame.accountStateRoot &&
    accountFrameDeltasEqual(deltas, receivedFrame.deltas)
  ) return undefined;
  accountLog.warn('frame.state_root_mismatch', {
    height: receivedFrame.height,
    txs: receivedFrame.accountTxs.map(tx => tx.type),
    localAccountStateRoot: accountStateRoot,
    receivedAccountStateRoot: receivedFrame.accountStateRoot,
    localDeltas: summarizeDeltasForLog(new Map(deltas.map(delta => [delta.tokenId, delta]))),
    receivedDeltas: summarizeDeltasForLog(new Map(receivedFrame.deltas.map(delta => [delta.tokenId, delta]))),
    localAccountStateSectionHashes: computeAccountStateSectionHashes(account.state),
    lastFinalizedJHeight: account.state.lastFinalizedJHeight,
    leftPendingJClaims: account.state.leftPendingJClaims,
    rightPendingJClaims: account.state.rightPendingJClaims,
  });
  return accountInputValidationRejected('Bilateral account state root mismatch', events);
};

const logAcceptedIncomingFrame = (input: AccountPeerInput, frame: AccountFrame): void => {
  accountLog.debug('frame.accept', {
    height: frame.height,
    from: shortId(input.fromEntityId),
    txs: frame.accountTxs.map(tx => tx.type),
  });
};

async function validateIncomingFrameOnDraft(
  context: AccountConsensusContext,
  account: AccountReplica,
  input: AccountPeerInput,
  receivedFrame: AccountFrame,
  frameJHeight: number,
  events: string[],
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
  accountJClaimNodeStore: AccountJClaimNodeStore,
  securityContext: AccountInputSecurityContext,
): Promise<IncomingFrameValidationResult> {
  const frameHashMismatch = await timePerfPhase(
    'account.receive.frameHash',
    () => verifySenderFrameHash(receivedFrame, events),
  );
  if (frameHashMismatch) {
    return { kind: 'return', result: frameHashMismatch };
  }

  const transition = timePerfPhase(
    'account.receive.beginOverlay',
    () => beginAccountTransition(account),
  );
  const clonedMachine = accountTransitionView(transition);
  let sealed = false;
  const jClaimSession = createAccountJClaimSession(accountJClaimNodeStore);

  try {
    accountLog.debug('frame.receiver_validate', {
      height: receivedFrame.height,
      txs: receivedFrame.accountTxs.map(tx => tx.type),
    });
    const replayResult = await timePerfPhase(
      'account.receive.replayTxs',
      () => replayIncomingFrameOnClone(
        context,
        clonedMachine,
        input,
        receivedFrame,
        frameJHeight,
        events,
        jClaimSession,
        securityContext,
      ),
    );
    if (replayResult.kind === 'return') {
      discardAccountTransition(transition);
      return replayResult;
    }

    // Preparing consumes only the ephemeral owner; it does not publish into the
    // Entity Account index. Hash the prepared persistent roots, never a draft
    // view whose collections intentionally expose no commitment authority.
    const committed = timePerfPhase(
      'account.receive.prepareOverlay',
      () => commitAccountTransition(transition, 'incomingValidation'),
    );
    sealed = true;
    const validatedMachine = committed.account;
    const stateMismatch = validateIncomingCommittedState(
      validatedMachine,
      committed.accountStateRoot,
      receivedFrame,
      events,
    );
    if (stateMismatch) return { kind: 'return', result: stateMismatch };
    const proofResult = timePerfPhase(
      'account.receive.proofBody',
      () => buildAccountProofBodyFromJurisdictions(context, validatedMachine),
    );
    const localProofBodyHash = proofResult.proofBodyHash;
    const frameSealError = getDisputeSealRequirementError(
      localProofBodyHash,
      account.counterpartyDisputeProofBodyHash,
      account.counterpartyDisputeProofNonce,
      Number(validatedMachine.state.jNonce ?? account.state.jNonce ?? 0),
      validatedCounterpartyDisputeSeal,
    );
    if (frameSealError) {
      return { kind: 'return', result: accountInputValidationRejected(frameSealError, events) };
    }

    logAcceptedIncomingFrame(input, receivedFrame);

    const accountJClaimNodeChanges = jClaimSession.changes();
    return {
      kind: 'continue',
      validation: {
        clonedMachine: committed.account,
        proofResult,
        ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
        ...replayResult.replay,
      },
    };
  } catch (error) {
    if (!sealed) discardAccountTransition(transition);
    throw error;
  }
}

async function commitIncomingFrameOnRealState(
  account: AccountReplica,
  input: AccountPeerInput,
  receivedFrame: AccountFrame,
  validation: IncomingFrameValidation,
  ourEntityId: string,
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
  events: string[],
  committedFrames: AccountCommittedFrame[],
  committedJClaims: AccountJClaimSession,
  securityContext: AccountInputSecurityContext,
  timedOutHashlocks: string[],
  candidateEffects: AccountOutput[],
): Promise<void> {
  const { counterparty: cpForCommitLog } = getAccountPerspective(account.state, ourEntityId);
  if (HEAVY_LOGS) {
    accountLog.debug('receiver.commit.install', {
      txs: receivedFrame.accountTxs.length,
      counterparty: shortId(cpForCommitLog),
      source: 'validated-transition',
    });
  }

  // The prepared overlay owns financial state and commit effects; coordination
  // fields stay on the live envelope. RIGHT collision rollback therefore may
  // restore its losing proposal to the live mempool first and then publish the
  // already-validated winning transition without executing its AccountTxs a
  // second time.
  publishAccountOverlay(account, validation.clonedMachine);
  if (account.state !== validation.clonedMachine.state) {
    throw new Error('ACCOUNT_OVERLAY_PUBLISH_STATE_IDENTITY_MISMATCH');
  }
  timedOutHashlocks.push(...validation.timedOutHashlocks);
  candidateEffects.push(...validation.candidateEffects);
  if (validation.accountJClaimNodeChanges) {
    committedJClaims.absorb(validation.accountJClaimNodeChanges);
  }

  accountLog.debug('frame.commit.complete', {
    side: 'receiver',
    counterparty: shortId(cpForCommitLog),
    height: receivedFrame.height,
    tokens: account.state.deltas.size,
  });
  if (account.pendingForwards?.length) {
    accountLog.debug('pending_forwards.copied', {
      count: account.pendingForwards.length,
      routes: account.pendingForwards.map(forward => forward.route.map(r => shortId(r))),
    });
  }

  account.currentFrame = cloneIsolatedAccountFrame(receivedFrame);
  account.currentHeight = receivedFrame.height;
  const acceptedFrameHanko = accountInputProposal(input)?.frameHanko;
  if (!acceptedFrameHanko) throw new Error('ACCEPTED_ACCOUNT_FRAME_HANKO_MISSING');
  account.counterpartyFrameHanko = acceptedFrameHanko;
  if (accountInputProposal(input)?.disputeSeal) {
    storeCounterpartyDisputeSeal(account, validatedCounterpartyDisputeSeal);
    accountLog.debug('hanko.dispute_frame_stored', { height: receivedFrame.height, from: shortId(input.fromEntityId) });
  }

  // The committed Account graph is frozen at Entity commit, so history may
  // share the live head's frame object; only genesis handlers write
  // accountStateRoot in place, and never on this path.
  committedFrames.push({ frame: account.currentFrame, committedViaNewFrame: true });
  accountLog.debug('frame.indexed', { source: 'peerCommit', height: receivedFrame.height });

  events.push(...validation.processEvents);
  events.push(`🤝 Accepted frame ${receivedFrame.height} from Entity ${input.fromEntityId.slice(-4)}`);

  const postCommitAutoRebalanceTxs = runPostFrameAutoRebalanceCheck(
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
  response: Extract<AccountPeerInput, { kind: 'ack' }>;
  outboundAck: {
    height: number;
    counterpartyEntityId: string;
    response: Extract<AccountPeerInput, { kind: 'ack' }>;
  };
  ackDisputeHash?: string;
  ackProofBodyHash: string;
  ackSignedNonce: number;
  ackProposerIsLeft: boolean;
  proofChanged: boolean;
};

type IncomingFrameAckMaterialResult =
  { kind: 'continue'; material: IncomingFrameAckMaterial } | { kind: 'return'; result: HandleAccountInputResult };

const selectAckDisputeSeal = (
  account: AccountReplica,
  proofBodyHash: string,
  signedNonce: number,
  proofChanged: boolean,
  disputeHash: string | undefined,
  proposerIsLeft: boolean,
): AccountDisputeSeal | undefined => {
  if (proofChanged && disputeHash) {
    return {
      hash: disputeHash,
      proofBodyHash,
      proofNonce: signedNonce,
      proposerIsLeft,
    };
  }
  const reusable =
    account.currentDisputeProofHanko &&
    account.currentDisputeHash &&
    account.currentDisputeProofBodyHash?.toLowerCase() === proofBodyHash.toLowerCase() &&
    account.currentDisputeProofProposerIsLeft === proposerIsLeft &&
    Number(account.currentDisputeProofNonce ?? 0) > Number(account.state.jNonce ?? 0);
  if (!reusable) return undefined;
  return {
    hanko: account.currentDisputeProofHanko!,
    hash: account.currentDisputeHash!,
    proofBodyHash: account.currentDisputeProofBodyHash!,
    proofNonce: account.currentDisputeProofNonce!,
    proposerIsLeft,
  };
};

async function buildIncomingFrameAckMaterial(
  account: AccountReplica,
  input: AccountPeerInput,
  receivedFrame: AccountFrame,
  ackProofResult: ReturnType<typeof buildAccountProofBodyFromJurisdictions>,
  events: string[],
): Promise<IncomingFrameAckMaterialResult> {
  const ackEntityId = account.proofHeader.fromEntity;
  accountLog.debug('hanko.ack.defer_to_entity_consensus', {
    entity: shortId(ackEntityId),
    height: receivedFrame.height,
  });

  const ackHankoDomain = getAccountStateDomain(account.state);
  const proofChanged =
    ackProofResult.proofBodyHash.toLowerCase() !== account.currentDisputeProofBodyHash?.toLowerCase() ||
    account.currentDisputeProofProposerIsLeft !== receivedFrame.byLeft ||
    Number(account.currentDisputeProofNonce ?? 0) <= Number(account.state.jNonce ?? 0);
  const ackSignedNonce = Math.max(Number(account.proofHeader.nextProofNonce ?? 0), Number(account.state.jNonce ?? 0) + 1);
  const ackDisputeHash = proofChanged
    ? createDisputeProofHashWithNonce(
        account.state,
        ackProofResult.proofBodyHash,
        ackHankoDomain,
        ackSignedNonce,
        receivedFrame.byLeft,
      )
    : undefined;
  if (proofChanged) {
    if (!ackDisputeHash) {
      return { kind: 'return', result: accountInputValidationRejected('Failed to build ACK dispute hanko', events) };
    }
  }

  const ackDisputeSeal = selectAckDisputeSeal(
    account,
    ackProofResult.proofBodyHash,
    ackSignedNonce,
    proofChanged,
    ackDisputeHash,
    receivedFrame.byLeft,
  );

  const response: Extract<AccountPeerInput, { kind: 'ack' }> = {
    kind: 'ack',
    fromEntityId: account.proofHeader.fromEntity,
    toEntityId: input.fromEntityId,
    domain: copyAccountStateDomain(account.state.domain),
    disputeConfig: copyAccountDisputeConfig(account.state.disputeConfig),
    watchSeed: account.state.watchSeed,
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
      ackProposerIsLeft: receivedFrame.byLeft,
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
      proposerIsLeft: material.ackProposerIsLeft,
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
  const allRevealedSecrets = [
    ...validation.revealedSecrets,
    ...(proposeResult && isProposedAccountFrame(proposeResult) ? proposeResult.revealedSecrets ?? [] : []),
  ];
  const allSwapOffersCreated = [
    ...validation.swapOffersCreated,
    ...(proposeResult && isProposedAccountFrame(proposeResult) ? proposeResult.swapOffersCreated ?? [] : []),
  ];
  const allSwapCancelRequests = [
    ...validation.swapCancelRequests,
    ...(proposeResult && isProposedAccountFrame(proposeResult) ? proposeResult.swapCancelRequests ?? [] : []),
  ];
  const allSwapOffersCancelled = [
    ...validation.swapOffersCancelled,
    ...(proposeResult && isProposedAccountFrame(proposeResult) ? proposeResult.swapOffersCancelled ?? [] : []),
  ];
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
    ...(proposeResult && isProposedAccountFrame(proposeResult) ? proposeResult.hashesToSign ?? [] : []),
  ];

  if (HEAVY_LOGS) {
    accountLog.debug('return.response', {
      height: accountInputReferenceHeight(response),
      prevHanko: Boolean(accountInputAck(response)?.frameHanko),
      newFrame: Boolean(accountInputProposal(response)),
    });
  }
  return accountInputApplied({
    response,
    events,
    revealedSecrets: allRevealedSecrets,
    swapOffersCreated: allSwapOffersCreated,
    swapCancelRequests: allSwapCancelRequests,
    swapOffersCancelled: allSwapOffersCancelled,
    timedOutHashlocks,
    ...(committedFrames.length > 0 && { committedFrames }),
    ...(hashesToSign.length > 0 && { hashesToSign }),
  });
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

const classifyIncomingValidationFailure = (
  account: AccountReplica,
  input: AccountPeerInput,
  receivedFrame: AccountFrame,
  result: HandleAccountInputResult,
): IncomingFrameResult => {
  if (result.ok) return { kind: 'return', result };
  if (result.disposition === 'rejected' && result.rejection.kind === 'peer') {
    return { kind: 'return', result };
  }
  const txRejection = result.disposition === 'rejected' && result.rejection.kind === 'tx'
    ? result.rejection.tx
    : undefined;
  const failureMessage = accountInputFailureMessage(result);
  if (isRefreshableStaleIncomingSettlementSeal(account, receivedFrame, txRejection)) {
    accountLog.warn('frame.stale_settlement_seal_rejected', {
      height: receivedFrame.height,
      error: failureMessage,
    });
    return {
      kind: 'return',
      result: rejectAccountPeerInput(
        'ACCOUNT_PEER_FRAME_STALE_SETTLEMENT_SEAL',
        failureMessage || 'Stale settlement seal rejected',
        result.events,
      ),
    };
  }
  const proposal = accountInputProposal(input)!;
  if (!proposal.frameHanko) {
    throw new Error('INBOUND_ACCOUNT_FRAME_HANKO_MISSING_AFTER_VALIDATION');
  }
  return {
    kind: 'return',
    result: accountInputDisputeRequired(
      {
        reason: failureMessage || 'Signed account frame failed deterministic replay',
        evidenceSecrets: [],
        signedFrame: {
          frame: structuredClone(receivedFrame),
          frameHanko: proposal.frameHanko,
        },
      },
      result.events,
    ),
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
    return { kind: 'return', result: preflight.result };
  }

  const validationResult = await validateIncomingFrameOnDraft(
    context,
    account,
    input,
    preflight.receivedFrame,
    preflight.frameJHeight,
    events,
    validatedCounterpartyDisputeSeal,
    committedJClaims.store,
    securityContext,
  );
  if (validationResult.kind === 'return') {
    return classifyIncomingValidationFailure(account, input, preflight.receivedFrame, validationResult.result);
  }

  if (preflight.rollbackPendingFrame) {
    applySameHeightIncomingFrameRollback(account, preflight.receivedFrame, events);
    countOp('account.collision.validatedOverlayReused');
  }

  await commitIncomingFrameOnRealState(
    account,
    input,
    preflight.receivedFrame,
    validationResult.validation,
    preflight.ourEntityId,
    validatedCounterpartyDisputeSeal,
    events,
    committedFrames,
    committedJClaims,
    securityContext,
    timedOutHashlocks,
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
  if (!result.ok) return result;
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
      result: rejectAccountPeerEvidenceError(error, events),
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

const handleStandaloneDispute = async (
  account: AccountReplica,
  input: Extract<AccountPeerInput, { kind: 'dispute' }>,
  securityContext: AccountInputSecurityContext,
  events: string[],
): Promise<HandleAccountInputResult> => {
  try {
    const seal = await validateCounterpartyDisputeSeal(
      account,
      input,
      input.disputeSeal,
      'ACCOUNT_DISPUTE',
      securityContext,
    );
    const sealError = getDisputeSealRequirementError(
      account.currentDisputeProofBodyHash,
      account.counterpartyDisputeProofBodyHash,
      account.counterpartyDisputeProofNonce,
      Number(account.state.jNonce ?? 0),
      seal,
    );
    if (sealError) {
      return rejectAccountPeerInput(
        'ACCOUNT_PEER_DISPUTE_SEAL_INVALID',
        sealError,
        events,
      );
    }
    storeCounterpartyDisputeSeal(account, seal);
    return accountInputApplied({ events });
  } catch (error) {
    return rejectAccountPeerEvidenceError(error, events);
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
    return rejectAccountPeerEvidenceError(error, events);
  }
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
      finalizedJHeight: account.state.lastFinalizedJHeight ?? 0,
    }),
    verifyHanko: context.verifyHanko,
  });

const applyExternalFinalityInput = (
  account: AccountReplica,
  input: Extract<AccountInput, { kind: 'external_finality' }>,
): HandleAccountInputResult => {
  if (input.finality.kind === 'dispute_started') {
    applyAccountDisputeStarted(account, input.finality);
    return accountInputApplied({ events: ['ACCOUNT_DISPUTE_STARTED_APPLIED'] });
  }
  const { finalizedJNonce, finalizedTokenIds } = input.finality;
  return accountInputApplied({
    events: ['ACCOUNT_DISPUTE_FINALITY_APPLIED'],
    externalFinality: applyAccountDisputeFinality(
      account,
      finalizedJNonce,
      finalizedTokenIds,
    ),
  });
};

export async function applyAccountInput(
  context: AccountConsensusContext,
  account: AccountReplica,
  input: AccountInput,
  providedSecurityContext?: AccountInputSecurityContext,
): Promise<HandleAccountInputResult> {
  if (input.kind === 'enqueue') return applyAccountEnqueue(account, input);
  const envelopeError = getAccountInputEnvelopeError(account.state, input);
  if (envelopeError) {
    if (input.kind === 'external_finality') {
      return accountInputValidationRejected(envelopeError.reason, []);
    }
    return rejectAccountPeerInput(envelopeError.code, envelopeError.reason, []);
  }
  if (input.kind === 'external_finality') {
    return applyExternalFinalityInput(account, input);
  }
  return applyPeerAccountInput(context, account, input, providedSecurityContext);
}

const applyPeerAccountInput = async (
  context: AccountConsensusContext,
  account: AccountReplica,
  input: Exclude<AccountInput, { kind: 'enqueue' | 'external_finality' }>,
  providedSecurityContext: AccountInputSecurityContext | undefined,
): Promise<HandleAccountInputResult> => {
  const accountJClaimNodeStore = context.jClaimNodeStore;
  const securityContext = resolveAccountInputSecurityContext(context, account, providedSecurityContext);
  if (input.kind === 'dispute') {
    const events: string[] = [];
    const disputeHankoShapeError = getDisputeHankoShapeError(input);
    if (disputeHankoShapeError) {
      return rejectAccountPeerInput(
        'ACCOUNT_PEER_HANKO_SHAPE_INVALID',
        disputeHankoShapeError,
        events,
      );
    }
    // A standalone dispute witness is sequenced by its signed proof nonce, not
    // by an Account frame height. Route it before frame-height normalization so
    // adversarial peer evidence can only be accepted or rejected, never turn a
    // valid heightless protocol lane into a local-bug Runtime halt.
    return handleStandaloneDispute(account, input, securityContext, events);
  }
  const heightNormalization = normalizeAccountInputHeight(input);
  if (!heightNormalization.ok) {
    return rejectAccountPeerInput(
      'ACCOUNT_PEER_HEIGHT_INVALID',
      heightNormalization.message,
      [],
    );
  }
  const { normalizedInputHeight } = heightNormalization;
  if (normalizedInputHeight === undefined) {
    throw new Error('ACCOUNT_INPUT_HEIGHT_NORMALIZATION_INVARIANT');
  }
  const events: string[] = [];
  const disputeHankoShapeError = getDisputeHankoShapeError(input);
  if (disputeHankoShapeError) {
    return rejectAccountPeerInput(
      'ACCOUNT_PEER_HANKO_SHAPE_INVALID',
      disputeHankoShapeError,
      events,
    );
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
  const ack = await timePerfPhase(
    'account.peer.ackPhase',
    () => handleAccountAckPhase(session),
  );
  if (ack.kind === 'return') return finishAccountInput(session, ack.result);
  const proposalResult = await timePerfPhase(
    'account.peer.proposalPhase',
    () => handleAccountProposalPhase(session, ack.ackProcessed),
  );
  if (proposalResult) return finishAccountInput(session, proposalResult);
  if (HEAVY_LOGS) accountLog.debug('return.no_response');
  return finishAccountInput(session, accountInputApplied({
    events,
    swapOffersCreated: [],
    swapCancelRequests: [],
    swapOffersCancelled: [],
    timedOutHashlocks: session.timedOutHashlocks,
    ...(session.committedFrames.length > 0 && {
      committedFrames: session.committedFrames,
    }),
  }));
};
