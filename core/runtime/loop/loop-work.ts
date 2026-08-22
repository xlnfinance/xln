import { hasProposableAccount } from '../../entity/consensus/account/work-index';
import { isEntityActiveLeader } from '../../entity/consensus/leader';
import {
  entityRequiresJPrefixCertificate,
  getLocalJPrefixAttestableHeight,
  hasCurrentRoundJPrefixAttestation,
  hasPendingLocalJEvent,
  isFrozenBaseJPrefixRollAuthorized,
} from '../../jurisdiction/machine/history/j-prefix-consensus.ts';
import { getWallClockMs } from '../../support/time.ts';
import type { RuntimeOutputRoutingDeps } from '../delivery/topology/output-routing.ts';
import {
  generateHookPingsWithDeps,
  getEarliestWallClockDueTimestampWithDeps,
  getNextWallClockWakeTimestampWithDeps,
  hasDueEntityHooksWithDeps,
} from '../mempool/wake.ts';
import { requireRuntimeMempool } from '../mempool/input-queue.ts';
import { ensureRuntimeConfig } from './loop-environment.ts';
import { enqueueRuntimeInputs } from './loop-envelope.ts';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope.ts';
import { hasReadyCommittedJOutbox } from '../registration/governance-submit-state.ts';
import type { EntityInput, EntityReplica } from '../../entity/types.ts';
import type { RoutedEntityInput, RuntimeReplica, RuntimeInput } from '../types.ts';
import { atomicCrossJInputCohortKey } from '../delivery/topology/entity-routing.ts';

import { createStructuredLogger } from '../../support/logger.ts';

const loopWorkLog = createStructuredLogger('runtime.loop-work');

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

const suppressedWakeLogAt = new Map<string, number>();
const SUPPRESSED_WAKE_LOG_INTERVAL_MS = 10_000;

// A leader replica holding mempool txs but denied a wake is invisible from the
// outside: the Runtime idles, the command sits, and the caller times out with
// no error anywhere. Name the exact suppressor so a stall names its cause.
const logSuppressedEntityMempoolWake = (replica: EntityReplica, reason: string): void => {
  const key = `${replica.entityId}:${reason}`;
  const now = Date.now();
  if (now - (suppressedWakeLogAt.get(key) ?? 0) < SUPPRESSED_WAKE_LOG_INTERVAL_MS) return;
  suppressedWakeLogAt.set(key, now);
  loopWorkLog.info('entity.mempool_wake_suppressed', {
    entityId: replica.entityId,
    signerId: replica.signerId,
    reason,
    mempool: replica.mempool.length,
    mempoolTxTypes: [...new Set(replica.mempool.map(tx => tx.type))].slice(0, 6),
    hasProposal: Boolean(replica.proposal),
    hasLockedFrame: Boolean(replica.lockedFrame),
    jPrefixCertificate: Boolean(replica.jPrefixRound?.certificate),
    entityHeight: replica.state.height,
  });
};

const entityMempoolNeedsWake = (replica: EntityReplica): boolean => {
  if (!isEntityActiveLeader(replica)) return false;
  const hasWork =
    replica.mempool.length > 0 ||
    Boolean(
      replica.jPrefixRound?.certificate &&
      replica.jPrefixRound.certificate.selected.scannedThroughHeight >
        replica.state.lastFinalizedJHeight,
    ) ||
    isFrozenBaseJPrefixRollAuthorized(replica, replica.jPrefixRound?.certificate);
  if (!hasWork) return false;
  if (!entityJPrefixReadyForWake(replica)) {
    logSuppressedEntityMempoolWake(replica, 'j-prefix-round-incomplete');
    return false;
  }
  if (replica.proposal) {
    logSuppressedEntityMempoolWake(replica, 'proposal-in-flight');
    return false;
  }
  if (replica.lockedFrame) {
    logSuppressedEntityMempoolWake(replica, 'locked-frame');
    return false;
  }
  return true;
};

export type ReplicaMempoolWakeInputs = {
  entityInputs: EntityInput[];
  accountInputs: EntityInput[];
};

const replicaWakeIds = (replica: EntityReplica): { entityId: string; signerId: string } | null => {
  const entityId = String(replica.entityId || replica.state.entityId).trim().toLowerCase();
  const signerId = String(replica.signerId || '').trim().toLowerCase();
  if (!entityId || !signerId) return null;
  return { entityId, signerId };
};

export const collectReplicaMempoolWakeInputs = (env: RuntimeReplica): ReplicaMempoolWakeInputs => {
  const entityInputs: EntityInput[] = [];
  const accountInputs: EntityInput[] = [];
  for (const replica of env.state.eReplicas.values()) {
    const ids = replicaWakeIds(replica);
    if (!ids) continue;
    if (entityMempoolNeedsWake(replica)) entityInputs.push({ ...ids, entityTxs: [] });
    if (hasProposableAccount(replica.state)) accountInputs.push({ ...ids, entityTxs: [] });
  }
  return { entityInputs, accountInputs };
};

export const collectAccountMempoolWakeInputs = (env: RuntimeReplica): EntityInput[] =>
  collectReplicaMempoolWakeInputs(env).accountInputs;

export const collectEntityMempoolWakeInputs = (env: RuntimeReplica): EntityInput[] =>
  collectReplicaMempoolWakeInputs(env).entityInputs;

const runtimeWakeDeps = {
  ensureRuntimeInfrastructure,
  requireRuntimeMempool,
  enqueueRuntimeInputs,
  getRuntimeNowMs: (env: RuntimeReplica) => env.state.timestamp ?? 0,
};

const hasDueEntityHooks = (env: RuntimeReplica): boolean =>
  hasDueEntityHooksWithDeps(env, runtimeWakeDeps);

export const getEarliestWallClockDueTimestamp = (env: RuntimeReplica): number | null =>
  getEarliestWallClockDueTimestampWithDeps(env, runtimeWakeDeps);

export const resolveRuntimeWorkReason = (
  env: RuntimeReplica,
  deps: RuntimeWorkDeps,
): string | null => {
  const mempool = requireRuntimeMempool(env);
  if (hasReadyCommittedJOutbox(env, getWallClockMs())) return 'committed-j-outbox';
  if ((env.infrastructure?.pendingJurisdictionImports?.size ?? 0) > 0) return 'jurisdiction-import';
  if (mempool.runtimeTxs.length > 0 || mempool.entityInputs.length > 0) return 'runtime-mempool';
  if ((mempool.jInputs?.length ?? 0) > 0) return 'j-input';
  if (
    deps.runtimeInputHasQueuedWork(mempool) &&
    (mempool.queuedAt ?? 0) > (env.state.timestamp ?? 0)
  ) {
    return 'future-queued-input';
  }
  if (env.pendingOutputs?.length) return 'pending-output';
  if (env.networkInbox?.length) return 'network-inbox';
  const replicaWakes = collectReplicaMempoolWakeInputs(env);
  if (replicaWakes.entityInputs.length > 0) return 'entity-mempool';
  if (replicaWakes.accountInputs.length > 0) return 'account-mempool';
  // Quiesce drains only work accepted before its ingress fence. Timers remain
  // durable and fire after explicit resume.
  if (!env.infrastructure?.persistenceQuiescing && hasDueEntityHooks(env)) {
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
    if (atomicCrossJInputCohortKey(input)) {
      deferredInputs.push(input);
      continue;
    }
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
  const selectedCount = selectAtomicPrefix(runtimeInput.entityInputs, limit, () => 1);
  const deferred = runtimeInput.entityInputs.slice(selectedCount);
  runtimeInput.entityInputs = runtimeInput.entityInputs.slice(0, selectedCount);
  mempool.entityInputs = [...deferred, ...mempool.entityInputs];
  mempool.queuedAt ??= timestamp;
  return true;
};

type AtomicCapInput = EntityInput & Pick<
  RoutedEntityInput,
  'atomicCrossJurisdictionPair' | 'sourceRuntimeFrame'
>;

const atomicCrossJFrameKey = (input: AtomicCapInput): string | null => {
  return atomicCrossJInputCohortKey(input);
};

const selectAtomicPrefix = (
  inputs: readonly AtomicCapInput[],
  limit: number,
  weightOf: (input: AtomicCapInput) => number,
): number => {
  const lastIndexByKey = new Map<string, number>();
  for (let index = 0; index < inputs.length; index += 1) {
    const key = atomicCrossJFrameKey(inputs[index]!);
    if (key) lastIndexByKey.set(key, index);
  }

  let cursor = 0;
  let selectedWeight = 0;
  while (cursor < inputs.length) {
    let end = cursor;
    let unitWeight = 0;
    for (let index = cursor; index <= end; index += 1) {
      const input = inputs[index]!;
      const key = atomicCrossJFrameKey(input);
      if (key) end = Math.max(end, lastIndexByKey.get(key) ?? index);
      unitWeight += weightOf(input);
    }
    if (selectedWeight > 0 && selectedWeight + unitWeight > limit) break;
    cursor = end + 1;
    selectedWeight += unitWeight;
    if (selectedWeight >= limit) break;
  }
  return cursor;
};

export const applyEntityTxFrameCap = (
  runtimeInput: RuntimeInput,
  mempool: RuntimeInput,
  maxTxs: number,
  timestamp: number,
): boolean => {
  const limit = Math.max(0, Math.floor(Number(maxTxs)));
  if (limit <= 0) return false;
  const selectedCount = selectAtomicPrefix(
    runtimeInput.entityInputs,
    limit,
    input => input.entityTxs?.length ?? 0,
  );
  if (selectedCount >= runtimeInput.entityInputs.length) return false;
  const deferred = runtimeInput.entityInputs.slice(selectedCount);
  runtimeInput.entityInputs = runtimeInput.entityInputs.slice(0, selectedCount);
  mempool.entityInputs = [...deferred, ...mempool.entityInputs];
  mempool.queuedAt ??= timestamp;
  return true;
};

export const resolveNextWallClockWakeTimestamp = (
  env: RuntimeReplica,
): number | null => {
  const entityDueAt = getNextWallClockWakeTimestampWithDeps(env, runtimeWakeDeps);
  return entityDueAt;
};

export const generateHookPings = (
  env: RuntimeReplica,
  nowMs = env.state.timestamp ?? 0,
  queuedAt = env.state.timestamp ?? 0,
): void => {
  if (env.infrastructure?.persistenceQuiescing) return;
  generateHookPingsWithDeps(env, runtimeWakeDeps, nowMs, queuedAt);
};

export const isRuntimeFrameReady = (
  env: RuntimeReplica,
  now: number,
  overrideDelayMs?: number,
): boolean => {
  if (env.scenarioMode) return true;
  const config = ensureRuntimeConfig(env);
  const rawDelayMs = overrideDelayMs ?? config.minFrameDelayMs ?? 0;
  if (!Number.isFinite(rawDelayMs) || rawDelayMs <= 0) return true;
  const lastFrameAt = ensureRuntimeInfrastructure(env).lastFrameAt;
  if (typeof lastFrameAt !== 'number' || !Number.isFinite(lastFrameAt) || lastFrameAt <= 0) {
    return true;
  }
  const elapsed = Math.max(0, now - lastFrameAt);
  if (elapsed < Math.floor(rawDelayMs)) return false;
  // Min delay satisfied. If a mempool depth threshold is configured, hold the
  // frame back until enough work accumulates or the max delay cap fires.
  const minDepth = config.minFrameMempoolDepth ?? 0;
  const maxDelayMs = config.maxFrameDelayMs ?? 0;
  if (minDepth > 0 && maxDelayMs > 0 && elapsed < maxDelayMs) {
    const mempool = requireRuntimeMempool(env);
    const depth = mempool.entityInputs.length + mempool.runtimeTxs.length;
    if (depth < minDepth) return false;
  }
  return true;
};

export const getRemainingRuntimeFrameDelayMs = (
  env: RuntimeReplica,
  overrideDelayMs?: number,
): number => {
  if (env.scenarioMode) return 0;
  const config = ensureRuntimeConfig(env);
  const rawDelayMs = overrideDelayMs ?? config.minFrameDelayMs ?? 0;
  if (!Number.isFinite(rawDelayMs) || rawDelayMs <= 0) return 0;
  const lastFrameAt = ensureRuntimeInfrastructure(env).lastFrameAt;
  if (typeof lastFrameAt !== 'number' || !Number.isFinite(lastFrameAt) || lastFrameAt <= 0) {
    return 0;
  }
  const now = getWallClockMs();
  const elapsed = Math.max(0, now - lastFrameAt);
  const minRemaining = Math.max(0, Math.floor(rawDelayMs) - elapsed);
  if (minRemaining > 0) return minRemaining;
  // Min delay has passed. If holding for mempool depth, return time until
  // the max delay cap fires (so the loop sleeps instead of spinning).
  const minDepth = config.minFrameMempoolDepth ?? 0;
  const maxDelayMs = config.maxFrameDelayMs ?? 0;
  if (minDepth > 0 && maxDelayMs > 0 && elapsed < maxDelayMs) {
    const mempool = requireRuntimeMempool(env);
    const depth = mempool.entityInputs.length + mempool.runtimeTxs.length;
    if (depth < minDepth) return Math.max(1, maxDelayMs - elapsed);
  }
  return 0;
};
