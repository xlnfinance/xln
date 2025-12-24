import { EntityState, Delta, JBlockObservation, JBlockFinalized, JurisdictionEvent, Env } from '../types';
import { DEBUG } from '../utils';
import { cloneEntityState, addMessage } from '../state-helpers';
import { getTokenInfo, getDefaultCreditLimit } from '../account-utils';
import { safeStringify } from '../serialization-utils';
import { CANONICAL_J_EVENTS } from '../j-event-watcher';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * J-EVENT HANDLERS (Single Source of Truth - must match j-event-watcher.ts)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Canonical J-Events (update entity state):
 * - ReserveUpdated  → entity.reserves[tokenId] = newBalance
 * - AccountSettled  → entity.accounts[counterparty].deltas[tokenId] = { collateral, ondelta }
 *
 * Future J-Events (when added to Solidity):
 * - InsuranceRegistered, InsuranceClaimed, InsuranceExpired
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

// ═══════════════════════════════════════════════════════════════════════════════
// J-EVENT HANDLER: Entry point for jurisdiction (blockchain) events
// ═══════════════════════════════════════════════════════════════════════════════
//
// When a signer observes a blockchain event (via j-event-watcher.ts), it submits
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
export const handleJEvent = (entityState: EntityState, entityTxData: JEventEntityTxData, env: Env): EntityState => {
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
    return entityState;
  }

  // Skip blocks at or below lastFinalizedJHeight (monotonic progress only)
  // Note: The == case is already caught by alreadyFinalized check above,
  // but we use <= here for explicit monotonic enforcement
  // TODO: For multi-signer production, add appliedJBlockHashes: Set<string>
  // to track exact block hashes and reject conflicting observations
  if (blockNumber <= entityState.lastFinalizedJHeight) {
    console.log(`   ⏭️ SKIP: stale block (${blockNumber} <= finalized ${entityState.lastFinalizedJHeight})`);
    return entityState;
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
  newEntityState = tryFinalizeJBlocks(newEntityState, entityState.config.threshold);

  return newEntityState;
};

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
 * @returns Updated state with finalized events applied
 */
function tryFinalizeJBlocks(state: EntityState, threshold: bigint): EntityState {
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

  for (const [_key, observations] of observationGroups) {
    // Count UNIQUE signers (ignore duplicate submissions from same signer)
    const uniqueSigners = new Set(observations.map(o => o.signerId));
    const signerCount = uniqueSigners.size;

    // Does this group meet the threshold?
    if (BigInt(signerCount) >= threshold) {
      const jHeight = observations[0].jHeight;
      const jBlockHash = observations[0].jBlockHash;

      console.log(`   ✅ J-BLOCK FINALIZED: height=${jHeight} (${signerCount}/${threshold} signers)`);

      // ─────────────────────────────────────────────────────────────────────────
      // Step 3: Merge events from all observations
      // ─────────────────────────────────────────────────────────────────────────
      // All honest signers should see identical events. We merge/dedup in case
      // of minor ordering differences or duplicate submissions.
      const events = mergeSignerObservations(observations);

      // ─────────────────────────────────────────────────────────────────────────
      // Step 4: Create finalized block record
      // ─────────────────────────────────────────────────────────────────────────
      const finalized: JBlockFinalized = {
        jHeight,
        jBlockHash,
        events,
        finalizedAt: Date.now(),
        signerCount,
      };

      // ─────────────────────────────────────────────────────────────────────────
      // Step 5: Apply all events from this finalized block
      // ─────────────────────────────────────────────────────────────────────────
      for (const event of events) {
        state = applyFinalizedJEvent(state, event);
      }

      // Update entity's j-block tracking
      state.lastFinalizedJHeight = Math.max(state.lastFinalizedJHeight, jHeight);
      state.jBlockChain.push(finalized);
      finalizedHeights.push(jHeight);

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

  return state;
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
      const key = `${event.type}:${JSON.stringify(event.data)}`;
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
// - InsuranceXxx    → entity.insuranceLines (future)
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
function applyFinalizedJEvent(entityState: EntityState, event: JurisdictionEvent): EntityState {
  const entityShort = entityState.entityId.slice(-4);
  const blockNumber = event.blockNumber ?? 0;
  const transactionHash = event.transactionHash || 'unknown';
  const txHashShort = transactionHash.slice(0, 10) + '...';

  // Clone state for mutation
  const newState = cloneEntityState(entityState);

  // ═══════════════════════════════════════════════════════════════════════════
  // CANONICAL J-EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  if (event.type === 'ReserveUpdated') {
    const { entity, tokenId, newBalance } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const balanceDisplay = (Number(newBalance) / (10 ** decimals)).toFixed(4);

    if (entity === entityState.entityId) {
      newState.reserves.set(String(tokenId), BigInt(newBalance as string | number | bigint));
      if (DEBUG) console.log(`✅ Reserve updated: Token ${tokenId} → ${newBalance}`);
    }

    addMessage(newState, `📊 RESERVE: ${tokenSymbol} = ${balanceDisplay} | Block ${blockNumber} | Tx ${txHashShort}`);

  } else if (event.type === 'AccountSettled') {
    // Universal settlement event (covers R2C, C2R, settle, rebalance)
    const { counterpartyEntityId, tokenId, ownReserve, collateral, ondelta } = event.data;
    const tokenIdNum = Number(tokenId);
    const cpShort = (counterpartyEntityId as string).slice(-4);
    const tokenSymbol = getTokenSymbol(tokenIdNum);
    const decimals = getTokenDecimals(tokenIdNum);

    // Update own reserves based on the settlement (entity-level)
    newState.reserves.set(String(tokenId), BigInt(ownReserve as string | number | bigint));

    // DIRECT UPDATE - J-machine is authoritative
    const account = newState.accounts.get(counterpartyEntityId as string);
    if (account) {
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
      const oldOndelta = delta.ondelta;
      delta.collateral = BigInt(collateral as string | number | bigint);
      delta.ondelta = BigInt(ondelta as string | number | bigint);
      console.log(`   💰 [3/3] J-APPLIED: ${entityShort}↔${cpShort} | coll ${oldColl}→${delta.collateral} | ondelta ${oldOndelta}→${delta.ondelta}`);
    } else {
      console.warn(`   ⚠️ Settlement: No account for ${cpShort}`);
    }

    const collDisplay = (Number(collateral) / (10 ** decimals)).toFixed(4);
    addMessage(newState, `⚖️ SETTLED: ${tokenSymbol} with ${cpShort} | coll=${collDisplay} ondelta=${ondelta} | Block ${blockNumber}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // FUTURE J-EVENTS (when added to Solidity - handlers ready)
  // ═══════════════════════════════════════════════════════════════════════════

  } else if (event.type === 'InsuranceRegistered') {
    const { insured, insurer, tokenId, limit, expiresAt } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const limitDisplay = (Number(limit) / (10 ** decimals)).toFixed(2);

    if (!newState.insuranceLines) {
      newState.insuranceLines = [];
    }

    if (insured === entityState.entityId) {
      newState.insuranceLines.push({
        insurer: insurer as string,
        tokenId: tokenId as number,
        remaining: BigInt(limit as string | number | bigint),
        expiresAt: BigInt(expiresAt as string | number | bigint),
      });
    }

    addMessage(newState, `🛡️ INSURANCE: ${(insurer as string).slice(-8)} covers ${limitDisplay} ${tokenSymbol} | Block ${blockNumber}`);

  } else if (event.type === 'InsuranceClaimed') {
    const { insured, insurer, creditor, tokenId, amount } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const amountDisplay = (Number(amount) / (10 ** decimals)).toFixed(4);

    if (insured === entityState.entityId && newState.insuranceLines) {
      const line = newState.insuranceLines.find(
        l => l.insurer === insurer && l.tokenId === tokenId
      );
      if (line) {
        line.remaining -= BigInt(amount as string | number | bigint);
      }
    }

    addMessage(newState, `💸 INSURANCE CLAIMED: ${amountDisplay} ${tokenSymbol} paid to ${(creditor as string).slice(-8)} | Block ${blockNumber}`);

  } else if (event.type === 'InsuranceExpired') {
    const { insured, insurer, tokenId } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);

    addMessage(newState, `⏰ INSURANCE EXPIRED: ${(insurer as string).slice(-8)} → ${(insured as string).slice(-8)} ${tokenSymbol} | Block ${blockNumber}`);

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

    addMessage(newState, `🔴 DEBT: ${amountDisplay} ${tokenSymbol} owed to ${(creditor as string).slice(-8)} | Block ${blockNumber}`);

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

  } else {
    // Unknown event - log but don't fail
    addMessage(newState, `⚠️ Unknown j-event: ${event.type} | Block ${blockNumber}`);
    console.warn(`⚠️ Unknown j-event type: ${event.type}. Canonical events: ${CANONICAL_J_EVENTS.join(', ')}`);
  }

  return newState;
}
