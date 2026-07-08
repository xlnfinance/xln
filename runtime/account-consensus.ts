/**
 * Bilateral account consensus: two entities agree on a frame chain for one
 * off-chain account, then bubble committed effects back to the entity runtime.
 */

import type {
  AccountMachine,
  AccountFrame,
  AccountTx,
  AccountInput,
  Env,
  EntityState,
  Delta,
} from './types';
import {
  cloneAccountFrame,
  cloneAccountMachine,
  getAccountPerspective,
} from './state-helpers';
import { isLeft } from './account-utils';
import { HEAVY_LOGS } from './utils';
import { safeStringify } from './serialization-utils';
import { applyAccountTx } from './account-tx/apply';
import { appendAccountFrameHistoryView, getAccountFrameHistoryView, markStorageAccountDirty, recordAccountFrameHistory } from './env-events';
import { deriveAccountFrameOffdeltas, deriveAccountFrameTokenIds } from './account-frame';
import { createStructuredLogger, shortHash, shortId, shouldLogFullPayloads } from './logger';
import {
  createFrameHash,
  getAccountFrameValidationError,
} from './account-consensus-frame';
import { normalizeAccountWatchSeed } from './account-watch-seed';
import {
  assertNoUnilateralSettlementMutation,
  captureSettlementVector,
  getAccountDepositoryAddress,
  isAddress20,
  kickHubRebalanceAfterFrameFinalize,
  prependUniqueMempoolTxs,
  runPostFrameAutoRebalanceCheck,
  shouldIncludeToken,
  summarizeDeltasForLog,
} from './account-consensus-helpers';
import { MEMPOOL_LIMIT } from './account-consensus/constants';
import { proposeAccountFrame } from './account-consensus/propose';
import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from './dispute-arguments';
import type {
  AccountConsensusHashToSign,
  AccountSwapOfferCreated,
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from './account-consensus/types';
import { buildAccountProofBody, createDisputeProofHashWithNonce } from './proof-builder';
import { signEntityHashes, verifyHankoForHash } from './hanko/signing';
import { getReplicaByEntityId } from './replica-utils';
export { proposeAccountFrame } from './account-consensus/propose';
export type {
  AccountConsensusFrameResult,
  AccountConsensusHashToSign,
  AccountSwapOfferCreated,
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from './account-consensus/types';

const accountLog = createStructuredLogger('account');

export { computeFrameHash, validateAccountFrame } from './account-consensus-frame';

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
  context: string,
): Promise<ValidatedCounterpartyDisputeSeal | undefined> {
  if (!input.newDisputeHanko) return undefined;
  if (
    input.disputeProofNonce === undefined ||
    !input.newDisputeHash ||
    !input.newDisputeProofBodyHash
  ) {
    throw new Error(`${context}:DISPUTE_SEAL_INCOMPLETE`);
  }

  const depositoryAddress = getAccountDepositoryAddress(env, accountMachine);
  if (!isAddress20(depositoryAddress)) {
    throw new Error(`${context}:DISPUTE_SEAL_DEPOSITORY_MISSING`);
  }

  // A dispute Hanko is only useful if it signs the exact Solidity message:
  // (MessageType.DisputeProof, depository, canonical accountKey, nonce,
  // proofbodyHash). Verifying a peer-supplied `newDisputeHash` alone is not
  // enough: a malicious peer can sign any random hash, attach a plausible
  // proofbodyHash, and make us store metadata that later fails on-chain.
  const expectedHash = createDisputeProofHashWithNonce(
    accountMachine,
    input.newDisputeProofBodyHash,
    depositoryAddress,
    input.disputeProofNonce,
  );
  if (String(input.newDisputeHash).toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`${context}:DISPUTE_SEAL_HASH_MISMATCH:${safeStringify({
      kind: input.kind,
      currentHeight: accountMachine.currentHeight,
      pendingHeight: accountMachine.pendingFrame?.height ?? null,
      inputHeight: input.height ?? null,
      newFrameHeight: input.newAccountFrame?.height ?? null,
      localNonce: accountMachine.proofHeader.nonce,
      signedNonce: input.disputeProofNonce,
      proofBodyHash: input.newDisputeProofBodyHash,
      expected: expectedHash,
      received: input.newDisputeHash,
      from: shortId(input.fromEntityId),
      to: shortId(input.toEntityId),
    })}`);
  }

  const { valid } = await verifyHankoForHash(
    input.newDisputeHanko,
    expectedHash,
    input.fromEntityId,
    env,
  );
  if (!valid) {
    throw new Error(`${context}:DISPUTE_SEAL_HANKO_INVALID`);
  }

  return {
    hanko: input.newDisputeHanko,
    nonce: input.disputeProofNonce,
    hash: expectedHash,
    proofBodyHash: input.newDisputeProofBodyHash,
  };
}

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

type AccountInputHeightNormalization =
  | { normalizedInputHeight: number | undefined; error?: undefined }
  | { normalizedInputHeight?: undefined; error: string };

function normalizeAccountInputHeight(input: AccountInput): AccountInputHeightNormalization {
  const normalizedInputHeight =
    input.height === undefined || input.height === null ? undefined : Number(input.height as number | string);
  if (normalizedInputHeight !== undefined && !Number.isFinite(normalizedInputHeight)) {
    return { error: `Invalid account input height: ${String(input.height)}` };
  }
  return { normalizedInputHeight };
}

function getDisputeHankoShapeError(input: AccountInput): string | undefined {
  if (input.newDisputeHanko === undefined || input.newDisputeHanko === null) return undefined;
  if (typeof input.newDisputeHanko !== 'string') return 'Invalid dispute hanko type';
  const hankoHex = input.newDisputeHanko.toLowerCase();
  const normalized = hankoHex.startsWith('0x') ? hankoHex.slice(2) : hankoHex;
  if (normalized.length === 0) return 'Invalid dispute hanko (empty)';
  if (normalized.length % 2 !== 0) return 'Invalid dispute hanko (odd length)';
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
  const currentHeight = Number(accountMachine.currentHeight ?? 0);
  const pendingHeight = Number(accountMachine.pendingFrame?.height ?? 0);
  const inputHeight =
    input.height === undefined || input.height === null
      ? 0
      : Number(input.height);
  const newFrameHeight =
    input.newAccountFrame === undefined || input.newAccountFrame === null
      ? undefined
      : Number(input.newAccountFrame.height);
  const ackIsStale =
    Boolean(input.prevHanko) &&
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
  env: Env,
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
      response: {
        kind: 'ack',
        fromEntityId: accountMachine.proofHeader.fromEntity,
        toEntityId: input.fromEntityId,
        height: cachedAck.height,
        prevHanko: cachedAck.prevHanko,
      },
      events,
    };
  }

  const ackEntityId = accountMachine.proofHeader.fromEntity;
  const ackReplica = getReplicaByEntityId(env, ackEntityId);
  const ackSignerId = ackReplica?.state.config.validators[0];
  if (!ackSignerId) {
    return {
      success: false,
      error: `Cannot rebuild duplicate ACK signer for ${ackEntityId.slice(-4)}`,
      events,
    };
  }
  const [rebuiltHanko] = await signEntityHashes(env, ackEntityId, ackSignerId, [
    receivedFrame.stateHash,
  ]);
  if (!rebuiltHanko) {
    return { success: false, error: 'Failed to rebuild duplicate ACK hanko', events };
  }
  accountMachine.lastOutboundFrameAck = {
    height: receivedHeight,
    counterpartyEntityId: input.fromEntityId,
    prevHanko: rebuiltHanko,
  };
  events.push(
    `↩️ Rebuilt ACK for duplicate committed frame ${String(receivedHeight)}`,
  );
  return {
    success: true,
    response: {
      kind: 'ack',
      fromEntityId: accountMachine.proofHeader.fromEntity,
      toEntityId: input.fromEntityId,
      height: receivedHeight,
      prevHanko: rebuiltHanko,
    },
    events,
  };
}

async function handleReplayOrObsoleteAccountInput(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  replay: AccountInputReplayClassification,
  events: string[],
): Promise<HandleAccountInputResult | undefined> {
  if (input.newAccountFrame !== undefined && input.newAccountFrame !== null) {
    // Network delivery is at-least-once. If the peer retries an already
    // committed frame because our ACK was lost, re-ACK before the generic stale
    // guards. The safety gate is exact: same height and same committed stateHash.
    const duplicateAck = await buildDuplicateCommittedFrameAck(
      env,
      accountMachine,
      input,
      events,
      replay.currentHeight,
      input.newAccountFrame,
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
  if (!input.prevHanko && replay.frameIsStale) {
    accountLog.debug('input.stale_frame_ignored', {
      currentHeight: replay.currentHeight,
      inputHeight: replay.inputHeight,
      newFrameHeight: replay.newFrameHeight ?? null,
      from: shortId(input.fromEntityId),
    });
    return { success: true, events };
  }
  if (
    input.prevHanko &&
    !input.newAccountFrame &&
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

async function handlePendingFrameAck(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  ackHeight: number | undefined,
  validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }>,
): Promise<PendingFrameAckResult> {
  if (!(accountMachine.pendingFrame && ackHeight === accountMachine.pendingFrame.height && input.prevHanko)) {
    return { kind: 'not_applicable' };
  }
  if (HEAVY_LOGS) console.log(`✅ ACK-DEBUG: fromEntity=${input.fromEntityId.slice(-4)}, toEntity=${input.toEntityId.slice(-4)}`);

  const frameHash = accountMachine.pendingFrame.stateHash;

  // HANKO ACK VERIFICATION: Verify hanko instead of single signature
  const ackHanko = input.prevHanko;
  if (!ackHanko) {
    return { kind: 'return', result: { success: false, error: 'Missing ACK hanko', events } };
  }

  const expectedAckEntity = accountMachine.proofHeader.toEntity;
  accountLog.debug('hanko.ack.verify', { height: ackHeight, frame: shortHash(frameHash) });
  const verifyResult = await verifyHankoForHash(ackHanko, frameHash, expectedAckEntity, env);
  const valid = verifyResult.valid;
  const recoveredEntityId = verifyResult.entityId;
  if (!valid) {
    return { kind: 'return', result: { success: false, error: 'Invalid ACK hanko signature', events } };
  }

  if (!recoveredEntityId || recoveredEntityId.toLowerCase() !== expectedAckEntity.toLowerCase()) {
    return {
      kind: 'return',
      result: {
        success: false,
        error: `ACK hanko entityId mismatch: got ${recoveredEntityId?.slice(-4)}, expected ${expectedAckEntity.slice(-4)}`,
        events,
      },
    };
  }
  accountLog.debug('hanko.ack.verified', { from: shortId(recoveredEntityId ?? expectedAckEntity), height: ackHeight });

  const tokenIds = deriveAccountFrameTokenIds(accountMachine.pendingFrame);
  const txTypes = accountMachine.pendingFrame.accountTxs.map(tx => tx.type);
  accountLog.debug('frame.commit', {
    height: accountMachine.pendingFrame.height,
    txs: txTypes,
    tokens: tokenIds,
    state: shortHash(frameHash),
  });
  if (shouldLogFullPayloads()) {
    accountLog.trace('frame.commit.payload', {
      txs: accountMachine.pendingFrame.accountTxs,
      offdeltas: deriveAccountFrameOffdeltas(accountMachine.pendingFrame).map(d => d.toString()),
    });
  }

  // PROPOSER COMMIT: Re-execute txs on REAL state (Channel.ts pattern)
  // This eliminates fragile manual field copying
  const { counterparty: cpForLog } = getAccountPerspective(accountMachine, accountMachine.proofHeader.fromEntity);
  accountLog.debug('frame.reexecute', {
    height: accountMachine.pendingFrame.height,
    counterparty: shortId(cpForLog),
    txs: accountMachine.pendingFrame.accountTxs.length,
  });

  // Re-execute all frame txs on REAL accountMachine (deterministic)
  // CRITICAL: Use frame.timestamp for determinism (HTLC validation must use agreed consensus time)
  const pendingJHeight = accountMachine.pendingFrame.jHeight ?? accountMachine.lastFinalizedJHeight ?? 0;
  for (const tx of accountMachine.pendingFrame.accountTxs) {
    const beforeSettlement = captureSettlementVector(accountMachine);
    const commitResult = await applyAccountTx(
      accountMachine,
      tx,
      accountMachine.pendingFrame.byLeft!,
      accountMachine.pendingFrame.timestamp,
      pendingJHeight,
      false,
      env,
    );
    if (!commitResult.success) {
      console.error(`❌ PROPOSER-COMMIT FAILED for tx type=${tx.type}: ${commitResult.error}`);
      throw new Error(
        `Frame ${accountMachine.pendingFrame.height} commit failed: ${tx.type} - ${commitResult.error}`,
      );
    }
    assertNoUnilateralSettlementMutation(accountMachine, beforeSettlement, tx, 'proposer/commit');
    if (commitResult.timedOutHashlock) {
      timedOutHashlocks.push(commitResult.timedOutHashlock);
    }
  }

  accountLog.debug('frame.commit.complete', {
    side: 'proposer',
    counterparty: shortId(cpForLog),
    height: accountMachine.pendingFrame.height,
    tokens: accountMachine.deltas.size,
  });
  if (shouldLogFullPayloads()) {
    accountLog.trace('frame.commit.deltas', {
      side: 'proposer',
      counterparty: shortId(cpForLog),
      deltas: summarizeDeltasForLog(accountMachine.deltas),
    });
  }

  // Clean up clone (no longer needed with re-execution)
  delete accountMachine.clonedForValidation;

  // CRITICAL: Deep-copy entire pendingFrame to prevent mutation issues
  accountMachine.currentFrame = structuredClone(accountMachine.pendingFrame);
  accountMachine.currentHeight = accountMachine.pendingFrame.height;
  if (input.newDisputeHanko) {
    storeCounterpartyDisputeSeal(accountMachine, validatedCounterpartyDisputeSeal);
    accountLog.debug('hanko.dispute_ack_stored', {
      nonce: input.disputeProofNonce,
      from: shortId(input.fromEntityId),
    });
  }

  const committedFrame = cloneAccountFrame(accountMachine.pendingFrame);
  committedFrames.push({ frame: committedFrame, committedViaNewFrame: false });
  recordAccountFrameHistory(env, {
    entityId: accountMachine.proofHeader.fromEntity,
    counterpartyId: input.fromEntityId,
    accountHeight: committedFrame.height,
    source: 'ackCommit',
    frame: committedFrame,
  });
  // Past bilateral frames are not future-consensus state. Keep only a
  // non-enumerable UI/debug view; durable history lives in the frame DB.
  appendAccountFrameHistoryView(accountMachine, committedFrame);
  accountLog.debug('frame.indexed', { source: 'ackCommit', height: accountMachine.pendingFrame.height });

  // Clear pending state
  const committedHeight = accountMachine.pendingFrame.height;
  delete accountMachine.pendingFrame;
  delete accountMachine.pendingAccountInput;
  delete accountMachine.clonedForValidation;
  if (
    accountMachine.lastOutboundFrameAck &&
    Number(accountMachine.lastOutboundFrameAck.height) < Number(committedHeight)
  ) {
    delete accountMachine.lastOutboundFrameAck;
  }
  markStorageAccountDirty(env, accountMachine.proofHeader.fromEntity, input.fromEntityId);
  accountMachine.rollbackCount = Math.max(0, accountMachine.rollbackCount - 1); // Successful confirmation reduces rollback
  if (accountMachine.rollbackCount === 0) {
    delete accountMachine.lastRollbackFrameHash; // Reset deduplication on full resolution
  }

  events.push(`✅ Frame ${ackHeight} confirmed and committed`);

  // Run auto-rebalance only after pending frame is cleared.
  // Otherwise checkAutoRebalance self-skips with "pendingFrame exists".
  const ackAutoRebalanceTxs = await runPostFrameAutoRebalanceCheck(
    env,
    accountMachine,
    accountMachine.proofHeader.fromEntity,
    input.fromEntityId,
    committedHeight,
  );
  if (ackAutoRebalanceTxs.length > 0) {
    for (const tx of ackAutoRebalanceTxs) {
      accountMachine.mempool.push(tx);
    }
    events.push(`🔄 Auto-rebalance queued ${ackAutoRebalanceTxs.length} tx(s) after ACK commit`);
  }
  kickHubRebalanceAfterFrameFinalize(env, accountMachine.proofHeader.fromEntity);

  // CRITICAL FIX: Chained Proposal - if mempool has items (e.g. j_event_claim), propose immediately
  if (!input.newAccountFrame) {
    if (accountMachine.mempool.length > 0) {
      const proposeResult = await proposeAccountFrame(env, accountMachine);
      if (proposeResult.success && proposeResult.accountInput) {
        return {
          kind: 'return',
          result: {
            success: true,
            response: proposeResult.accountInput,
            events: [...events, ...proposeResult.events],
            timedOutHashlocks,
            ...(committedFrames.length > 0 && { committedFrames }),
            ...(proposeResult.revealedSecrets && { revealedSecrets: proposeResult.revealedSecrets }),
            ...(proposeResult.swapOffersCreated && { swapOffersCreated: proposeResult.swapOffersCreated }),
            ...(proposeResult.swapCancelRequests && { swapCancelRequests: proposeResult.swapCancelRequests }),
            ...(proposeResult.swapOffersCancelled && { swapOffersCancelled: proposeResult.swapOffersCancelled }),
            ...(proposeResult.hashesToSign &&
              proposeResult.hashesToSign.length > 0 && { hashesToSign: proposeResult.hashesToSign }),
          },
        };
      }
    }
    if (HEAVY_LOGS) console.log(`🔍 RETURN-ACK-ONLY: frame ${ackHeight} ACKed, no new frame bundled`);
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
  }
  | { kind: 'return'; result: HandleAccountInputResult };

type IncomingFrameValidation = {
  clonedMachine: AccountMachine;
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
  const pendingHeight = Number(accountMachine.pendingFrame?.height ?? 0);
  const bundledNewFrameHeight =
    input.newAccountFrame === undefined || input.newAccountFrame === null
      ? undefined
      : Number(input.newAccountFrame.height);
  const ackTargetsPendingFrame =
    Boolean(input.prevHanko) &&
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
  const pendingFrameHeight = Number(accountMachine.pendingFrame?.height ?? 0);
  return (
    Boolean(input.prevHanko) &&
    Boolean(input.newAccountFrame) &&
    pendingFrameHeight > 0 &&
    Number(input.newAccountFrame?.height ?? 0) === pendingFrameHeight &&
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
  if (!input.prevHanko || ackProcessed) return undefined;
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
        `newFrame=${String(input.newAccountFrame?.height ?? 'none')}`,
      events,
    };
  }

  if (input.newAccountFrame) return undefined;
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

function handleSameHeightIncomingFrame(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  events: string[],
  committedFrames: AccountCommittedFrame[],
): HandleAccountInputResult | undefined {
  if (!(accountMachine.pendingFrame && receivedFrame.height === accountMachine.pendingFrame.height)) {
    return undefined;
  }

  // Simultaneous proposal tiebreaker: left keeps its pending frame, right rolls back.
  const isLeftEntity = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
  if (HEAVY_LOGS) {
    console.log(
      `🔍 TIEBREAKER: fromEntity=${accountMachine.proofHeader.fromEntity.slice(-4)}, toEntity=${accountMachine.proofHeader.toEntity.slice(-4)}, isLeft=${isLeftEntity}`,
    );
  }

  if (isLeftEntity) {
    events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${receivedFrame.height} (waiting for their ACK)`);
    if (accountMachine.mempool.length > 0) {
      events.push(`⚠️ LEFT has ${accountMachine.mempool.length} pending txs while waiting for RIGHT's ACK`);
    }
    return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
  }

  const receivedHash = receivedFrame.stateHash;
  if (accountMachine.lastRollbackFrameHash === receivedHash) {
    accountLog.debug('rollback.duplicate', { frame: shortHash(receivedHash) });
    return undefined;
  }

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
  delete accountMachine.clonedForValidation;
  markStorageAccountDirty(env, accountMachine.proofHeader.fromEntity, input.fromEntityId);
  accountMachine.rollbackCount = Math.max(1, accountMachine.rollbackCount + 1);
  accountMachine.lastRollbackFrameHash = receivedHash; // Track this rollback
  if (accountMachine.rollbackCount > 1) {
    console.warn(
      `⚠️ ROLLBACK-RETRY: repeated RIGHT rollback count=${accountMachine.rollbackCount} (continuing deterministically)`,
    );
  }

  events.push(`📥 Accepted LEFT's frame ${receivedFrame.height} (we are RIGHT, deterministic tiebreaker)`);
  return undefined;
}

async function verifyIncomingFrameHanko(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  events: string[],
): Promise<HandleAccountInputResult | undefined> {
  const hankoToVerify = input.newHanko;
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
  );

  if (!valid || !recoveredEntityId) {
    return { success: false, error: `Invalid hanko signature from ${input.fromEntityId.slice(-4)}`, events };
  }

  accountLog.debug('hanko.frame.verified', { height: receivedFrame.height, from: shortId(recoveredEntityId) });
  accountMachine.counterpartyFrameHanko = hankoToVerify;
  return undefined;
}

async function preflightIncomingAccountFrame(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  normalizedInputHeight: number | undefined,
  replayCurrentHeight: number,
  events: string[],
  committedFrames: AccountCommittedFrame[],
): Promise<IncomingFramePreflightResult> {
  const receivedFrame = input.newAccountFrame;
  if (!receivedFrame) {
    throw new Error('preflightIncomingAccountFrame called without newAccountFrame');
  }

  if (Number(receivedFrame.height) <= Number(accountMachine.currentHeight ?? 0)) {
    const duplicateAck = await buildDuplicateCommittedFrameAck(
      env,
      accountMachine,
      input,
      events,
      replayCurrentHeight,
      receivedFrame,
    );
    if (duplicateAck) return { kind: 'return', result: duplicateAck };
    events.push(
      `ℹ️ Ignored stale frame ${String(receivedFrame.height)} (current=${String(accountMachine.currentHeight ?? 0)})`,
    );
    return { kind: 'return', result: { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) } };
  }

  const expectedFrameByLeft = isLeft(input.fromEntityId, input.toEntityId);
  if (receivedFrame.byLeft !== expectedFrameByLeft) {
    return {
      kind: 'return',
      result: {
        success: false,
        error:
          `Frame proposer side mismatch: expected byLeft=${String(expectedFrameByLeft)} ` +
          `for proposer ${input.fromEntityId.slice(-4)}, got ${String(receivedFrame.byLeft)}`,
        events,
      },
    };
  }

  const previousTimestamp = accountMachine.currentFrame?.timestamp;
  const frameValidationError = getAccountFrameValidationError(receivedFrame, env.timestamp, previousTimestamp);
  if (frameValidationError) {
    return { kind: 'return', result: { success: false, error: `Invalid frame structure: ${frameValidationError}`, events } };
  }

  const expectedPrevFrameHash =
    accountMachine.currentHeight === 0 ? 'genesis' : accountMachine.currentFrame.stateHash || '';

  if (receivedFrame.prevFrameHash !== expectedPrevFrameHash) {
    const mismatchDebug = {
      inputFromEntityId: input.fromEntityId,
      inputToEntityId: input.toEntityId,
      inputHeight: normalizedInputHeight ?? null,
      receivedHeight: Number(receivedFrame.height ?? 0),
      receivedStateHash: receivedFrame.stateHash ?? null,
      receivedPrevFrameHash: receivedFrame.prevFrameHash ?? null,
      receivedTxTypes: receivedFrame.accountTxs.map((tx) => tx.type),
      expectedPrevFrameHash,
      account: describeAccountState(accountMachine),
    };
    console.warn(`⚠️ FRAME-CHAIN: prevHash mismatch at height ${accountMachine.currentHeight}`);
    console.warn(`[A-MACHINE][FRAME-CHAIN-MISMATCH] ${safeStringify(mismatchDebug)}`);
    return {
      kind: 'return',
      result: {
        success: false,
        error:
          `Frame chain broken: prevFrameHash mismatch ` +
          `(expected ${expectedPrevFrameHash.slice(0, 16)}..., got ${String(receivedFrame.prevFrameHash).slice(0, 16)}..., ` +
          `current=${accountMachine.currentHeight}, pending=${Number(accountMachine.pendingFrame?.height ?? 0)})`,
        events,
      },
    };
  }

  const sameHeightResult = handleSameHeightIncomingFrame(
    env,
    accountMachine,
    input,
    receivedFrame,
    events,
    committedFrames,
  );
  if (sameHeightResult) {
    return { kind: 'return', result: sameHeightResult };
  }

  // NOTE: rollbackCount decrement happens in ACK block when pendingFrame confirmed.
  if (HEAVY_LOGS) {
    console.log(
      `🔍 SEQUENCE-CHECK: receivedFrame.height=${receivedFrame.height}, currentHeight=${accountMachine.currentHeight}, expected=${accountMachine.currentHeight + 1}`,
    );
  }
  if (receivedFrame.height !== accountMachine.currentHeight + 1) {
    console.log(
      `❌ Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`,
    );
    return {
      kind: 'return',
      result: {
        success: false,
        error: `Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`,
        events,
      },
    };
  }

  const hankoError = await verifyIncomingFrameHanko(env, accountMachine, input, receivedFrame, events);
  if (hankoError) {
    return { kind: 'return', result: hankoError };
  }

  const ourEntityId = accountMachine.proofHeader.fromEntity;
  const currentJHeight = accountMachine.lastFinalizedJHeight ?? 0;
  const frameJHeight = receivedFrame.jHeight ?? currentJHeight;

  return { kind: 'continue', receivedFrame, ourEntityId, frameJHeight };
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
      if (HEAVY_LOGS) console.log(`⏭️  RECEIVER: Skipping unused token ${tokenId} from validation`);
      continue;
    }

    tokenIds.push(tokenId);
    deltas.push({ ...delta });
  }

  if (HEAVY_LOGS) {
    console.log(`🔍 RECEIVER: Computed ${tokenIds.length} tokens after filtering: [${tokenIds.join(', ')}]`);
  }
  return { tokenIds, deltas };
}

function verifyReceiverStateMatchesFrame(
  receivedFrame: AccountFrame,
  ourFinalTokenIds: number[],
  ourFinalDeltas: Delta[],
  events: string[],
): HandleAccountInputResult | undefined {
  const ourOffdeltas = deriveAccountFrameOffdeltas(ourFinalDeltas);
  const theirOffdeltas = deriveAccountFrameOffdeltas(receivedFrame);

  const ourComputedState = Buffer.from(ourOffdeltas.map(d => d.toString()).join(',')).toString('hex');
  const theirClaimedState = Buffer.from(theirOffdeltas.map(d => d.toString()).join(',')).toString('hex');

  accountLog.debug('frame.state_verify', {
    height: receivedFrame.height,
    ourTokens: ourFinalTokenIds.length,
    theirTokens: deriveAccountFrameTokenIds(receivedFrame).length,
    our: shortHash(ourComputedState),
    their: shortHash(theirClaimedState),
  });
  if (shouldLogFullPayloads()) {
    accountLog.trace('frame.state_verify_payload', {
      height: receivedFrame.height,
      ourTokenIds: ourFinalTokenIds,
      ourOffdeltas: ourOffdeltas.map(d => d.toString()),
      theirTokenIds: deriveAccountFrameTokenIds(receivedFrame),
      theirOffdeltas: theirOffdeltas.map(d => d.toString()),
    });
  }

  if (ourComputedState !== theirClaimedState) {
    console.warn(
      `⚠️ CONSENSUS: Frame ${receivedFrame.height} - state mismatch (our: ${ourComputedState.slice(0, 16)}... vs their: ${theirClaimedState.slice(0, 16)}...)`,
    );
    return { success: false, error: `Bilateral consensus failure - states don't match`, events };
  }
  return undefined;
}

function verifyReceiverBilateralDeltas(
  receivedFrame: AccountFrame,
  ourFinalDeltas: Delta[],
  events: string[],
): HandleAccountInputResult | undefined {
  const theirDeltas = receivedFrame.deltas;
  if (ourFinalDeltas.length !== theirDeltas.length) {
    console.warn(
      `⚠️ SECURITY: delta count mismatch (our: ${ourFinalDeltas.length}, their: ${theirDeltas.length})`,
    );
    return { success: false, error: `Bilateral state injection detected - delta count mismatch`, events };
  }

  for (let i = 0; i < ourFinalDeltas.length; i++) {
    const ours = ourFinalDeltas[i]!;
    const theirs = theirDeltas[i]!;
    const bilateralMismatch =
      ours.offdelta !== theirs.offdelta ||
      ours.leftCreditLimit !== theirs.leftCreditLimit ||
      ours.rightCreditLimit !== theirs.rightCreditLimit ||
      ours.leftAllowance !== theirs.leftAllowance ||
      ours.rightAllowance !== theirs.rightAllowance ||
      (ours.leftHold ?? 0n) !== (theirs.leftHold ?? 0n) ||
      (ours.rightHold ?? 0n) !== (theirs.rightHold ?? 0n);

    if (bilateralMismatch) {
      console.warn(`⚠️ SECURITY: Bilateral field mismatch at token ${ours.tokenId}:`);
      console.warn(`   offdelta: our=${ours.offdelta}, their=${theirs.offdelta}`);
      console.warn(`   leftCreditLimit: our=${ours.leftCreditLimit}, their=${theirs.leftCreditLimit}`);
      console.warn(`   rightCreditLimit: our=${ours.rightCreditLimit}, their=${theirs.rightCreditLimit}`);
      console.warn(`   leftHold: our=${ours.leftHold ?? 0n}, their=${theirs.leftHold ?? 0n}`);
      console.warn(`   rightHold: our=${ours.rightHold ?? 0n}, their=${theirs.rightHold ?? 0n}`);
      return { success: false, error: `Bilateral state injection detected - credit/allowance mismatch`, events };
    }
  }
  return undefined;
}

async function verifySenderFrameHash(
  receivedFrame: AccountFrame,
  events: string[],
): Promise<HandleAccountInputResult | undefined> {
  if (HEAVY_LOGS) console.log(`🔍 ABOUT-TO-VERIFY-HASH: Computing frame hash...`);
  if (HEAVY_LOGS) console.log(`🔍 COMPUTING-HASH: Creating hash for frame ${receivedFrame.height}...`);
  const senderHashFrame: AccountFrame = {
    height: receivedFrame.height,
    timestamp: receivedFrame.timestamp,
    jHeight: receivedFrame.jHeight,
    accountTxs: receivedFrame.accountTxs,
    prevFrameHash: receivedFrame.prevFrameHash,
    deltas: receivedFrame.deltas,
    stateHash: '', // Computed by createFrameHash
    ...(receivedFrame.byLeft === undefined ? {} : { byLeft: receivedFrame.byLeft }),
  };
  const recomputedSenderHash = await createFrameHash(senderHashFrame);

  if (recomputedSenderHash !== receivedFrame.stateHash) {
    console.warn(`⚠️ SECURITY: Frame hash mismatch after validation`);
    console.warn(`   Recomputed: ${recomputedSenderHash.slice(0, 16)}...`);
    console.warn(`   Claimed:    ${receivedFrame.stateHash.slice(0, 16)}...`);
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
): Promise<IncomingFrameValidationResult> {
  const clonedMachine = cloneAccountMachine(accountMachine);
  const processEvents: string[] = [];
  const revealedSecrets: AccountRevealedSecret[] = [];
  const swapOffersCreated: AccountSwapOfferCreated[] = [];
  const swapCancelRequests: AccountSwapCancelRequest[] = [];
  const swapOffersCancelled: AccountSwapCancelRequest[] = [];

  accountLog.debug('frame.receiver_validate', {
    height: receivedFrame.height,
    txs: receivedFrame.accountTxs.map(tx => tx.type),
  });
  if (shouldLogFullPayloads()) {
    accountLog.trace('frame.receiver_initial_deltas', {
      height: receivedFrame.height,
      deltas: summarizeDeltasForLog(clonedMachine.deltas),
    });
  }

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
    );
    if (!result.success) {
      return { kind: 'return', result: { success: false, error: `Frame application failed: ${result.error}`, events } };
    }
    assertNoUnilateralSettlementMutation(clonedMachine, beforeSettlement, accountTx, 'receiver/validate');
    processEvents.push(...result.events);

    if (HEAVY_LOGS) console.log(`🔍 TX-PROCESSED: ${accountTx.type}, success=${result.success}`);
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

  const { tokenIds: ourFinalTokenIds, deltas: ourFinalDeltas } = collectReceiverValidationDeltas(clonedMachine);
  const stateMismatch = verifyReceiverStateMatchesFrame(receivedFrame, ourFinalTokenIds, ourFinalDeltas, events);
  if (stateMismatch) return { kind: 'return', result: stateMismatch };

  const bilateralMismatch = verifyReceiverBilateralDeltas(receivedFrame, ourFinalDeltas, events);
  if (bilateralMismatch) return { kind: 'return', result: bilateralMismatch };

  const frameHashMismatch = await verifySenderFrameHash(receivedFrame, events);
  if (frameHashMismatch) return { kind: 'return', result: frameHashMismatch };

  accountLog.debug('frame.accept', {
    height: receivedFrame.height,
    from: shortId(input.fromEntityId),
    txs: receivedFrame.accountTxs.map(tx => tx.type),
  });

  return {
    kind: 'continue',
    validation: {
      clonedMachine,
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
  ackProcessed: boolean,
  events: string[],
  committedFrames: AccountCommittedFrame[],
): Promise<void> {
  const { counterparty: cpForCommitLog } = getAccountPerspective(accountMachine, ourEntityId);
  if (HEAVY_LOGS) {
    console.log(
      `🔍 RECEIVER-COMMIT: Re-executing ${receivedFrame.accountTxs.length} txs for ${cpForCommitLog.slice(-4)}`,
    );
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
    );

    if (!commitResult.success) {
      console.error(`❌ RECEIVER-COMMIT FAILED for tx type=${tx.type}: ${commitResult.error}`);
      throw new Error(`Frame ${receivedFrame.height} commit failed: ${tx.type} - ${commitResult.error}`);
    }
    assertNoUnilateralSettlementMutation(accountMachine, beforeSettlement, tx, 'receiver/commit');
  }

  accountLog.debug('frame.commit.complete', {
    side: 'receiver',
    counterparty: shortId(cpForCommitLog),
    height: receivedFrame.height,
    tokens: accountMachine.deltas.size,
  });
  if (shouldLogFullPayloads()) {
    accountLog.trace('frame.commit.deltas', {
      side: 'receiver',
      counterparty: shortId(cpForCommitLog),
      deltas: summarizeDeltasForLog(accountMachine.deltas),
    });
  }

  if (validation.clonedMachine.pendingForward) {
    accountMachine.pendingForward = validation.clonedMachine.pendingForward;
    accountLog.debug('pending_forward.copied', {
      route: validation.clonedMachine.pendingForward.route.map(r => shortId(r)),
    });
  }

  accountMachine.currentFrame = structuredClone(receivedFrame);
  accountMachine.currentHeight = receivedFrame.height;
  if (input.newDisputeHanko && !ackProcessed) {
    storeCounterpartyDisputeSeal(accountMachine, validatedCounterpartyDisputeSeal);
    accountLog.debug('hanko.dispute_frame_stored', { height: receivedFrame.height, from: shortId(input.fromEntityId) });
  }

  const committedFrame = cloneAccountFrame(receivedFrame);
  committedFrames.push({ frame: committedFrame, committedViaNewFrame: true });
  recordAccountFrameHistory(env, {
    entityId: accountMachine.proofHeader.fromEntity,
    counterpartyId: input.fromEntityId,
    accountHeight: committedFrame.height,
    source: 'peerCommit',
    frame: committedFrame,
  });
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
  );
  if (postCommitAutoRebalanceTxs.length > 0) {
    for (const tx of postCommitAutoRebalanceTxs) {
      accountMachine.mempool.push(tx);
    }
    events.push(`🔄 Auto-rebalance queued ${postCommitAutoRebalanceTxs.length} tx(s) after frame commit`);
  }
  kickHubRebalanceAfterFrameFinalize(env, ourEntityId);
}

function mergeBatchedProposalIntoAck(
  response: AccountInput,
  proposeResult: ProposeAccountFrameResult,
  events: string[],
): void {
  response.kind = 'frame_ack';
  if (proposeResult.accountInput?.newAccountFrame) {
    response.newAccountFrame = proposeResult.accountInput.newAccountFrame;
  }
  if (proposeResult.accountInput?.newHanko) {
    response.newHanko = proposeResult.accountInput.newHanko;
  }
  if (proposeResult.accountInput?.newDisputeHanko) {
    response.newDisputeHanko = proposeResult.accountInput.newDisputeHanko;
  } else {
    delete response.newDisputeHanko;
  }
  if (proposeResult.accountInput?.newDisputeHash) {
    response.newDisputeHash = proposeResult.accountInput.newDisputeHash;
  } else {
    delete response.newDisputeHash;
  }
  if (proposeResult.accountInput?.newDisputeProofBodyHash) {
    response.newDisputeProofBodyHash = proposeResult.accountInput.newDisputeProofBodyHash;
  } else {
    delete response.newDisputeProofBodyHash;
  }
  if (proposeResult.accountInput?.disputeProofNonce !== undefined) {
    response.disputeProofNonce = proposeResult.accountInput.disputeProofNonce;
  } else {
    delete response.disputeProofNonce;
  }

  const newFrameId = proposeResult.accountInput?.newAccountFrame?.height || 0;
  events.push(`📤 Batched ACK + frame ${newFrameId}`);
}

type IncomingFrameAckMaterial = {
  response: AccountInput;
  outboundAck: {
    height: number;
    counterpartyEntityId: string;
    prevHanko: string;
  };
  ackDisputeHash: string;
  ackDisputeHanko: string | undefined;
  ackProofBodyHash: string;
  ackSignedNonce: number;
};

type IncomingFrameAckMaterialResult =
  | { kind: 'continue'; material: IncomingFrameAckMaterial }
  | { kind: 'return'; result: HandleAccountInputResult };

async function buildIncomingFrameAckMaterial(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  receivedFrame: AccountFrame,
  events: string[],
): Promise<IncomingFrameAckMaterialResult> {
  const ackEntityId = accountMachine.proofHeader.fromEntity;
  const ackReplica = getReplicaByEntityId(env, ackEntityId);
  const ackSignerId = ackReplica?.state.config.validators[0];
  if (!ackSignerId) {
    return { kind: 'return', result: { success: false, error: `Cannot find signerId for ACK from ${ackEntityId.slice(-4)}`, events } };
  }

  accountLog.debug('hanko.ack.sign', { entity: shortId(ackEntityId), signer: shortId(ackSignerId), height: receivedFrame.height });

  const ackDepositoryAddress = getAccountDepositoryAddress(env, accountMachine);
  if (!isAddress20(ackDepositoryAddress)) {
    return { kind: 'return', result: { success: false, error: 'ACK_DISPUTE_PROOF_BUILD_FAILED: MISSING_DEPOSITORY_ADDRESS', events } };
  }
  const ackProofResult = buildAccountProofBody(accountMachine);
  const ackDisputeHash = createDisputeProofHashWithNonce(
    accountMachine,
    ackProofResult.proofBodyHash,
    ackDepositoryAddress,
    accountMachine.proofHeader.nonce,
  );
  const [confirmationHanko, ackDisputeHanko] = await signEntityHashes(env, ackEntityId, ackSignerId, [
    receivedFrame.stateHash,
    ackDisputeHash,
  ]);
  if (!confirmationHanko) {
    return { kind: 'return', result: { success: false, error: 'Failed to build ACK hanko', events } };
  }

  const ackSignedNonce = accountMachine.proofHeader.nonce;
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
      { appliedAccountTxs: receivedFrame.accountTxs, appliedFrameHeight: receivedFrame.height },
    ),
  );

  return {
    kind: 'continue',
    material: {
      response: {
        kind: 'ack',
        fromEntityId: accountMachine.proofHeader.fromEntity,
        toEntityId: input.fromEntityId,
        watchSeed: accountMachine.watchSeed,
        height: receivedFrame.height,
        prevHanko: confirmationHanko,
        ...(ackDisputeHanko && { newDisputeHanko: ackDisputeHanko }),
        newDisputeHash: ackDisputeHash,
        newDisputeProofBodyHash: ackProofResult.proofBodyHash,
        disputeProofNonce: ackSignedNonce,
      } as AccountInput,
      outboundAck: {
        height: receivedFrame.height,
        counterpartyEntityId: input.fromEntityId,
        prevHanko: confirmationHanko,
      },
      ackDisputeHash,
      ackDisputeHanko,
      ackProofBodyHash: ackProofResult.proofBodyHash,
      ackSignedNonce,
    },
  };
}

async function maybeBatchAckWithNewFrame(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
  response: AccountInput,
  events: string[],
): Promise<{ batchedWithNewFrame: boolean; proposeResult: ProposeAccountFrameResult | undefined }> {
  let batchedWithNewFrame = false;
  let proposeResult: ProposeAccountFrameResult | undefined;

  if (HEAVY_LOGS) {
    console.log(
      `🔍 BATCH-CHECK for account ${input.fromEntityId.slice(-4)}: mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.pendingFrame}, mempoolTxs=[${accountMachine.mempool.map(tx => tx.type).join(',')}]`,
    );
  }
  if (accountMachine.mempool.length > 0 && !accountMachine.pendingFrame) {
    proposeResult = await proposeAccountFrame(env, accountMachine, true);

    if (proposeResult.success && proposeResult.accountInput) {
      batchedWithNewFrame = true;
      mergeBatchedProposalIntoAck(response, proposeResult, events);
    }
  }

  return { batchedWithNewFrame, proposeResult };
}

function storeAckResponseState(
  accountMachine: AccountMachine,
  material: IncomingFrameAckMaterial,
  batchedWithNewFrame: boolean,
): void {
  if (!batchedWithNewFrame) {
    accountMachine.lastOutboundFrameAck = material.outboundAck;
    if (material.ackDisputeHanko) {
      accountMachine.currentDisputeProofHanko = material.ackDisputeHanko;
      accountMachine.currentDisputeProofNonce = material.ackSignedNonce;
      accountMachine.currentDisputeProofBodyHash = material.ackProofBodyHash;
      accountMachine.currentDisputeHash = material.ackDisputeHash;
    }
    return;
  }
  delete accountMachine.lastOutboundFrameAck;
}

function buildIncomingFrameReturnPayload(
  input: AccountInput,
  receivedFrame: AccountFrame,
  response: AccountInput,
  validation: IncomingFrameValidation,
  proposeResult: ProposeAccountFrameResult | undefined,
  batchedWithNewFrame: boolean,
  ackDisputeHash: string,
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
    ...(!batchedWithNewFrame
      ? [{ hash: ackDisputeHash, type: 'dispute' as const, context: `account:${input.fromEntityId.slice(-8)}:ack-dispute` }]
      : []),
    ...(proposeResult?.hashesToSign || []),
  ];

  if (HEAVY_LOGS) {
    console.log(
      `🔍 RETURN-RESPONSE: h=${response.height} prevHanko=${!!response.prevHanko} newFrame=${!!response.newAccountFrame}`,
    );
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
  const ackMaterial = await buildIncomingFrameAckMaterial(env, accountMachine, input, receivedFrame, events);
  if (ackMaterial.kind === 'return') return ackMaterial.result;
  const { material } = ackMaterial;
  const { batchedWithNewFrame, proposeResult } = await maybeBatchAckWithNewFrame(
    env,
    accountMachine,
    input,
    material.response,
    events,
  );

  storeAckResponseState(accountMachine, material, batchedWithNewFrame);
  ++accountMachine.proofHeader.nonce;
  return buildIncomingFrameReturnPayload(
    input,
    receivedFrame,
    material.response,
    validation,
    proposeResult,
    batchedWithNewFrame,
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
  ackProcessed: boolean,
  events: string[],
  timedOutHashlocks: string[],
  committedFrames: AccountCommittedFrame[],
): Promise<IncomingFrameResult> {
  if (!input.newAccountFrame) {
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
  );
  if (preflight.kind === 'return') return preflight;

  const validationResult = await validateIncomingFrameOnClone(
    env,
    accountMachine,
    input,
    preflight.receivedFrame,
    preflight.frameJHeight,
    events,
    timedOutHashlocks,
  );
  if (validationResult.kind === 'return') return validationResult;

  await commitIncomingFrameOnRealState(
    env,
    accountMachine,
    input,
    preflight.receivedFrame,
    preflight.frameJHeight,
    validationResult.validation,
    preflight.ourEntityId,
    validatedCounterpartyDisputeSeal,
    ackProcessed,
    events,
    committedFrames,
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

/**
 * Handle received AccountInput (bilateral consensus)
 */
export async function applyAccountInput(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
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
  const committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }> = [];

  const events: string[] = [];
  const timedOutHashlocks: string[] = [];
  let ackProcessed = false;
  // Replay protection: frame chain (height + prevFrameHash) checked at :836
  // ACK replay protection: pendingFrame cleared on commit, so replayed ACK fails pendingFrame check

  const disputeHankoShapeError = getDisputeHankoShapeError(input);
  if (disputeHankoShapeError) {
    return { success: false, error: disputeHankoShapeError, events };
  }

  const replay = classifyAccountInputReplay(accountMachine, input);

  const replayGateResult = await handleReplayOrObsoleteAccountInput(
    env,
    accountMachine,
    input,
    replay,
    events,
  );
  if (replayGateResult) return replayGateResult;

  let validatedCounterpartyDisputeSeal: ValidatedCounterpartyDisputeSeal | undefined;
  try {
    validatedCounterpartyDisputeSeal = await validateCounterpartyDisputeSeal(
      env,
      accountMachine,
      input,
      String(input.kind || 'ACCOUNT_INPUT').toUpperCase(),
    );
  } catch (error) {
    return { success: false, error: (error as Error).message, events };
  }

  const { ackHeight } = resolveAccountAckTarget(accountMachine, input, normalizedInputHeight);

  const pendingAckResult = await handlePendingFrameAck(
    env,
    accountMachine,
    input,
    ackHeight,
    validatedCounterpartyDisputeSeal,
    events,
    timedOutHashlocks,
    committedFrames,
  );
  if (pendingAckResult.kind === 'return') return pendingAckResult.result;
  if (pendingAckResult.kind === 'fallthrough') ackProcessed = true;

  // ACK for a pending frame must never be ignored unless this is the valid
  // same-height race case: peer ACKs the last committed frame and proposes the
  // same next height we already have pending. That path is resolved below by
  // the simultaneous-proposal handler.
  const unmatchedPendingAck = handleUnmatchedAck(
    accountMachine,
    input,
    normalizedInputHeight,
    ackProcessed,
    events,
    committedFrames,
    'before_frame',
  );
  if (unmatchedPendingAck) return unmatchedPendingAck;

  const incomingFrameResult = await handleIncomingAccountFrame(
    env,
    accountMachine,
    input,
    normalizedInputHeight,
    replay.currentHeight,
    validatedCounterpartyDisputeSeal,
    ackProcessed,
    events,
    timedOutHashlocks,
    committedFrames,
  );
  if (incomingFrameResult.kind === 'return') return incomingFrameResult.result;

  // ACK inputs must never be silently ignored; this causes replay divergence.
  const unmatchedAck = handleUnmatchedAck(
    accountMachine,
    input,
    normalizedInputHeight,
    ackProcessed,
    events,
    committedFrames,
    'after_frame',
  );
  if (unmatchedAck) return unmatchedAck;

  if (HEAVY_LOGS) console.log(`🔍 RETURN-NO-RESPONSE: No response object`);
  return {
    success: true,
    events,
    swapOffersCreated: [],
    swapCancelRequests: [],
    swapOffersCancelled: [],
    timedOutHashlocks,
    ...(committedFrames.length > 0 && { committedFrames }),
  };
}

// === E-MACHINE INTEGRATION ===

/**
 * Add transaction to account mempool with limits
 */
export function addToAccountMempool(accountMachine: AccountMachine, accountTx: AccountTx): boolean {
  if (accountMachine.mempool.length >= MEMPOOL_LIMIT) {
    accountLog.warn('mempool.full', { mempool: accountMachine.mempool.length, limit: MEMPOOL_LIMIT });
    return false;
  }

  accountMachine.mempool.push(accountTx);
  return true;
}

export function shouldProposeFrame(accountMachine: AccountMachine): boolean {
  const should = accountMachine.mempool.length > 0 && !accountMachine.pendingFrame;
  if (HEAVY_LOGS) {
    console.log(
      `   shouldProposeFrame: mempool=${accountMachine.mempool.length}, pending=${!!accountMachine.pendingFrame}, result=${should}`,
    );
  }
  return should;
}

export function getAccountsToProposeFrames(entityState: EntityState): string[] {
  const accountsToProposeFrames: string[] = [];

  if (!entityState.accounts || !(entityState.accounts instanceof Map)) {
    accountLog.warn('entity.accounts.invalid', { type: typeof entityState.accounts });
    return accountsToProposeFrames;
  }

  for (const [accountKey, accountMachine] of entityState.accounts) {
    if (shouldProposeFrame(accountMachine)) {
      accountsToProposeFrames.push(accountKey);
    }
  }

  return accountsToProposeFrames;
}
