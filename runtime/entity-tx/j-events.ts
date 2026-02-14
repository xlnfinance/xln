import type { EntityState, Delta, JBlockObservation, JBlockFinalized, JurisdictionEvent, Env } from '../types';
import { ethers } from 'ethers';
import { DEBUG } from '../utils';
import { cloneEntityState, addMessage, canonicalAccountKey } from '../state-helpers';
import { getTokenInfo, getDefaultCreditLimit } from '../account-utils';
import { isLeftEntity } from '../entity-id-utils';
import { safeStringify } from '../serialization-utils';
import { CANONICAL_J_EVENTS } from '../jadapter/helpers';
import { hashHtlcSecret } from '../htlc-utils';

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

  // Convert raw events to JurisdictionEvent format
  const jEvents: JurisdictionEvent[] = rawEvents.map((e: any) => ({
    type: e.type as any,
    data: e.data as any,
    blockNumber,
    blockHash,
  }));

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

  for (const key of matches) {
    const leftObs = leftMap.get(key)!;
    const jHeight = leftObs.jHeight;

    // Skip already finalized
    if (account.lastFinalizedJHeight >= jHeight) continue;
    if (account.jEventChain.some((b: any) => b.jHeight === jHeight)) continue;

    console.log(`   ✅ BILATERAL-FINALIZE: jHeight=${jHeight}`);

    // Apply events (from left observation - both should be identical)
    for (const event of leftObs.events) {
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

        // NOTE: Do NOT increment nonce here!
        // R2C also emits AccountSettled but doesn't increment on-chain nonce.
        // Nonce is incremented in tryFinalizeAccountJEvents when workspace status is 'ready_to_submit'.
        console.log(`   💰 BILATERAL-APPLIED for ${counterpartyId.slice(-4)}: coll ${oldColl}→${delta.collateral}, ondelta=${delta.ondelta}`);
      }
    }

    // Add to jEventChain (replay prevention) - DETERMINISTIC timestamp
    account.jEventChain.push({ jHeight, jBlockHash: leftObs.jBlockHash, events: leftObs.events, finalizedAt: opts.timestamp });
    account.lastFinalizedJHeight = Math.max(account.lastFinalizedJHeight, jHeight);

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
        account.currentDisputeProofCooperativeNonce = postProof.cooperativeNonce;
        account.currentDisputeProofBodyHash = postProof.proofBodyHash;
        account.counterpartyDisputeProofCooperativeNonce = postProof.cooperativeNonce;
        account.counterpartyDisputeProofBodyHash = postProof.proofBodyHash;
        console.log(`   🔐 Post-settlement dispute proof activated (nonce=${postProof.cooperativeNonce})`);
      }

      account.onChainSettlementNonce = (account.onChainSettlementNonce || 0) + 1;
      console.log(`   💰 NONCE-INC: Settlement finalized → onChainNonce=${account.onChainSettlementNonce} (ws.status was '${ws.status}')`);
      // Clear workspace after nonce increment — both sides (Hub + counterparty)
      delete account.settlementWorkspace;
      console.log(`   🧹 WORKSPACE-CLEAR: Settlement completed`);
    }
  }

  // Prune finalized
  const finalizedHeights = new Set(matches.map(k => leftMap.get(k)!.jHeight));
  account.leftJObservations = account.leftJObservations.filter((o: any) => !finalizedHeights.has(o.jHeight));
  account.rightJObservations = account.rightJObservations.filter((o: any) => !finalizedHeights.has(o.jHeight));
  console.log(`   🧹 Pruned ${finalizedHeights.size} finalized (left=${account.leftJObservations.length}, right=${account.rightJObservations.length} pending)`);
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
    for (const event of obs.events) {
      // Create unique key from event type and data
    const key = `${event.type}:${safeStringify(event.data)}`;
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
    const { counterpartyEntityId, tokenId, ownReserve, collateral, ondelta } = event.data;
    const tokenIdNum = Number(tokenId);
    const cpShort = (counterpartyEntityId as string).slice(-4);
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

    // Initialize consensus fields
    if (!account.leftJObservations) account.leftJObservations = [];
    if (!account.rightJObservations) account.rightJObservations = [];
    if (!account.jEventChain) account.jEventChain = [];
    if (account.lastFinalizedJHeight === undefined) account.lastFinalizedJHeight = 0;

    const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId as string);
    const jHeight = event.blockNumber ?? blockNumber;
    const jBlockHash = event.blockHash || '';

    // Store OWN observation
    const obs = { jHeight, jBlockHash, events: [event], observedAt: entityState.timestamp || 0 };
    if (isLeft) {
      account.leftJObservations.push(obs);
      console.log(`   📝 LEFT obs: jHeight=${jHeight}`);
    } else {
      account.rightJObservations.push(obs);
      console.log(`   📝 RIGHT obs: jHeight=${jHeight}`);
    }

    // Add j_event_claim via mempoolOps (auto-triggers proposableAccounts + account frame)
    // Account keyed by counterparty ID
    // CRITICAL: Deep-copy event to prevent mutation issues (frame fullDeltaStates added later)
    const eventCopy = JSON.parse(safeStringify(event));
    mempoolOps.push({
      accountId: counterpartyEntityId as string,
      tx: { type: 'j_event_claim', data: { jHeight, jBlockHash, events: [eventCopy], observedAt: obs.observedAt } },
    });
    console.log(`   📮 j_event_claim → mempoolOps[${mempoolOps.length}] (will auto-propose frame)`);

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
    const { sender, counterentity, disputeNonce, proofbodyHash } = event.data;
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
      // Query on-chain for timeout
      const browserVM = (await import('../evm')).getBrowserVMInstance(env);
      if (!browserVM || !browserVM.getAccountInfo) {
        console.warn(`⚠️ DisputeStarted: No browserVM to query timeout`);
        return { newState, mempoolOps };
      }

      const accountInfo = await browserVM.getAccountInfo(newState.entityId, counterpartyId);

      const weAreStarter = senderStr === entityIdNorm;
      const hasCounterpartySig = Boolean(account.counterpartyDisputeProofHanko);
      let initialCooperativeNonce = account.proofHeader.cooperativeNonce;
      let nonceSource = 'proofHeader';
      const mappedNonce = account.disputeProofNoncesByHash?.[String(proofbodyHash)];
      if (mappedNonce !== undefined) {
        initialCooperativeNonce = mappedNonce;
        nonceSource = 'hashMap';
      } else if (weAreStarter) {
        if (account.counterpartyDisputeProofCooperativeNonce !== undefined) {
          initialCooperativeNonce = account.counterpartyDisputeProofCooperativeNonce;
          nonceSource = 'counterpartySig';
        }
      } else {
        if (account.currentDisputeProofCooperativeNonce !== undefined) {
          initialCooperativeNonce = account.currentDisputeProofCooperativeNonce;
          nonceSource = 'currentSig';
        }
      }
      console.log(`   DEBUG DisputeStarted: starter=${weAreStarter}, source=${nonceSource}, proofHeader.cooperativeNonce=${account.proofHeader.cooperativeNonce}, initialCooperativeNonce=${initialCooperativeNonce}`);

      // Store dispute state from event + on-chain (source of truth)
      account.activeDispute = {
        startedByLeft: senderStr < counterentityStr,
        initialProofbodyHash: String(proofbodyHash),  // From event (committed on-chain)
        initialDisputeNonce: Number(disputeNonce),
        disputeTimeout: Number(accountInfo.disputeTimeout),  // From on-chain
        initialCooperativeNonce,  // Nonce PASSED to disputeStart (for hash match)
        onChainCooperativeNonce: Number(accountInfo.cooperativeNonce),  // May differ
        initialArguments: event.data.initialArguments || '0x',
      };

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

    const { sender, counterentity, initialDisputeNonce, initialProofbodyHash } = event.data;
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
      if (account.activeDispute) {
        delete account.activeDispute;
        addMessage(newState, `✅ DISPUTE FINALIZED with ${counterpartyId.slice(-4)} (nonce ${Number(initialDisputeNonce)})`);
        console.log(`✅ activeDispute cleared for ${counterpartyId.slice(-4)} (proof=${String(initialProofbodyHash).slice(0, 10)}...)`);
      } else {
        console.warn(`⚠️ DisputeFinalized: No activeDispute for ${counterpartyId.slice(-4)}`);
      }
    } else {
      console.warn(`⚠️ DisputeFinalized: account ${candidateCounterpartyId.slice(-4)} not found for entity ${entityIdNorm.slice(-4)}`);
    }

  } else if (event.type === 'HankoBatchProcessed') {
    // jBatch finalization event - confirms our batch was processed on-chain
    const { entityId: batchEntityId, hankoHash, nonce, success } = event.data;

    // Only process if this is our batch
    if (batchEntityId !== newState.entityId) {
      console.log(`   ⏭️ HankoBatchProcessed: Not our batch (${String(batchEntityId).slice(-4)} != ${entityShort})`);
      return { newState, mempoolOps };
    }

    console.log(`📦 HankoBatchProcessed: nonce=${nonce}, success=${success}, hanko=${String(hankoHash).slice(0, 10)}...`);

    if (success) {
      // Clear jBatch now that it's finalized on-chain
      if (newState.jBatchState) {
        const { createEmptyBatch } = await import('../j-batch');
        newState.jBatchState.batch = createEmptyBatch();
        newState.jBatchState.pendingBroadcast = false; // Unlock for new operations
        console.log(`   ✅ jBatch cleared on successful finalization`);
      }
      addMessage(newState, `✅ jBatch finalized (nonce ${nonce}) | Block ${blockNumber}`);
    } else {
      // Batch failed - keep it for potential rebroadcast or manual clear
      // pendingBroadcast stays true - user must j_clear_batch or rebroadcast
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
