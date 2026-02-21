import type { EntityState, Delta, JBlockObservation, JBlockFinalized, JurisdictionEvent, Env } from '../types';
import { ethers } from 'ethers';
import { DEBUG } from '../utils';
import { cloneEntityState, addMessage, canonicalAccountKey } from '../state-helpers';
import { getTokenInfo } from '../account-utils';
import { safeStringify } from '../serialization-utils';
import { CANONICAL_J_EVENTS } from '../jadapter/helpers';
import { hashHtlcSecret } from '../htlc-utils';
import type { JAdapter } from '../jadapter/types';
import {
  canonicalJurisdictionEventKey,
  normalizeJurisdictionEvent,
  normalizeJurisdictionEvents,
} from '../j-event-normalization';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * J-EVENT HANDLERS (Single Source of Truth - must match jadapter/helpers.ts)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Canonical J-Events (update entity state):
 * - ReserveUpdated  → entity.reserves[tokenId] = newBalance
 * - AccountSettled  → entity.accounts[counterparty].deltas[tokenId] = { collateral, ondelta }
 *
 * Future J-Events (when added to Solidity):
 * - DebtCreated, DebtEnforced
 *
 * Design: One event = One state change. No redundant handlers.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Jurisdiction event transaction data structure
 * These events come from blockchain watchers observing on-chain activity
 */
export interface JEventEntityTxData {
  from: string;  // Signer ID that observed the event
  event: {
    type: string;  // Event name (e.g., "ReserveUpdated", "AccountSettled")
    data: Record<string, unknown>;  // Event-specific data from blockchain
  };
  events?: Array<{
    type: string;  // Event name (e.g., "ReserveUpdated", "AccountSettled")
    data: Record<string, unknown>;
  }>;
  observedAt: number;  // Timestamp when event was observed (ms)
  blockNumber: number;  // Blockchain block number where event occurred
  blockHash: string;    // Block hash for JBlock consensus
  transactionHash: string;  // Blockchain transaction hash
}

const getTokenSymbol = (tokenId: number): string => {
  return getTokenInfo(tokenId).symbol;
};

const getTokenDecimals = (tokenId: number): number => {
  return getTokenInfo(tokenId).decimals;
};

function getEnvJAdapter(env: Env): JAdapter | null {
  if (!env.jReplicas || env.jReplicas.size === 0) return null;
  const active = env.activeJurisdiction ? env.jReplicas.get(env.activeJurisdiction) : undefined;
  if (active?.jadapter) return active.jadapter;
  for (const jr of env.jReplicas.values()) {
    if (jr.jadapter) return jr.jadapter;
  }
  return null;
}

function decodeDisputeInitialSecrets(initialArgumentsRaw: unknown): string[] {
  const initialArguments = String(initialArgumentsRaw || '0x');
  if (initialArguments === '0x') return [];

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  let argArray: string[];
  try {
    [argArray] = abiCoder.decode(['bytes[]'], initialArguments) as [string[]];
  } catch {
    return [];
  }

  const secrets = new Set<string>();
  for (const arg of argArray) {
    if (!arg || arg === '0x') continue;
    try {
      const [, decodedSecrets] = abiCoder.decode(['uint32[]', 'bytes32[]'], arg) as [Array<bigint>, Array<string>];
      for (const secret of decodedSecrets) {
        if (ethers.isHexString(secret, 32)) {
          secrets.add(String(secret).toLowerCase());
        }
      }
    } catch {
      // Ignore non-HTLC transformer argument formats.
    }
  }

  return Array.from(secrets);
}

function queueInboundResolvesByHashlock(
  newState: EntityState,
  mempoolOps: Array<{ accountId: string; tx: any }>,
  hashlock: string,
  secret: string,
): number {
  let queued = 0;
  for (const [counterpartyId, account] of newState.accounts.entries()) {
    const weAreLeft = account.leftEntity === newState.entityId;
    for (const lock of account.locks.values()) {
      if (String(lock.hashlock).toLowerCase() !== hashlock) continue;
      const senderIsUs = (lock.senderIsLeft && weAreLeft) || (!lock.senderIsLeft && !weAreLeft);
      if (senderIsUs) continue;
      mempoolOps.push({
        accountId: counterpartyId,
        tx: {
          type: 'htlc_resolve',
          data: {
            lockId: lock.lockId,
            outcome: 'secret' as const,
            secret,
          },
        },
      });
      queued++;
    }
  }
  return queued;
}

function applyKnownHtlcSecret(
  newState: EntityState,
  mempoolOps: Array<{ accountId: string; tx: any }>,
  hashlockRaw: string,
  secretRaw: string,
  blockNumber: number,
  source: 'SecretRevealed' | 'DisputeStarted',
): boolean {
  const hashlock = String(hashlockRaw).toLowerCase();
  const secret = String(secretRaw).toLowerCase();

  let routeKey = hashlock;
  let route = newState.htlcRoutes.get(routeKey);
  if (!route) {
    for (const [candidateKey, candidateRoute] of newState.htlcRoutes.entries()) {
      if (candidateKey.toLowerCase() === hashlock) {
        routeKey = candidateKey;
        route = candidateRoute;
        break;
      }
    }
  }

  if (!route) {
    const recovered = queueInboundResolvesByHashlock(newState, mempoolOps, hashlock, secret);
    if (recovered > 0) {
      console.log(`⬅️ HTLC: ${source} secret propagated via lock-scan (${recovered} lock${recovered > 1 ? 's' : ''})`);
      addMessage(newState, `🔓 HTLC reveal observed: ${hashlock.slice(0, 10)}... | Block ${blockNumber}`);
      return true;
    }
    console.log(`⚠️ HTLC: ${source} secret for unknown hashlock ${hashlock.slice(0, 16)}...`);
    return false;
  }

  if (route.secret) {
    console.log(`✅ HTLC: Secret already stored for hashlock ${routeKey.slice(0, 16)}...`);
    addMessage(newState, `🔓 HTLC reveal observed: ${hashlock.slice(0, 10)}... | Block ${blockNumber}`);
    return true;
  }

  route.secret = secret;

  if (route.pendingFee) {
    newState.htlcFeesEarned = (newState.htlcFeesEarned || 0n) + route.pendingFee;
    console.log(`💰 HTLC: Fee earned on ${source}: ${route.pendingFee} (total: ${newState.htlcFeesEarned})`);
    delete route.pendingFee;
  }

  if (route.outboundLockId) {
    newState.lockBook.delete(route.outboundLockId);
  }
  if (route.inboundLockId) {
    newState.lockBook.delete(route.inboundLockId);
  }

  if (route.inboundEntity && route.inboundLockId) {
    mempoolOps.push({
      accountId: route.inboundEntity,
      tx: {
        type: 'htlc_resolve',
        data: {
          lockId: route.inboundLockId,
          outcome: 'secret' as const,
          secret,
        },
      },
    });
    console.log(`⬅️ HTLC: ${source} secret propagated to ${route.inboundEntity.slice(-4)}`);
  } else {
    console.log(`✅ HTLC: ${source} reveal complete (no inbound hop)`);
  }

  addMessage(newState, `🔓 HTLC reveal observed: ${hashlock.slice(0, 10)}... | Block ${blockNumber}`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// J-EVENT HANDLER: Entry point for jurisdiction (blockchain) events
// ═══════════════════════════════════════════════════════════════════════════════
//
// When a signer observes a blockchain event (via JAdapter.startWatching), it submits
// a j_event EntityTx. This handler:
//
// 1. Creates a JBlockObservation from the incoming event
// 2. Adds it to the entity's pending observations
// 3. Attempts to finalize j-blocks (if threshold met)
// 4. Returns updated state
//
// The actual event application happens in applyFinalizedJEvent() ONLY after
// consensus is reached. This prevents a single signer from injecting fake events.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle incoming j-event from a signer.
 *
 * Converts the event to an observation and attempts j-block finalization.
 * Events are only applied to state after threshold agreement.
 *
 * @param entityState - Current entity state
 * @param entityTxData - J-event data from the observing signer
 * @param env - Runtime environment
 * @returns Updated state (may include finalized events if threshold met)
 */
export const handleJEvent = async (entityState: EntityState, entityTxData: JEventEntityTxData, env: Env): Promise<{ newState: EntityState; mempoolOps: Array<{ accountId: string; tx: any }> }> => {
  const { from: signerId, observedAt, blockNumber, blockHash } = entityTxData;
  // j-watcher now sends batched events - use 'events' array, fallback to single 'event'
  const rawEvents = (entityTxData as any).events || [entityTxData.event];

  const entityShort = entityState.entityId.slice(-4);
  console.log(`🏛️ [2/3] E-MACHINE: ${entityShort} ← ${rawEvents.length} events (block ${blockNumber})`);

  // ─────────────────────────────────────────────────────────────────────────────
  // Skip already-finalized blocks
  // ─────────────────────────────────────────────────────────────────────────────
  // Check if this block height was already finalized (prevents re-applying events)
  const alreadyFinalized = entityState.jBlockChain.some(b => b.jHeight === blockNumber);
  if (alreadyFinalized) {
    console.log(`   ⏭️ SKIP: block ${blockNumber} already finalized`);
    return { newState: entityState, mempoolOps: [] };
  }

  // Skip blocks at or below lastFinalizedJHeight (monotonic progress only)
  // Note: The == case is already caught by alreadyFinalized check above,
  // but we use <= here for explicit monotonic enforcement
  // TODO: For multi-signer production, add appliedJBlockHashes: Set<string>
  // to track exact block hashes and reject conflicting observations
  if (blockNumber <= entityState.lastFinalizedJHeight) {
    console.log(`   ⏭️ SKIP: stale block (${blockNumber} <= finalized ${entityState.lastFinalizedJHeight})`);
    return { newState: entityState, mempoolOps: [] };
  }

  // Convert raw events to canonical JurisdictionEvent format
  const jEvents: JurisdictionEvent[] = [];
  for (const raw of rawEvents) {
    const normalized = normalizeJurisdictionEvent({
      ...(raw || {}),
      blockNumber,
      blockHash,
      transactionHash: (raw as any)?.transactionHash ?? entityTxData.transactionHash,
    });
    if (!normalized) {
      console.warn(`⚠️ Dropping malformed j-event payload at block ${blockNumber}: ${safeStringify(raw)}`);
      continue;
    }
    jEvents.push(normalized);
  }
  if (jEvents.length === 0) {
    console.warn(`⚠️ No valid j-events after normalization for block ${blockNumber}; skipping observation`);
    return { newState: entityState, mempoolOps: [] };
  }

  // Clone state and create observation with ALL events from this batch
  let newEntityState = cloneEntityState(entityState);

  const observation: JBlockObservation = {
    signerId,
    jHeight: blockNumber,
    jBlockHash: blockHash,
    events: jEvents,
    observedAt,
  };

  newEntityState.jBlockObservations.push(observation);
  console.log(`   📝 Observation from ${signerId}: ${jEvents.length} events for block ${blockNumber}`);

  // Try to finalize - with batching, single-signer entities finalize immediately
  // with ALL events from the block (no more race condition)
  const { newState, mempoolOps } = await tryFinalizeJBlocks(newEntityState, entityState.config.threshold, env);
  newEntityState = newState;

  // DEBUG: Dump account mempools after j-event processing
  for (const [cpId, account] of newEntityState.accounts) {
    if (account.mempool.length > 0 || account.leftJObservations.length > 0 || account.rightJObservations.length > 0) {
      console.log(`🔍 AFTER-J-EVENT: Account ${cpId.slice(-4)} mempool=${account.mempool.length} txs:`, account.mempool.map((tx: any) => tx.type));
      console.log(`🔍 AFTER-J-EVENT: leftJObs=${account.leftJObservations?.length || 0}, rightJObs=${account.rightJObservations?.length || 0}`);
    }
  }

  if (mempoolOps.length > 0) {
    console.log(`   📦 handleJEvent: Returning ${mempoolOps.length} mempoolOps for bilateral consensus`);
  }

  // Return both newState and mempoolOps
  return { newState: newEntityState, mempoolOps };
};

// ═══════════════════════════════════════════════════════════════════════════════
// BILATERAL J-EVENT CONSENSUS: 2-of-2 agreement on AccountSettled events
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Finalize AccountSettled when BOTH entities agree (2-of-2).
 * Called after receiving j_event_claim from counterparty.
 */
export function tryFinalizeAccountJEvents(account: any, counterpartyId: string, opts: { timestamp: number }): void {
  const normalizeObsEvents = (obs: any): JurisdictionEvent[] => {
    const raw = obs?.events;
    if (!Array.isArray(raw)) return [];
    return normalizeJurisdictionEvents(raw);
  };

  const sameEventMultiset = (a: JurisdictionEvent[], b: JurisdictionEvent[]): boolean => {
    if (a.length !== b.length) return false;
    const counts = new Map<string, number>();
    for (const event of a) {
      const key = canonicalJurisdictionEventKey(event);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const event of b) {
      const key = canonicalJurisdictionEventKey(event);
      const current = counts.get(key) || 0;
      if (current <= 0) return false;
      counts.set(key, current - 1);
    }
    for (const [, remaining] of counts) {
      if (remaining !== 0) return false;
    }
    return true;
  };

  // Find matching (jHeight, jBlockHash) in left + right observations
  const leftMap = new Map();
  const rightMap = new Map();

  for (const obs of account.leftJObservations) {
    leftMap.set(`${obs.jHeight}:${obs.jBlockHash}`, obs);
  }
  for (const obs of account.rightJObservations) {
    rightMap.set(`${obs.jHeight}:${obs.jBlockHash}`, obs);
  }

  const matches = Array.from(leftMap.keys()).filter(k => rightMap.has(k));

  if (matches.length === 0) {
    console.log(`   🔍 BILATERAL: left=${account.leftJObservations.length}, right=${account.rightJObservations.length}, matches=0`);
    return;
  }

  console.log(`   🤝 BILATERAL-MATCH: ${matches.length} j-blocks agreed!`);
  const finalizedKeys = new Set<string>();

  for (const key of matches) {
    const leftObs = leftMap.get(key)!;
    const rightObs = rightMap.get(key)!;
    const jHeight = leftObs.jHeight;

    // Skip already finalized
    if (account.lastFinalizedJHeight >= jHeight) continue;
    if (account.jEventChain.some((b: any) => b.jHeight === jHeight)) continue;

    // Require both sides to agree on canonical settlement payload.
    const leftRawLen = Array.isArray(leftObs?.events) ? leftObs.events.length : 0;
    const rightRawLen = Array.isArray(rightObs?.events) ? rightObs.events.length : 0;
    const leftEvents = normalizeObsEvents(leftObs);
    const rightEvents = normalizeObsEvents(rightObs);
    if (leftEvents.length === 0 || rightEvents.length === 0) {
      console.warn(
        `   ⚠️ BILATERAL-MISMATCH: empty/non-array events at jHeight=${jHeight} hash=${leftObs.jBlockHash.slice(0, 10)}...`,
      );
      continue;
    }
    if (leftEvents.length !== leftRawLen || rightEvents.length !== rightRawLen) {
      console.warn(
        `   ⚠️ BILATERAL-MISMATCH: malformed events dropped jHeight=${jHeight} hash=${leftObs.jBlockHash.slice(0, 10)}... ` +
          `leftRawLen=${leftRawLen} leftNormLen=${leftEvents.length} rightRawLen=${rightRawLen} rightNormLen=${rightEvents.length}`,
      );
      continue;
    }

    if (!sameEventMultiset(leftEvents, rightEvents)) {
      const leftKeys = leftEvents.map(canonicalJurisdictionEventKey);
      const rightKeys = rightEvents.map(canonicalJurisdictionEventKey);
      console.warn(
        `   ⚠️ BILATERAL-MISMATCH: jHeight=${jHeight} hash=${leftObs.jBlockHash.slice(0, 10)}... ` +
        `leftKeys=${JSON.stringify(leftKeys)} rightKeys=${JSON.stringify(rightKeys)} ` +
        `leftRaw=${safeStringify(leftObs.events)} rightRaw=${safeStringify(rightObs.events)}`,
      );
      continue;
    }

    console.log(`   ✅ BILATERAL-FINALIZE: jHeight=${jHeight}`);

    // Apply events (from left observation - both should be identical)
    for (const event of leftEvents) {
      if (event.type === 'AccountSettled') {
        const { tokenId, collateral, ondelta } = event.data;
        const tokenIdNum = Number(tokenId);

        let delta = account.deltas.get(tokenIdNum);
        if (!delta) {
          const defaultCreditLimit = getDefaultCreditLimit(tokenIdNum);
          delta = {
            tokenId: tokenIdNum,
            collateral: 0n,
            ondelta: 0n,
            offdelta: 0n,
            leftCreditLimit: defaultCreditLimit,
            rightCreditLimit: defaultCreditLimit,
            leftAllowance: 0n,
            rightAllowance: 0n,
          };
          account.deltas.set(tokenIdNum, delta);
        }

        const oldColl = delta.collateral;
        delta.collateral = BigInt(collateral);
        delta.ondelta = BigInt(ondelta);

        // requestedRebalance lifecycle:
        // Clear/reduce only after bilateral on-chain collateral update is finalized.
        // Fee is prepaid in request_collateral (never charged here).
        const pendingRequest = account.requestedRebalance?.get(tokenIdNum) ?? 0n;
        if (pendingRequest > 0n) {
          const collateralIncrease = delta.collateral > oldColl ? delta.collateral - oldColl : 0n;
          if (collateralIncrease > 0n) {
            const fulfilledAmount = pendingRequest > collateralIncrease ? collateralIncrease : pendingRequest;
            const remaining = pendingRequest - fulfilledAmount;
            if (remaining > 0n) {
              account.requestedRebalance.set(tokenIdNum, remaining);
              const feeState = account.requestedRebalanceFeeState?.get(tokenIdNum);
              if (feeState) {
                feeState.jBatchSubmittedAt = 0;
              }
              // Keep fee metadata for audit/scheduling; fee is already prepaid.
              console.log(
                `   🔄 REBALANCE-REQUEST-PARTIAL: token=${tokenIdNum} request ${pendingRequest}→${remaining} ` +
                `(credited=${fulfilledAmount})`,
              );
            } else {
              account.requestedRebalance.delete(tokenIdNum);
              account.requestedRebalanceFeeState?.delete(tokenIdNum);
              console.log(
                `   ✅ REBALANCE-REQUEST-CLEARED: token=${tokenIdNum} request ${pendingRequest} fulfilled ` +
                `(credited=${fulfilledAmount})`,
              );
            }
          }
        }

        // NOTE: Do NOT increment nonce here!
        // R2C also emits AccountSettled but doesn't increment on-chain nonce.
        // Nonce is incremented in tryFinalizeAccountJEvents when workspace status is 'ready_to_submit'.
        console.log(`   💰 BILATERAL-APPLIED for ${counterpartyId.slice(-4)}: coll ${oldColl}→${delta.collateral}, ondelta=${delta.ondelta}`);
        console.log(
          `[REB][5][FINALIZED_IN_ACCOUNT] cp=${counterpartyId.slice(-8)} token=${tokenIdNum} collateral=${delta.collateral} ondelta=${delta.ondelta} jHeight=${jHeight}`,
        );
      }
    }

    // Add to jEventChain (replay prevention) - DETERMINISTIC timestamp
    account.jEventChain.push({ jHeight, jBlockHash: leftObs.jBlockHash, events: leftEvents, finalizedAt: opts.timestamp });
    account.lastFinalizedJHeight = Math.max(account.lastFinalizedJHeight, jHeight);
    finalizedKeys.add(key);

    // SYMMETRIC NONCE TRACKING: Both sides increment when workspace has signed hankos.
    // Covers all settlement types: C2R (counterparty hanko only), full settle (both hankos).
    // R2C events don't create workspaces, so this check safely skips them.
    const ws = account.settlementWorkspace;
    if (ws && (ws.leftHanko || ws.rightHanko)) {
      // Activate post-settlement dispute proof (nonce+1) before clearing workspace
      const postProof = ws.postSettlementDisputeProof;
      if (postProof?.leftHanko && postProof?.rightHanko) {
        // Side-safe: store MY hanko vs THEIR hanko based on which side I am
        const iAmLeftHere = account.leftEntity !== counterpartyId;
        account.currentDisputeProofHanko = iAmLeftHere ? postProof.leftHanko : postProof.rightHanko;
        account.counterpartyDisputeProofHanko = iAmLeftHere ? postProof.rightHanko : postProof.leftHanko;
        account.currentDisputeProofNonce = postProof.nonce;
        account.currentDisputeProofBodyHash = postProof.proofBodyHash;
        account.counterpartyDisputeProofNonce = postProof.nonce;
        account.counterpartyDisputeProofBodyHash = postProof.proofBodyHash;
        console.log(`   🔐 Post-settlement dispute proof activated (nonce=${postProof.nonce})`);
      }

      // Set on-chain nonce from event data (not +1 — handles nonce jumps from disputes)
      const firstSettled = leftEvents.find(e => e.type === 'AccountSettled');
      const eventNonce = firstSettled?.data?.nonce;
      if (typeof eventNonce === 'number') {
        account.onChainSettlementNonce = eventNonce;
      } else {
        // Fallback: use workspace's signed nonce (should match on-chain after settlement)
        account.onChainSettlementNonce = ws.nonceAtSign ?? ((account.onChainSettlementNonce || 0) + 1);
      }
      console.log(`   💰 NONCE-SET: Settlement finalized → onChainNonce=${account.onChainSettlementNonce} (ws.status was '${ws.status}', eventNonce=${eventNonce})`);
      // Clear workspace after nonce increment — both sides (Hub + counterparty)
      delete account.settlementWorkspace;
      console.log(`   🧹 WORKSPACE-CLEAR: Settlement completed`);
    }
  }

  // Prune finalized
  account.leftJObservations = account.leftJObservations.filter(
    (o: any) => !finalizedKeys.has(`${o.jHeight}:${o.jBlockHash}`),
  );
  account.rightJObservations = account.rightJObservations.filter(
    (o: any) => !finalizedKeys.has(`${o.jHeight}:${o.jBlockHash}`),
  );
  console.log(
    `   🧹 Pruned ${finalizedKeys.size} finalized (left=${account.leftJObservations.length}, right=${account.rightJObservations.length} pending)`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// J-BLOCK CONSENSUS: Multi-signer agreement on jurisdiction (blockchain) state
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY: Each entity has multiple signers (board members). When the J-machine
// (blockchain) emits events, each signer independently observes them. We need
// threshold agreement before applying events to entity state - this prevents
// a single compromised signer from injecting fake blockchain events.
//
// HOW IT WORKS:
// 1. Each signer watches the blockchain and submits observations of j-blocks
// 2. Observations are grouped by (blockHeight, blockHash) tuple
// 3. When enough signers agree on the same tuple → block is "finalized"
// 4. Finalized events are applied to entity state
// 5. Old observations are pruned
//
// EXAMPLE: Entity with 3 signers, threshold=2
// - Signer A sees block 100 with hash 0xabc... → adds observation
// - Signer B sees block 100 with hash 0xabc... → adds observation
// - Now 2 signers agree → block 100 finalized, events applied
// - Signer C's late observation is ignored (already finalized)
//
// SINGLE-SIGNER FAST PATH: For entities with threshold=1, blocks finalize
// immediately when the single signer submits an observation.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Merge observations with same (jHeight, jBlockHash) into a single observation.
 * This batches multiple AccountSettled events from the same settlement tx so
 * tryFinalizeAccountJEvents can process all token updates atomically.
 */
function mergeAccountJObservations(observations: Array<{ jHeight: number; jBlockHash: string; events: JurisdictionEvent[] }>): void {
  if (observations.length <= 1) return;
  const groups = new Map<string, number>(); // key → index in observations[]
  let i = 0;
  while (i < observations.length) {
    const obs = observations[i];
    const key = `${obs.jHeight}:${obs.jBlockHash}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      // Merge events into existing observation (dedup by type+data)
      const target = observations[existing];
      const normalizedEvents = normalizeJurisdictionEvents(obs.events);
      for (const ev of normalizedEvents) {
        const evKey = canonicalJurisdictionEventKey(ev);
        const alreadyHas = target.events.some((e: JurisdictionEvent) => canonicalJurisdictionEventKey(e) === evKey);
        if (!alreadyHas) target.events.push(ev);
      }
      observations.splice(i, 1); // Remove merged obs
    } else {
      groups.set(key, i);
      i++;
    }
  }
}

/**
 * Merge j_event_claim mempoolOps targeting the same (accountId, jHeight, jBlockHash)
 * into a single op with all events batched.
 */
function mergeJEventClaimOps(ops: Array<{ accountId: string; tx: any }>): void {
  const groups = new Map<string, number>(); // key → index in ops[]
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.tx.type !== 'j_event_claim') { i++; continue; }
    const key = `${op.accountId}:${op.tx.data.jHeight}:${op.tx.data.jBlockHash}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      // Merge events into existing op
      const target = ops[existing];
      const normalizedEvents = normalizeJurisdictionEvents(op.tx.data.events);
      for (const ev of normalizedEvents) {
        target.tx.data.events.push(ev);
      }
      ops.splice(i, 1);
    } else {
      groups.set(key, i);
      i++;
    }
  }
}

/**
 * Check for j-block finalization and apply finalized events.
 *
 * Groups pending observations by (height, hash), checks threshold,
 * and applies events from blocks that reach consensus.
 *
 * @param state - Entity state with pending jBlockObservations
 * @param threshold - Required number of agreeing signers (from entity config)
 * @param env - Runtime environment for deterministic timestamps
 * @returns Updated state with finalized events applied
 */
async function tryFinalizeJBlocks(
  state: EntityState,
  threshold: bigint,
  env: Env
): Promise<{ newState: EntityState; mempoolOps: Array<{ accountId: string; tx: any }> }> {
  const allMempoolOps: Array<{ accountId: string; tx: any }> = [];

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 1: Group observations by (height, hash)
  // ─────────────────────────────────────────────────────────────────────────────
  // Multiple signers may observe the same block - group them together.
  // Key format: "height:hash" e.g. "100:0xabc123..."
  const observationGroups = new Map<string, JBlockObservation[]>();

  for (const obs of state.jBlockObservations) {
    const key = `${obs.jHeight}:${obs.jBlockHash}`;
    if (!observationGroups.has(key)) {
      observationGroups.set(key, []);
    }
    observationGroups.get(key)!.push(obs);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 2: Check each group for threshold agreement
  // ─────────────────────────────────────────────────────────────────────────────
  const finalizedHeights: number[] = [];
  console.log(`   📊 OBSERVATION-GROUPS: ${observationGroups.size} groups, keys=[${Array.from(observationGroups.keys()).join(', ')}]`);

  for (const [_key, observations] of observationGroups) {
    // Count UNIQUE signers (ignore duplicate submissions from same signer)
    const uniqueSigners = new Set(observations.map(o => o.signerId));
    const signerCount = uniqueSigners.size;

    // Does this group meet the threshold?
    if (BigInt(signerCount) >= threshold) {
      const jHeight = observations[0]!.jHeight;
      const jBlockHash = observations[0]!.jBlockHash;

      // ─────────────────────────────────────────────────────────────────────────
      // IDEMPOTENCY CHECK: Skip if this block height was already finalized
      // ─────────────────────────────────────────────────────────────────────────
      // This can happen if:
      // 1. Multiple observation groups exist for same height (different hashes)
      // 2. A previous iteration of this loop already finalized this height
      // 3. Block was finalized in a previous call (caught at handleJEvent entry)
      console.log(`   🔍 CHECK-FINALIZE: jHeight=${jHeight}, jBlockChain.length=${state.jBlockChain.length}, heights=[${state.jBlockChain.map(b => b.jHeight).join(',')}]`);
      const alreadyInChain = state.jBlockChain.some(b => b.jHeight === jHeight);
      if (alreadyInChain) {
        console.log(`   ⏭️ SKIP-FINALIZE: block ${jHeight} already in jBlockChain`);
        continue;
      }

      console.log(`   ✅ J-BLOCK FINALIZED: height=${jHeight} (${signerCount}/${threshold} signers)`);

      // ─────────────────────────────────────────────────────────────────────────
      // Step 3: Merge events from all observations
      // ─────────────────────────────────────────────────────────────────────────
      const events = mergeSignerObservations(observations);

      // ─────────────────────────────────────────────────────────────────────────
      // Step 4: Create finalized block record - DETERMINISTIC timestamp
      // ─────────────────────────────────────────────────────────────────────────
      const finalized: JBlockFinalized = {
        jHeight,
        jBlockHash,
        events,
        finalizedAt: state.timestamp, // Entity-level timestamp for determinism across validators
        signerCount,
      };

      // CRITICAL: Add to jBlockChain BEFORE applying events
      // This prevents duplicate finalization in subsequent loop iterations
      state.jBlockChain.push(finalized);
      state.lastFinalizedJHeight = jHeight;
      finalizedHeights.push(jHeight);
      console.log(`   ✅ Added block ${jHeight} to jBlockChain (length: ${state.jBlockChain.length})`);
      console.log(`   🧭 J-HEIGHT: entity=${state.entityId} lastFinalizedJHeight=${state.lastFinalizedJHeight}`);

      // ─────────────────────────────────────────────────────────────────────────
      // Step 5: Apply all events from this finalized block
      // ─────────────────────────────────────────────────────────────────────────
      console.log(`   📦 Applying ${events.length} events from block ${jHeight}`);
      console.log(`      Event types:`, events.map(e => e.type));
      for (const event of events) {
        console.log(`      🔧 Applying event: ${event.type}`);
        const { newState, mempoolOps } = await applyFinalizedJEvent(state, event, env);
        state = newState;
        allMempoolOps.push(...mempoolOps);
        // applyFinalizedJEvent clones state - ensure jBlockChain preserved
        if (!state.jBlockChain.some(b => b.jHeight === jHeight)) {
          console.log(`   ⚠️  CLONE LOST jBlockChain - restoring block ${jHeight}`);
          state.jBlockChain.push(finalized);
          state.lastFinalizedJHeight = jHeight;
        }
      }

      console.log(`   📦 Applied ${events.length} events from j-block ${jHeight}`);

      // ─────────────────────────────────────────────────────────────────────────
      // Step 5b: Merge AccountSettled observations + j_event_claims per account
      // ─────────────────────────────────────────────────────────────────────────
      // Multiple AccountSettled events from the same batch create separate observations
      // and j_event_claims per token. Merge them so tryFinalizeAccountJEvents processes
      // all token updates atomically in one bilateral consensus round.
      for (const [_cpId, account] of state.accounts) {
        mergeAccountJObservations(account.leftJObservations);
        mergeAccountJObservations(account.rightJObservations);
      }
      mergeJEventClaimOps(allMempoolOps);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 6: Prune ONLY finalized heights
  // ─────────────────────────────────────────────────────────────────────────────
  // Only remove observations for heights that were actually finalized.
  // Keep observations for unfinalized heights (even if lower than highest finalized)
  // to allow out-of-order finalization and detect conflicts.
  if (finalizedHeights.length > 0) {
    const finalizedSet = new Set(finalizedHeights);
    state.jBlockObservations = state.jBlockObservations.filter(
      obs => !finalizedSet.has(obs.jHeight)
    );
    console.log(`   🧹 Pruned finalized heights [${finalizedHeights.join(',')}] (${state.jBlockObservations.length} pending)`);
  }

  return { newState: state, mempoolOps: allMempoolOps };
}

/**
 * Merge events from multiple signers' observations of the same j-block.
 *
 * In a healthy network, all signers observe identical events for a given block.
 * This function handles edge cases like:
 * - Duplicate submissions from the same signer
 * - Minor ordering differences between signers
 *
 * @param observations - All observations for a specific (height, hash) tuple
 * @returns Deduplicated list of events from that block
 */
function mergeSignerObservations(observations: JBlockObservation[]): JurisdictionEvent[] {
  // Dedup by (eventType + eventData) - all signers should see same events
  const eventMap = new Map<string, JurisdictionEvent>();

  for (const obs of observations) {
    const normalized = normalizeJurisdictionEvents(obs.events);
    for (const event of normalized) {
      // Create unique key from event type and data
      const key = canonicalJurisdictionEventKey(event);
      if (!eventMap.has(key)) {
        eventMap.set(key, event);
      }
    }
  }

  return Array.from(eventMap.values());
}

// ═══════════════════════════════════════════════════════════════════════════════
// J-EVENT APPLICATION: Apply finalized blockchain events to entity state
// ═══════════════════════════════════════════════════════════════════════════════
//
// This is called ONLY after j-block consensus is reached. At this point we trust
// the event is legitimate (threshold signers agreed on it).
//
// Each event type maps to a specific state change:
// - ReserveUpdated  → entity.reserves[tokenId] = newBalance
// - AccountSettled  → entity.accounts[cp].deltas[tokenId] = {collateral, ondelta}
// - DebtXxx         → entity.debts (future)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply a single finalized j-event to entity state.
 *
 * Called after j-block consensus - the event is trusted at this point.
 * Maps each event type to the appropriate state mutation.
 *
 * @param entityState - Current entity state
 * @param event - Finalized j-event to apply
 * @returns New state with event applied
 */
async function applyFinalizedJEvent(
  entityState: EntityState,
  event: JurisdictionEvent,
  env: Env
): Promise<{ newState: EntityState; mempoolOps: Array<{ accountId: string; tx: any }> }> {
  console.log(`🔧🔧 applyFinalizedJEvent: entityId=${entityState.entityId.slice(-4)}, event.type=${event.type}`);

  const entityShort = entityState.entityId.slice(-4);
  const blockNumber = event.blockNumber ?? 0;
  const transactionHash = event.transactionHash || 'unknown';
  const txHashShort = transactionHash.slice(0, 10) + '...';

  // Clone state for mutation
  const newState = cloneEntityState(entityState);
  const mempoolOps: Array<{ accountId: string; tx: any }> = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // CANONICAL J-EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  if (event.type === 'ReserveUpdated') {
    const { entity, tokenId, newBalance } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const balanceDisplay = (Number(newBalance) / (10 ** decimals)).toFixed(4);

    if (entity === entityState.entityId) {
      const before = entityState.reserves.get(String(tokenId)) ?? 0n;
      newState.reserves.set(String(tokenId), BigInt(newBalance as string | number | bigint));
      console.log(`💰 ReserveUpdated APPLIED: entity=${entityShort} token=${tokenId} balance=${newBalance}`);
      console.log(`   Before: ${before.toString()}`);
      console.log(`   After: ${(newState.reserves.get(String(tokenId)) ?? 0n).toString()}`);
    }

    addMessage(newState, `📊 RESERVE: ${tokenSymbol} = ${balanceDisplay} | Block ${blockNumber} | Tx ${txHashShort}`);

  } else if (event.type === 'SecretRevealed') {
    const { hashlock, secret } = event.data;
    applyKnownHtlcSecret(newState, mempoolOps, String(hashlock), String(secret), blockNumber, 'SecretRevealed');

  } else if (event.type === 'AccountSettled') {
    // Universal settlement event (covers R2C, C2R, settle, rebalance)
    const { leftEntity, rightEntity, tokenId, leftReserve, rightReserve, collateral, ondelta } = event.data;
    const tokenIdNum = Number(tokenId);
    const myEntityId = String(entityState.entityId).toLowerCase();
    const leftId = String(leftEntity).toLowerCase();
    const rightId = String(rightEntity).toLowerCase();
    const myIsLeft = myEntityId === leftId;
    const myIsRight = myEntityId === rightId;
    if (!myIsLeft && !myIsRight) {
      console.warn(`   ⚠️ AccountSettled not for this entity: me=${entityState.entityId.slice(-4)} left=${leftId.slice(-4)} right=${rightId.slice(-4)}`);
      return { newState, mempoolOps };
    }
    const counterpartyEntityId = myIsLeft ? rightEntity : leftEntity;
    const cpShort = String(counterpartyEntityId).slice(-4);
    const ownReserve = myIsLeft ? leftReserve : rightReserve;
    const tokenSymbol = getTokenSymbol(tokenIdNum);
    const decimals = getTokenDecimals(tokenIdNum);

    // Update own reserves (entity-level, unilateral OK)
    const oldReserve = newState.reserves.get(String(tokenId)) || 0n;
    console.log(`   💰 RESERVE-UPDATE: ownReserve=${ownReserve}, old=${oldReserve}, tokenId=${tokenId}`);
    if (ownReserve) {
      const newReserve = BigInt(ownReserve as string | number | bigint);
      newState.reserves.set(String(tokenId), newReserve);
      console.log(`   💰 RESERVE-SET: ${oldReserve} → ${newReserve}`);
    } else {
      console.log(`   ⚠️ RESERVE-SKIP: ownReserve is falsy`);
    }

    // BILATERAL J-EVENT CONSENSUS: Need 2-of-2 agreement before applying to account
    // Use canonical key for account lookup
    // Account keyed by counterparty ID
    const account = newState.accounts.get(counterpartyEntityId as string);
    if (!account) {
      console.warn(`   ⚠️ No account for ${cpShort}`);
      return { newState, mempoolOps };
    }

    // Initialize consensus fields (claims are stored ONLY via bilateral account frames).
    // IMPORTANT: Do NOT mutate left/right observations here.
    // This function runs on unilateral entity-level J-observation and must not
    // advance shared account state inputs before 2-of-2 account consensus.
    if (!account.leftJObservations) account.leftJObservations = [];
    if (!account.rightJObservations) account.rightJObservations = [];
    if (!account.jEventChain) account.jEventChain = [];
    if (account.lastFinalizedJHeight === undefined) account.lastFinalizedJHeight = 0;

    const jHeight = event.blockNumber ?? blockNumber;
    const jBlockHash = event.blockHash || '';

    // Add j_event_claim via mempoolOps (auto-triggers proposableAccounts + account frame)
    // Account keyed by counterparty ID.
    // Use canonical normalized event payload so both sides hash the same data.
    const normalizedClaimEvents = normalizeJurisdictionEvents([event]);
    if (normalizedClaimEvents.length !== 1) {
      console.warn(
        `⚠️ AccountSettled normalization failed for claim enqueue: token=${tokenIdNum} cp=${cpShort} block=${blockNumber}`,
      );
      return { newState, mempoolOps };
    }
    const eventCopy = structuredClone(normalizedClaimEvents[0]);
    const observedAt = entityState.timestamp || 0;
    mempoolOps.push({
      accountId: counterpartyEntityId as string,
      tx: { type: 'j_event_claim', data: { jHeight, jBlockHash, events: [eventCopy], observedAt } },
    });
    console.log(`   📮 j_event_claim → mempoolOps[${mempoolOps.length}] (will auto-propose frame)`);
    console.log(
      `[REB][4][J_EVENT_CLAIM_QUEUED] entity=${entityState.entityId.slice(-8)} cp=${String(counterpartyEntityId).slice(-8)} token=${tokenIdNum} jHeight=${jHeight}`,
    );
    const p2p = (env as any)?.runtimeState?.p2p;
    if (p2p && typeof p2p.sendDebugEvent === 'function') {
      p2p.sendDebugEvent({
        level: 'info',
        code: 'REB_STEP',
        step: 4,
        status: 'ok',
        event: 'j_event_claim_queued',
        entityId: entityState.entityId,
        counterpartyId: String(counterpartyEntityId),
        tokenId: tokenIdNum,
        jHeight,
      });
    }

    const collDisplay = (Number(collateral) / (10 ** decimals)).toFixed(4);
    addMessage(newState, `⚖️ OBSERVED: ${tokenSymbol} ${cpShort} | coll=${collDisplay} | j-block ${blockNumber} (awaiting 2-of-2)`);

  // ═══════════════════════════════════════════════════════════════════════════
  // FUTURE J-EVENTS (when added to Solidity - handlers ready)
  // ═══════════════════════════════════════════════════════════════════════════

  } else if (event.type === 'DebtCreated') {
    const { debtor, creditor, tokenId, amount, debtIndex } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const amountDisplay = (Number(amount) / (10 ** decimals)).toFixed(4);

    if (!newState.debts) {
      newState.debts = [];
    }

    if (debtor === entityState.entityId) {
      newState.debts.push({
        creditor: creditor as string,
        tokenId: tokenId as number,
        amount: BigInt(amount as string | number | bigint),
        index: debtIndex as number,
      });
    }

    addMessage(newState, `🔴 DEBT: ${(debtor as string).slice(-8)} owes ${amountDisplay} ${tokenSymbol} to ${(creditor as string).slice(-8)} | Block ${blockNumber}`);

  } else if (event.type === 'DebtEnforced') {
    const { debtor, creditor, tokenId, amountPaid, remainingAmount, newDebtIndex } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const paidDisplay = (Number(amountPaid) / (10 ** decimals)).toFixed(4);

    if (debtor === entityState.entityId && newState.debts) {
      const debt = newState.debts.find(
        d => d.creditor === creditor && d.tokenId === tokenId
      );
      if (debt) {
        debt.amount = BigInt(remainingAmount as string | number | bigint);
        debt.index = newDebtIndex as number;
      }
    }

    addMessage(newState, `✅ DEBT PAID: ${paidDisplay} ${tokenSymbol} to ${(creditor as string).slice(-8)} | Block ${blockNumber}`);

  } else if (event.type === 'DisputeStarted') {
    console.log(`🔍 DISPUTE-EVENT HANDLER: entityId=${newState.entityId.slice(-4)}`);

    // Dispute started on-chain - store dispute state from event
    const { sender, counterentity, nonce, proofbodyHash } = event.data as { sender: string; counterentity: string; nonce: string; proofbodyHash: string; initialArguments: string };
    const normalizeId = (id: string) => String(id).toLowerCase();
    const senderStr = normalizeId(sender as string);
    const counterentityStr = normalizeId(counterentity as string);
    const entityIdNorm = normalizeId(newState.entityId);

    // Find which account this affects (we are either sender or counterentity)
    const candidateCounterpartyId = senderStr === entityIdNorm ? counterentityStr : senderStr;
    let counterpartyId = candidateCounterpartyId;
    let account = newState.accounts.get(counterpartyId);
    if (!account) {
      for (const [key, value] of newState.accounts.entries()) {
        if (normalizeId(key) === candidateCounterpartyId) {
          counterpartyId = key;
          account = value;
          break;
        }
      }
    }

    if (account) {
      account.status = 'disputed';
      // Query on-chain account state via adapter (works for both RPC and BrowserVM backends).
      const jadapter = getEnvJAdapter(env);
      if (!jadapter || typeof jadapter.getAccountInfo !== 'function') {
        console.warn(`⚠️ DisputeStarted: No JAdapter account-info reader available`);
        return { newState, mempoolOps };
      }
      const accountInfo = await jadapter.getAccountInfo(newState.entityId, counterpartyId);

      const weAreStarter = senderStr === entityIdNorm;
      const hasCounterpartySig = Boolean(account.counterpartyDisputeProofHanko);

      // Store dispute state from event + on-chain (source of truth)
      // Unified nonce: initialNonce = the nonce used in disputeStart (from event)
      // onChainNonce = the nonce stored on-chain at time of dispute
      account.activeDispute = {
        startedByLeft: senderStr < counterentityStr,
        initialProofbodyHash: String(proofbodyHash),  // From event (committed on-chain)
        initialNonce: Number(nonce),
        disputeTimeout: Number(accountInfo.disputeTimeout),  // From on-chain
        onChainNonce: Number(accountInfo.nonce),
        initialArguments: event.data.initialArguments || '0x',
      };
      account.onChainSettlementNonce = Number(accountInfo.nonce);

      // ASSERTION: Our local proof hash should match on-chain committed hash
      const { buildAccountProofBody } = await import('../proof-builder');
      const localProof = buildAccountProofBody(account);
      if (localProof.proofBodyHash !== account.activeDispute.initialProofbodyHash) {
        console.error(`❌ CONSENSUS DIVERGENCE: Local proofBodyHash != on-chain`);
        console.error(`   Local: ${localProof.proofBodyHash}`);
        console.error(`   On-chain: ${account.activeDispute.initialProofbodyHash}`);
        console.error(`   This means bilateral state diverged - CRITICAL BUG!`);
        // Continue but log for audit
      } else {
        console.log(`✅ Proof hash verified: local matches on-chain`);
      }

      const disputeSecrets = decodeDisputeInitialSecrets(event.data.initialArguments || '0x');
      if (disputeSecrets.length > 0) {
        console.log(`🔓 DISPUTE-ARGS: ${disputeSecrets.length} secret(s) decoded from initialArguments`);
        for (const disputeSecret of disputeSecrets) {
          const hashlock = hashHtlcSecret(disputeSecret);
          applyKnownHtlcSecret(newState, mempoolOps, hashlock, disputeSecret, blockNumber, 'DisputeStarted');
        }
      }

      addMessage(newState, `⚔️ DISPUTE ${weAreStarter ? 'STARTED' : 'vs us'} with ${counterpartyId.slice(-4)}, timeout: block ${account.activeDispute.disputeTimeout}`);
      console.log(`⚔️ activeDispute stored: hash=${account.activeDispute.initialProofbodyHash.slice(0,10)}..., timeout=${account.activeDispute.disputeTimeout}`);
    } else {
      console.warn(`⚠️ DisputeStarted: account ${candidateCounterpartyId.slice(-4)} not found for entity ${entityIdNorm.slice(-4)}`);
    }

  } else if (event.type === 'DisputeFinalized') {
    console.log(`🔍 DISPUTE-FINALIZED HANDLER: entityId=${newState.entityId.slice(-4)}`);

    const { sender, counterentity, initialNonce, initialProofbodyHash } = event.data as { sender: string; counterentity: string; initialNonce: string; initialProofbodyHash: string; finalProofbodyHash: string };
    const normalizeId = (id: string) => String(id).toLowerCase();
    const senderStr = normalizeId(sender as string);
    const counterentityStr = normalizeId(counterentity as string);
    const entityIdNorm = normalizeId(newState.entityId);

    const candidateCounterpartyId = senderStr === entityIdNorm ? counterentityStr : senderStr;
    let counterpartyId = candidateCounterpartyId;
    let account = newState.accounts.get(counterpartyId);
    if (!account) {
      for (const [key, value] of newState.accounts.entries()) {
        if (normalizeId(key) === candidateCounterpartyId) {
          counterpartyId = key;
          account = value;
          break;
        }
      }
    }

    if (account) {
      const jadapter = getEnvJAdapter(env);
      if (jadapter && typeof jadapter.getAccountInfo === 'function') {
        try {
          const accountInfo = await jadapter.getAccountInfo(newState.entityId, counterpartyId);
          account.onChainSettlementNonce = Number(accountInfo.nonce);
        } catch (error) {
          console.warn(
            `⚠️ DisputeFinalized nonce sync failed for ${counterpartyId.slice(-4)}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (account.activeDispute) {
        delete account.activeDispute;
        addMessage(newState, `✅ DISPUTE FINALIZED with ${counterpartyId.slice(-4)} (nonce ${Number(initialNonce)})`);
        console.log(`✅ activeDispute cleared for ${counterpartyId.slice(-4)} (proof=${String(initialProofbodyHash).slice(0, 10)}...)`);
      } else {
        console.warn(`⚠️ DisputeFinalized: No activeDispute for ${counterpartyId.slice(-4)}`);
      }
      // Dispute completed on-chain: unfreeze account and move proof nonce cursor forward.
      const finalizedOnChainNonce = Number(account.onChainSettlementNonce ?? 0);
      if (account.proofHeader.nonce <= finalizedOnChainNonce) {
        account.proofHeader.nonce = finalizedOnChainNonce + 1;
      }
      account.status = 'active';
      delete account.pendingFrame;
      delete account.pendingAccountInput;
      delete account.clonedForValidation;
      account.rollbackCount = 0;
      delete account.lastRollbackFrameHash;
      // Drop stale dispute snapshots from pre-finalization epoch.
      delete account.counterpartyDisputeProofHanko;
      delete account.counterpartyDisputeProofNonce;
      delete account.counterpartyDisputeProofBodyHash;
      console.log(
        `✅ DisputeFinalized: account re-activated for ${counterpartyId.slice(-4)} ` +
        `(onChainNonce=${finalizedOnChainNonce}, nextProofNonce=${account.proofHeader.nonce})`,
      );

      // IMPORTANT: Do not mutate shared account deltas from unilateral entity-layer events.
      // Dispute flow can be reflected via status/nonce; collateral/ondelta must move only
      // through bilateral account consensus.
      if (jadapter) {
        for (const [tokenId, delta] of account.deltas.entries()) {
          try {
            const onChainCollateral = await jadapter.getCollateral(account.leftEntity, account.rightEntity, tokenId);
            if (delta.collateral !== onChainCollateral) {
              console.warn(
                `⚠️ DisputeFinalized observed collateral drift (no local apply): ${counterpartyId.slice(-4)} token=${tokenId} ` +
                `local=${delta.collateral} chain=${onChainCollateral}`,
              );
            }
          } catch (error) {
            console.warn(
              `⚠️ DisputeFinalized collateral check failed token=${tokenId} ` +
              `for ${counterpartyId.slice(-4)}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } else {
      console.warn(`⚠️ DisputeFinalized: account ${candidateCounterpartyId.slice(-4)} not found for entity ${entityIdNorm.slice(-4)}`);
    }

  } else if (event.type === 'HankoBatchProcessed') {
    // jBatch finalization event - confirms our batch was processed on-chain
    const { entityId: batchEntityId, hankoHash, nonce, success } = event.data as { entityId: string; hankoHash: string; nonce: number; success: boolean };

    // Only process if this is our batch
    if (batchEntityId !== newState.entityId) {
      console.log(`   ⏭️ HankoBatchProcessed: Not our batch (${String(batchEntityId).slice(-4)} != ${entityShort})`);
      return { newState, mempoolOps };
    }

    console.log(`📦 HankoBatchProcessed: nonce=${nonce}, success=${success}, hanko=${String(hankoHash).slice(0, 10)}...`);

    if (success) {
      if (newState.jBatchState) {
        const { batchOpCount: countOps, isBatchEmpty, mergeBatchOps } = await import('../j-batch');
        const sentBatch = newState.jBatchState.sentBatch;
        const opCount = sentBatch ? countOps(sentBatch.batch) : 0;
        const wasPending = !!sentBatch;

        // Duplicate/replayed HankoBatchProcessed can arrive after we already cleared the
        // batch on the first finalized event. Ignore zero-op confirmations in that case.
        if (!wasPending && opCount === 0) {
          const currentNonce = Number(newState.jBatchState.entityNonce || 0);
          const eventNonceNum = Number(nonce || 0);
          newState.jBatchState.entityNonce = eventNonceNum > currentNonce ? eventNonceNum : currentNonce;
          console.warn(
            `⚠️ HankoBatchProcessed duplicate ignored (nonce ${nonce}, opCount=0, pending=false)`,
          );
          return { newState, mempoolOps };
        }

        // Record completed batch in history (keep last 20)
        if (!newState.batchHistory) newState.batchHistory = [];
        newState.batchHistory.push({
          batchHash: sentBatch?.batchHash || '',
          txHash: sentBatch?.txHash || transactionHash || '',
          status: 'confirmed' as const,
          broadcastedAt: sentBatch?.lastSubmittedAt || newState.jBatchState.lastBroadcast || 0,
          confirmedAt: newState.timestamp,
          opCount,
          entityNonce: Number(nonce),
        });
        if (newState.batchHistory.length > 20) {
          newState.batchHistory = newState.batchHistory.slice(-20);
        }

        // Clear sent batch for next cycle.
        newState.jBatchState.sentBatch = undefined;
        newState.jBatchState.status = isBatchEmpty(newState.jBatchState.batch) ? 'empty' : 'accumulating';
        // Authoritative nonce sync from on-chain finalized event.
        // Never trust optimistic local increments from submission path.
        const currentNonce = Number(newState.jBatchState.entityNonce || 0);
        const eventNonceNum = Number(nonce || 0);
        newState.jBatchState.entityNonce = eventNonceNum > currentNonce ? eventNonceNum : currentNonce;
        console.log(`   ✅ jBatch confirmed (nonce ${nonce}, ${opCount} ops)`);
      }
      addMessage(newState, `✅ jBatch finalized (nonce ${nonce}) | Block ${blockNumber}`);
    } else {
      // Batch failed — update status, keep batch for retry
      if (newState.jBatchState) {
        const sentBatch = newState.jBatchState.sentBatch;
        newState.jBatchState.status = 'failed';
        newState.jBatchState.failedAttempts++;
        // Keep nonce synchronized to finalized event nonce.
        const currentNonce = Number(newState.jBatchState.entityNonce || 0);
        const eventNonceNum = Number(nonce || 0);
        newState.jBatchState.entityNonce = eventNonceNum > currentNonce ? eventNonceNum : currentNonce;

        if (!newState.batchHistory) newState.batchHistory = [];
        newState.batchHistory.push({
          batchHash: sentBatch?.batchHash || '',
          txHash: sentBatch?.txHash || transactionHash || '',
          status: 'failed' as const,
          broadcastedAt: sentBatch?.lastSubmittedAt || newState.jBatchState.lastBroadcast || 0,
          confirmedAt: newState.timestamp,
          opCount: 0,
          entityNonce: Number(nonce),
        });
        if (newState.batchHistory.length > 20) {
          newState.batchHistory = newState.batchHistory.slice(-20);
        }

        // Requeue failed sentBatch ops back to current batch so operator can rebroadcast
        // with fresh nonce in the next cycle.
        if (sentBatch) {
          mergeBatchOps(newState.jBatchState.batch, sentBatch.batch);
        }
        newState.jBatchState.sentBatch = undefined;
        newState.jBatchState.status = isBatchEmpty(newState.jBatchState.batch) ? 'failed' : 'accumulating';
      }
      // Batch is atomic on-chain; success=false means none of its ops applied.
      // Unfreeze submitted rebalance requests so hub can retry in next crontab tick.
      for (const account of newState.accounts.values()) {
        if (!account.requestedRebalanceFeeState) continue;
        for (const feeState of account.requestedRebalanceFeeState.values()) {
          if ((feeState.jBatchSubmittedAt || 0) > 0) {
            feeState.jBatchSubmittedAt = 0;
          }
        }
      }
      console.warn(`   ⚠️ jBatch FAILED on-chain (nonce ${nonce}) - not clearing`);
      addMessage(newState, `⚠️ jBatch failed (nonce ${nonce}) - use j_clear_batch to abort | Block ${blockNumber}`);
    }

  } else {
    // Unknown event - log but don't fail
    addMessage(newState, `⚠️ Unknown j-event: ${event.type} | Block ${blockNumber}`);
    console.warn(`⚠️ Unknown j-event type: ${event.type}. Canonical events: ${CANONICAL_J_EVENTS.join(', ')}`);
  }

  return { newState, mempoolOps };
}
