/**
 * Account frame proposal path. This module owns local mempool validation,
 * frame construction, frame hanko signing, and dispute-proof signing.
 */

import type { AccountFrame, AccountInput, AccountMachine, AccountTx, Delta, Env } from '../../types';
import { cloneAccountFrame, cloneAccountMachine, getAccountPerspective, removeCommittedTxsFromMempool } from '../../state-helpers';
import { isLeft } from '../../account-utils';
import { getPerfMs, HEAVY_LOGS } from '../../utils';
import { safeStringify } from '../../serialization-utils';
import { validateAccountFrame as validateAccountFrameStrict } from '../../validation-utils';
import { applyAccountTx } from '../tx/apply';
import { markStorageAccountDirty } from '../../env-events';
import { createStructuredLogger, shortHash, shortId } from '../../logger';
import { createFrameHash, MAX_ACCOUNT_FRAME_TXS, MAX_FRAME_SIZE_BYTES } from './frame';
import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../../proof-builder';
import { signEntityHashes } from '../../hanko/signing';
import {
  assertNoUnilateralSettlementMutation,
  captureSettlementVector,
  getAccountDepositoryAddress,
  getAccountStateDomain,
  isAddress20,
  isEntityId32,
  shouldIncludeToken,
} from './helpers';
import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../../dispute-arguments';
import { MEMPOOL_LIMIT } from './constants';
import type { AccountConsensusHashToSign, AccountSwapOfferCreated, ProposeAccountFrameResult } from './types';
import { getReplicaByEntityId } from '../../entity/replica';
import { computeAccountStateRoot } from '../state-root';

const accountLog = createStructuredLogger('account');
const ACCOUNT_PROPOSAL_PROFILE =
  typeof process !== 'undefined' && process.env?.['XLN_ACCOUNT_PROPOSAL_PROFILE'] === '1';
const ACCOUNT_PROPOSAL_SLOW_MS = Math.max(
  0,
  Number(typeof process !== 'undefined' ? process.env?.['XLN_ACCOUNT_PROPOSAL_SLOW_MS'] || '250' : '250'),
);

const shouldUseOptimisticProposalBatch = (txs: readonly AccountTx[]): boolean =>
  txs.length > 1 &&
  txs.every((tx) =>
    tx.type === 'swap_resolve' ||
    tx.type === 'cross_swap_fill_ack' ||
    tx.type === 'pull_lock' ||
    tx.type === 'swap_offer',
  );

const isCrossJurisdictionPullResolveTx = (
  accountMachine: AccountMachine,
  accountTx: AccountTx,
): accountTx is Extract<AccountTx, { type: 'pull_resolve' }> => {
  if (accountTx.type !== 'pull_resolve') return false;
  const pullId = accountTx.data.pullId;
  if (accountMachine.pulls?.get(pullId)?.crossJurisdiction) return true;
  for (const offer of accountMachine.swapOffers?.values() ?? []) {
    const route = offer.crossJurisdiction;
    if (!route) continue;
    if (route.sourcePull?.pullId === pullId || route.targetPull?.pullId === pullId) return true;
  }
  return false;
};

export async function proposeAccountFrame(
  env: Env,
  accountMachine: AccountMachine,
  entityJHeight?: number, // Optional: J-height from entity state for HTLC consensus
): Promise<ProposeAccountFrameResult> {
  const profileStartMs = getPerfMs();
  // Derive counterparty from canonical left/right
  const myEntityId = accountMachine.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(accountMachine, myEntityId);
  const quiet = env.quietRuntimeLogs === true;
  if (!quiet) {
    accountLog.debug('proposal.start', {
      counterparty: shortId(counterparty),
      mempool: accountMachine.mempool.length,
      pendingFrame: Boolean(accountMachine.pendingFrame),
      height: accountMachine.currentHeight,
    });
  }

  const events: string[] = [];

  if (accountMachine.mempool.length > MEMPOOL_LIMIT) {
    accountLog.warn('proposal.mempool_overflow', { mempool: accountMachine.mempool.length, limit: MEMPOOL_LIMIT });
    return { success: false, error: `Mempool overflow: ${accountMachine.mempool.length} > ${MEMPOOL_LIMIT}`, events };
  }

  if (accountMachine.mempool.length === 0) {
    accountLog.debug('proposal.empty_mempool');
    return { success: false, error: 'No transactions to propose', events };
  }

  if (accountMachine.pendingFrame) {
    if (!quiet) accountLog.debug('proposal.waiting_ack', { pendingHeight: accountMachine.pendingFrame.height });
    return { success: false, error: 'Waiting for ACK on pending frame', events };
  }

  // IMPORTANT: Do NOT gate RIGHT-side j_event_claim proposals on presence of a
  // previously committed LEFT claim.
  //
  // Correct model:
  // 1. Each side may observe the same J-event independently.
  // 2. Each side is allowed to propose its own j_event_claim account frame.
  // 3. Those claims are stored in account state as left/right observations.
  // 4. tryFinalizeAccountJEvents() is the ONLY place that may require 2-of-2
  //    agreement and finalize the unilateral settlement fields.
  //
  // If proposal logic blocks one side until the other side's claim is already
  // committed, bilateral rebalance can deadlock at "Waiting for LEFT claim":
  // the second observation never enters account state, so the 2-of-2 matcher
  // never sees both sides. Same-height races are handled by the normal
  // simultaneous-proposal rollback/tiebreaker path below, not by a special
  // j_event_claim gate here.

  const proposalWindow = accountMachine.mempool.slice(0, MAX_ACCOUNT_FRAME_TXS);
  if (!quiet) {
    accountLog.info('proposal.frame_create', {
      txs: proposalWindow.map(tx => tx.type),
      mempool: accountMachine.mempool.length,
      frameMax: MAX_ACCOUNT_FRAME_TXS,
    });
  }
  if (HEAVY_LOGS) {
    accountLog.debug('proof.header', {
      from: shortId(accountMachine.proofHeader.fromEntity, 8),
      to: shortId(accountMachine.proofHeader.toEntity, 8),
    });
  }

  // Clone account machine for validation
  let clonedMachine = cloneAccountMachine(accountMachine);
  // NOTE: proofHeader.nextProofNonce is NOT set here — it's incremented per-message, not per-frame

  // Deterministic J-height for account frame hashing:
  // Use account-level finalized J-height (consensus state), not live replica tip.
  // Replica tip can drift between runtime sessions and break WAL replay hashes.
  const frameJHeight = entityJHeight ?? accountMachine.lastFinalizedJHeight ?? 0;
  // Every transaction must execute against the exact timestamp committed by
  // the frame. In rapid multi-runtime flows the previous frame can already be
  // at env.timestamp, so monotonicity advances this value by one. Applying a
  // timestamp-bearing tx (for example pull_lock) with env.timestamp first and
  // publishing previous+1 later makes proposer and receiver commit different
  // Account state roots.
  const previousTimestamp = accountMachine.currentFrame?.timestamp ?? 0;
  const frameTimestamp = Math.max(env.timestamp, previousTimestamp + 1);

  const allEvents: string[] = [];
  const revealedSecrets: Array<{ secret: string; hashlock: string }> = [];
  const swapOffersCreated: AccountSwapOfferCreated[] = [];
  const swapCancelRequests: Array<{ offerId: string; accountId: string }> = [];
  const swapOffersCancelled: Array<{ offerId: string; accountId: string }> = [];

  if (HEAVY_LOGS) {
    accountLog.debug('mempool.before_process', {
      proposalWindow: proposalWindow.length,
      mempool: accountMachine.mempool.length,
      txs: proposalWindow.map(tx => tx.type),
    });
  }

  const validTxs: typeof accountMachine.mempool = [];
  const failedHtlcLocks: Array<{ hashlock: string; reason: string }> = [];
  const txsToRemove: typeof accountMachine.mempool = [];
  const proposerByLeft = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  const processOnMachine = async (machine: AccountMachine, accountTx: AccountTx) => {
    const beforeSettlement = captureSettlementVector(machine);
    const result = await applyAccountTx(
      machine,
      accountTx,
      proposerByLeft,
      frameTimestamp,
      frameJHeight, // Entity's synced J-height
      true, // isValidation = true (on clone, skip persistent state updates)
      env,
    );
    if (result.success) {
      assertNoUnilateralSettlementMutation(machine, beforeSettlement, accountTx, 'propose/validate');
    }
    return result;
  };

  const collectSuccessfulTx = (
    accountTx: AccountTx,
    result: Awaited<ReturnType<typeof applyAccountTx>>,
  ): void => {
    validTxs.push(accountTx);
    allEvents.push(...result.events);

    if (HEAVY_LOGS) {
      accountLog.debug('tx.result', {
        type: accountTx.type,
        hasSecret: Boolean(result.secret),
        hasHashlock: Boolean(result.hashlock),
      });
    }
    if (result.secret && result.hashlock) {
      revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
    }

    if (result.swapOfferCreated) {
      swapOffersCreated.push(result.swapOfferCreated);
    }

    if (result.swapOfferCancelRequested) {
      swapCancelRequests.push({
        ...result.swapOfferCancelRequested,
        accountId: accountMachine.proofHeader.toEntity,
      });
    }

    if (result.swapOfferCancelled) {
      swapOffersCancelled.push(result.swapOfferCancelled);
    }
  };

  const canOptimisticallyValidateBatch = shouldUseOptimisticProposalBatch(proposalWindow);
  let optimisticBatchFailed = false;
  if (canOptimisticallyValidateBatch) {
    const optimisticMachine = cloneAccountMachine(accountMachine);
    const optimisticResults: Array<{ tx: AccountTx; result: Awaited<ReturnType<typeof applyAccountTx>> }> = [];
    for (const accountTx of proposalWindow) {
      if (HEAVY_LOGS) accountLog.debug('batch.optimistic_tx', { type: accountTx.type });
      const result = await processOnMachine(optimisticMachine, accountTx);
      if (!result.success) {
        optimisticBatchFailed = true;
        break;
      }
      optimisticResults.push({ tx: accountTx, result });
    }
    if (!optimisticBatchFailed) {
      clonedMachine = optimisticMachine;
      for (const { tx, result } of optimisticResults) collectSuccessfulTx(tx, result);
    }
  }
  if (!canOptimisticallyValidateBatch || optimisticBatchFailed) {
    if (optimisticBatchFailed) {
      clonedMachine = cloneAccountMachine(accountMachine);
    }
    for (const accountTx of proposalWindow) {
      if (HEAVY_LOGS) accountLog.debug('tx.process', { type: accountTx.type });
      const txMachine = cloneAccountMachine(clonedMachine);
      const result = await processOnMachine(txMachine, accountTx);

      if (!result.success) {
        if (accountTx.type === 'cross_swap_fill_ack') {
          throw new Error(
            `CROSS_J_FILL_ACK_PROPOSAL_FAILED: offer=${accountTx.data.offerId} ` +
              `seq=${accountTx.data.fillSeq} error=${result.error || 'validation_failed'}`,
          );
        }
        if (accountTx.type === 'pull_lock' && accountTx.data.crossJurisdiction) {
          throw new Error(
            `CROSS_J_PULL_LOCK_PROPOSAL_FAILED: pull=${accountTx.data.pullId} ` +
              `order=${accountTx.data.crossJurisdiction.orderId} error=${result.error || 'validation_failed'}`,
          );
        }
        if (accountTx.type === 'swap_offer' && accountTx.data.crossJurisdiction) {
          throw new Error(
            `CROSS_J_SWAP_OFFER_PROPOSAL_FAILED: offer=${accountTx.data.offerId} ` +
              `error=${result.error || 'validation_failed'}`,
          );
        }
        if (isCrossJurisdictionPullResolveTx(accountMachine, accountTx)) {
          throw new Error(
            `CROSS_J_PULL_RESOLVE_PROPOSAL_FAILED: pull=${accountTx.data.pullId} ` +
              `error=${result.error || 'validation_failed'}`,
          );
        }
        txsToRemove.push(accountTx);
        accountLog.debug('tx.skipped', { type: accountTx.type, error: result.error || 'unknown' });

        if (accountTx.type === 'htlc_lock') {
          failedHtlcLocks.push({
            hashlock: accountTx.data.hashlock,
            reason: result.error || 'validation_failed',
          });
          accountLog.debug('htlc_lock.cancel_queued', { hashlock: shortHash(accountTx.data.hashlock) });
        }
        continue; // Skip to next tx
      }
      clonedMachine = txMachine;
      collectSuccessfulTx(accountTx, result);
    }
  }

  accountMachine.mempool = removeCommittedTxsFromMempool(accountMachine.mempool, txsToRemove);
  markStorageAccountDirty(env, accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  if (validTxs.length === 0) {
    const earlyResult: {
      success: false;
      error: string;
      events: string[];
      failedHtlcLocks?: Array<{ hashlock: string; reason: string }>;
    } = {
      success: false,
      error: 'All transactions failed validation',
      events: allEvents,
    };
    if (failedHtlcLocks.length > 0) earlyResult.failedHtlcLocks = failedHtlcLocks;
    return earlyResult;
  }

  const finalDeltas: Delta[] = [];

  // Sort by tokenId for deterministic ordering
  const sortedTokens = Array.from(clonedMachine.deltas.entries()).sort((a, b) => a[0] - b[0]);

  for (const [tokenId, delta] of sortedTokens) {
    // CONSENSUS FIX: Only include tokens that were actually used in transactions
    // This prevents mismatch when one side creates empty delta entries
    // CRITICAL: Use offdelta ONLY for frame comparison (not ondelta)
    // ondelta is set by J-events which have timing dependencies (bilateral finalization)
    // offdelta is set by bilateral transactions (deterministic)
    const totalDelta = delta.offdelta;

    // Skip tokens with zero delta AND zero limits AND zero holds (never used)
    // CRITICAL: Include tokens with HTLC/swap holds even if delta/limits/collateral are zero
    // NOTE: Collateral changes from j_events are included separately in frame validation
    // Only skip if delta, limits, AND holds are all zero
    // Collateral is omitted here because j_events can set it during frame processing
    if (!shouldIncludeToken(delta, totalDelta)) {
      if (HEAVY_LOGS) accountLog.debug('token.skip_unused', { tokenId });
      continue;
    }

    finalDeltas.push({ ...delta });
  }

  const weAreLeft = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  // Ensure monotonic timestamps within account (HTLC safety + multi-runtime compatibility).
  if (frameTimestamp > env.timestamp && HEAVY_LOGS) {
    accountLog.debug('timestamp.monotonic', { frameTimestamp, previousTimestamp, envTimestamp: env.timestamp });
  }

  const accountTxsCopy = structuredClone([...validTxs]);
  let accountStateRoot: string;
  try {
    accountStateRoot = computeAccountStateRoot(clonedMachine, getAccountStateDomain(env, accountMachine));
  } catch (error) {
    return {
      success: false,
      error: `ACCOUNT_STATE_ROOT_BUILD_FAILED: ${(error as Error).message}`,
      events,
    };
  }
  const frameData = {
    height: accountMachine.currentHeight + 1,
    timestamp: frameTimestamp, // MONOTONIC: max(env.timestamp, prev+1) for multi-runtime safety
    jHeight: frameJHeight, // CRITICAL: J-height for HTLC consensus
    accountTxs: accountTxsCopy,
    // CRITICAL: Use stored stateHash from currentFrame (set during commit)
    prevFrameHash: accountMachine.currentHeight === 0 ? 'genesis' : accountMachine.currentFrame.stateHash || '',
    accountStateRoot,
    stateHash: '', // Will be filled after hash calculation
    byLeft: weAreLeft, // Who proposed this frame
    deltas: finalDeltas,
  };

  frameData.stateHash = await createFrameHash(frameData as AccountFrame);

  let newFrame: AccountFrame;
  try {
    newFrame = validateAccountFrameStrict(frameData, 'proposeAccountFrame');
  } catch (error) {
    accountLog.warn('frame.validation_failed', { error: error instanceof Error ? error.message : String(error) });
    return {
      success: false,
      error: `Frame validation failed: ${(error as Error).message}`,
      events,
    };
  }

  const frameSize = safeStringify(newFrame).length;
  if (frameSize > MAX_FRAME_SIZE_BYTES) {
    accountLog.warn('frame.too_large', { frameSize, limit: MAX_FRAME_SIZE_BYTES });
    return {
      success: false,
      error: `Frame exceeds ${MAX_FRAME_SIZE_BYTES} byte limit: ${frameSize} bytes`,
      events,
    };
  }

  // Generate HANKO signature - CRITICAL: Use signerId, not entityId
  // For single-signer entities, build hanko with single EOA signature
  const signingEntityId = accountMachine.proofHeader.fromEntity;
  const signingReplica = getReplicaByEntityId(env, signingEntityId);
  if (!signingReplica) {
    return { success: false, error: `Cannot find replica for entity ${signingEntityId.slice(-4)}`, events };
  }
  const signingSignerId = signingReplica.state.config.validators[0]; // Single-signer: use first validator
  if (!signingSignerId) {
    return { success: false, error: `Entity ${signingEntityId.slice(-4)} has no validators`, events };
  }

  if (!quiet) accountLog.debug('hanko.sign', { entity: shortId(signingEntityId), signer: shortId(signingSignerId) });

  // Build the on-chain projection from NEW state. Credit-limit and other
  // off-chain-only changes alter accountStateRoot but intentionally reuse the
  // last dispute proof when the Solidity ProofBody projection is unchanged.
  if (!isEntityId32(clonedMachine.leftEntity) || !isEntityId32(clonedMachine.rightEntity)) {
    const left = String(clonedMachine.leftEntity);
    const right = String(clonedMachine.rightEntity);
    return {
      success: false,
      error: `INVALID_ACCOUNT_ENTITY_ID: left=${left} right=${right}`,
      events,
    };
  }

  const depositoryAddress = getAccountDepositoryAddress(env, accountMachine);
  if (!isAddress20(depositoryAddress)) {
    return {
      success: false,
      error: `DISPUTE_PROOF_BUILD_FAILED: MISSING_DEPOSITORY_ADDRESS`,
      events,
    };
  }

  let proofResult: ReturnType<typeof buildAccountProofBody>;
  let disputeHash: string | undefined;
  let signedProofNonce = 0;
  try {
    proofResult = buildAccountProofBody(clonedMachine);
    const proofBodyChanged =
      proofResult.proofBodyHash.toLowerCase() !== accountMachine.currentDisputeProofBodyHash?.toLowerCase();
    const proofNonceConsumed =
      Number(accountMachine.currentDisputeProofNonce ?? 0) <= Number(clonedMachine.jNonce ?? 0);
    if (proofBodyChanged || proofNonceConsumed) {
      signedProofNonce = Math.max(
        Number(clonedMachine.proofHeader.nextProofNonce ?? 0),
        Number(clonedMachine.jNonce ?? 0) + 1,
      );
      disputeHash = createDisputeProofHashWithNonce(
        clonedMachine,
        proofResult.proofBodyHash,
        depositoryAddress,
        signedProofNonce,
      );
    }
  } catch (error) {
    return {
      success: false,
      error: `DISPUTE_PROOF_BUILD_FAILED: ${(error as Error).message}`,
      events,
    };
  }

  const proofChanged = disputeHash !== undefined;
  const [frameHanko, disputeHanko] = await signEntityHashes(
    env,
    signingEntityId,
    signingSignerId,
    [newFrame.stateHash, ...(disputeHash ? [disputeHash] : [])],
  );
  if (!frameHanko) {
    return { success: false, error: 'Failed to build frame hanko', events };
  }
  if (proofChanged && !disputeHanko) {
    return { success: false, error: 'Failed to build dispute hanko', events };
  }
  accountMachine.currentFrameHanko = frameHanko;
  if (proofChanged && disputeHanko && disputeHash) {
    accountMachine.currentDisputeProofHanko = disputeHanko;
    accountMachine.currentDisputeProofNonce = signedProofNonce;
    accountMachine.currentDisputeProofBodyHash = proofResult.proofBodyHash;
    accountMachine.currentDisputeHash = disputeHash;
    accountMachine.disputeProofNoncesByHash ??= {};
    accountMachine.disputeProofNoncesByHash[proofResult.proofBodyHash] = signedProofNonce;
    accountMachine.disputeProofBodiesByHash ??= {};
    accountMachine.disputeProofBodiesByHash[proofResult.proofBodyHash] = proofResult.proofBodyStruct;
    storeDisputeArgumentSnapshot(
      accountMachine,
      captureDisputeArgumentSnapshot(
        clonedMachine,
        proofResult.proofBodyHash,
        signedProofNonce,
        proofResult.proofBodyStruct,
        { appliedAccountTxs: validTxs, appliedFrameHeight: newFrame.height },
      ),
    );
  }

  // Settlements are handled via SettlementWorkspace flow (entity/tx/handlers/settle.ts).

  // Set pending state (no longer storing clone - re-execution on commit)
  accountMachine.pendingFrame = newFrame;
  markStorageAccountDirty(env, accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  // Remove only the transactions that actually made it into the proposed frame.
  // This function is async and can yield while hashing/signing; late arrivals must
  // remain queued for the next frame instead of being silently wiped by position.
  accountMachine.mempool = removeCommittedTxsFromMempool(accountMachine.mempool, newFrame.accountTxs);

  events.push(`🚀 Proposed frame ${newFrame.height} with ${newFrame.accountTxs.length} transactions`);

  const outboundFrame = cloneAccountFrame(newFrame);
  const reusableAck = accountMachine.lastOutboundFrameAck;
  const shouldBundlePreviousAck =
    !!reusableAck &&
    reusableAck.counterpartyEntityId.toLowerCase() === accountMachine.proofHeader.toEntity.toLowerCase() &&
    Number(reusableAck.height) === Number(newFrame.height) - 1 &&
    Number(accountMachine.currentHeight) === Number(reusableAck.height);
  const disputeSeal = proofChanged && disputeHanko && disputeHash ? {
    hanko: disputeHanko,
    hash: disputeHash,
    proofBodyHash: proofResult.proofBodyHash,
    proofNonce: signedProofNonce,
  } : (
    accountMachine.currentDisputeProofHanko &&
    accountMachine.currentDisputeHash &&
    accountMachine.currentDisputeProofBodyHash?.toLowerCase() === proofResult.proofBodyHash.toLowerCase() &&
    Number(accountMachine.currentDisputeProofNonce ?? 0) > Number(clonedMachine.jNonce ?? 0)
      ? {
          hanko: accountMachine.currentDisputeProofHanko,
          hash: accountMachine.currentDisputeHash,
          proofBodyHash: accountMachine.currentDisputeProofBodyHash,
          proofNonce: accountMachine.currentDisputeProofNonce!,
        }
      : undefined
  );
  const proposal = {
    frame: outboundFrame,
    frameHanko,
    ...(disputeSeal ? { disputeSeal } : {}),
  };
  const accountInput: AccountInput = shouldBundlePreviousAck ? {
    kind: 'frame_ack',
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: accountMachine.proofHeader.toEntity,
    watchSeed: accountMachine.watchSeed,
    ack: structuredClone(reusableAck.response.ack),
    proposal,
  } : {
    kind: 'frame',
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: accountMachine.proofHeader.toEntity,
    watchSeed: accountMachine.watchSeed,
    proposal,
  };
  if (!shouldBundlePreviousAck && reusableAck && Number(reusableAck.height) < Number(accountMachine.currentHeight)) {
    delete accountMachine.lastOutboundFrameAck;
  }
  if (proofChanged) accountMachine.proofHeader.nextProofNonce = signedProofNonce + 1;
  accountMachine.pendingAccountInput = structuredClone(accountInput);

  // Collect hashes for entity-quorum signing (multi-signer support)
  const hashesToSign: AccountConsensusHashToSign[] = [
    {
      hash: newFrame.stateHash,
      type: 'accountFrame',
      context: `account:${counterparty.slice(-8)}:frame:${newFrame.height}`,
    },
    ...(disputeHash ? [{ hash: disputeHash, type: 'dispute' as const, context: `account:${counterparty.slice(-8)}:dispute` }] : []),
  ];

  const finalResult: ProposeAccountFrameResult = {
    success: true,
    accountInput,
    events,
    revealedSecrets,
    swapOffersCreated,
    swapCancelRequests,
    swapOffersCancelled,
    hashesToSign,
  };
  if (failedHtlcLocks.length > 0) finalResult.failedHtlcLocks = failedHtlcLocks;
  const profileTotalMs = Math.round(getPerfMs() - profileStartMs);
  if (ACCOUNT_PROPOSAL_PROFILE || profileTotalMs >= ACCOUNT_PROPOSAL_SLOW_MS) {
    const profile = {
      entity: shortId(signingEntityId, 8),
      counterparty: shortId(counterparty, 8),
      height: newFrame.height,
      txs: newFrame.accountTxs.length,
      txTypes: Array.from(new Set(newFrame.accountTxs.map((tx) => tx.type))).sort(),
      optimisticBatch: canOptimisticallyValidateBatch && !optimisticBatchFailed,
      totalMs: profileTotalMs,
    };
    if (ACCOUNT_PROPOSAL_PROFILE) accountLog.warn('proposal.profile', profile);
    else accountLog.debug('proposal.profile', profile);
  }
  return finalResult;
}
