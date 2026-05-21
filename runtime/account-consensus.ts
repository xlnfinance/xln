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
  EntityReplica,
} from './types';
import {
  cloneAccountFrame,
  cloneAccountMachine,
  getAccountPerspective,
} from './state-helpers';
import { isLeft } from './account-utils';
import { signAccountFrame } from './account-crypto';
import { cryptoHash as hash, HEAVY_LOGS } from './utils';
import { safeStringify } from './serialization-utils';
import { processAccountTx } from './account-tx/apply';
import { appendAccountFrameHistoryView, getAccountFrameHistoryView, markStorageAccountDirty, recordAccountFrameHistory } from './env-events';
import { deriveAccountFrameOffdeltas, deriveAccountFrameTokenIds } from './account-frame';
import { createStructuredLogger, shortHash, shortId, shouldLogFullPayloads } from './logger';
import {
  createFrameHash,
  validateAccountFrame,
} from './account-consensus-frame';
import {
  assertNoUnilateralSettlementMutation,
  captureSettlementVector,
  getDepositoryAddress,
  isAddress20,
  kickHubRebalanceAfterFrameFinalize,
  prependUniqueMempoolTxs,
  runPostFrameAutoRebalanceCheck,
  shouldIncludeToken,
  summarizeDeltasForLog,
} from './account-consensus-helpers';
import { MEMPOOL_LIMIT } from './account-consensus/constants';
import { proposeAccountFrame } from './account-consensus/propose';
import type { HandleAccountInputResult } from './account-consensus/types';
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

/**
 * Handle received AccountInput (bilateral consensus)
 */
export async function handleAccountInput(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
): Promise<HandleAccountInputResult> {
  const normalizedInputHeight =
    input.height === undefined || input.height === null ? undefined : Number(input.height as number | string);
  if (normalizedInputHeight !== undefined && !Number.isFinite(normalizedInputHeight)) {
    return { success: false, error: `Invalid account input height: ${String(input.height)}`, events: [] };
  }
  const committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }> = [];

  const events: string[] = [];
  const timedOutHashlocks: string[] = [];
  let ackProcessed = false;
  const describeAccountState = () => ({
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
  });
  // Replay protection: frame chain (height + prevFrameHash) checked at :836
  // ACK replay protection: pendingFrame cleared on commit, so replayed ACK fails pendingFrame check

  if (input.newDisputeHanko !== undefined && input.newDisputeHanko !== null) {
    if (typeof input.newDisputeHanko !== 'string') {
      return { success: false, error: 'Invalid dispute hanko type', events };
    }
    const hankoHex = input.newDisputeHanko.toLowerCase();
    const normalized = hankoHex.startsWith('0x') ? hankoHex.slice(2) : hankoHex;
    if (normalized.length === 0) {
      return { success: false, error: 'Invalid dispute hanko (empty)', events };
    }
    if (normalized.length % 2 !== 0) {
      return { success: false, error: 'Invalid dispute hanko (odd length)', events };
    }
  }

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
  const ackHeight = ackTargetsPendingFrame ? pendingHeight : normalizedInputHeight;

  // Handle pending frame confirmation
  if (accountMachine.pendingFrame && ackHeight === accountMachine.pendingFrame.height && input.prevHanko) {
    if (HEAVY_LOGS) console.log(`✅ ACK-DEBUG: fromEntity=${input.fromEntityId.slice(-4)}, toEntity=${input.toEntityId.slice(-4)}`);

    const frameHash = accountMachine.pendingFrame.stateHash;

    // HANKO ACK VERIFICATION: Verify hanko instead of single signature
    const ackHanko = input.prevHanko;
    if (!ackHanko) {
      return { success: false, error: 'Missing ACK hanko', events };
    }

    const expectedAckEntity = accountMachine.proofHeader.toEntity;
    accountLog.debug('hanko.ack.verify', { height: ackHeight, frame: shortHash(frameHash) });
    const { verifyHankoForHash } = await import('./hanko/signing');
    const verifyResult = await verifyHankoForHash(ackHanko, frameHash, expectedAckEntity, env);
    const valid = verifyResult.valid;
    const recoveredEntityId = verifyResult.entityId;
    if (!valid) {
      return { success: false, error: 'Invalid ACK hanko signature', events };
    }

    if (!recoveredEntityId || recoveredEntityId.toLowerCase() !== expectedAckEntity.toLowerCase()) {
      return {
        success: false,
        error: `ACK hanko entityId mismatch: got ${recoveredEntityId?.slice(-4)}, expected ${expectedAckEntity.slice(-4)}`,
        events,
      };
    }
    accountLog.debug('hanko.ack.verified', { from: shortId(recoveredEntityId ?? expectedAckEntity), height: ackHeight });

    // ACK is valid - proceed
    ackProcessed = true;
    {
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
      {
        const { counterparty: cpForLog } = getAccountPerspective(accountMachine, accountMachine.proofHeader.fromEntity);
        accountLog.debug('frame.reexecute', {
          height: accountMachine.pendingFrame.height,
          counterparty: shortId(cpForLog),
          txs: accountMachine.pendingFrame.accountTxs.length,
        });

        // Re-execute all frame txs on REAL accountMachine (deterministic)
        // CRITICAL: Use frame.timestamp for determinism (HTLC validation must use agreed consensus time)
        const pendingJHeight = accountMachine.pendingFrame.jHeight ?? accountMachine.currentHeight;
        for (const tx of accountMachine.pendingFrame.accountTxs) {
          const beforeSettlement = captureSettlementVector(accountMachine);
          const commitResult = await processAccountTx(
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
          if (input.disputeProofNonce === undefined || !input.newDisputeHash) {
            console.warn(
              `⚠️ ACK has newDisputeHanko but missing disputeProofNonce or newDisputeHash — skipping dispute metadata`,
            );
          } else {
            // Cryptographic binding: verify hanko actually signs the claimed dispute hash
            const { verifyHankoForHash } = await import('./hanko/signing');
            const { valid: disputeValid } = await verifyHankoForHash(
              input.newDisputeHanko,
              input.newDisputeHash,
              input.fromEntityId,
              env,
            );
            if (!disputeValid) {
              console.warn(`⚠️ ACK dispute hanko fails verification — skipping dispute metadata`);
            } else {
              accountMachine.counterpartyDisputeProofHanko = input.newDisputeHanko;
              const signedCooperativeNonce = input.disputeProofNonce;
              accountMachine.counterpartyDisputeProofNonce = signedCooperativeNonce;
              accountMachine.counterpartyDisputeHash = input.newDisputeHash;
              if (input.newDisputeProofBodyHash) {
                accountMachine.counterpartyDisputeProofBodyHash = input.newDisputeProofBodyHash;
                if (!accountMachine.disputeProofNoncesByHash) {
                  accountMachine.disputeProofNoncesByHash = {};
                }
                accountMachine.disputeProofNoncesByHash[input.newDisputeProofBodyHash] = signedCooperativeNonce;
              }
              accountLog.debug('hanko.dispute_ack_stored', { nonce: signedCooperativeNonce, from: shortId(input.fromEntityId) });
            }
          }
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

      }

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
            };
          }
        }
        if (HEAVY_LOGS) console.log(`🔍 RETURN-ACK-ONLY: frame ${ackHeight} ACKed, no new frame bundled`);
        return { success: true, events, timedOutHashlocks, ...(committedFrames.length > 0 && { committedFrames }) };
      }
      // Fall through to process newAccountFrame below
    }
  }

  const pendingFrameHeight = Number(accountMachine.pendingFrame?.height ?? 0);
  const isSameHeightSimultaneousProposal =
    Boolean(input.prevHanko) &&
    Boolean(input.newAccountFrame) &&
    pendingFrameHeight > 0 &&
    Number(input.newAccountFrame?.height ?? 0) === pendingFrameHeight &&
    Number(normalizedInputHeight ?? 0) === pendingFrameHeight - 1;

  // ACK for a pending frame must never be ignored unless this is the valid
  // same-height race case: peer ACKs the last committed frame and proposes the
  // same next height we already have pending. That path is resolved below by
  // the simultaneous-proposal handler.
  if (input.prevHanko && !ackProcessed && accountMachine.pendingFrame && !isSameHeightSimultaneousProposal) {
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

  // Handle new frame proposal
  if (input.newAccountFrame) {
    const receivedFrame = input.newAccountFrame;
    if (Number(receivedFrame.height) <= Number(accountMachine.currentHeight ?? 0)) {
      const cachedAck = accountMachine.lastOutboundFrameAck;
      const canReackCommittedFrame =
        Number(receivedFrame.height) === Number(accountMachine.currentHeight ?? 0) &&
        receivedFrame.stateHash === accountMachine.currentFrame?.stateHash &&
        !!cachedAck &&
        Number(cachedAck.height) === Number(receivedFrame.height) &&
        cachedAck.counterpartyEntityId.toLowerCase() === input.fromEntityId.toLowerCase();
      if (canReackCommittedFrame) {
        events.push(
          `↩️ Re-sent ACK for duplicate committed frame ${String(receivedFrame.height)}`,
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
      events.push(
        `ℹ️ Ignored stale frame ${String(receivedFrame.height)} (current=${String(accountMachine.currentHeight ?? 0)})`,
      );
      return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
    }

    // Validate frame with timestamp checks (HTLC safety)
    const previousTimestamp = accountMachine.currentFrame?.timestamp;
    if (!validateAccountFrame(receivedFrame, env.timestamp, previousTimestamp)) {
      return { success: false, error: 'Invalid frame structure', events };
    }

    // CRITICAL: Verify prevFrameHash links to our current frame (prevent state fork)
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
        account: describeAccountState(),
      };
      console.warn(`⚠️ FRAME-CHAIN: prevHash mismatch at height ${accountMachine.currentHeight}`);
      console.warn(`[A-MACHINE][FRAME-CHAIN-MISMATCH] ${safeStringify(mismatchDebug)}`);
      return {
        success: false,
        error:
          `Frame chain broken: prevFrameHash mismatch ` +
          `(expected ${expectedPrevFrameHash.slice(0, 16)}..., got ${String(receivedFrame.prevFrameHash).slice(0, 16)}..., ` +
          `current=${accountMachine.currentHeight}, pending=${Number(accountMachine.pendingFrame?.height ?? 0)})`,
        events,
      };
    }

    if (accountMachine.pendingFrame && receivedFrame.height === accountMachine.pendingFrame.height) {
      // Simultaneous proposal tiebreaker: left keeps its pending frame, right rolls back.
      const isLeftEntity = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
      if (HEAVY_LOGS)
        console.log(
          `🔍 TIEBREAKER: fromEntity=${accountMachine.proofHeader.fromEntity.slice(-4)}, toEntity=${accountMachine.proofHeader.toEntity.slice(-4)}, isLeft=${isLeftEntity}`,
        );

      if (isLeftEntity) {
        events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${receivedFrame.height} (waiting for their ACK)`);
        if (accountMachine.mempool.length > 0) {
          events.push(`⚠️ LEFT has ${accountMachine.mempool.length} pending txs while waiting for RIGHT's ACK`);
        }
        return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
      } else {
        const receivedHash = receivedFrame.stateHash;
        if (accountMachine.lastRollbackFrameHash === receivedHash) {
          accountLog.debug('rollback.duplicate', { frame: shortHash(receivedHash) });
        } else {
          // Restore transactions to mempool before discarding frame.
          // IMPORTANT: allow repeated RIGHT rollbacks (same-height races can happen
          // under burst traffic); dedupe mempool to avoid tx duplication.
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
        }
      }
    }

    // NOTE: rollbackCount decrement happens in ACK block (line 547) when pendingFrame confirmed
    // This ensures we only decrement once per rollback resolution (no double-decrement)

    // Verify frame sequence
    if (HEAVY_LOGS)
      console.log(
        `🔍 SEQUENCE-CHECK: receivedFrame.height=${receivedFrame.height}, currentHeight=${accountMachine.currentHeight}, expected=${accountMachine.currentHeight + 1}`,
      );
    if (receivedFrame.height !== accountMachine.currentHeight + 1) {
      console.log(
        `❌ Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`,
      );
      return {
        success: false,
        error: `Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`,
        events,
      };
    }

    // SECURITY: Verify signatures (REQUIRED for all frames)
    // HANKO VERIFICATION: Require hanko for all frames
    const hankoToVerify = input.newHanko;
    if (!hankoToVerify) {
      return { success: false, error: 'SECURITY: Frame must have hanko signature', events };
    }

    accountLog.debug('hanko.frame.verify', { height: receivedFrame.height, from: shortId(input.fromEntityId) });

    // Verify hanko - CRITICAL: Must verify fromEntityId is the signer with board validation
    const { verifyHankoForHash } = await import('./hanko/signing');
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

    // Store counterparty's frame hanko
    accountMachine.counterpartyFrameHanko = hankoToVerify;

    // Dispute metadata stored on COMMIT (not here) — input is in scope throughout

    // Get entity's synced J-height for deterministic HTLC validation
    const ourEntityId = accountMachine.proofHeader.fromEntity;
    const ourReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === ourEntityId);
    const currentJHeight = ourReplica?.state.lastFinalizedJHeight || 0;
    const frameJHeight = receivedFrame.jHeight ?? currentJHeight;

    // Apply frame transactions to clone (as receiver)
    const clonedMachine = cloneAccountMachine(accountMachine);
    const processEvents: string[] = [];

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
    const revealedSecrets: Array<{ secret: string; hashlock: string }> = [];
    // AUDIT FIX (CRITICAL-1): SwapOfferEvent carries makerIsLeft + fromEntity/toEntity
    const swapOffersCreated: Array<{
      offerId: string;
      makerIsLeft: boolean;
      fromEntity: string;
      toEntity: string;
      accountId?: string;
      giveTokenId: number;
      giveAmount: bigint;
	      wantTokenId: number;
	      wantAmount: bigint;
	      priceTicks?: bigint | undefined;
	      timeInForce?: 0 | 1 | 2 | undefined;
	      minFillRatio: number;
	    }> = [];
    const swapCancelRequests: Array<{ offerId: string; accountId: string }> = [];
    const swapOffersCancelled: Array<{ offerId: string; accountId: string }> = [];

    for (const accountTx of receivedFrame.accountTxs) {
      // When receiving a frame, we process transactions from counterparty's perspective (incoming)
      // CRITICAL: Use receivedFrame.timestamp for determinism (HTLC validation must use agreed consensus time)
      const beforeSettlement = captureSettlementVector(clonedMachine);
      const result = await processAccountTx(
        clonedMachine,
        accountTx,
        receivedFrame.byLeft!, // Channel.ts: frame-level byLeft (same on both sides)
        receivedFrame.timestamp, // DETERMINISTIC: Use frame's consensus timestamp
        frameJHeight, // Frame's consensus J-height
        true, // isValidation = true (on clone, skip bilateral finalization)
        env,
      );
      if (!result.success) {
        return { success: false, error: `Frame application failed: ${result.error}`, events };
      }
      assertNoUnilateralSettlementMutation(clonedMachine, beforeSettlement, accountTx, 'receiver/validate');
      processEvents.push(...result.events);

      if (HEAVY_LOGS) console.log(`🔍 TX-PROCESSED: ${accountTx.type}, success=${result.success}`);
      // Collect revealed secrets (CRITICAL for multi-hop)
      if (result.secret && result.hashlock) {
        revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
      }
      if (result.timedOutHashlock) {
        timedOutHashlocks.push(result.timedOutHashlock);
      }

      // Collect swap offers for orderbook integration
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

    // STATE VERIFICATION: Compare deltas directly (both sides compute identically)
    // Extract final state from clonedMachine after processing ALL transactions
    const ourFinalTokenIds: number[] = [];
    const ourFinalDeltas: Delta[] = [];

    const sortedOurTokens = Array.from(clonedMachine.deltas.entries()).sort((a, b) => a[0] - b[0]);
    for (const [tokenId, delta] of sortedOurTokens) {
      // CRITICAL: Use offdelta ONLY for frame comparison (same as proposer)
      // ondelta is set by J-events which have timing dependencies (bilateral finalization)
      // offdelta is set by bilateral transactions (deterministic)
      const totalDelta = delta.offdelta;

      // CONSENSUS FIX: Apply SAME filtering as proposer
      // Skip tokens with zero delta AND zero limits (never used)
      if (!shouldIncludeToken(delta, totalDelta)) {
        if (HEAVY_LOGS) console.log(`⏭️  RECEIVER: Skipping unused token ${tokenId} from validation`);
        continue;
      }

      ourFinalTokenIds.push(tokenId);
      ourFinalDeltas.push({ ...delta });
    }

    if (HEAVY_LOGS)
      console.log(
        `🔍 RECEIVER: Computed ${ourFinalTokenIds.length} tokens after filtering: [${ourFinalTokenIds.join(', ')}]`,
      );

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
      // Compact error - full dump only if DEBUG enabled
      console.warn(
        `⚠️ CONSENSUS: Frame ${receivedFrame.height} - state mismatch (our: ${ourComputedState.slice(0, 16)}... vs their: ${theirClaimedState.slice(0, 16)}...)`,
      );
      return { success: false, error: `Bilateral consensus failure - states don't match`, events };
    }

    // SECURITY FIX: Verify BILATERAL fields in deltas (prevents state injection attack)
    // ondelta/collateral may differ due to J-event timing, but bilateral fields MUST match:
    // - offdelta: Set by bilateral payments
    // - creditLimit: Set by bilateral set_credit_limit tx
    // - allowance: Set by bilateral transactions
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

      // Compare BILATERAL fields only (ondelta/collateral may differ due to J-event timing)
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

    if (HEAVY_LOGS) console.log(`🔍 ABOUT-TO-VERIFY-HASH: Computing frame hash...`);
    // Duplex-safe hash validation:
    // - bilateral fields are enforced above (offdelta/limits/allowances)
    // - unilateral fields (collateral/ondelta) may lag between peers until claims converge
    //   so hash must be recomputed from sender payload, not receiver-local unilateral state
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

    accountLog.debug('frame.accept', {
      height: receivedFrame.height,
      from: shortId(input.fromEntityId),
      txs: receivedFrame.accountTxs.map(tx => tx.type),
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSENSUS PRINCIPLE: strict on bilateral fields, tolerant on unilateral lag
    // ═══════════════════════════════════════════════════════════════════════════
    // 1) Bilateral fields (offdelta/limits/allowances) MUST match our execution.
    // 2) Sender frame hash must be self-consistent.
    // 3) Unilateral fields (collateral/ondelta) may temporarily differ until
    //    j_event_claims converge and are finalized 2-of-2 in account state.
    // ═══════════════════════════════════════════════════════════════════════════

    // RECEIVER COMMIT: Re-execute txs on REAL state (Channel.ts pattern)
    // This eliminates fragile manual field copying
    const { counterparty: cpForCommitLog } = getAccountPerspective(accountMachine, ourEntityId);
    if (HEAVY_LOGS)
      console.log(
        `🔍 RECEIVER-COMMIT: Re-executing ${receivedFrame.accountTxs.length} txs for ${cpForCommitLog.slice(-4)}`,
      );

    // Re-execute all frame txs on REAL accountMachine (deterministic)
    // CRITICAL: Use receivedFrame.timestamp for determinism (HTLC validation must use agreed consensus time)
    for (const tx of receivedFrame.accountTxs) {
      // CRITICAL: Use frame.jHeight for HTLC checks (consensus-aligned height)
      const jHeightForCommit = receivedFrame.jHeight || accountMachine.currentHeight;
      const beforeSettlement = captureSettlementVector(accountMachine);
      const commitResult = await processAccountTx(
        accountMachine,
        tx,
        receivedFrame.byLeft!,
        receivedFrame.timestamp,
        jHeightForCommit,
        false,
        env,
      );

      // CRITICAL: Verify commit succeeded (Codex: prevent silent divergence)
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

    // CRITICAL: Copy pendingForward for multi-hop routing
    if (clonedMachine.pendingForward) {
      accountMachine.pendingForward = clonedMachine.pendingForward;
      accountLog.debug('pending_forward.copied', {
        route: clonedMachine.pendingForward.route.map(r => shortId(r)),
      });
    }

    // Persist sender frame for hash-chain continuity; shared state is still driven
    // by our own tx re-execution above.
    accountMachine.currentFrame = structuredClone(receivedFrame);
    accountMachine.currentHeight = receivedFrame.height;
    // Store counterparty dispute metadata on COMMIT (verified, frame accepted)
    if (input.newDisputeHanko && !ackProcessed && input.disputeProofNonce !== undefined && input.newDisputeHash) {
      const { verifyHankoForHash } = await import('./hanko/signing');
      const { valid: disputeValid } = await verifyHankoForHash(
        input.newDisputeHanko,
        input.newDisputeHash,
        input.fromEntityId,
        env,
      );
      if (disputeValid) {
        accountMachine.counterpartyDisputeProofHanko = input.newDisputeHanko;
        accountMachine.counterpartyDisputeProofNonce = input.disputeProofNonce;
        accountMachine.counterpartyDisputeHash = input.newDisputeHash;
        if (input.newDisputeProofBodyHash) {
          accountMachine.counterpartyDisputeProofBodyHash = input.newDisputeProofBodyHash;
          if (!accountMachine.disputeProofNoncesByHash) accountMachine.disputeProofNoncesByHash = {};
          accountMachine.disputeProofNoncesByHash[input.newDisputeProofBodyHash] = input.disputeProofNonce;
        }
        accountLog.debug('hanko.dispute_frame_stored', { height: receivedFrame.height, from: shortId(input.fromEntityId) });
      } else {
        console.warn(`⚠️ Dispute hanko verification failed on commit — skipping dispute metadata`);
      }
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
    // Past bilateral frames are not future-consensus state. Keep only a
    // non-enumerable UI/debug view; durable history lives in the frame DB.
    appendAccountFrameHistoryView(accountMachine, committedFrame);
    accountLog.debug('frame.indexed', { source: 'peerCommit', height: receivedFrame.height });

    events.push(...processEvents);
    events.push(`🤝 Accepted frame ${receivedFrame.height} from Entity ${input.fromEntityId.slice(-4)}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // POST-FRAME AUTO-REBALANCE CHECK
    // After frame commit, check if uncollateralized debt exceeds r2cRequestSoftLimit.
    // If yes, auto-queue request_collateral + fee into mempool.
    // User is ALWAYS online here (just processed an inbound frame).
    // ═══════════════════════════════════════════════════════════════════════════
    const postCommitAutoRebalanceTxs = await runPostFrameAutoRebalanceCheck(
      env,
      accountMachine,
      ourEntityId,
      input.fromEntityId,
      receivedFrame.height,
    );
    if (postCommitAutoRebalanceTxs.length > 0) {
      for (const tx of postCommitAutoRebalanceTxs) {
        // Post-commit rebalance is a fresh follow-up account reaction. The
        // received frame is already committed; queuing new account txs into the
        // local mempool here is the correct "next proposal" path, not handler
        // mutation of an in-flight entity frame.
        accountMachine.mempool.push(tx);
      }
      events.push(`🔄 Auto-rebalance queued ${postCommitAutoRebalanceTxs.length} tx(s) after frame commit`);
    }
    kickHubRebalanceAfterFrameFinalize(env, ourEntityId);

    // Send confirmation (ACK) using HANKO
    const ackEntityId = accountMachine.proofHeader.fromEntity;
    const ackReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === ackEntityId);
    const ackSignerId = ackReplica?.state.config.validators[0];
    if (!ackSignerId) {
      return { success: false, error: `Cannot find signerId for ACK from ${ackEntityId.slice(-4)}`, events };
    }

    accountLog.debug('hanko.ack.sign', { entity: shortId(ackEntityId), signer: shortId(ackSignerId), height: receivedFrame.height });

    // Build ACK hanko
    const { signEntityHashes } = await import('./hanko/signing');
    const ackHankos = await signEntityHashes(env, ackEntityId, ackSignerId, [receivedFrame.stateHash]);
    const confirmationHanko = ackHankos[0];
    if (!confirmationHanko) {
      return { success: false, error: 'Failed to build ACK hanko', events };
    }

    // CHANNEL.TS PATTERN (Lines 576-612): Batch ACK + new frame in same message!
    // Check if we should batch BEFORE incrementing nonce
    let batchedWithNewFrame = false;
    let proposeResult: Awaited<ReturnType<typeof proposeAccountFrame>> | undefined;
    // Build dispute proof hanko for ACK response (always include current state's dispute proof)
    const { buildAccountProofBody: buildProof, createDisputeProofHash: createHash } = await import('./proof-builder');
    const ackDepositoryAddress = getDepositoryAddress(env);
    if (!isAddress20(ackDepositoryAddress)) {
      return { success: false, error: 'ACK_DISPUTE_PROOF_BUILD_FAILED: MISSING_DEPOSITORY_ADDRESS', events };
    }
    const ackProofResult = buildProof(accountMachine);
    const ackDisputeHash = createHash(accountMachine, ackProofResult.proofBodyHash, ackDepositoryAddress);
    const ackDisputeHankos = await signEntityHashes(env, ackEntityId, ackSignerId, [ackDisputeHash]);
    const ackDisputeHanko = ackDisputeHankos[0];
    const ackSignedNonce = accountMachine.proofHeader.nonce;
    if (!accountMachine.disputeProofNoncesByHash) {
      accountMachine.disputeProofNoncesByHash = {};
    }
    accountMachine.disputeProofNoncesByHash[ackProofResult.proofBodyHash] = ackSignedNonce;
    if (!accountMachine.disputeProofBodiesByHash) {
      accountMachine.disputeProofBodiesByHash = {};
    }
    accountMachine.disputeProofBodiesByHash[ackProofResult.proofBodyHash] = ackProofResult.proofBodyStruct;

    const response = {
      kind: 'ack',
      fromEntityId: accountMachine.proofHeader.fromEntity,
      toEntityId: input.fromEntityId,
      height: receivedFrame.height,
      prevHanko: confirmationHanko, // Hanko ACK on their frame
      ...(ackDisputeHanko && { newDisputeHanko: ackDisputeHanko }), // My dispute proof hanko (current state)
      newDisputeHash: ackDisputeHash, // Full dispute hash (key in hankoWitness for quorum lookup)
      newDisputeProofBodyHash: ackProofResult.proofBodyHash, // ProofBodyHash that ackDisputeHanko signs
      disputeProofNonce: ackSignedNonce, // nonce at which ACK's dispute proof was signed
    } as AccountInput;
    const outboundAck = {
      height: receivedFrame.height,
      counterpartyEntityId: input.fromEntityId,
      prevHanko: confirmationHanko,
    };

    if (HEAVY_LOGS)
      console.log(
        `🔍 BATCH-CHECK for account ${input.fromEntityId.slice(-4)}: mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.pendingFrame}, mempoolTxs=[${accountMachine.mempool.map(tx => tx.type).join(',')}]`,
      );
    if (accountMachine.mempool.length > 0 && !accountMachine.pendingFrame) {
      // Pass skipNonceIncrement=true since we'll increment for the whole batch below
      proposeResult = await proposeAccountFrame(env, accountMachine, true);

      if (proposeResult.success && proposeResult.accountInput) {
        batchedWithNewFrame = true;
        response.kind = 'frame_ack';
        // Merge ACK and new proposal into same AccountInput
        if (proposeResult.accountInput.newAccountFrame) {
          response.newAccountFrame = proposeResult.accountInput.newAccountFrame;
        }
        if (proposeResult.accountInput.newHanko) {
          response.newHanko = proposeResult.accountInput.newHanko;
        }
        // When ACK and next frame are bundled, the attached dispute proof must
        // describe the bundled proposal state. Sending ACK dispute metadata
        // alongside proposal frame data mixes hashes/nonces and poisons the
        // counterparty's stored dispute proof for the latest agreed state.
        if (proposeResult.accountInput.newDisputeHanko) {
          response.newDisputeHanko = proposeResult.accountInput.newDisputeHanko;
        } else {
          delete response.newDisputeHanko;
        }
        if (proposeResult.accountInput.newDisputeHash) {
          response.newDisputeHash = proposeResult.accountInput.newDisputeHash;
        } else {
          delete response.newDisputeHash;
        }
        if (proposeResult.accountInput.newDisputeProofBodyHash) {
          response.newDisputeProofBodyHash = proposeResult.accountInput.newDisputeProofBodyHash;
        } else {
          delete response.newDisputeProofBodyHash;
        }
        if (proposeResult.accountInput.disputeProofNonce !== undefined) {
          response.disputeProofNonce = proposeResult.accountInput.disputeProofNonce;
        } else {
          delete response.disputeProofNonce;
        }

        const newFrameId = proposeResult.accountInput.newAccountFrame?.height || 0;
        events.push(`📤 Batched ACK + frame ${newFrameId}`);
      }
    }

    if (!batchedWithNewFrame) {
      accountMachine.lastOutboundFrameAck = outboundAck;
      if (ackDisputeHanko) {
        accountMachine.currentDisputeProofHanko = ackDisputeHanko;
        accountMachine.currentDisputeProofNonce = ackSignedNonce;
        accountMachine.currentDisputeProofBodyHash = ackProofResult.proofBodyHash;
        accountMachine.currentDisputeHash = ackDisputeHash;
      }
    } else if (batchedWithNewFrame) {
      delete accountMachine.lastOutboundFrameAck;
    }

    // Increment nonce for this message (on-chain nonce for dispute proofs / settlements)
    ++accountMachine.proofHeader.nonce;

    // Merge revealed secrets from BOTH incoming frame AND proposed frame
    const allRevealedSecrets = [
      ...revealedSecrets, // From incoming frame (line 493)
      ...(proposeResult?.revealedSecrets || []), // From our proposed frame (if batched)
    ];

    // Merge swap offers from BOTH incoming frame AND proposed frame
    const allSwapOffersCreated = [...swapOffersCreated, ...(proposeResult?.swapOffersCreated || [])];
    const allSwapCancelRequests = [...swapCancelRequests, ...(proposeResult?.swapCancelRequests || [])];
    const allSwapOffersCancelled = [...swapOffersCancelled, ...(proposeResult?.swapOffersCancelled || [])];

    // Collect hashes that need entity-quorum signing (multi-signer support)
    const hashesToSign: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }> = [
      {
        hash: receivedFrame.stateHash,
        type: 'accountFrame',
        context: `account:${input.fromEntityId.slice(-8)}:ack:${receivedFrame.height}`,
      },
      ...(!batchedWithNewFrame
        ? [{ hash: ackDisputeHash, type: 'dispute' as const, context: `account:${input.fromEntityId.slice(-8)}:ack-dispute` }]
        : []),
      ...(proposeResult?.hashesToSign || []), // From batched proposal
    ];

    if (HEAVY_LOGS)
      console.log(
        `🔍 RETURN-RESPONSE: h=${response.height} prevHanko=${!!response.prevHanko} newFrame=${!!response.newAccountFrame}`,
      );
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

  // ACK inputs must never be silently ignored; this causes replay divergence.
  if (input.prevHanko && !ackProcessed && !input.newAccountFrame) {
    const pending = accountMachine.pendingFrame?.height ?? 'none';
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
      error: `Unmatched ACK: height=${String(normalizedInputHeight ?? 'none')} pending=${String(pending)}`,
      events,
    };
  }

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

// === PROOF GENERATION (for future J-Machine integration) ===

/**
 * Generate account proof for dispute resolution (like old_src Channel.getSubchannelProofs)
 * Must be ABI-compatible with Depository contract
 *
 * DUAL-TRACK APPROACH:
 * - proofBody: Simple internal representation (tokenIds + deltas)
 * - abiProofBody: ABI-encoded for on-chain disputes (includes transformers)
 */
export async function generateAccountProof(
  env: Env,
  accountMachine: AccountMachine,
): Promise<{
  proofHash: string;
  signature: string;
  abiEncodedProofBody?: string;
  abiProofBodyHash?: string;
}> {
  // Update simple proofBody with current state (like old_src does before signing)
  accountMachine.proofBody = {
    tokenIds: Array.from(accountMachine.deltas.keys()).sort((a, b) => a - b), // Deterministic order
    deltas: Array.from(accountMachine.deltas.keys())
      .sort((a, b) => a - b)
      .map(tokenId => {
        const delta = accountMachine.deltas.get(tokenId);
        if (!delta) {
          console.warn(`Missing delta for token ${tokenId}`);
          throw new Error(`Critical financial data missing: delta for token ${tokenId}`);
        }
        return delta.ondelta + delta.offdelta; // Total delta for each token
      }),
  };

  // Build ABI-encoded proofBody for on-chain disputes
  const { buildAccountProofBody } = await import('./proof-builder.js');
  const abiResult = buildAccountProofBody(accountMachine);

  // Store ABI-encoded proofBody for later dispute submission
  accountMachine.abiProofBody = {
    encodedProofBody: abiResult.encodedProofBody,
    proofBodyHash: abiResult.proofBodyHash,
    lastUpdatedHeight: accountMachine.currentHeight,
  };

  // Create proof structure expected by Depository.sol.
  const proofData = {
    fromEntity: accountMachine.proofHeader.fromEntity,
    toEntity: accountMachine.proofHeader.toEntity,
    nonce: accountMachine.proofHeader.nonce,
    tokenIds: accountMachine.proofBody.tokenIds,
    deltas: accountMachine.proofBody.deltas.map(d => d.toString()), // Convert BigInt for JSON
  };

  // Create deterministic proof hash using browser-compatible crypto
  const proofContent = safeStringify(proofData);
  const fullHash = await hash(proofContent);
  const proofHash = fullHash.slice(2); // Remove 0x prefix for compatibility

  // Generate hanko signature - CRITICAL: Use signerId, not entityId
  const proofEntityId = accountMachine.proofHeader.fromEntity;
  const proofReplica = Array.from(env.eReplicas.values()).find(
    (r: EntityReplica) => r.state.entityId === proofEntityId,
  );
  const proofSignerId = proofReplica?.state.config.validators[0];
  if (!proofSignerId) {
    throw new Error(`Cannot find signerId for proof from ${proofEntityId.slice(-4)}`);
  }
  const signature = signAccountFrame(env, proofSignerId, `0x${proofHash}`);

  accountMachine.hankoSignature = signature;
  accountLog.debug('proof.generated', {
    entity: shortId(proofEntityId),
    signer: shortId(proofSignerId),
    tokens: accountMachine.proofBody.tokenIds.length,
    proof: shortHash(`0x${proofHash}`),
    abiProof: shortHash(abiResult.proofBodyHash),
  });

  return {
    proofHash: `0x${proofHash}`,
    signature,
    abiEncodedProofBody: abiResult.encodedProofBody,
    abiProofBodyHash: abiResult.proofBodyHash,
  };
}
