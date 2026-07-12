import type { EntityReplica, EntityState, EntityTx, Env } from './types';
import type { CrontabTaskMethod } from './crontab-types';
import { compareStableText, safeStringify } from './serialization-utils';

export type ScheduledWakeTx = Extract<EntityTx, { type: 'scheduledWake' }>;
export type ScheduledWakeJob = ScheduledWakeTx['data']['jobs'][number];
export const MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS = 1_000;

type DeadlineEntry = {
  dueAt: number;
  entityId: string;
  signerId: string;
  generation: number;
};

type DeadlineIndex = {
  heap: DeadlineEntry[];
  generations: Map<string, number>;
  replicas: Map<string, EntityReplica>;
  initialized: boolean;
};

const LOCAL_SCHEDULED_WAKE = Symbol.for('xln.runtime.scheduled-wake.local');

const replicaKey = (entityId: string, signerId: string): string =>
  `${entityId.toLowerCase()}:${signerId.toLowerCase()}`;

const compareDeadline = (left: DeadlineEntry, right: DeadlineEntry): number =>
  left.dueAt - right.dueAt ||
  compareStableText(left.entityId, right.entityId) ||
  compareStableText(left.signerId, right.signerId) ||
  left.generation - right.generation;

const heapPush = (heap: DeadlineEntry[], entry: DeadlineEntry): void => {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareDeadline(heap[parent]!, heap[index]!) <= 0) break;
    [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
    index = parent;
  }
};

const heapPop = (heap: DeadlineEntry[]): DeadlineEntry | undefined => {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  heap[0] = last;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && compareDeadline(heap[left]!, heap[smallest]!) < 0) smallest = left;
    if (right < heap.length && compareDeadline(heap[right]!, heap[smallest]!) < 0) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
    index = smallest;
  }
  return first;
};

const getIndex = (env: Env): DeadlineIndex => {
  if (!env.runtimeState) env.runtimeState = {};
  let index = env.runtimeState.scheduledWakeIndex;
  if (!index) {
    index = { heap: [], generations: new Map(), replicas: new Map(), initialized: false };
    env.runtimeState.scheduledWakeIndex = index;
  }
  return index;
};

export const entityNeedsPeriodicWake = (replica: EntityReplica): boolean => {
  const state = replica.state;
  for (const account of state.accounts.values()) {
    const settlement = account.settlementWorkspace;
    if (settlement && settlement.status !== 'submitted') {
      const counterpartyHanko = state.entityId === account.leftEntity
        ? settlement.rightHanko
        : settlement.leftHanko;
      if (counterpartyHanko) return true;
    }
    if (account.activeDispute || account.pendingFrame || account.pendingAccountInput) return true;
  }
  if (!state.hubRebalanceConfig) return false;
  if (state.jBatchState?.sentBatch) return true;
  for (const account of state.accounts.values()) {
    if ((account.requestedRebalance?.size ?? 0) > 0) return true;
    if ((account.requestedRebalanceFeeState?.size ?? 0) > 0) return true;
  }
  return false;
};

export const collectDueScheduledWakeJobs = (
  state: EntityState,
  now: number,
  includePeriodicTasks: boolean,
): ScheduledWakeJob[] => {
  const jobs: ScheduledWakeJob[] = [];
  for (const hook of state.crontabState?.hooks?.values() ?? []) {
    if (hook.triggerAt <= now) jobs.push({ kind: 'hook', id: hook.id, dueAt: hook.triggerAt });
  }
  if (includePeriodicTasks) {
    for (const task of state.crontabState?.tasks?.values() ?? []) {
      const dueAt = task.lastRun + task.intervalMs;
      if (task.enabled && dueAt <= now) jobs.push({ kind: 'task', id: task.method, dueAt });
    }
  }
  return jobs.sort((left, right) =>
    left.dueAt - right.dueAt || compareStableText(left.kind, right.kind) || compareStableText(left.id, right.id));
};

const nextReplicaDeadline = (replica: EntityReplica): number | null => {
  if (!replica.isProposer) return null;
  let next = Infinity;
  for (const hook of replica.state.crontabState?.hooks?.values() ?? []) {
    next = Math.min(next, hook.triggerAt);
  }
  if (entityNeedsPeriodicWake(replica)) {
    for (const task of replica.state.crontabState?.tasks?.values() ?? []) {
      if (!task.enabled) continue;
      const dueAt = task.lastRun + task.intervalMs;
      next = Math.min(next, dueAt);
    }
  }
  return Number.isFinite(next) ? next : null;
};

const refreshReplica = (env: Env, replica: EntityReplica): void => {
  const index = getIndex(env);
  const key = replicaKey(replica.entityId, replica.signerId);
  index.replicas.set(key, replica);
  const generation = (index.generations.get(key) ?? 0) + 1;
  index.generations.set(key, generation);
  const dueAt = nextReplicaDeadline(replica);
  if (dueAt !== null) {
    heapPush(index.heap, {
      dueAt,
      entityId: replica.entityId,
      signerId: replica.signerId,
      generation,
    });
  }
};

export const rebuildScheduledWakeIndex = (env: Env): void => {
  const index = getIndex(env);
  index.heap = [];
  index.generations.clear();
  index.replicas.clear();
  index.initialized = true;
  for (const replica of env.eReplicas.values()) refreshReplica(env, replica);
};

export const refreshScheduledWakeIndex = (env: Env, entityIds?: ReadonlySet<string>): void => {
  const index = getIndex(env);
  if (!index.initialized) {
    rebuildScheduledWakeIndex(env);
    return;
  }
  const normalized = entityIds
    ? new Set([...entityIds].map(entityId => entityId.toLowerCase()))
    : null;
  const liveKeys = new Set<string>();
  for (const replica of env.eReplicas.values()) {
    const key = replicaKey(replica.entityId, replica.signerId);
    liveKeys.add(key);
    const indexedReplica = index.replicas.get(key);
    if (!indexedReplica || indexedReplica !== replica || !normalized || normalized.has(replica.entityId.toLowerCase())) {
      refreshReplica(env, replica);
    }
  }
  for (const key of index.replicas.keys()) {
    if (liveKeys.has(key)) continue;
    index.replicas.delete(key);
    // Advance and retain the tombstone. Deleting or merely retaining the old
    // generation lets a detached replica's heap entry remain valid until the
    // same signer/entity pair is imported again.
    index.generations.set(key, (index.generations.get(key) ?? 0) + 1);
  }
};

const peekValidDeadline = (env: Env): DeadlineEntry | null => {
  const index = getIndex(env);
  if (!index.initialized) rebuildScheduledWakeIndex(env);
  while (index.heap.length > 0) {
    const entry = index.heap[0]!;
    const currentGeneration = index.generations.get(replicaKey(entry.entityId, entry.signerId));
    if (currentGeneration === entry.generation) return entry;
    heapPop(index.heap);
  }
  return null;
};

export const getNextScheduledWakeTimestamp = (env: Env): number | null =>
  peekValidDeadline(env)?.dueAt ?? null;

export const createDueScheduledWakeInputs = (env: Env, now: number): Array<{
  entityId: string;
  signerId: string;
  entityTxs: ScheduledWakeTx[];
}> => {
  const inputs: Array<{ entityId: string; signerId: string; entityTxs: ScheduledWakeTx[] }> = [];
  const queued = new Set((env.runtimeMempool?.entityInputs ?? [])
    .filter(input => input.entityTxs?.some(tx => tx.type === 'scheduledWake'))
    .map(input => replicaKey(input.entityId, input.signerId)));
  for (const replica of env.eReplicas.values()) {
    if (replica.mempool.some(tx => tx.type === 'scheduledWake')) {
      queued.add(replicaKey(replica.entityId, replica.signerId));
    }
  }

  const index = getIndex(env);
  while (true) {
    const entry = peekValidDeadline(env);
    if (!entry || entry.dueAt > now) break;
    heapPop(index.heap);
    const key = replicaKey(entry.entityId, entry.signerId);
    const replica = index.replicas.get(key);
    if (!replica?.isProposer || queued.has(key)) continue;
    const dueJobs = collectDueScheduledWakeJobs(replica.state, now, entityNeedsPeriodicWake(replica));
    if (dueJobs.length === 0) {
      refreshReplica(env, replica);
      continue;
    }
    // Jobs are advisory diagnostics. Execution recomputes and drains the full
    // canonical due set from EntityState at frame timestamp.
    const jobs = dueJobs.slice(0, MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS);
    const tx: ScheduledWakeTx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: replica.signerId,
        dueAt: jobs[0]!.dueAt,
        jobs,
      },
    };
    Object.defineProperty(tx, LOCAL_SCHEDULED_WAKE, { value: true, enumerable: false });
    inputs.push({ entityId: replica.entityId, signerId: replica.signerId, entityTxs: [tx] });
    queued.add(key);
  }
  return inputs;
};

export const assertScheduledWakeTxAuthorized = (tx: EntityTx, replay: boolean): void => {
  if (
    tx.type !== 'scheduledWake' ||
    replay ||
    (tx as EntityTx & { [LOCAL_SCHEDULED_WAKE]?: boolean })[LOCAL_SCHEDULED_WAKE] === true
  ) return;
  throw new Error('SCHEDULED_WAKE_EXTERNAL_INGRESS_REJECTED');
};

export const assertScheduledWakeMatchesState = (
  state: EntityState,
  tx: ScheduledWakeTx,
): void => {
  const proposerSignerId = state.config.validators?.[0];
  if (!proposerSignerId || proposerSignerId.toLowerCase() !== tx.data.proposerSignerId.toLowerCase()) {
    throw new Error('SCHEDULED_WAKE_PROPOSER_MISMATCH');
  }
  if (
    tx.data.version !== 1 ||
    !Number.isSafeInteger(tx.data.dueAt) ||
    tx.data.dueAt < 0 ||
    tx.data.dueAt > state.timestamp ||
    !Array.isArray(tx.data.jobs) ||
    tx.data.jobs.length === 0 ||
    tx.data.jobs.length > MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS
  ) {
    throw new Error('SCHEDULED_WAKE_INVALID_PAYLOAD');
  }
  const actual = [...tx.data.jobs].sort((left, right) =>
    left.dueAt - right.dueAt || compareStableText(left.kind, right.kind) || compareStableText(left.id, right.id));
  const actualKeys = actual.map(job => safeStringify(job));
  const actualIsCanonical = safeStringify(actual) === safeStringify(tx.data.jobs);
  const actualIsUnique = new Set(actualKeys).size === actualKeys.length;
  const actualIsStructurallyValid = actual.every(job =>
    (job.kind === 'hook' || job.kind === 'task') &&
    typeof job.id === 'string' &&
    job.id.length > 0 &&
    job.id.length <= 256 &&
    Number.isSafeInteger(job.dueAt) &&
    job.dueAt >= 0 &&
    job.dueAt <= state.timestamp);
  if (
    actual[0]!.dueAt !== tx.data.dueAt ||
    !actualIsCanonical ||
    !actualIsUnique ||
    !actualIsStructurallyValid
  ) {
    throw new Error(`SCHEDULED_WAKE_INVALID_PAYLOAD: jobs=${safeStringify(tx.data.jobs)}`);
  }
};

export const assertScheduledWakeFrameOrder = (entityTxs: readonly EntityTx[]): void => {
  const wakeIndexes = entityTxs.flatMap((tx, index) => tx.type === 'scheduledWake' ? [index] : []);
  if (wakeIndexes.length === 0) return;
  if (wakeIndexes.length !== 1 || wakeIndexes[0] !== 0) {
    throw new Error(`SCHEDULED_WAKE_FRAME_ORDER_INVALID: indexes=${wakeIndexes.join(',')}`);
  }
};

export const deleteScheduledWakeIndex = (env: Env): void => {
  if (env.runtimeState) delete env.runtimeState.scheduledWakeIndex;
};

export const scheduledWakeTaskId = (method: CrontabTaskMethod): string => method;
