import type {
  AccountMachine,
  AccountTx,
  CrossJurisdictionSwapRoute,
  EntityInput,
  EntityState,
  JBlockObservation,
  JBlockFinalized,
  JurisdictionEvent,
  Env,
} from '../types';
import type { CompletedBatch } from '../j-batch';
import { ethers } from 'ethers';
import { cloneEntityState, addMessage } from '../state-helpers';
import { getDefaultCreditLimit, getTokenInfo } from '../account-utils';
import { safeStringify } from '../serialization-utils';
import { CANONICAL_J_EVENTS } from '../jadapter/helpers';
import { hashHtlcSecret } from '../htlc-utils';
import { scheduleHook as scheduleCrontabHook, cancelHook as cancelCrontabHook } from '../entity-crontab';
import { getRuntimeJurisdictionDefaultDisputeDelayBlocks } from '../j-height';
import {
  filterActiveDisputeFinalizations,
  scrubDisputeFinalizationsForCounterparty,
} from './dispute-finalize-guards';
import {
  canonicalJurisdictionEventKey,
  normalizeJurisdictionEvent,
  normalizeJurisdictionEvents,
} from '../j-event-normalization';
import {
  buildJEventObservationDigest,
  canonicalJurisdictionEventsHash,
} from '../j-event-observation';
import { verifyAccountSignature } from '../account-crypto';
import { decodeHashLadderBinary } from '../hashladder';
import { markStorageEntityDirty } from '../env-events';
import { applyDebtCreated, applyDebtEnforced, applyDebtForgiven } from './j-events-debt';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * J-EVENT HANDLERS (Single Source of Truth - must match jadapter/helpers.ts)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Canonical J-Events (update entity state):
 * - ReserveUpdated  → entity.reserves[tokenId] = newBalance
 * - AccountSettled  → entity.accounts[counterparty].deltas[tokenId] = { collateral, ondelta }
 *
 * Debt J-Events:
 * - DebtCreated, DebtEnforced, DebtForgiven
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
  eventsHash?: string;
  signature?: string;
}

type JEventApplyResult = {
  newState: EntityState;
  mempoolOps: JEventMempoolOp[];
  outputs: EntityInput[];
  dirtyAccounts: string[];
};

type JEventMempoolOp = {
  accountId: string;
  tx: AccountTx;
};

type JEventClaimTx = Extract<AccountTx, { type: 'j_event_claim' }>;
type AccountJObservation = AccountMachine['leftJObservations'][number];

const isJEventClaimOp = (op: JEventMempoolOp): op is { accountId: string; tx: JEventClaimTx } =>
  op.tx.type === 'j_event_claim';

const normalizeSignerId = (value: unknown): string => String(value || '').trim().toLowerCase();

const signerVotingPower = (state: EntityState, signers: Iterable<string>): bigint => {
  let total = 0n;
  const seen = new Set<string>();
  const sharesByNormalized = new Map<string, bigint>();
  for (const [signerId, shares] of Object.entries(state.config.shares || {})) {
    sharesByNormalized.set(normalizeSignerId(signerId), BigInt(shares));
  }
  for (const signerId of signers) {
    const normalized = normalizeSignerId(signerId);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    total += sharesByNormalized.get(normalized) ?? 0n;
  }
  return total;
};

const isValidatorSigner = (state: EntityState, signerId: string): boolean => {
  const normalized = normalizeSignerId(signerId);
  return (state.config.validators || []).some((validatorId) => normalizeSignerId(validatorId) === normalized);
};

const observationEventsHash = (observation: JBlockObservation): string => {
  const existing = typeof observation.eventsHash === 'string' && observation.eventsHash.trim()
    ? observation.eventsHash.toLowerCase()
    : '';
  return existing || canonicalJurisdictionEventsHash(observation.events || []);
};

const getTokenSymbol = (tokenId: number): string => {
  return getTokenInfo(tokenId).symbol;
};

const getTokenDecimals = (tokenId: number): number => {
  return getTokenInfo(tokenId).decimals;
};

function emptyOpBreakdown() {
  return {
    flashloans: 0,
    reserveToReserve: 0,
    reserveToCollateral: 0,
    collateralToReserve: 0,
    settlements: 0,
    disputeStarts: 0,
    disputeFinalizations: 0,
    externalTokenToReserve: 0,
    reserveToExternalToken: 0,
    revealSecrets: 0,
  };
}

function appendBatchHistory(state: EntityState, entry: CompletedBatch): void {
  if (!state.batchHistory) state.batchHistory = [];
  const last = state.batchHistory[state.batchHistory.length - 1];
  const sameAsLast =
    !!last &&
    String(last.txHash || '') === String(entry['txHash'] || '') &&
    String(last.eventType || '') === String(entry['eventType'] || '') &&
    Number(last.jBlockNumber || 0) === Number(entry['jBlockNumber'] || 0) &&
    Number(last.entityNonce || 0) === Number(entry['entityNonce'] || 0);
  if (sameAsLast) return;
  state.batchHistory.push(entry);
  if (state.batchHistory.length > 40) {
    state.batchHistory = state.batchHistory.slice(-40);
  }
}

function findAccountEntryByCounterparty(state: EntityState, counterpartyEntityId: string): [string, AccountMachine] | null {
  const normalized = String(counterpartyEntityId || '').toLowerCase();
  if (!normalized) return null;
  for (const [accountId, account] of state.accounts.entries()) {
    const accountIdNorm = String(accountId || '').toLowerCase();
    const leftNorm = String(account.leftEntity || '').toLowerCase();
    const rightNorm = String(account.rightEntity || '').toLowerCase();
    if (accountIdNorm === normalized || leftNorm === normalized || rightNorm === normalized) {
      return [accountId, account];
    }
  }
  return null;
}

function findAccountByCounterparty(state: EntityState, counterpartyEntityId: string): AccountMachine | null {
  return findAccountEntryByCounterparty(state, counterpartyEntityId)?.[1] ?? null;
}

function findEntityStateById(env: Env, entityId: string): EntityState | null {
  const target = String(entityId || '').toLowerCase();
  if (!target) return null;
  for (const replica of env.eReplicas?.values?.() || []) {
    const state = replica?.state;
    if (state && String(state.entityId || '').toLowerCase() === target) return state;
  }
  return null;
}

function hasQueuedDisputeStart(state: EntityState | null, counterpartyEntityId: string): boolean {
  if (!state) return false;
  const target = String(counterpartyEntityId || '').toLowerCase();
  const draft = state.jBatchState?.batch?.disputeStarts || [];
  const sent = state.jBatchState?.sentBatch?.batch?.disputeStarts || [];
  return (
    draft.some((op) => String(op?.counterentity || '').toLowerCase() === target) ||
    sent.some((op) => String(op?.counterentity || '').toLowerCase() === target)
  );
}

function decodeDisputeInitialSecrets(initialArgumentsRaw: unknown): string[] {
  const initialArguments = String(initialArgumentsRaw || '0x');
  if (initialArguments === '0x') return [];

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  let argArray: string[];
  try {
    [argArray] = abiCoder.decode(['bytes[]'], initialArguments) as unknown as [string[]];
  } catch {
    return [];
  }

  const secrets = new Set<string>();
  for (const arg of argArray) {
    if (!arg || arg === '0x') continue;
    try {
      const [decoded] = abiCoder.decode(
        ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
        arg,
      ) as unknown as [{ secrets?: Array<string> }];
      for (const secret of decoded.secrets || []) {
        if (ethers.isHexString(secret, 32)) {
          secrets.add(String(secret).toLowerCase());
        }
      }
      continue;
    } catch {
      // Ignore non-HTLC transformer argument formats.
    }
  }

  return Array.from(secrets);
}

function decodeDisputeCrossPullBinaries(initialArgumentsRaw: unknown): Array<{ fillRatio: number; binary: string }> {
  const initialArguments = String(initialArgumentsRaw || '0x');
  if (initialArguments === '0x') return [];

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  let argArray: string[];
  try {
    [argArray] = abiCoder.decode(['bytes[]'], initialArguments) as unknown as [string[]];
  } catch {
    return [];
  }

  const binaries: Array<{ fillRatio: number; binary: string }> = [];
  for (const arg of argArray) {
    if (!arg || arg === '0x') continue;
    try {
      const [decoded] = abiCoder.decode(
        ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
        arg,
      ) as unknown as [{ pulls?: Array<string> }];
      for (const binary of decoded.pulls || []) {
        try {
          const decodedBinary = decodeHashLadderBinary(binary);
          if (decodedBinary.fillRatio > 0) binaries.push({ fillRatio: decodedBinary.fillRatio, binary });
        } catch {
          // Ignore malformed pull args inside otherwise valid transformer args.
        }
      }
      continue;
    } catch {
      // Ignore non-DeltaTransformer argument formats.
    }
  }
  return binaries;
}

function findCrossJurisdictionRouteForSourceDispute(
  state: EntityState,
  counterpartyId: string,
): CrossJurisdictionSwapRoute | null {
  const self = String(state.entityId || '').toLowerCase();
  const counterparty = String(counterpartyId || '').toLowerCase();
  for (const route of state.crossJurisdictionSwaps?.values() ?? []) {
    if (
      String(route.source.entityId || '').toLowerCase() === self &&
      String(route.source.counterpartyEntityId || '').toLowerCase() === counterparty
    ) {
      return route;
    }
  }
  return null;
}

function findCrossJurisdictionRouteForTargetDispute(
  state: EntityState,
  counterpartyId: string,
): CrossJurisdictionSwapRoute | null {
  const self = String(state.entityId || '').toLowerCase();
  const counterparty = String(counterpartyId || '').toLowerCase();
  for (const route of state.crossJurisdictionSwaps?.values() ?? []) {
    if (
      String(route.target.counterpartyEntityId || '').toLowerCase() === self &&
      String(route.target.entityId || '').toLowerCase() === counterparty
    ) {
      return route;
    }
  }
  return null;
}

function queueCrossJurisdictionSalvageFromDispute(
  state: EntityState,
  outputs: EntityInput[],
  counterpartyId: string,
  initialArgumentsRaw: unknown,
  blockNumber: number,
): boolean {
  const initialArguments = String(initialArgumentsRaw || '0x');
  if (!initialArguments || initialArguments === '0x') return false;
  const pullBinaries = decodeDisputeCrossPullBinaries(initialArguments);
  if (pullBinaries.length === 0) return false;

  const route = findCrossJurisdictionRouteForSourceDispute(state, counterpartyId);
  if (!route) {
    console.warn(
      `🌉 CROSS-J: non-zero pull args observed but no local route for source=${state.entityId.slice(-4)} counterparty=${counterpartyId.slice(-4)}`,
    );
    return false;
  }

  const best = pullBinaries.reduce((acc, item) => item.fillRatio > acc.fillRatio ? item : acc, pullBinaries[0]!);
  outputs.push({
    entityId: route.target.counterpartyEntityId,
    entityTxs: [{
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary: best.binary,
        fillRatio: best.fillRatio,
        sourceEntityId: route.source.entityId,
        sourceCounterpartyEntityId: route.source.counterpartyEntityId,
        observedAt: blockNumber,
      },
    }],
  });
  addMessage(state, `🌉 Cross-j pull args observed for ${route.orderId}; target salvage queued`);
  console.log(
    `🌉 CROSS-J: queued salvage route=${route.orderId} fill=${best.fillRatio}/65535 ` +
    `target=${route.target.counterpartyEntityId.slice(-4)}`,
  );
  return true;
}

function queueCrossJurisdictionSourceDisputeFromTargetDispute(
  env: Env,
  state: EntityState,
  outputs: EntityInput[],
  counterpartyId: string,
  initialArgumentsRaw: unknown,
): boolean {
  if (decodeDisputeCrossPullBinaries(initialArgumentsRaw).length > 0) return false;
  const route = findCrossJurisdictionRouteForTargetDispute(state, counterpartyId);
  if (!route) return false;

  const sourceUserState = findEntityStateById(env, route.source.entityId);
  const sourceAccount = sourceUserState
    ? findAccountByCounterparty(sourceUserState, route.source.counterpartyEntityId)
    : null;
  if (!sourceUserState || !sourceAccount) {
    console.warn(`🌉 CROSS-J: target dispute ${route.orderId} observed but source account is unavailable`);
    return false;
  }
  if ((sourceAccount.status ?? 'active') === 'disputed' || sourceAccount.activeDispute) return false;
  if (hasQueuedDisputeStart(sourceUserState, route.source.counterpartyEntityId)) return false;

  outputs.push({
    entityId: route.source.entityId,
    entityTxs: [
      {
        type: 'disputeStart',
        data: {
          counterpartyEntityId: route.source.counterpartyEntityId,
          description: `Cross-j target dispute ${route.orderId} forces source pull reveal`,
        },
      },
      { type: 'j_broadcast', data: {} },
    ],
  });
  addMessage(
    state,
    `🌉 Target dispute for ${route.orderId} has no pull args; source dispute queued to force hub reveal`,
  );
  return true;
}

function queueInboundResolvesByHashlock(
  newState: EntityState,
  mempoolOps: JEventMempoolOp[],
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
  mempoolOps: JEventMempoolOp[],
  outputs: EntityInput[],
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
  } else if (route.crossJurisdictionRelay) {
    const relay = route.crossJurisdictionRelay;
    outputs.push({
      entityId: relay.targetEntityId,
      entityTxs: [{
        type: 'resolveHtlcLock',
        data: {
          counterpartyEntityId: relay.targetCounterpartyEntityId,
          lockId: relay.targetLockId,
          secret,
          description: `Cross-j ${relay.routeId} target claim ${relay.fillRatio}/65535`,
        },
      }],
    });
    console.log(
      `🌉 HTLC: ${source} relayed cross-j secret route=${relay.routeId} ` +
      `target=${relay.targetEntityId.slice(-4)} ratio=${relay.fillRatio}/65535`,
    );
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
export const handleJEvent = async (entityState: EntityState, entityTxData: JEventEntityTxData, env: Env): Promise<JEventApplyResult> => {
  const { from: signerId, observedAt, blockNumber, blockHash } = entityTxData;
  if (!isValidatorSigner(entityState, signerId)) {
    throw new Error(`j_event rejected: non-validator signer ${String(signerId)}`);
  }
  type RawJEventBatchData = JEventEntityTxData & {
    events?: unknown[];
    event?: unknown;
    transactionHash?: string;
    eventsHash?: string;
    signature?: string;
  };
  const batchData = entityTxData as RawJEventBatchData;
  const rawEvents = Array.isArray(batchData.events)
    ? batchData.events
    : batchData.event !== undefined
      ? [batchData.event]
      : [];

  // ─────────────────────────────────────────────────────────────────────────────
  // Skip already-finalized blocks and reject same-height hash conflicts.
  // ─────────────────────────────────────────────────────────────────────────────
  const finalizedAtHeight = entityState.jBlockChain.find(b => b.jHeight === blockNumber);
  if (finalizedAtHeight) {
    if (finalizedAtHeight.jBlockHash !== blockHash) {
      throw new Error(
        `j_event conflict: block ${blockNumber} finalized as ${finalizedAtHeight.jBlockHash}, observed ${blockHash}`,
      );
    }
    console.log(`   ⏭️ SKIP: block ${blockNumber} already finalized`);
    return { newState: entityState, mempoolOps: [], outputs: [], dirtyAccounts: [] };
  }

  // Skip blocks at or below lastFinalizedJHeight (monotonic progress only)
  // Note: The == case is already handled above with hash conflict detection.
  if (blockNumber <= entityState.lastFinalizedJHeight) {
    console.log(`   ⏭️ SKIP: stale block (${blockNumber} <= finalized ${entityState.lastFinalizedJHeight})`);
    return { newState: entityState, mempoolOps: [], outputs: [], dirtyAccounts: [] };
  }

  // Convert raw events to canonical JurisdictionEvent format
  const jEvents: JurisdictionEvent[] = [];
  for (const raw of rawEvents) {
    const normalized = normalizeJurisdictionEvent({
      ...(raw || {}),
      blockNumber,
      blockHash,
      transactionHash:
        (typeof raw === 'object' && raw !== null && 'transactionHash' in raw && typeof (raw as { transactionHash?: unknown }).transactionHash === 'string')
          ? (raw as { transactionHash: string }).transactionHash
          : batchData.transactionHash,
    });
    if (!normalized) {
      console.warn(`⚠️ Dropping malformed j-event payload at block ${blockNumber}: ${safeStringify(raw)}`);
      continue;
    }
    jEvents.push(normalized);
  }
  if (jEvents.length === 0) {
    console.warn(`⚠️ No valid j-events after normalization for block ${blockNumber}; skipping observation`);
    return { newState: entityState, mempoolOps: [], outputs: [], dirtyAccounts: [] };
  }
  const canonicalEventsHash = canonicalJurisdictionEventsHash(jEvents);
  const suppliedEventsHash = typeof batchData.eventsHash === 'string' ? batchData.eventsHash.toLowerCase() : '';
  if (!suppliedEventsHash) {
    throw new Error(`j_event rejected: missing eventsHash for signer ${String(signerId)} block ${blockNumber}`);
  }
  if (suppliedEventsHash !== canonicalEventsHash) {
    throw new Error(
      `j_event rejected: eventsHash mismatch for signer ${String(signerId)} block ${blockNumber}`,
    );
  }

  const signature = typeof batchData.signature === 'string' ? batchData.signature : '';
  if (!signature) {
    throw new Error(`j_event rejected: missing observation signature for signer ${String(signerId)}`);
  }
  const digest = buildJEventObservationDigest({
    entityId: entityState.entityId,
    signerId: String(signerId),
    blockNumber,
    blockHash,
    transactionHash: batchData.transactionHash || '',
    eventsHash: canonicalEventsHash,
  });
  if (!verifyAccountSignature(env, String(signerId), digest, signature)) {
    throw new Error(`j_event rejected: invalid observation signature for signer ${String(signerId)}`);
  }

  // Clone state and create observation with ALL events from this batch
  let newEntityState = cloneEntityState(entityState);

  const observation: JBlockObservation = {
    signerId: normalizeSignerId(signerId),
    jHeight: blockNumber,
    jBlockHash: blockHash,
    eventsHash: canonicalEventsHash,
    events: jEvents,
    observedAt,
  };

  newEntityState.jBlockObservations.push(observation);
  console.log(`   📝 Observation from ${signerId}: ${jEvents.length} events for block ${blockNumber}`);

  // Try to finalize - with batching, single-signer entities finalize immediately
  // with ALL events from the block (no more race condition)
  const { newState, mempoolOps, outputs, dirtyAccounts } = await tryFinalizeJBlocks(newEntityState, entityState.config.threshold, env);
  newEntityState = newState;

  // DEBUG: Dump account mempools after j-event processing
  for (const [cpId, account] of newEntityState.accounts) {
    if (account.mempool.length > 0 || account.leftJObservations.length > 0 || account.rightJObservations.length > 0) {
      console.log(`🔍 AFTER-J-EVENT: Account ${cpId.slice(-4)} mempool=${account.mempool.length} txs:`, account.mempool.map((tx) => tx.type));
      console.log(`🔍 AFTER-J-EVENT: leftJObs=${account.leftJObservations?.length || 0}, rightJObs=${account.rightJObservations?.length || 0}`);
    }
  }

  if (mempoolOps.length > 0) {
    console.log(`   📦 handleJEvent: Returning ${mempoolOps.length} mempoolOps for bilateral consensus`);
  }

  // Return both newState and mempoolOps
  return { newState: newEntityState, mempoolOps, outputs, dirtyAccounts };
};

// ═══════════════════════════════════════════════════════════════════════════════
// BILATERAL J-EVENT CONSENSUS: 2-of-2 agreement on AccountSettled events
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Finalize AccountSettled when BOTH entities agree (2-of-2).
 * Called after receiving j_event_claim from counterparty.
 */
export function tryFinalizeAccountJEvents(account: AccountMachine, counterpartyId: string, opts: { timestamp: number }): void {
  const normalizeObsEvents = (obs: AccountJObservation): JurisdictionEvent[] => {
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
  const leftMap = new Map<string, AccountJObservation>();
  const rightMap = new Map<string, AccountJObservation>();

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
    if (account.jEventChain.some((b) => b.jHeight === jHeight)) continue;

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

        // Always sync onChainSettlementNonce from event — keep it accurate
        const eventNonce = event.data.nonce;
        if (eventNonce != null) {
          const eventNonceNum = Number(eventNonce);
          const prev = account.onChainSettlementNonce ?? 0;
          if (eventNonceNum > prev) {
            account.onChainSettlementNonce = eventNonceNum;
          }
        }
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
    (o) => !finalizedKeys.has(`${o.jHeight}:${o.jBlockHash}`),
  );
  account.rightJObservations = account.rightJObservations.filter(
    (o) => !finalizedKeys.has(`${o.jHeight}:${o.jBlockHash}`),
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
function mergeAccountJObservations(observations: Array<{ jHeight: number; jBlockHash: string; events: JurisdictionEvent[] }>): boolean {
  if (observations.length <= 1) return false;
  const groups = new Map<string, number>(); // key → index in observations[]
  let changed = false;
  let i = 0;
  while (i < observations.length) {
    const obs = observations[i];
    if (!obs) {
      observations.splice(i, 1);
      changed = true;
      continue;
    }
    const key = `${obs.jHeight}:${obs.jBlockHash}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      // Merge events into existing observation (dedup by type+data)
      const target = observations[existing];
      if (!target) {
        groups.delete(key);
        i++;
        continue;
      }
      const normalizedEvents = normalizeJurisdictionEvents(obs.events);
      for (const ev of normalizedEvents) {
        const evKey = canonicalJurisdictionEventKey(ev);
        const alreadyHas = target.events.some((e: JurisdictionEvent) => canonicalJurisdictionEventKey(e) === evKey);
        if (!alreadyHas) {
          target.events.push(ev);
          changed = true;
        }
      }
      observations.splice(i, 1); // Remove merged obs
      changed = true;
    } else {
      groups.set(key, i);
      i++;
    }
  }
  return changed;
}

/**
 * Merge j_event_claim mempoolOps targeting the same (accountId, jHeight, jBlockHash)
 * into a single op with all events batched.
 */
function mergeJEventClaimOps(ops: JEventMempoolOp[]): void {
  const groups = new Map<string, number>(); // key → index in ops[]
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (!op) {
      ops.splice(i, 1);
      continue;
    }
    if (!isJEventClaimOp(op)) { i++; continue; }
    const key = `${op.accountId}:${op.tx.data.jHeight}:${op.tx.data.jBlockHash}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      // Merge events into existing op
      const target = ops[existing];
      if (!target || !isJEventClaimOp(target)) {
        groups.delete(key);
        i++;
        continue;
      }
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
): Promise<JEventApplyResult> {
  const allMempoolOps: JEventMempoolOp[] = [];
  const allOutputs: EntityInput[] = [];
  const dirtyAccounts = new Set<string>();

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 1: Group observations by (height, hash, canonical events)
  // ─────────────────────────────────────────────────────────────────────────────
  // Multiple signers may observe the same block - group them together only if
  // they also agree on the relevant event set. A block hash quorum is not enough:
  // a Byzantine signer must not be able to union fake events into a finalized
  // J-block after honest signers agreed only on the block hash.
  // Key format: "height:hash:eventsHash".
  const observationGroups = new Map<string, JBlockObservation[]>();
  const signerObservationHashes = new Map<string, string>();

  for (const obs of state.jBlockObservations) {
    if (!isValidatorSigner(state, obs.signerId)) {
      throw new Error(`j_event rejected: non-validator signer ${String(obs.signerId)}`);
    }
    const signerId = normalizeSignerId(obs.signerId);
    const eventsHash = observationEventsHash(obs);
    const signerKey = `${obs.jHeight}:${obs.jBlockHash}:${signerId}`;
    const previousEventsHash = signerObservationHashes.get(signerKey);
    if (previousEventsHash && previousEventsHash !== eventsHash) {
      throw new Error(
        `j_event conflict: signer ${signerId} submitted multiple event sets for block ${obs.jHeight}:${obs.jBlockHash}`,
      );
    }
    signerObservationHashes.set(signerKey, eventsHash);
    const key = `${obs.jHeight}:${obs.jBlockHash}:${eventsHash}`;
    if (!observationGroups.has(key)) {
      observationGroups.set(key, []);
    }
    observationGroups.get(key)!.push({ ...obs, signerId, eventsHash });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 2: Check each group for threshold agreement
  // ─────────────────────────────────────────────────────────────────────────────
  const finalizedHeights: number[] = [];

  const thresholdHashesByHeight = new Map<number, Set<string>>();
  const thresholdEventHashesByBlock = new Map<string, Set<string>>();
  for (const observations of observationGroups.values()) {
    const uniqueSigners = new Set(observations.map(o => normalizeSignerId(o.signerId)));
    if (signerVotingPower(state, uniqueSigners) < threshold) continue;
    const jHeight = observations[0]!.jHeight;
    const jBlockHash = observations[0]!.jBlockHash;
    const eventsHash = observationEventsHash(observations[0]!);
    const hashes = thresholdHashesByHeight.get(jHeight) ?? new Set<string>();
    hashes.add(jBlockHash);
    thresholdHashesByHeight.set(jHeight, hashes);
    if (hashes.size > 1) {
      throw new Error(
        `j_event conflict: multiple threshold hashes for block ${jHeight}: ${Array.from(hashes).join(', ')}`,
      );
    }
    const blockKey = `${jHeight}:${jBlockHash}`;
    const eventHashes = thresholdEventHashesByBlock.get(blockKey) ?? new Set<string>();
    eventHashes.add(eventsHash);
    thresholdEventHashesByBlock.set(blockKey, eventHashes);
    if (eventHashes.size > 1) {
      throw new Error(
        `j_event conflict: multiple threshold event sets for block ${blockKey}: ${Array.from(eventHashes).join(', ')}`,
      );
    }
  }

  for (const [_key, observations] of observationGroups) {
    // Count UNIQUE signers (ignore duplicate submissions from same signer)
    const uniqueSigners = new Set(observations.map(o => normalizeSignerId(o.signerId)));
    const signerCount = uniqueSigners.size;
    const signerPower = signerVotingPower(state, uniqueSigners);

    // Does this group meet the threshold?
    if (signerPower >= threshold) {
      const jHeight = observations[0]!.jHeight;
      const jBlockHash = observations[0]!.jBlockHash;

      // ─────────────────────────────────────────────────────────────────────────
      // IDEMPOTENCY CHECK: Skip if this block height was already finalized
      // ─────────────────────────────────────────────────────────────────────────
      // This can happen if:
      // 1. Multiple observation groups exist for same height (different hashes)
      // 2. A previous iteration of this loop already finalized this height
      // 3. Block was finalized in a previous call (caught at handleJEvent entry)
      const alreadyInChain = state.jBlockChain.some(b => b.jHeight === jHeight);
      if (alreadyInChain) {
        continue;
      }

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
        const { newState, mempoolOps, outputs, dirtyAccounts: eventDirtyAccounts } = await applyFinalizedJEvent(state, event, env);
        state = newState;
        allMempoolOps.push(...mempoolOps);
        allOutputs.push(...outputs);
        for (const accountId of eventDirtyAccounts) dirtyAccounts.add(accountId);
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
      for (const [cpId, account] of state.accounts) {
        const leftChanged = mergeAccountJObservations(account.leftJObservations);
        const rightChanged = mergeAccountJObservations(account.rightJObservations);
        if (leftChanged || rightChanged) dirtyAccounts.add(String(cpId).toLowerCase());
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

  return { newState: state, mempoolOps: allMempoolOps, outputs: allOutputs, dirtyAccounts: Array.from(dirtyAccounts) };
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
): Promise<JEventApplyResult> {
  const entityShort = entityState.entityId.slice(-4);
  const blockNumber = event.blockNumber ?? 0;
  const transactionHash = event.transactionHash || 'unknown';
  const txHashShort = transactionHash.slice(0, 10) + '...';

  // Clone state for mutation
  const newState = cloneEntityState(entityState);
  const mempoolOps: JEventMempoolOp[] = [];
  const outputs: EntityInput[] = [];
  const dirtyAccounts = new Set<string>();
  const done = (): JEventApplyResult => ({
    newState,
    mempoolOps,
    outputs,
    dirtyAccounts: Array.from(dirtyAccounts),
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CANONICAL J-EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  if (event.type === 'ReserveUpdated') {
    const { entity, tokenId, newBalance } = event.data;
    const tokenIdNum = Number(tokenId);
    const tokenSymbol = getTokenSymbol(tokenIdNum);
    const decimals = getTokenDecimals(tokenIdNum);
    const balanceDisplay = (Number(newBalance) / (10 ** decimals)).toFixed(4);

    if (String(entity).toLowerCase() === String(entityState.entityId).toLowerCase()) {
      newState.reserves.set(tokenIdNum, BigInt(newBalance as string | number | bigint));
    }

    addMessage(newState, `📊 RESERVE: ${tokenSymbol} = ${balanceDisplay} | Block ${blockNumber} | Tx ${txHashShort}`);

  } else if (event.type === 'SecretRevealed') {
    const { hashlock, secret } = event.data;
    applyKnownHtlcSecret(newState, mempoolOps, outputs, String(hashlock), String(secret), blockNumber, 'SecretRevealed');

  } else if (event.type === 'AccountSettled') {
    // Universal settlement event (covers R2C, C2R, settle, rebalance)
    const { leftEntity, rightEntity, tokenId, leftReserve, rightReserve, collateral } = event.data;
    const tokenIdNum = Number(tokenId);
    const myEntityId = String(entityState.entityId).toLowerCase();
    const leftId = String(leftEntity).toLowerCase();
    const rightId = String(rightEntity).toLowerCase();
    const myIsLeft = myEntityId === leftId;
    const myIsRight = myEntityId === rightId;
    if (!myIsLeft && !myIsRight) {
      console.warn(`   ⚠️ AccountSettled not for this entity: me=${entityState.entityId.slice(-4)} left=${leftId.slice(-4)} right=${rightId.slice(-4)}`);
      return done();
    }
    const counterpartyEntityId = myIsLeft ? rightEntity : leftEntity;
    const cpShort = String(counterpartyEntityId).slice(-4);
    const ownReserve = myIsLeft ? leftReserve : rightReserve;
    const tokenSymbol = getTokenSymbol(tokenIdNum);
    const decimals = getTokenDecimals(tokenIdNum);

    // Update own reserves (entity-level, unilateral OK)
    const oldReserve = newState.reserves.get(tokenIdNum) || 0n;
    console.log(`   💰 RESERVE-UPDATE: ownReserve=${ownReserve}, old=${oldReserve}, tokenId=${tokenId}`);
    if (ownReserve) {
      const newReserve = BigInt(ownReserve as string | number | bigint);
      newState.reserves.set(tokenIdNum, newReserve);
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
      return done();
    }
    dirtyAccounts.add(String(counterpartyEntityId).toLowerCase());

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
      return done();
    }
    const normalizedClaimEvent = normalizedClaimEvents[0];
    if (!normalizedClaimEvent) return done();
    const eventCopy = structuredClone(normalizedClaimEvent);
    const observedAt = entityState.timestamp || 0;
    mempoolOps.push({
      accountId: counterpartyEntityId as string,
      tx: { type: 'j_event_claim', data: { jHeight, jBlockHash, events: [eventCopy], observedAt } },
    });
    console.log(`   📮 j_event_claim → mempoolOps[${mempoolOps.length}] (will auto-propose frame)`);
    console.log(
      `[REB][4][J_EVENT_CLAIM_QUEUED] entity=${entityState.entityId.slice(-8)} cp=${String(counterpartyEntityId).slice(-8)} token=${tokenIdNum} jHeight=${jHeight}`,
    );
    const p2p = env.runtimeState?.p2p as { sendDebugEvent?: (payload: unknown) => boolean } | undefined;
    if (typeof p2p?.sendDebugEvent === 'function') {
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
  // DEBT J-EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  } else if (event.type === 'DebtCreated') {
    const { debtor, creditor, tokenId, amount } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const amountDisplay = (Number(amount) / (10 ** decimals)).toFixed(4);
    applyDebtCreated(newState, event);

    addMessage(newState, `🔴 DEBT: ${(debtor as string).slice(-8)} owes ${amountDisplay} ${tokenSymbol} to ${(creditor as string).slice(-8)} | Block ${blockNumber}`);

  } else if (event.type === 'DebtEnforced') {
    const { creditor, tokenId, amountPaid } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const paidDisplay = (Number(amountPaid) / (10 ** decimals)).toFixed(4);
    applyDebtEnforced(newState, event);

    addMessage(newState, `✅ DEBT PAID: ${paidDisplay} ${tokenSymbol} to ${(creditor as string).slice(-8)} | Block ${blockNumber}`);

  } else if (event.type === 'DebtForgiven') {
    const { debtor, creditor, tokenId, amountForgiven, debtIndex } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const forgivenDisplay = (Number(amountForgiven) / (10 ** decimals)).toFixed(4);
    applyDebtForgiven(newState, event);

    addMessage(newState, `🩶 DEBT FORGIVEN: ${forgivenDisplay} ${tokenSymbol} between ${(debtor as string).slice(-8)} and ${(creditor as string).slice(-8)} | Block ${blockNumber} · debt #${debtIndex}`);

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
      dirtyAccounts.add(counterpartyId.toLowerCase());
      account.status = 'disputed';
      const weAreStarter = senderStr === entityIdNorm;
      const disputeEventData = event.data as typeof event.data & {
        disputeTimeout?: unknown;
        onChainNonce?: unknown;
      };
      const disputeTimeout =
        Number(disputeEventData.disputeTimeout ?? 0) ||
        (
          Number(blockNumber || 0) +
          getRuntimeJurisdictionDefaultDisputeDelayBlocks(env, newState.config.jurisdiction?.name, 5)
        );
      const onChainNonce = Number(disputeEventData.onChainNonce ?? nonce);

      // Store dispute state from event payload only.
      // Unified nonce: initialNonce = the nonce used in disputeStart (from event)
      // onChainNonce defaults to the dispute nonce when no richer event payload exists.
      account.activeDispute = {
        startedByLeft: senderStr < counterentityStr,
        initialProofbodyHash: String(proofbodyHash),  // From event (committed on-chain)
        initialNonce: Number(nonce),
        disputeTimeout,
        onChainNonce,
        initialArguments: event.data.initialArguments || '0x',
        finalizeQueued: false,
      };
      account.onChainSettlementNonce = Math.max(Number(account.onChainSettlementNonce ?? 0), onChainNonce);

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
          applyKnownHtlcSecret(newState, mempoolOps, outputs, hashlock, disputeSecret, blockNumber, 'DisputeStarted');
        }
      }
      queueCrossJurisdictionSalvageFromDispute(
        newState,
        outputs,
        counterpartyId,
        event.data.initialArguments || '0x',
        blockNumber,
      );
      queueCrossJurisdictionSourceDisputeFromTargetDispute(
        env,
        newState,
        outputs,
        counterpartyId,
        event.data.initialArguments || '0x',
      );

      addMessage(newState, `⚔️ DISPUTE ${weAreStarter ? 'STARTED' : 'vs us'} with ${counterpartyId.slice(-4)}, timeout: block ${account.activeDispute.disputeTimeout}`);
      console.log(`⚔️ activeDispute stored: hash=${account.activeDispute.initialProofbodyHash.slice(0,10)}..., timeout=${account.activeDispute.disputeTimeout}`);
      if (!weAreStarter) {
        const ops = emptyOpBreakdown();
        ops.disputeStarts = 1;
        appendBatchHistory(newState, {
          batchHash: `event:dispute-start:${String(proofbodyHash).slice(0, 12)}`,
          txHash: transactionHash || '',
          status: 'confirmed' as const,
          broadcastedAt: newState.timestamp,
          confirmedAt: newState.timestamp,
          opCount: 1,
          entityNonce: Number(nonce || 0),
          jBlockNumber: Number(blockNumber || 0),
          batch: {
            flashloans: [],
            reserveToReserve: [],
            reserveToCollateral: [],
            collateralToReserve: [],
            settlements: [],
            disputeStarts: [{
              counterentity: counterpartyId,
              nonce: Number(nonce || 0),
              proofbodyHash: String(proofbodyHash || '0x'),
              sig: '0x',
              initialArguments: String(event.data.initialArguments || '0x'),
            }],
            disputeFinalizations: [],
            externalTokenToReserve: [],
            reserveToExternalToken: [],
            revealSecrets: [],
            hub_id: 0,
          },
          operations: ops,
          source: 'counterparty-event' as const,
          eventType: 'DisputeStarted' as const,
          note: `Counterparty ${senderStr.slice(-4)} started dispute`,
        });
      }

      if (newState.crontabState) {
        const kickoffDelayMs = weAreStarter ? 1 : 5000;
        const logicalTimestamp =
          Number.isFinite(Number(newState.timestamp)) && Number(newState.timestamp) >= 0
            ? Number(newState.timestamp)
            : 0;
        scheduleCrontabHook(newState.crontabState, {
          id: `dispute-deadline:${counterpartyId.toLowerCase()}`,
          triggerAt: logicalTimestamp + kickoffDelayMs,
          type: 'dispute_deadline',
          data: { accountId: counterpartyId },
        });
        markStorageEntityDirty(env, newState.entityId);
      }
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
      dirtyAccounts.add(counterpartyId.toLowerCase());
      const weAreFinalizer = senderStr === entityIdNorm;
      const finalProofbodyHash = String(event.data.finalProofbodyHash || '0x');
      const finalizedOnChainNonce = Math.max(
        Number(account.onChainSettlementNonce ?? 0),
        Number(initialNonce || 0),
      );
      account.onChainSettlementNonce = finalizedOnChainNonce;
      if (account.activeDispute) {
        delete account.activeDispute;
        addMessage(newState, `✅ DISPUTE FINALIZED with ${counterpartyId.slice(-4)} (nonce ${Number(initialNonce)})`);
        console.log(`✅ activeDispute cleared for ${counterpartyId.slice(-4)} (proof=${String(initialProofbodyHash).slice(0, 10)}...)`);
        if (newState.crontabState) {
          cancelCrontabHook(newState.crontabState, `dispute-deadline:${counterpartyId.toLowerCase()}`);
          markStorageEntityDirty(env, newState.entityId);
        }
      } else {
        console.warn(`⚠️ DisputeFinalized: No activeDispute for ${counterpartyId.slice(-4)}`);
      }
      // Dispute completed on-chain: keep finalized-disputed until explicit reopen.
      if (account.proofHeader.nonce <= finalizedOnChainNonce) {
        account.proofHeader.nonce = finalizedOnChainNonce + 1;
      }
      account.status = 'disputed';
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
        `✅ DisputeFinalized: account moved to finalized-disputed for ${counterpartyId.slice(-4)} ` +
        `(onChainNonce=${finalizedOnChainNonce}, nextProofNonce=${account.proofHeader.nonce})`,
      );
      if (!weAreFinalizer) {
        const ops = emptyOpBreakdown();
        ops.disputeFinalizations = 1;
        appendBatchHistory(newState, {
          batchHash: `event:dispute-finalize:${String(initialProofbodyHash).slice(0, 12)}`,
          txHash: transactionHash || '',
          status: 'confirmed' as const,
          broadcastedAt: newState.timestamp,
          confirmedAt: newState.timestamp,
          opCount: 1,
          entityNonce: Number(initialNonce || 0),
          jBlockNumber: Number(blockNumber || 0),
          batch: {
            flashloans: [],
            reserveToReserve: [],
            reserveToCollateral: [],
            collateralToReserve: [],
            settlements: [],
            disputeStarts: [],
            disputeFinalizations: [{
              counterentity: counterpartyId,
              initialNonce: Number(initialNonce || 0),
              finalNonce: Number(initialNonce || 0),
              initialProofbodyHash: String(initialProofbodyHash || '0x'),
              finalProofbody: {
                offdeltas: [],
                tokenIds: [],
                transformers: [],
              },
              finalArguments: '0x',
              initialArguments: '0x',
              sig: '0x',
              startedByLeft: false,
              disputeUntilBlock: Number(blockNumber || 0),
              cooperative: false,
            }],
            externalTokenToReserve: [],
            reserveToExternalToken: [],
            revealSecrets: [],
            hub_id: 0,
          },
          operations: ops,
          source: 'counterparty-event' as const,
          eventType: 'DisputeFinalized' as const,
          note: `Counterparty ${senderStr.slice(-4)} finalized dispute`,
        });
      }

      // Drop stale local draft dispute-finalize ops for this account.
      // If the dispute is already finalized on-chain, re-broadcasting the same finalize
      // in a future mixed batch can revert the whole batch.
      const removedDraft = scrubDisputeFinalizationsForCounterparty(
        newState.jBatchState?.batch,
        candidateCounterpartyId,
      );
      const removedSent = scrubDisputeFinalizationsForCounterparty(
        newState.jBatchState?.sentBatch?.batch,
        candidateCounterpartyId,
      );
      const removed = removedDraft + removedSent;
      if (removed > 0) {
        addMessage(newState, `🧹 Removed ${removed} stale dispute-finalize op(s) for ${counterpartyId.slice(-4)}`);
        console.log(`🧹 Cleared ${removed} stale disputeFinalizations for ${counterpartyId.slice(-4)}`);
      }

      // DisputeFinalized is authoritative. Clear the off-chain component and transient holds
      // using locally stored proof-body knowledge only.
      const finalizedProofBody = finalProofbodyHash
        ? account.disputeProofBodiesByHash?.[finalProofbodyHash] as { tokenIds?: unknown[]; offdeltas?: unknown[] } | undefined
        : undefined;
      if (finalizedProofBody && Array.isArray(finalizedProofBody.tokenIds) && Array.isArray(finalizedProofBody.offdeltas)) {
        for (let i = 0; i < finalizedProofBody.tokenIds.length; i += 1) {
          const tokenId = Number(finalizedProofBody.tokenIds[i]);
          const delta = account.deltas.get(tokenId);
          if (!delta) continue;
          const prevOffdelta = delta.offdelta;
          delta.offdelta = 0n;
          delta.leftHold = 0n;
          delta.rightHold = 0n;
          delta.leftAllowance = 0n;
          delta.rightAllowance = 0n;
          if (prevOffdelta !== 0n) {
            console.log(
              `💰 DisputeFinalized local sync: ${counterpartyId.slice(-4)} token=${tokenId} offdelta ${prevOffdelta}→0`,
            );
          }
        }
      } else {
        console.warn(
          `⚠️ DisputeFinalized local sync missing proof body for ${counterpartyId.slice(-4)}; clearing all token deltas conservatively`,
        );
        for (const [tokenId, delta] of account.deltas.entries()) {
          const prevOffdelta = delta.offdelta;
          delta.offdelta = 0n;
          delta.leftHold = 0n;
          delta.rightHold = 0n;
          delta.leftAllowance = 0n;
          delta.rightAllowance = 0n;
          if (prevOffdelta !== 0n) {
            console.log(
              `💰 DisputeFinalized local sync: ${counterpartyId.slice(-4)} token=${tokenId} offdelta ${prevOffdelta}→0`,
            );
          }
        }
      }

      // Drop off-chain intents from pre-dispute epoch.
      if (account.swapOffers.size > 0) {
        const staleOffers = account.swapOffers.size;
        account.swapOffers.clear();
        console.log(`🧹 DisputeFinalized cleanup: cleared ${staleOffers} stale swap offer(s) for ${counterpartyId.slice(-4)}`);
      }
      if (account.locks.size > 0) {
        const staleLocks = account.locks.size;
        account.locks.clear();
        console.log(`🧹 DisputeFinalized cleanup: cleared ${staleLocks} stale lock(s) for ${counterpartyId.slice(-4)}`);
      }
    } else {
      console.warn(`⚠️ DisputeFinalized: account ${candidateCounterpartyId.slice(-4)} not found for entity ${entityIdNorm.slice(-4)}`);
    }

  } else if (event.type === 'HankoBatchProcessed') {
    // jBatch finalization event - confirms our batch was processed on-chain
    const { entityId: batchEntityId, hankoHash, nonce, success } = event.data as { entityId: string; hankoHash: string; nonce: number; success: boolean };

    // Only process if this is our batch (case-insensitive: adapters may normalize differently).
    if (String(batchEntityId || '').toLowerCase() !== String(newState.entityId || '').toLowerCase()) {
      console.log(`   ⏭️ HankoBatchProcessed: Not our batch (${String(batchEntityId).slice(-4)} != ${entityShort})`);
      return done();
    }

    console.log(`📦 HankoBatchProcessed: nonce=${nonce}, success=${success}, hanko=${String(hankoHash).slice(0, 10)}...`);

    if (success) {
      if (newState.jBatchState) {
        const { batchOpCount: countOps, batchOpBreakdown, isBatchEmpty, cloneJBatch } = await import('../j-batch');
        const sentBatch = newState.jBatchState.sentBatch;
        const opCount = sentBatch ? countOps(sentBatch.batch) : 0;
        const opBreakdown = sentBatch ? batchOpBreakdown(sentBatch.batch) : undefined;
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
          return done();
        }

        // Record completed batch in history (keep last 20)
        appendBatchHistory(newState, {
          batchHash: sentBatch?.batchHash || '',
          txHash: sentBatch?.txHash || transactionHash || '',
          status: 'confirmed' as const,
          broadcastedAt: sentBatch?.lastSubmittedAt || newState.jBatchState.lastBroadcast || 0,
          confirmedAt: newState.timestamp,
          opCount,
          entityNonce: Number(nonce),
          jBlockNumber: Number(blockNumber || 0),
          ...(sentBatch?.batch ? { batch: cloneJBatch(sentBatch.batch) } : {}),
          ...(opBreakdown ? { operations: opBreakdown } : {}),
          source: 'self-batch' as const,
        });

        // Clear sent batch for next cycle.
        delete newState.jBatchState.sentBatch;
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
        const { batchOpCount: countOps, batchOpBreakdown, isBatchEmpty, mergeBatchOps, cloneJBatch } = await import('../j-batch');
        const sentBatch = newState.jBatchState.sentBatch;
        const opCount = sentBatch ? countOps(sentBatch.batch) : 0;
        const opBreakdown = sentBatch ? batchOpBreakdown(sentBatch.batch) : undefined;
        newState.jBatchState.status = 'failed';
        newState.jBatchState.failedAttempts++;
        // Keep nonce synchronized to finalized event nonce.
        const currentNonce = Number(newState.jBatchState.entityNonce || 0);
        const eventNonceNum = Number(nonce || 0);
        newState.jBatchState.entityNonce = eventNonceNum > currentNonce ? eventNonceNum : currentNonce;

        appendBatchHistory(newState, {
          batchHash: sentBatch?.batchHash || '',
          txHash: sentBatch?.txHash || transactionHash || '',
          status: 'failed' as const,
          broadcastedAt: sentBatch?.lastSubmittedAt || newState.jBatchState.lastBroadcast || 0,
          confirmedAt: newState.timestamp,
          opCount,
          entityNonce: Number(nonce),
          jBlockNumber: Number(blockNumber || 0),
          ...(sentBatch?.batch ? { batch: cloneJBatch(sentBatch.batch) } : {}),
          ...(opBreakdown ? { operations: opBreakdown } : {}),
          source: 'self-batch' as const,
        });

        // Requeue failed sentBatch ops back to current batch so operator can rebroadcast
        // with fresh nonce in the next cycle.
        if (sentBatch) {
          const requeueBatch = cloneJBatch(sentBatch.batch);
          const { removed, droppedCounterparties } = filterActiveDisputeFinalizations(newState, requeueBatch);
          if (removed > 0) {
            addMessage(newState, `🧹 Filtered ${removed} stale dispute-finalize op(s) from failed batch requeue`);
          }
          mergeBatchOps(newState.jBatchState.batch, requeueBatch);
          for (const fin of requeueBatch.disputeFinalizations || []) {
            const accountEntry = findAccountEntryByCounterparty(newState, String(fin.counterentity || ''));
            const account = accountEntry?.[1];
            if (account?.activeDispute) {
              account.activeDispute.finalizeQueued = false;
              dirtyAccounts.add(String(accountEntry?.[0] || fin.counterentity || '').toLowerCase());
            }
          }
          for (const counterpartyId of droppedCounterparties) {
            const accountEntry = findAccountEntryByCounterparty(newState, counterpartyId);
            const account = accountEntry?.[1];
            if (account?.activeDispute) {
              account.activeDispute.finalizeQueued = false;
              dirtyAccounts.add(String(accountEntry?.[0] || counterpartyId).toLowerCase());
            }
          }
        }
        delete newState.jBatchState.sentBatch;
        newState.jBatchState.status = isBatchEmpty(newState.jBatchState.batch) ? 'failed' : 'accumulating';
      }
      // Batch is atomic on-chain; success=false means none of its ops applied.
      // Unfreeze submitted rebalance requests so hub can retry in next crontab tick.
      for (const [accountId, account] of newState.accounts.entries()) {
        if (!account.requestedRebalanceFeeState) continue;
        for (const feeState of account.requestedRebalanceFeeState.values()) {
          if ((feeState.jBatchSubmittedAt || 0) > 0) {
            feeState.jBatchSubmittedAt = 0;
            dirtyAccounts.add(String(accountId).toLowerCase());
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

  return done();
}
