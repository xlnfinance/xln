/**
 * Account frame proposal path. This module owns local mempool validation,
 * frame construction, frame hanko signing, and dispute-proof signing.
 */

import type { AccountFrame, AccountInput, AccountMachine, AccountTx, Delta, Env } from '../types';
import { cloneAccountFrame, cloneAccountMachine, getAccountPerspective, removeCommittedTxsFromMempool } from '../state-helpers';
import { isLeft } from '../account-utils';
import { formatEntityId, HEAVY_LOGS } from '../utils';
import { safeStringify } from '../serialization-utils';
import { validateAccountFrame as validateAccountFrameStrict } from '../validation-utils';
import { processAccountTx } from '../account-tx/apply';
import { markStorageAccountDirty } from '../env-events';
import { createStructuredLogger, shortHash, shortId } from '../logger';
import { createFrameHash, MAX_ACCOUNT_FRAME_TXS, MAX_FRAME_SIZE_BYTES } from '../account-consensus-frame';
import {
  assertNoUnilateralSettlementMutation,
  captureSettlementVector,
  getAccountDepositoryAddress,
  isAddress20,
  isEntityId32,
  shouldIncludeToken,
} from '../account-consensus-helpers';
import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../dispute-arguments';
import { MEMPOOL_LIMIT } from './constants';
import type { AccountConsensusHashToSign, AccountSwapOfferCreated, ProposeAccountFrameResult } from './types';

const accountLog = createStructuredLogger('account');

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
  skipNonceIncrement: boolean = false,
  entityJHeight?: number, // Optional: J-height from entity state for HTLC consensus
): Promise<ProposeAccountFrameResult> {
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
  if (HEAVY_LOGS)
    console.log(
      `🔍 PROOF-HEADER: from=${formatEntityId(accountMachine.proofHeader.fromEntity)}, to=${formatEntityId(accountMachine.proofHeader.toEntity)}`,
    );

  // Clone account machine for validation
  let clonedMachine = cloneAccountMachine(accountMachine);
  // NOTE: proofHeader.nonce is NOT set here — it's incremented per-message, not per-frame

  // Deterministic J-height for account frame hashing:
  // Use account-level finalized J-height (consensus state), not live replica tip.
  // Replica tip can drift between runtime sessions and break WAL replay hashes.
  const frameJHeight = entityJHeight ?? accountMachine.lastFinalizedJHeight ?? 0;

  const allEvents: string[] = [];
  const revealedSecrets: Array<{ secret: string; hashlock: string }> = [];
  const swapOffersCreated: AccountSwapOfferCreated[] = [];
  const swapCancelRequests: Array<{ offerId: string; accountId: string }> = [];
  const swapOffersCancelled: Array<{ offerId: string; accountId: string }> = [];

  if (HEAVY_LOGS)
    console.log(
      `🔍 MEMPOOL-BEFORE-PROCESS: proposalWindow=${proposalWindow.length}/${accountMachine.mempool.length} txs:`,
      proposalWindow.map(tx => tx.type),
    );

  const validTxs: typeof accountMachine.mempool = [];
  const failedHtlcLocks: Array<{ hashlock: string; reason: string }> = [];
  const txsToRemove: typeof accountMachine.mempool = [];
  const proposerByLeft = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  const processOnMachine = async (machine: AccountMachine, accountTx: AccountTx) => {
    const beforeSettlement = captureSettlementVector(machine);
    const result = await processAccountTx(
      machine,
      accountTx,
      proposerByLeft,
      env.timestamp, // Will be replaced by frame.timestamp during commit
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
    result: Awaited<ReturnType<typeof processAccountTx>>,
  ): void => {
    validTxs.push(accountTx);
    allEvents.push(...result.events);

    if (HEAVY_LOGS)
      console.log(
        `🔍 TX-RESULT: type=${accountTx.type}, hasSecret=${!!result.secret}, hasHashlock=${!!result.hashlock}`,
      );
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

  const canOptimisticallyValidateBatch =
    proposalWindow.length > 1 &&
    proposalWindow.every((tx) => tx.type === 'swap_resolve' || tx.type === 'cross_swap_fill_ack');
  let optimisticBatchFailed = false;
  if (canOptimisticallyValidateBatch) {
    const optimisticMachine = cloneAccountMachine(accountMachine);
    const optimisticResults: Array<{ tx: AccountTx; result: Awaited<ReturnType<typeof processAccountTx>> }> = [];
    for (const accountTx of proposalWindow) {
      if (HEAVY_LOGS) console.log(`   🔍 Optimistic batch accountTx type=${accountTx.type}`);
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
      if (HEAVY_LOGS) console.log(`   🔍 Processing accountTx type=${accountTx.type}`);
      const txMachine = cloneAccountMachine(clonedMachine);
      const result = await processOnMachine(txMachine, accountTx);

      if (!result.success) {
        if (accountTx.type === 'cross_swap_fill_ack') {
          throw new Error(
            `CROSS_J_FILL_ACK_PROPOSAL_FAILED: offer=${accountTx.data.offerId} ` +
              `seq=${accountTx.data.fillSeq} error=${result.error || 'validation_failed'}`,
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
      if (HEAVY_LOGS) console.log(`⏭️  Skipping unused token ${tokenId} from frame (zero delta/limits/holds)`);
      continue;
    }

    finalDeltas.push({ ...delta });
  }

  const weAreLeft = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  // Ensure monotonic timestamps within account (HTLC safety + multi-runtime compatibility)
  // In multi-runtime P2P scenarios, different runtimes may have different clock rates
  // We ensure frames always have increasing timestamps within an account chain
  const previousTimestamp = accountMachine.currentFrame?.timestamp ?? 0;
  const frameTimestamp = Math.max(env.timestamp, previousTimestamp + 1);
  if (frameTimestamp > env.timestamp && HEAVY_LOGS) {
    console.log(
      `⚡ TIMESTAMP-SYNC: Using monotonic timestamp ${frameTimestamp} (prev=${previousTimestamp}, env=${env.timestamp})`,
    );
  }

  const accountTxsCopy = structuredClone([...validTxs]);
  const frameData = {
    height: accountMachine.currentHeight + 1,
    timestamp: frameTimestamp, // MONOTONIC: max(env.timestamp, prev+1) for multi-runtime safety
    jHeight: frameJHeight, // CRITICAL: J-height for HTLC consensus
    accountTxs: accountTxsCopy,
    // CRITICAL: Use stored stateHash from currentFrame (set during commit)
    prevFrameHash: accountMachine.currentHeight === 0 ? 'genesis' : accountMachine.currentFrame.stateHash || '',
    stateHash: '', // Will be filled after hash calculation
    byLeft: weAreLeft, // Who proposed this frame
    deltas: finalDeltas,
  };

  frameData.stateHash = await createFrameHash(frameData as AccountFrame);

  let newFrame: AccountFrame;
  try {
    newFrame = validateAccountFrameStrict(frameData, 'proposeAccountFrame');
  } catch (error) {
    console.warn(`⚠️ Frame validation failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      error: `Frame validation failed: ${(error as Error).message}`,
      events,
    };
  }

  const frameSize = safeStringify(newFrame).length;
  if (frameSize > MAX_FRAME_SIZE_BYTES) {
    console.warn(`⚠️ Frame too large: ${frameSize} bytes`);
    return {
      success: false,
      error: `Frame exceeds 1MB limit: ${frameSize} bytes`,
      events,
    };
  }

  // Generate HANKO signature - CRITICAL: Use signerId, not entityId
  // For single-signer entities, build hanko with single EOA signature
  const signingEntityId = accountMachine.proofHeader.fromEntity;
  const signingReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === signingEntityId);
  if (!signingReplica) {
    return { success: false, error: `Cannot find replica for entity ${signingEntityId.slice(-4)}`, events };
  }
  const signingSignerId = signingReplica.state.config.validators[0]; // Single-signer: use first validator
  if (!signingSignerId) {
    return { success: false, error: `Entity ${signingEntityId.slice(-4)} has no validators`, events };
  }

  if (!quiet) accountLog.debug('hanko.sign', { entity: shortId(signingEntityId), signer: shortId(signingSignerId) });

  // Build dispute proof and sign it (CRITICAL: always sign dispute proof with every frame)
  // BUG FIX: Use clonedMachine (has NEW state after txs) NOT accountMachine (old state)
  if (!isEntityId32(clonedMachine.leftEntity) || !isEntityId32(clonedMachine.rightEntity)) {
    const left = String(clonedMachine.leftEntity);
    const right = String(clonedMachine.rightEntity);
    return {
      success: false,
      error: `INVALID_ACCOUNT_ENTITY_ID: left=${left} right=${right}`,
      events,
    };
  }

  const { buildAccountProofBody, createDisputeProofHashWithNonce } = await import('../proof-builder');
  const depositoryAddress = getAccountDepositoryAddress(env, accountMachine);
  if (!isAddress20(depositoryAddress)) {
    return {
      success: false,
      error: `DISPUTE_PROOF_BUILD_FAILED: MISSING_DEPOSITORY_ADDRESS`,
      events,
    };
  }

  let proofResult: ReturnType<typeof buildAccountProofBody>;
  let disputeHash: string;
  try {
    proofResult = buildAccountProofBody(clonedMachine);
    disputeHash = createDisputeProofHashWithNonce(
      clonedMachine,
      proofResult.proofBodyHash,
      depositoryAddress,
      clonedMachine.proofHeader.nonce,
    );
  } catch (error) {
    return {
      success: false,
      error: `DISPUTE_PROOF_BUILD_FAILED: ${(error as Error).message}`,
      events,
    };
  }

  // Build both hankos in one signer-key/precheck pass. They remain separate
  // hankos over separate hashes; batching here only removes duplicated local
  // lookup/guard work from the hot account-consensus path.
  const { signEntityHashes } = await import('../hanko/signing');
  const [frameHanko, disputeHanko] = await signEntityHashes(env, signingEntityId, signingSignerId, [
    newFrame.stateHash,
    disputeHash,
  ]);
  if (!frameHanko) {
    return { success: false, error: 'Failed to build frame hanko', events };
  }
  if (!disputeHanko) {
    return { success: false, error: 'Failed to build dispute hanko', events };
  }
  accountMachine.currentFrameHanko = frameHanko;
  accountMachine.currentDisputeProofHanko = disputeHanko;
  accountMachine.currentDisputeProofNonce = clonedMachine.proofHeader.nonce;
  accountMachine.currentDisputeProofBodyHash = proofResult.proofBodyHash;
  accountMachine.currentDisputeHash = disputeHash;
  if (!accountMachine.disputeProofNoncesByHash) {
    accountMachine.disputeProofNoncesByHash = {};
  }
  accountMachine.disputeProofNoncesByHash[proofResult.proofBodyHash] = clonedMachine.proofHeader.nonce;
  if (!accountMachine.disputeProofBodiesByHash) {
    accountMachine.disputeProofBodiesByHash = {};
  }
  accountMachine.disputeProofBodiesByHash[proofResult.proofBodyHash] = proofResult.proofBodyStruct;
  storeDisputeArgumentSnapshot(
    accountMachine,
    captureDisputeArgumentSnapshot(
      clonedMachine,
      proofResult.proofBodyHash,
	      clonedMachine.proofHeader.nonce,
	      proofResult.proofBodyStruct,
	      { appliedAccountTxs: validTxs, appliedFrameHeight: newFrame.height },
	    ),
	  );

  // Settlements are handled via SettlementWorkspace flow (entity-tx/handlers/settle.ts).

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
  const accountInput: AccountInput = shouldBundlePreviousAck ? {
    kind: 'frame_ack',
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: accountMachine.proofHeader.toEntity,
    height: reusableAck.height,
    prevHanko: reusableAck.prevHanko,
    newAccountFrame: outboundFrame,
    newHanko: frameHanko,
    newDisputeHanko: disputeHanko,
    newDisputeHash: disputeHash,
    newDisputeProofBodyHash: proofResult.proofBodyHash,
    disputeProofNonce: accountMachine.proofHeader.nonce,
  } : {
    kind: 'frame',
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: accountMachine.proofHeader.toEntity,
    height: newFrame.height,
    newAccountFrame: outboundFrame,
    newHanko: frameHanko, // Hanko on frame stateHash
    newDisputeHanko: disputeHanko, // Hanko on dispute proof hash
    newDisputeHash: disputeHash, // Full dispute hash (key in hankoWitness for quorum lookup)
    newDisputeProofBodyHash: proofResult.proofBodyHash, // ProofBodyHash that disputeHanko signs
    // NOTE: Settlement hankos now handled via SettlementWorkspace (entity-tx/handlers/settle.ts)
    disputeProofNonce: accountMachine.proofHeader.nonce, // nonce at which dispute proof was signed (before increment)
  };
  if (!shouldBundlePreviousAck && reusableAck && Number(reusableAck.height) < Number(accountMachine.currentHeight)) {
    delete accountMachine.lastOutboundFrameAck;
  }
  if (!skipNonceIncrement) ++accountMachine.proofHeader.nonce;
  accountMachine.pendingAccountInput = structuredClone(accountInput);

  // Collect hashes for entity-quorum signing (multi-signer support)
  const hashesToSign: AccountConsensusHashToSign[] = [
    {
      hash: newFrame.stateHash,
      type: 'accountFrame',
      context: `account:${counterparty.slice(-8)}:frame:${newFrame.height}`,
    },
    { hash: disputeHash, type: 'dispute', context: `account:${counterparty.slice(-8)}:dispute` },
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
  return finalResult;
}
