import { accountHasProposableMempool } from '../entity/consensus/account-mempool-eligibility';
import { isEntityActiveLeader } from '../entity/consensus/leader';
import {
  entityRequiresJPrefixCertificate,
  getLocalJPrefixAttestableHeight,
  hasCurrentRoundJPrefixAttestation,
  hasPendingLocalJEvent,
  isFrozenBaseJPrefixRollAuthorized,
} from '../jurisdiction/j-prefix-consensus';
import { getWallClockMs } from '../utils';
import {
  getNextNetworkRetryTimestamp,
  hasReadyPendingNetworkOutputs,
  type RuntimeOutputRoutingDeps,
} from './output-routing';
import {
  generateHookPingsWithDeps,
  getEarliestWallClockDueTimestampWithDeps,
  getNextWallClockWakeTimestampWithDeps,
  hasDueEntityHooksWithDeps,
} from './wake';
import { requireRuntimeMempool } from './input-queue';
import { ensureRuntimeConfig } from './loop-environment';
import { enqueueRuntimeInputs } from './loop-infrastructure';
import { ensureRuntimeState } from './runtime-state';
import type { EntityInput, EntityReplica, Env, RuntimeInput } from '../types';

export type RuntimeWorkDeps = {
  runtimeInputHasQueuedWork(input: RuntimeInput): boolean;
  getOutputRoutingDeps(): RuntimeOutputRoutingDeps;
};

const entityJPrefixReadyForWake = (replica: EntityReplica): boolean => {
  const prefixNeeded =
    entityRequiresJPrefixCertificate(replica.state) ||
    hasPendingLocalJEvent(replica.state, replica.jHistory);
  if (!prefixNeeded || replica.jPrefixRound?.certificate) return true;
  if (hasCurrentRoundJPrefixAttestation(replica)) return false;
  return Boolean(
    replica.jHistory &&
    getLocalJPrefixAttestableHeight(replica.state, replica.jHistory) !== null,
  );
};

const entityMempoolNeedsWake = (replica: EntityReplica): boolean =>
  isEntityActiveLeader(replica) &&
  entityJPrefixReadyForWake(replica) &&
  (
    replica.mempool.length > 0 ||
    Boolean(
      replica.jPrefixRound?.certificate &&
      replica.jPrefixRound.certificate.selected.scannedThroughHeight >
        replica.state.lastFinalizedJHeight,
    ) ||
    isFrozenBaseJPrefixRollAuthorized(replica, replica.jPrefixRound?.certificate)
  ) &&
  !replica.proposal &&
  !replica.lockedFrame;

export const collectAccountMempoolWakeInputs = (env: Env): EntityInput[] => {
  const inputs: EntityInput[] = [];
  for (const replica of env.eReplicas.values()) {
    const entityId = String(replica.entityId || replica.state.entityId).trim().toLowerCase();
    const signerId = String(replica.signerId || '').trim().toLowerCase();
    if (!entityId || !signerId) continue;
    const hasProposable = [...replica.state.accounts.values()].some(account =>
      accountHasProposableMempool(account, replica.state),
    );
    if (hasProposable) inputs.push({ entityId, signerId, entityTxs: [] });
  }
  return inputs;
};

export const collectEntityMempoolWakeInputs = (env: Env): EntityInput[] => {
  const inputs: EntityInput[] = [];
  for (const replica of env.eReplicas.values()) {
    if (!entityMempoolNeedsWake(replica)) continue;
    const entityId = String(replica.entityId || replica.state.entityId).trim().toLowerCase();
    const signerId = String(replica.signerId || '').trim().toLowerCase();
    if (entityId && signerId) inputs.push({ entityId, signerId, entityTxs: [] });
  }
  return inputs;
};

const hasEntityMempoolWakeInput = (env: Env): boolean =>
  [...env.eReplicas.values()].some(entityMempoolNeedsWake);

const hasAccountMempoolWakeInput = (env: Env): boolean =>
  [...env.eReplicas.values()].some(replica =>
    [...replica.state.accounts.values()].some(account =>
      accountHasProposableMempool(account, replica.state),
    ),
  );

const runtimeWakeDeps = {
  ensureRuntimeState,
  requireRuntimeMempool,
  enqueueRuntimeInputs,
  getRuntimeNowMs: (env: Env) => env.timestamp ?? 0,
};

export const hasDueEntityHooks = (env: Env): boolean =>
  hasDueEntityHooksWithDeps(env, runtimeWakeDeps);

export const getEarliestWallClockDueTimestamp = (env: Env): number | null =>
  getEarliestWallClockDueTimestampWithDeps(env, runtimeWakeDeps);

export const resolveRuntimeWorkReason = (
  env: Env,
  deps: RuntimeWorkDeps,
): string | null => {
  const mempool = requireRuntimeMempool(env);
  if ((env.runtimeState?.pendingProfileCertificationEntityIds?.size ?? 0) > 0) {
    return 'profile-certification';
  }
  if ((env.runtimeState?.pendingCommittedJOutbox?.length ?? 0) > 0) return 'committed-j-outbox';
  if ((env.runtimeState?.pendingJurisdictionImports?.size ?? 0) > 0) return 'jurisdiction-import';
  if (mempool.runtimeTxs.length > 0 || mempool.entityInputs.length > 0) return 'runtime-mempool';
  if ((mempool.jInputs?.length ?? 0) > 0) return 'j-input';
  if ((mempool.reliableReceipts?.length ?? 0) > 0) return 'reliable-receipt';
  if (
    deps.runtimeInputHasQueuedWork(mempool) &&
    (mempool.queuedAt ?? 0) > (env.timestamp ?? 0)
  ) {
    return 'future-queued-input';
  }
  if (env.pendingOutputs?.length) return 'pending-output';
  if (env.networkInbox?.length) return 'network-inbox';
  if (
    hasReadyPendingNetworkOutputs(env, deps.getOutputRoutingDeps(), getWallClockMs())
  ) {
    return 'network-retry';
  }
  if (hasEntityMempoolWakeInput(env)) return 'entity-mempool';
  if (hasAccountMempoolWakeInput(env)) return 'account-mempool';
  // Quiesce drains only work accepted before its ingress fence. Timers remain
  // durable and fire after explicit resume.
  if (!env.runtimeState?.persistenceQuiescing && hasDueEntityHooks(env)) {
    return 'entity-hook';
  }
  return null;
};

export const prioritizeJEventFrame = (
  runtimeInput: RuntimeInput,
  mempool: RuntimeInput,
  timestamp: number,
): boolean => {
  const priorityInputs: EntityInput[] = [];
  const deferredInputs: EntityInput[] = [];
  for (const input of runtimeInput.entityInputs) {
    const txs = input.entityTxs ?? [];
    const jEventTxs = txs.filter(tx => tx.type === 'j_event');
    const otherTxs = txs.filter(tx => tx.type !== 'j_event');
    const hasConsensusLane = Boolean(
      input.proposedFrame ||
      input.hashPrecommitFrame ||
      input.hashPrecommits?.size ||
      input.jPrefixAttestations?.size ||
      input.leaderTimeoutVote,
    );
    if (jEventTxs.length > 0) {
      const {
        proposedFrame: _proposedFrame,
        hashPrecommitFrame: _hashPrecommitFrame,
        hashPrecommits: _hashPrecommits,
        jPrefixAttestations: _jPrefixAttestations,
        leaderTimeoutVote: _leaderTimeoutVote,
        ...transactionLane
      } = input;
      priorityInputs.push({ ...transactionLane, entityTxs: jEventTxs });
    }
    if (otherTxs.length > 0 || hasConsensusLane) {
      const deferred: EntityInput = { ...input, entityTxs: otherTxs };
      if (otherTxs.length === 0) delete deferred.entityTxs;
      deferredInputs.push(deferred);
    }
  }
  if (priorityInputs.length === 0 || deferredInputs.length === 0) return false;
  // Chain observations are frame-boundary facts. Commit them before local
  // follow-up work can build against stale sentBatch/nonces/reserves.
  runtimeInput.entityInputs = priorityInputs;
  mempool.entityInputs = [...deferredInputs, ...mempool.entityInputs];
  mempool.queuedAt ??= timestamp;
  return true;
};

export const applyEntityInputFrameCap = (
  runtimeInput: RuntimeInput,
  mempool: RuntimeInput,
  maxInputs: number,
  timestamp: number,
): boolean => {
  const limit = Math.max(0, Math.floor(Number(maxInputs)));
  if (limit <= 0 || runtimeInput.entityInputs.length <= limit) return false;
  const deferred = runtimeInput.entityInputs.slice(limit);
  runtimeInput.entityInputs = runtimeInput.entityInputs.slice(0, limit);
  mempool.entityInputs = [...deferred, ...mempool.entityInputs];
  mempool.queuedAt ??= timestamp;
  return true;
};

export const applyEntityTxFrameCap = (
  runtimeInput: RuntimeInput,
  mempool: RuntimeInput,
  maxTxs: number,
  timestamp: number,
): boolean => {
  const limit = Math.max(0, Math.floor(Number(maxTxs)));
  if (limit <= 0) return false;
  let selectedTxs = 0;
  let capReached = false;
  const selected: EntityInput[] = [];
  const deferred: EntityInput[] = [];
  for (const input of runtimeInput.entityInputs) {
    const txCount = input.entityTxs?.length ?? 0;
    const remaining = limit - selectedTxs;
    // Never split an authenticated Entity envelope into independently durable
    // prefixes. One oversized head passes whole so FIFO cannot deadlock.
    if (!capReached && (txCount === 0 || txCount <= remaining || selectedTxs === 0)) {
      selected.push(input);
      selectedTxs += txCount;
      capReached = selectedTxs >= limit;
    } else {
      deferred.push(input);
      capReached = true;
    }
  }
  if (deferred.length === 0) return false;
  runtimeInput.entityInputs = selected;
  mempool.entityInputs = [...deferred, ...mempool.entityInputs];
  mempool.queuedAt ??= timestamp;
  return true;
};

export const resolveNextWallClockWakeTimestamp = (
  env: Env,
  deps: RuntimeWorkDeps,
): number | null => {
  const entityDueAt = getNextWallClockWakeTimestampWithDeps(env, runtimeWakeDeps);
  const networkDueAt = getNextNetworkRetryTimestamp(env, deps.getOutputRoutingDeps());
  if (entityDueAt === null) return networkDueAt;
  if (networkDueAt === null) return entityDueAt;
  return Math.min(entityDueAt, networkDueAt);
};

export const generateHookPings = (
  env: Env,
  nowMs = env.timestamp ?? 0,
  queuedAt = env.timestamp ?? 0,
): void => {
  if (env.runtimeState?.persistenceQuiescing) return;
  generateHookPingsWithDeps(env, runtimeWakeDeps, nowMs, queuedAt);
};

export const isRuntimeFrameReady = (
  env: Env,
  now: number,
  overrideDelayMs?: number,
): boolean => {
  if (env.scenarioMode) return true;
  const rawDelayMs = overrideDelayMs ?? ensureRuntimeConfig(env).minFrameDelayMs ?? 0;
  if (!Number.isFinite(rawDelayMs) || rawDelayMs <= 0) return true;
  const lastFrameAt = ensureRuntimeState(env).lastFrameAt;
  if (typeof lastFrameAt !== 'number' || !Number.isFinite(lastFrameAt) || lastFrameAt <= 0) {
    return true;
  }
  return Math.max(0, now - lastFrameAt) >= Math.floor(rawDelayMs);
};

export const getRemainingRuntimeFrameDelayMs = (
  env: Env,
  overrideDelayMs?: number,
): number => {
  if (env.scenarioMode) return 0;
  const rawDelayMs = overrideDelayMs ?? ensureRuntimeConfig(env).minFrameDelayMs ?? 0;
  if (!Number.isFinite(rawDelayMs) || rawDelayMs <= 0) return 0;
  const lastFrameAt = ensureRuntimeState(env).lastFrameAt;
  if (typeof lastFrameAt !== 'number' || !Number.isFinite(lastFrameAt) || lastFrameAt <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(rawDelayMs) - Math.max(0, getWallClockMs() - lastFrameAt));
};
