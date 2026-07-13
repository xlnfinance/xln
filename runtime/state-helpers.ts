/**
 * XLN State Management Helpers
 * Utilities for entity replica cloning, snapshots, and state persistence
 */

import type {
  AccountFrame,
  AccountMachine,
  AccountSettleAction,
  AccountTx,
  DebtEntry,
  EntityReplica,
  EntityState,
  Env,
  LendingLoan,
  LendingPoolPosition,
  LendingState,
  LogCategory,
} from './types';
import type { DisputeArgumentSnapshot } from './protocol/dispute/arguments';
import type { ProofBodyStruct } from '../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { HEAVY_LOGS } from './utils';
import { validateEntityReplica, validateEntityState } from './validation-utils';
import { safeStringify } from './protocol/serialization';
import { isLeftEntity } from './entity/id';
import { getAccountFrameHistoryView, setAccountFrameHistoryView } from './machine/env-events';
import { getCachedSignerPrivateKey } from './account/crypto';
import { cloneJBatch, type CompletedBatch, type JBatchState } from './jurisdiction/batch';
import {
  cloneCrossJurisdictionBookAdmission,
  cloneCrossJurisdictionAccountFrameRoute,
  cloneCrossJurisdictionAccountTxRoute,
  cloneCrossJurisdictionAccountInputRoute,
  cloneCrossJurisdictionRoute,
  cloneCrossJurisdictionPullBinding,
  cloneCrossJurisdictionSwapHistoryRoute,
  cloneCrossJurisdictionSwapOfferRoute,
} from './extensions/cross-j/index';
import type { CrontabState, ScheduledHook } from './entity/scheduler-types';
import type { Profile } from './networking/gossip';
import { createStructuredLogger } from './infra/logger';
import { getEntityLeaderState, isEntityActiveLeader } from './entity/consensus/leader';

const stateHelperLog = createStructuredLogger('state.helpers');
import type {
  BookOrderState,
  BookState,
  HubProfile,
  OrderbookExtState,
  PriceBucketState,
  PriceLevelState,
} from './orderbook';

const cloneAccountTxForState = <T extends AccountTx>(tx: T): T => {
  const cloned = structuredClone(tx) as T;
  return cloneCrossJurisdictionAccountTxRoute(cloned) as T;
};

const cloneCrossJurisdictionRoutesInState = (state: EntityState, source: EntityState = state): void => {
  if (source.crossJurisdictionSwaps) {
    state.crossJurisdictionSwaps = new Map(
      Array.from(source.crossJurisdictionSwaps.entries()).map(([id, route]) => [
        id,
        cloneCrossJurisdictionRoute(route),
      ]),
    );
  }
  if (source.pendingCrossJurisdictionFillAcks) {
    state.pendingCrossJurisdictionFillAcks = new Map(
      Array.from(source.pendingCrossJurisdictionFillAcks.entries()).map(([id, pending]) => [
        id,
        {
          ...pending,
          tx: cloneAccountTxForState(pending.tx) as typeof pending.tx,
        },
      ]),
    );
  }
  if (source.crossJurisdictionBookAdmissions) {
    state.crossJurisdictionBookAdmissions = new Map(
      Array.from(source.crossJurisdictionBookAdmissions.entries()).map(([id, admission]) => [
        id,
        cloneCrossJurisdictionBookAdmission(admission),
      ]),
    );
  }
};

const cloneCrossJurisdictionRoutesInAccount = (account: AccountMachine, source: AccountMachine = account): void => {
  account.mempool = (source.mempool ?? []).map(cloneAccountTxForState);
  account.currentFrame = cloneCrossJurisdictionAccountFrameRoute(source.currentFrame);
  if (source.pendingFrame) account.pendingFrame = cloneCrossJurisdictionAccountFrameRoute(source.pendingFrame);
  if (source.pendingAccountInput) {
    account.pendingAccountInput = cloneCrossJurisdictionAccountInputRoute(source.pendingAccountInput);
  }
  account.swapOffers = new Map(
    Array.from((source.swapOffers ?? new Map()).entries()).map(([id, offer]) => [
      id,
      cloneCrossJurisdictionSwapOfferRoute(offer),
    ]),
  );
  account.pulls = new Map(
    Array.from((source.pulls ?? new Map()).entries()).map(([id, pull]) => [
      id,
      pull.crossJurisdiction
        ? { ...pull, crossJurisdiction: cloneCrossJurisdictionPullBinding(pull.crossJurisdiction) }
        : { ...pull },
    ]),
  );
  if (source.swapOrderHistory instanceof Map) {
    account.swapOrderHistory = new Map(
      Array.from(source.swapOrderHistory.entries()).map(([id, entry]) => [
        id,
        cloneCrossJurisdictionSwapHistoryRoute(entry),
      ]),
    );
  }
  if (source.swapClosedOrders instanceof Map) {
    account.swapClosedOrders = new Map(
      Array.from(source.swapClosedOrders.entries()).map(([id, entry]) => [
        id,
        cloneCrossJurisdictionSwapHistoryRoute(entry),
      ]),
    );
  }
};

// Message size limit for snapshot efficiency
const MESSAGE_LIMIT = 10;

/**
 * CANONICAL ACCOUNT KEY: Bilateral accounts stored in sorted form (left < right)
 * Pattern from Channel.ts - ensures both entities reference SAME account object
 */
export function canonicalAccountKey(entity1: string, entity2: string): string {
  return isLeftEntity(entity1, entity2) ? `${entity1}:${entity2}` : `${entity2}:${entity1}`;
}

/**
 * Get account perspective: Am I left or right? Derive from/to for current operation.
 */
export function getAccountPerspective(account: AccountMachine, myEntityId: string): {
  iAmLeft: boolean;
  from: string;
  to: string;
  counterparty: string;
} {
  const iAmLeft = myEntityId === account.leftEntity;
  return {
    iAmLeft,
    from: iAmLeft ? account.leftEntity : account.rightEntity,
    to: iAmLeft ? account.rightEntity : account.leftEntity,
    counterparty: iAmLeft ? account.rightEntity : account.leftEntity,
  };
}

/**
 * Add message to EntityState with automatic size limiting
 * Prevents unbounded message array growth that causes snapshot bloat
 */
export function addMessage(state: EntityState, message: string): void {
  state.messages.push(message);
  if (state.messages.length > MESSAGE_LIMIT) {
    state.messages.shift(); // Remove oldest message
  }
}

/**
 * Add multiple messages with size limiting
 */
export function addMessages(state: EntityState, messages: string[]): void {
  for (const msg of messages) {
    addMessage(state, msg);
  }
}

type FingerprintableTx = {
  type: string;
  data?: unknown;
};

export function txFingerprint(tx: FingerprintableTx): string {
  return `${tx.type}:${safeStringify(tx.data)}`;
}

export function removeCommittedTxsFromMempool<T extends FingerprintableTx>(
  mempool: T[],
  committedTxs: readonly T[],
): T[] {
  if (committedTxs.length === 0 || mempool.length === 0) return mempool;
  const pendingRemovals = new Map<string, number>();
  for (const tx of committedTxs) {
    const fp = txFingerprint(tx);
    pendingRemovals.set(fp, (pendingRemovals.get(fp) ?? 0) + 1);
  }
  return mempool.filter((tx) => {
    const fp = txFingerprint(tx);
    const remaining = pendingRemovals.get(fp) ?? 0;
    if (remaining <= 0) return true;
    if (remaining === 1) pendingRemovals.delete(fp);
    else pendingRemovals.set(fp, remaining - 1);
    return false;
  });
}

const cloneJBatchState = (state: JBatchState): JBatchState => {
  const cloned: JBatchState = {
    batch: cloneJBatch(state.batch),
    jurisdiction: state.jurisdiction,
    lastBroadcast: state.lastBroadcast,
    broadcastCount: state.broadcastCount,
    failedAttempts: state.failedAttempts,
    status: state.status,
  };
  if (state.sentBatch) {
    cloned.sentBatch = {
      ...state.sentBatch,
      batch: cloneJBatch(state.sentBatch.batch),
    };
  }
  if (state.entityNonce !== undefined) {
    cloned.entityNonce = state.entityNonce;
  }
  return cloned;
};

const cloneAccountSettleAction = (action: AccountSettleAction): AccountSettleAction => {
  const cloned: AccountSettleAction = { type: action.type };
  if (action.ops) cloned.ops = action.ops.map((op) => ({ ...op }));
  if (action.executorIsLeft !== undefined) cloned.executorIsLeft = action.executorIsLeft;
  if (action.hanko !== undefined) cloned.hanko = action.hanko;
  if (action.memo !== undefined) cloned.memo = action.memo;
  if (action.version !== undefined) cloned.version = action.version;
  if (action.nonceAtSign !== undefined) cloned.nonceAtSign = action.nonceAtSign;
  return cloned;
};

/**
 * Emit structured events with a scoped path for time-travel debugging.
 * This keeps per-frame logs queryable without bloating state.messages.
 */
export function emitScopedEvents(
  env: Env,
  category: LogCategory,
  scope: string,
  messages: string[],
  data: Record<string, unknown> = {},
  entityId?: string,
): void {
  if (!messages || messages.length === 0) return;

  const payload = { path: scope, ...data };
  for (const message of messages) {
    env.info(category, message, payload, entityId);
  }
}

/**
 * Resolve the proposer signerId for a given entity.
 * Prefers local proposer replica, then exact local replica signer, then local
 * config validators[0], then gossip board[0].
 * Throws if no signer can be resolved (fail early).
 */
export function resolveEntityProposerId(env: Env, entityId: string, context: string): string {
  const targetEntityId = String(entityId || '').toLowerCase();
  let localKeyReplicaFallback: string | null = null;
  let configFallback: string | null = null;
  let gossipFallback: string | null = null;

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const keyParts = String(replicaKey).split(':');
    const keyEntityId = String(keyParts[0] || '').toLowerCase();
    const replicaEntityId = String(replica.entityId || '').toLowerCase();
    if (replicaEntityId !== targetEntityId && keyEntityId !== targetEntityId) continue;
    const replicaSignerId = String(replica.signerId || keyParts[1] || '').trim();
    const configuredValidators = replica.state.config.validators || [];
    if (isEntityActiveLeader(replica) && replicaSignerId && getCachedSignerPrivateKey(replicaSignerId)) return replicaSignerId;
    if (!localKeyReplicaFallback && replicaSignerId && getCachedSignerPrivateKey(replicaSignerId)) {
      localKeyReplicaFallback = replicaSignerId;
    }
    if (!configFallback) {
      configFallback = getEntityLeaderState(replica.state).activeValidatorId || configuredValidators[0] || null;
    }
  }

  if (env.gossip?.getProfiles) {
    const profile = (env.gossip.getProfiles() as Profile[]).find(
      (p) => String(p.entityId || '').toLowerCase() === targetEntityId,
    );
    const board = profile?.metadata.board;
    if (board && Array.isArray(board.validators) && board.validators.length > 0) {
      const first = board.validators[0];
      gossipFallback = first?.signerId || first?.signer || null;
    }
  }

  if (localKeyReplicaFallback) return localKeyReplicaFallback;
  if (configFallback && getCachedSignerPrivateKey(configFallback)) return configFallback;
  if (gossipFallback) return gossipFallback;
  if (configFallback) return configFallback;

  throw new Error(`SIGNER_RESOLUTION_FAILED: ${context} entityId=${entityId}`);
}

// === CLONING UTILITIES ===
export const cloneMap = <K, V>(map: Map<K, V>) => new Map(map);
export const cloneArray = <T>(arr: T[]) => [...arr];

const cloneExternalWalletState = (
  state: NonNullable<EntityState['externalWallet']>,
): NonNullable<EntityState['externalWallet']> => ({
  balances: new Map(
    Array.from(state.balances.entries()).map(([owner, balances]) => [
      owner,
      new Map(Array.from(balances.entries()).map(([key, value]) => [key, { ...value }])),
    ]),
  ),
  allowances: new Map(
    Array.from(state.allowances.entries()).map(([owner, allowances]) => [
      owner,
      new Map(Array.from(allowances.entries()).map(([key, value]) => [key, { ...value }])),
    ]),
  ),
});

const cloneDebtEntry = (entry: DebtEntry): DebtEntry => ({
  ...entry,
  updates: entry.updates.map((update) => ({ ...update })),
});

const cloneDebtLedger = (
  ledger: Map<number, Map<string, DebtEntry>>,
): Map<number, Map<string, DebtEntry>> => {
  return new Map(
    Array.from(ledger.entries()).map(([tokenId, debtMap]) => [
      tokenId,
      new Map(
        Array.from(debtMap.entries()).map(([debtId, entry]) => [debtId, cloneDebtEntry(entry)]),
      ),
    ]),
  );
};

const cloneLendingPoolPosition = (position: LendingPoolPosition): LendingPoolPosition => ({
  ...position,
});

const cloneLendingLoan = (loan: LendingLoan): LendingLoan => ({
  ...loan,
});

const cloneLendingState = (lending: LendingState): LendingState => ({
  pools: new Map(
    Array.from(lending.pools.entries()).map(([positionId, position]) => [
      positionId,
      cloneLendingPoolPosition(position),
    ]),
  ),
  loans: new Map(
    Array.from(lending.loans.entries()).map(([loanId, loan]) => [
      loanId,
      cloneLendingLoan(loan),
    ]),
  ),
});

export function cloneAccountFrame(frame: AccountFrame): AccountFrame {
  try {
    return structuredClone(frame);
  } catch {
    const accountTxs = frame.accountTxs.map(
      (tx): AccountTx => ({ ...tx, data: tx.data ? structuredClone(tx.data) : tx.data }) as AccountTx,
    );
    return {
      ...frame,
      accountTxs,
      deltas: frame.deltas.map((delta) => ({ ...delta })),
    };
  }
}

const isProofBodyStructLike = (value: unknown): value is ProofBodyStruct => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate['offdeltas']) &&
    Array.isArray(candidate['tokenIds']) &&
    Array.isArray(candidate['transformers'])
  );
};

const cloneProofBodyStruct = (proofBody: unknown): unknown => {
  if (!isProofBodyStructLike(proofBody)) return proofBody;
  return {
    watchSeed: proofBody.watchSeed,
    offdeltas: [...proofBody.offdeltas],
    tokenIds: [...proofBody.tokenIds],
    transformers: proofBody.transformers.map((transformer) => ({
      transformerAddress: transformer.transformerAddress,
      encodedBatch: transformer.encodedBatch,
      allowances: transformer.allowances.map((allowance) => ({ ...allowance })),
    })),
  } satisfies ProofBodyStruct;
};

const cloneDisputeArgumentSnapshot = (
  snapshot: DisputeArgumentSnapshot,
): DisputeArgumentSnapshot => ({
  proofbodyHash: snapshot.proofbodyHash,
  nonce: snapshot.nonce,
  side: snapshot.side,
  proofBodyStruct: cloneProofBodyStruct(snapshot.proofBodyStruct) as ProofBodyStruct,
  ...(snapshot.appliedFrameHeight !== undefined ? { appliedFrameHeight: snapshot.appliedFrameHeight } : {}),
  plan: {
    paymentHashlocks: [...snapshot.plan.paymentHashlocks],
    leftSwapOfferIds: [...snapshot.plan.leftSwapOfferIds],
    rightSwapOfferIds: [...snapshot.plan.rightSwapOfferIds],
    leftPullIds: [...snapshot.plan.leftPullIds],
    rightPullIds: [...snapshot.plan.rightPullIds],
  },
  ...(snapshot.appliedSwapFillFingerprints
    ? { appliedSwapFillFingerprints: [...snapshot.appliedSwapFillFingerprints] }
    : {}),
});

const cloneDisputeEvidenceIntoAccount = (
  target: AccountMachine,
  source: AccountMachine,
): void => {
  // These two maps deliberately contain different evidence:
  // - disputeProofBodiesByHash is signed-state evidence revealed to Solidity.
  // - disputeArgumentSnapshotsByHash is runtime-only positional calldata plan.
  //
  // Never let a generic clone preserve shared object aliases between them. A
  // corrupted clone can make a proof-body lookup return a snapshot object, which
  // then disables counter-dispute finalization or pairs wrong arguments with a
  // signed proof.
  if (source.disputeProofBodiesByHash) {
    target.disputeProofBodiesByHash = Object.fromEntries(
      Object.entries(source.disputeProofBodiesByHash).map(([hash, proofBody]) => [
        hash,
        cloneProofBodyStruct(proofBody),
      ]),
    );
  } else {
    delete target.disputeProofBodiesByHash;
  }
  if (source.disputeArgumentSnapshotsByHash) {
    target.disputeArgumentSnapshotsByHash = Object.fromEntries(
      Object.entries(source.disputeArgumentSnapshotsByHash).map(([hash, snapshot]) => [
        hash,
        cloneDisputeArgumentSnapshot(snapshot),
      ]),
    );
  } else {
    delete target.disputeArgumentSnapshotsByHash;
  }
};

const cloneBatchHistoryEntry = (entry: CompletedBatch): CompletedBatch => {
  const cloned: CompletedBatch = { ...entry };
  if (entry.batch) {
    cloned.batch = cloneJBatch(entry.batch);
  }
  if (entry.operations) {
    cloned.operations = { ...entry.operations };
  }
  return cloned;
};

/**
 * Creates a safe deep clone of entity state with guaranteed jBlock preservation
 * This prevents the jBlock corruption bugs that occur with manual state spreading
 */
export function cloneEntityState(entityState: EntityState, forSnapshot: boolean = false): EntityState {
  let cloned: EntityState;

  // Use structuredClone for deep cloning with fallback.
  try {
    cloned = structuredClone(entityState);
  } catch (error) {
    const manual = manualCloneEntityState(entityState, forSnapshot);

    // VALIDATE AT SOURCE: Guarantee type safety from manual clone path too.
    return validateEntityState(manual, 'cloneEntityState.manual');
  }

  // CRITICAL: Validate entityId was preserved correctly.
  if (!cloned.entityId || cloned.entityId !== entityState.entityId) {
    stateHelperLog.error('clone.entity_state.entity_id_corrupt', {
      original: entityState.entityId,
      cloned: cloned.entityId,
    });
    throw new Error('cloneEntityState failed: entityId was not preserved');
  }

  // CRITICAL: Validate lastFinalizedJHeight was preserved correctly.
  if (typeof cloned.lastFinalizedJHeight !== 'number') {
    stateHelperLog.error('clone.entity_state.last_finalized_j_height_corrupt', {
      original: entityState.lastFinalizedJHeight,
      originalType: typeof entityState.lastFinalizedJHeight,
      cloned: cloned.lastFinalizedJHeight,
      clonedType: typeof cloned.lastFinalizedJHeight,
    });
    throw new Error('cloneEntityState failed: lastFinalizedJHeight was not preserved');
  }

  // For snapshots, remove clonedForValidation from all accounts to avoid cycles.
  if (forSnapshot) {
    for (const account of cloned.accounts.values()) {
      delete account.clonedForValidation;
    }
  }

  if (entityState.jBatchState && !cloned.jBatchState) {
    cloned.jBatchState = cloneJBatchState(entityState.jBatchState);
  }
  if (entityState.lending) {
    cloned.lending = cloneLendingState(entityState.lending);
  }
  cloneCrossJurisdictionRoutesInState(cloned, entityState);
  for (const [accountId, account] of cloned.accounts.entries()) {
    const sourceAccount = entityState.accounts.get(accountId);
    if (sourceAccount) cloneDisputeEvidenceIntoAccount(account, sourceAccount);
    cloneCrossJurisdictionRoutesInAccount(account, sourceAccount ?? account);
  }

  // VALIDATE AT SOURCE: Guarantee type safety from this point forward.
  return validateEntityState(cloned, 'cloneEntityState.structuredClone');
}

/**
 * Manual entity state cloning with explicit jBlock preservation
 * Fallback for environments that don't support structuredClone
 */
function manualCloneEntityState(entityState: EntityState, forSnapshot: boolean = false): EntityState {
  return {
    ...entityState,
    entityId: entityState.entityId, // CRITICAL: Explicitly preserve entityId
    nonces: cloneMap(entityState.nonces),
    messages: cloneArray(entityState.messages),
    proposals: new Map(
      Array.from(entityState.proposals.entries()).map(([id, proposal]) => [
        id,
        { ...proposal, votes: cloneMap(proposal.votes) },
      ]),
    ),
    reserves: cloneMap(entityState.reserves),
    accounts: new Map(
      Array.from(entityState.accounts.entries()).map(([id, account]) => [
        id,
        cloneAccountMachine(account, forSnapshot), // forSnapshot excludes clonedForValidation
      ]),
    ),
    ...(entityState.externalWallet ? { externalWallet: cloneExternalWalletState(entityState.externalWallet) } : {}),
    deferredAccountProposals: cloneMap(entityState.deferredAccountProposals || new Map()),
    accountInputQueue: cloneArray(entityState.accountInputQueue || []),
    ...(entityState.jBatchState ? { jBatchState: cloneJBatchState(entityState.jBatchState) } : {}),
    ...(Array.isArray(entityState.batchHistory)
      ? { batchHistory: entityState.batchHistory.map((entry) => cloneBatchHistoryEntry(entry as CompletedBatch)) }
      : {}),
    // JBlock consensus state
    lastFinalizedJHeight: entityState.lastFinalizedJHeight,
    jBlockObservations: cloneArray(entityState.jBlockObservations || []),
    jBlockChain: cloneArray(entityState.jBlockChain || []),
    jHistoryCheckpoints: cloneArray(entityState.jHistoryCheckpoints || []),
    ...(entityState.jHistoryFinality
      ? { jHistoryFinality: structuredClone(entityState.jHistoryFinality) }
      : {}),
    // Crontab state is part of entity state, but it remains declarative:
    // task metadata + scheduled hooks only. Handlers are rebound from the static
    // registry in entity-crontab.ts, so clone/persistence must preserve the data
    // and never try to serialize executable functions.
    ...(entityState.crontabState ? { crontabState: cloneCrontabState(entityState.crontabState) } : {}),
    // HTLC routing table (deep clone)
    htlcRoutes: new Map(
      Array.from((entityState.htlcRoutes || new Map()).entries()).map(([hashlock, route]) => [
        hashlock,
        { ...route } // Clone route object
      ])
    ),
    htlcNotes: new Map(Array.from((entityState.htlcNotes || new Map()).entries())),
    htlcFeesEarned: entityState.htlcFeesEarned || 0n,
    ...(entityState.outDebtsByToken ? { outDebtsByToken: cloneDebtLedger(entityState.outDebtsByToken) } : {}),
    ...(entityState.inDebtsByToken ? { inDebtsByToken: cloneDebtLedger(entityState.inDebtsByToken) } : {}),
    ...(entityState.lending ? { lending: cloneLendingState(entityState.lending) } : {}),
    // Orderbook extension (hub-only, contains TypedArrays)
    // Must manually clone since structuredClone failed (we're in fallback path)
    ...(entityState.orderbookExt && { orderbookExt: cloneOrderbookExt(entityState.orderbookExt) }),
    lockBook: new Map(
      Array.from((entityState.lockBook || new Map()).entries()).map(([id, entry]) => [
        id,
        { ...entry }
      ])
    ),
    ...(Array.isArray(entityState.swapTradingPairs)
      ? { swapTradingPairs: entityState.swapTradingPairs.map((pair) => ({ ...pair })) }
      : {}),
    ...(entityState.pendingSwapFillRatios
      ? { pendingSwapFillRatios: new Map(Array.from(entityState.pendingSwapFillRatios.entries())) }
      : {}),
    ...(entityState.crossJurisdictionSwaps
      ? { crossJurisdictionSwaps: new Map(Array.from(entityState.crossJurisdictionSwaps.entries()).map(([id, route]) => [id, cloneCrossJurisdictionRoute(route)])) }
      : {}),
    ...(entityState.pendingCrossJurisdictionFillAcks
      ? {
          pendingCrossJurisdictionFillAcks: new Map(
            Array.from(entityState.pendingCrossJurisdictionFillAcks.entries()).map(([id, pending]) => [
              id,
              {
                ...pending,
                tx: cloneAccountTxForState(pending.tx) as typeof pending.tx,
              },
            ]),
          ),
        }
      : {}),
    ...(entityState.crossJurisdictionBookAdmissions
      ? { crossJurisdictionBookAdmissions: new Map(Array.from(entityState.crossJurisdictionBookAdmissions.entries()).map(([id, admission]) => [id, cloneCrossJurisdictionBookAdmission(admission)])) }
      : {}),
  };
}

function cloneCrontabState(crontabState: CrontabState): CrontabState {
  return {
    tasks: new Map(
      Array.from(crontabState.tasks.entries()).map(([method, task]) => [
        method,
        {
          method: task.method,
          intervalMs: task.intervalMs,
          lastRun: task.lastRun,
          enabled: task.enabled,
          params: { ...task.params },
        },
      ]),
    ),
    hooks: new Map(
      Array.from(crontabState.hooks.entries()).map(([hookId, hook]) => [
        hookId,
        cloneScheduledHook(hook),
      ]),
    ),
  };
}

function cloneScheduledHook(hook: ScheduledHook): ScheduledHook {
  switch (hook.type) {
    case 'htlc_timeout':
      return { ...hook, data: { ...hook.data } };
    case 'dispute_deadline':
      return { ...hook, data: { ...hook.data } };
    case 'htlc_secret_ack_timeout':
      return { ...hook, data: { ...hook.data } };
    case 'settlement_window':
      return { ...hook, data: {} };
    case 'watchdog':
      return { ...hook, data: {} };
    case 'hub_rebalance_kick':
      return { ...hook, data: { ...hook.data } };
    case 'cross_j_orderbook_sweep':
      return { ...hook, data: { ...hook.data } };
  }
}

/**
 * Manually clone OrderbookExtState for environments without structuredClone
 * TypedArrays must be explicitly copied via their constructors
 */
function cloneOrderbookExt(ext: NonNullable<EntityState['orderbookExt']>): OrderbookExtState {
  const clonedBooks = new Map<string, BookState>();
  for (const [key, book] of ext.books) {
    clonedBooks.set(key, cloneBookState(book));
  }

  const clonedOrderPairs = new Map<string, string[]>();
  for (const [orderId, pairIds] of ext.orderPairs ?? []) {
    clonedOrderPairs.set(orderId, [...pairIds]);
  }

  // Clone referrals Map
  const clonedReferrals = new Map<string, OrderbookExtState['referrals'] extends Map<string, infer T> ? T : never>();
  if (ext.referrals) {
    for (const [key, referral] of ext.referrals) {
      clonedReferrals.set(key, { ...referral });
    }
  }

  // Clone hubProfile with nested arrays
  const clonedHubProfile: HubProfile = {
    ...ext.hubProfile,
    supportedPairs: [...ext.hubProfile.supportedPairs],
  };

  return {
    books: clonedBooks,
    orderPairs: clonedOrderPairs,
    referrals: clonedReferrals,
    hubProfile: clonedHubProfile,
  };
}

function cloneBookState(book: BookState): BookState {
  const cloneBucketMap = (source: Map<string, PriceBucketState>): Map<string, PriceBucketState> => {
    const cloned = new Map<string, PriceBucketState>();
    for (const [key, bucket] of source.entries()) {
      const clonedLevels = new Map<string, PriceLevelState>();
      for (const [levelKey, level] of bucket.levels.entries()) {
        clonedLevels.set(levelKey, {
          priceTicks: level.priceTicks,
          orderIds: [...level.orderIds],
          totalQtyLots: level.totalQtyLots,
        });
      }
      cloned.set(key, {
        bucketId: bucket.bucketId,
        pricesAsc: [...bucket.pricesAsc],
        levels: clonedLevels,
      });
    }
    return cloned;
  };

  return {
    ...book,
    params: { ...book.params },
    orders: new Map<string, BookOrderState>(Array.from(book.orders.entries()).map(([orderId, order]) => [orderId, { ...order }])),
    bidBuckets: cloneBucketMap(book.bidBuckets),
    askBuckets: cloneBucketMap(book.askBuckets),
    bidBucketIdsDesc: [...book.bidBucketIdsDesc],
    askBucketIdsAsc: [...book.askBucketIdsAsc],
  };
}

/**
 * Deep clone entity replica with all nested state properly cloned
 * Uses cloneEntityState as the entry point for state cloning
 */
export const cloneEntityReplica = (replica: EntityReplica, forSnapshot: boolean = false): EntityReplica => {
  return validateEntityReplica({
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: cloneEntityState(replica.state, forSnapshot), // forSnapshot excludes clonedForValidation
    mempool: Array.isArray(replica.mempool) ? cloneArray(replica.mempool) : [],
    ...(replica.proposal && {
      proposal: {
        height: replica.proposal.height,
        txs: cloneArray(replica.proposal.txs),
        hash: replica.proposal.hash,
        newState: replica.proposal.newState,
        leader: structuredClone(replica.proposal.leader),
        // Stored outputs from proposal time (used at commit, NOT re-applied)
        ...(replica.proposal.outputs && { outputs: [...replica.proposal.outputs] }),
        ...(replica.proposal.jOutputs && { jOutputs: [...replica.proposal.jOutputs] }),
        // Deep clone HashToSign objects (hash, type, context)
        ...(replica.proposal.hashesToSign && { hashesToSign: replica.proposal.hashesToSign.map(h => ({ ...h })) }),
        ...(replica.proposal.collectedSigs && { collectedSigs: new Map(Array.from(replica.proposal.collectedSigs.entries()).map(([k, v]) => [k, [...v]])) }),
        ...(replica.proposal.hankos && { hankos: [...replica.proposal.hankos] }),
      }
    }),
    ...(replica.lockedFrame && {
      lockedFrame: {
        height: replica.lockedFrame.height,
        txs: cloneArray(replica.lockedFrame.txs),
        hash: replica.lockedFrame.hash,
        newState: replica.lockedFrame.newState,
        leader: structuredClone(replica.lockedFrame.leader),
        // Deep clone HashToSign objects (hash, type, context)
        ...(replica.lockedFrame.hashesToSign && { hashesToSign: replica.lockedFrame.hashesToSign.map(h => ({ ...h })) }),
        ...(replica.lockedFrame.collectedSigs && { collectedSigs: new Map(Array.from(replica.lockedFrame.collectedSigs.entries()).map(([k, v]) => [k, [...v]])) }),
        ...(replica.lockedFrame.hankos && { hankos: [...replica.lockedFrame.hankos] }),
      }
    }),
    isProposer: replica.isProposer,
    ...(replica.position && { position: { ...replica.position } }),
    // SECURITY: Clone validator's computed state for state injection prevention
    ...(replica.validatorComputedState && { validatorComputedState: cloneEntityState(replica.validatorComputedState) }),
    ...(replica.leaderVotes && { leaderVotes: new Map(Array.from(replica.leaderVotes.entries()).map(([key, vote]) => [key, { ...vote }])) }),
    ...(replica.pendingLeaderCertificate && { pendingLeaderCertificate: structuredClone(replica.pendingLeaderCertificate) }),
    ...(replica.lastConsensusProgressAt !== undefined && { lastConsensusProgressAt: replica.lastConsensusProgressAt }),
  }, 'cloneEntityReplica');
};

// === ACCOUNT MACHINE HELPERS ===

/**
 * Clone AccountMachine for validation (replaces dryRun pattern)
 */
export function cloneAccountMachine(account: AccountMachine, forSnapshot: boolean = false): AccountMachine {
  // For snapshots, exclude clonedForValidation to avoid cycles
  if (forSnapshot) {
    const { clonedForValidation, ...accountWithoutCloned } = account;
    void clonedForValidation;
    try {
      const cloned = structuredClone(accountWithoutCloned) as AccountMachine;
      cloneDisputeEvidenceIntoAccount(cloned, account);
      cloneCrossJurisdictionRoutesInAccount(cloned, account);
      return cloned;
    } catch {
      return manualCloneAccountMachine(account, true);
    }
  }

  // Normal clone - preserve clonedForValidation for consensus
  try {
    const cloned = structuredClone(account);
    setAccountFrameHistoryView(cloned, getAccountFrameHistoryView(account));
    cloneDisputeEvidenceIntoAccount(cloned, account);
    cloneCrossJurisdictionRoutesInAccount(cloned, account);
    return cloned;
  } catch (error) {
    if (HEAVY_LOGS) {
      stateHelperLog.debug('clone.account_machine.structured_clone_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return manualCloneAccountMachine(account, false);
  }
}

/**
 * Manual AccountMachine cloning
 */
function manualCloneAccountMachine(account: AccountMachine, skipClonedForValidation: boolean = false): AccountMachine {
  const proofBody = account.proofBody ?? { tokenIds: [], deltas: [] };
  const result: AccountMachine = {
    ...account,
    mempool: Array.isArray(account.mempool) ? account.mempool.map(cloneAccountTxForState) : [],
    currentFrame: cloneAccountFrame(account.currentFrame),
    deltas: new Map(Array.from((account.deltas ?? new Map()).entries()).map(([key, delta]) => [key, { ...delta }])),
    locks: new Map(Array.from((account.locks ?? new Map()).entries()).map(([key, lock]) => [key, { ...lock }])),
    swapOffers: new Map(Array.from((account.swapOffers ?? new Map()).entries()).map(([key, offer]) => [key, { ...offer }])),
    pulls: new Map(Array.from((account.pulls ?? new Map()).entries()).map(([key, pull]) => [key, { ...pull }])),
    ...(account.lendingIntents instanceof Map
      ? { lendingIntents: new Map(account.lendingIntents) }
      : {}),
    ...(account.swapOrderHistory instanceof Map
      ? {
          swapOrderHistory: new Map(
            Array.from(account.swapOrderHistory.entries()).map(([key, entry]) => [
              key,
              {
                ...entry,
                resolves: Array.isArray(entry.resolves)
                  ? entry.resolves.map((resolve) => ({ ...resolve }))
                  : [],
              },
            ]),
          ),
        }
      : {}),
    ...(account.swapClosedOrders instanceof Map
      ? {
          swapClosedOrders: new Map(
            Array.from(account.swapClosedOrders.entries()).map(([key, entry]) => [
              key,
              {
                ...entry,
                resolves: Array.isArray(entry.resolves)
                  ? entry.resolves.map((resolve) => ({ ...resolve }))
                  : [],
              },
            ]),
          ),
        }
      : {}),
    pendingSignatures: Array.isArray(account.pendingSignatures) ? [...account.pendingSignatures] : [],
    globalCreditLimits: { ...(account.globalCreditLimits ?? {}) },
    proofHeader: { ...(account.proofHeader ?? {}) },
    proofBody: {
      ...proofBody,
      tokenIds: Array.isArray(proofBody.tokenIds) ? [...proofBody.tokenIds] : [],
      deltas: Array.isArray(proofBody.deltas) ? [...proofBody.deltas] : [],
    },
    disputeConfig: { ...(account.disputeConfig ?? {}) },
    leftJObservations: (Array.isArray(account.leftJObservations) ? account.leftJObservations : []).map(obs => ({
      ...obs,
      events: Array.isArray(obs.events) ? [...obs.events] : [],
    })),
    rightJObservations: (Array.isArray(account.rightJObservations) ? account.rightJObservations : []).map(obs => ({
      ...obs,
      events: Array.isArray(obs.events) ? [...obs.events] : [],
    })),
    jEventChain: (Array.isArray(account.jEventChain) ? account.jEventChain : []).map(entry => ({
      ...entry,
      events: Array.isArray(entry.events) ? [...entry.events] : [],
    })),
    lastFinalizedJHeight: account.lastFinalizedJHeight,
    jNonce: account.jNonce,
    pendingWithdrawals: new Map(account.pendingWithdrawals ?? []), // Phase 2: Clone withdrawal tracking
    requestedRebalance: new Map(account.requestedRebalance ?? []), // Phase 3: Clone rebalance hints
    requestedRebalanceFeeState: new Map(
      Array.from(account.requestedRebalanceFeeState || []).map(([tokenId, feeState]) => [
        tokenId,
        { ...feeState },
      ]),
    ),
    shadow: {
      rebalance: {
        policy: new Map(account.shadow.rebalance.policy),
        submittedAtByToken: new Map(account.shadow.rebalance.submittedAtByToken),
        ...(account.shadow.rebalance.activeQuote
          ? { activeQuote: { ...account.shadow.rebalance.activeQuote } }
          : {}),
        ...(account.shadow.rebalance.pendingRequest
          ? { pendingRequest: { ...account.shadow.rebalance.pendingRequest } }
          : {}),
      },
      ...(account.shadow.rejectedFrameEvidence
        ? { rejectedFrameEvidence: structuredClone(account.shadow.rejectedFrameEvidence) }
        : {}),
    },
  };

  if (account.pendingFrame) {
    result.pendingFrame = cloneAccountFrame(account.pendingFrame);
  }

  if (account.pendingAccountInput) {
    try {
      result.pendingAccountInput = structuredClone(account.pendingAccountInput);
    } catch {
      if (account.pendingAccountInput.kind === 'settle') {
        result.pendingAccountInput = {
          ...account.pendingAccountInput,
          settleAction: cloneAccountSettleAction(account.pendingAccountInput.settleAction),
        };
      } else {
        result.pendingAccountInput = { ...account.pendingAccountInput };
      }
    }
  }

  if (account.clonedForValidation && !skipClonedForValidation) {
    result.clonedForValidation = manualCloneAccountMachine(account.clonedForValidation, true);
  }

  if (!skipClonedForValidation) {
    setAccountFrameHistoryView(result, getAccountFrameHistoryView(account));
  }

  if (skipClonedForValidation) {
    delete result.clonedForValidation;
  }

  if (account.hankoSignature) {
    result.hankoSignature = account.hankoSignature;
  }
  if (account.currentDisputeProofHanko) {
    result.currentDisputeProofHanko = account.currentDisputeProofHanko;
  }
  if (account.currentDisputeProofNonce !== undefined) {
    result.currentDisputeProofNonce = account.currentDisputeProofNonce;
  }
  if (account.currentDisputeProofBodyHash) {
    result.currentDisputeProofBodyHash = account.currentDisputeProofBodyHash;
  }
  if (account.currentDisputeHash) {
    result.currentDisputeHash = account.currentDisputeHash;
  }
  if (account.counterpartyDisputeProofHanko) {
    result.counterpartyDisputeProofHanko = account.counterpartyDisputeProofHanko;
  }
  if (account.counterpartyDisputeProofNonce !== undefined) {
    result.counterpartyDisputeProofNonce = account.counterpartyDisputeProofNonce;
  }
  if (account.counterpartyDisputeProofBodyHash) {
    result.counterpartyDisputeProofBodyHash = account.counterpartyDisputeProofBodyHash;
  }
  if (account.counterpartyDisputeHash) {
    result.counterpartyDisputeHash = account.counterpartyDisputeHash;
  }
  if (account.disputeProofNoncesByHash) {
    result.disputeProofNoncesByHash = { ...account.disputeProofNoncesByHash };
  }
  cloneDisputeEvidenceIntoAccount(result, account);
  if (account.currentFrameHanko) {
    result.currentFrameHanko = account.currentFrameHanko;
  }
  if (account.counterpartyFrameHanko) {
    result.counterpartyFrameHanko = account.counterpartyFrameHanko;
  }
  if (account.activeDispute) {
    result.activeDispute = { ...account.activeDispute };
  }
  if (account.settlementWorkspace) {
    result.settlementWorkspace = {
      ...account.settlementWorkspace,
      ops: account.settlementWorkspace.ops.map(op => ({ ...op })),
      ...(account.settlementWorkspace.compiledDiffs && {
        compiledDiffs: account.settlementWorkspace.compiledDiffs.map(d => ({ ...d })),
      }),
      ...(account.settlementWorkspace.compiledForgiveTokenIds && {
        compiledForgiveTokenIds: [...account.settlementWorkspace.compiledForgiveTokenIds],
      }),
    };
  }
  if (account.pendingForward) {
    result.pendingForward = {
      ...account.pendingForward,
      route: [...account.pendingForward.route],
    };
  }

  // ABI-encoded proofBody for on-chain disputes
  if (account.abiProofBody) {
    result.abiProofBody = { ...account.abiProofBody };
  }

  // HTLC state (deep clone locks Map)
  result.locks = new Map(
    Array.from(account.locks.entries()).map(([lockId, lock]) => [
      lockId,
      { ...lock } // Clone lock object
    ])
  );

  // Swap state (deep clone swapOffers Map)
  result.swapOffers = new Map(
    Array.from((account.swapOffers || new Map()).entries()).map(([offerId, offer]) => [
      offerId,
      { ...offer } // Clone offer object
    ])
  );

  result.pulls = new Map(
    Array.from((account.pulls || new Map()).entries()).map(([pullId, pull]) => [
      pullId,
      { ...pull },
    ]),
  );

  if (account.swapOrderHistory instanceof Map) {
    result.swapOrderHistory = new Map(
      Array.from(account.swapOrderHistory.entries()).map(([offerId, entry]) => [
        offerId,
        {
          ...entry,
          resolves: Array.isArray(entry.resolves)
            ? entry.resolves.map((resolve) => ({ ...resolve }))
            : [],
        },
      ]),
    );
  }

  if (account.swapClosedOrders instanceof Map) {
    result.swapClosedOrders = new Map(
      Array.from(account.swapClosedOrders.entries()).map(([offerId, entry]) => [
        offerId,
        {
          ...entry,
          resolves: Array.isArray(entry.resolves)
            ? entry.resolves.map((resolve) => ({ ...resolve }))
            : [],
        },
      ]),
    );
  }

  cloneCrossJurisdictionRoutesInAccount(result, account);
  return result;
}
