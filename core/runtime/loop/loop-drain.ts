import type { RuntimeReplica } from '../types.ts';
import type { EntityReplica } from '../../entity/types';
import { inferRuntimeLifecyclePhase } from '../replica/lifecycle.ts';
import { requestRuntimeLoopWake } from '../mempool/input-queue.ts';
import { getRemainingRuntimeFrameDelayMs } from './loop-work.ts';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope.ts';
import { hasQueuedOrPendingAccountWork } from '../../entity/consensus/account/work-index';
import { ACCOUNT_WORK_PENDING, ACCOUNT_WORK_QUEUED } from '../../entity/account/account-work-flags';
import { sleep } from '../../support/boundary-guards';

export type RuntimeDrainDeps = {
  processRuntime(env: RuntimeReplica): Promise<unknown>;
  hasRuntimeWork(env: RuntimeReplica): boolean;
};

export const waitForPromiseBeforeTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const waitForProcessingCycle = async (env: RuntimeReplica, remaining: number): Promise<void> => {
  const processing = env.infrastructure?.processingPromise;
  if (!processing) return;
  await Promise.race([
    processing.then(
      () => undefined,
      () => undefined,
    ),
    sleep(Math.min(remaining, 250)),
  ]);
};

export type RuntimeDrainOptions = {
  allowPersistencePaused?: boolean;
  /**
   * Durable node shutdown only. An Account whose pendingFrame awaits a peer
   * that holds no transport is parked, not local work: its committed Account
   * output is still retained undelivered in the Runtime outbox, so no ACK can
   * be in flight, and the Entity frame plus that ordered outbox are already
   * in the Runtime WAL. Recovery rebuilds the same signed frame and redelivers
   * it on reconnect. A wallet lock never sets this and keeps waiting.
   */
  parkUndeliveredPeerFrames?: boolean;
};

const undeliveredAccountEdges = (env: RuntimeReplica): Set<string> => {
  const edges = new Set<string>();
  for (const output of env.pendingNetworkOutputs ?? []) {
    for (const tx of output.entityTxs ?? []) {
      if (tx.type === 'accountInput') edges.add(`${tx.data.fromEntityId}:${tx.data.toEntityId}`);
    }
  }
  return edges;
};

const hasUnparkedAccountWork = (
  replica: EntityReplica,
  parked: Set<string>,
): boolean => {
  const { accounts, entityId } = replica.state;
  for (const flag of [ACCOUNT_WORK_QUEUED, ACCOUNT_WORK_PENDING] as const) {
    for (const counterpartyId of accounts.workKeys(flag)) {
      const waitsOnPeer = Boolean(accounts.get(counterpartyId)?.pendingFrame) &&
        parked.has(`${entityId}:${counterpartyId}`);
      if (!waitsOnPeer) return true;
    }
  }
  return false;
};

const hasRuntimeDrainBlocker = (env: RuntimeReplica, options: RuntimeDrainOptions): boolean => {
  // A proposal awaiting its peer has no local wake work, but is not drained.
  // Otherwise the quiet window can expire before the ACK arrives and a wallet
  // lock closes the only transport carrying that accepted financial work.
  const parked = options.parkUndeliveredPeerFrames ? undeliveredAccountEdges(env) : null;
  for (const replica of env.state.eReplicas.values()) {
    if (replica.mempool.length > 0 || replica.proposal || replica.lockedFrame) return true;
    if (parked ? hasUnparkedAccountWork(replica, parked) : hasQueuedOrPendingAccountWork(replica.state)) return true;
  }
  const state = env.infrastructure;
  return Boolean(
    (state?.inFlightEntityInputs ?? 0) > 0 ||
    state?.stateMutationInFlight,
  );
};

const drainInactiveRuntime = async (
  env: RuntimeReplica,
  remaining: number,
  deps: RuntimeDrainDeps,
): Promise<boolean> => {
  const state = ensureRuntimeInfrastructure(env);
  if (state.persistencePaused) throw new Error('RUNTIME_WORK_DRAIN_PERSISTENCE_PAUSED');
  if (inferRuntimeLifecyclePhase(state) === 'halted') throw new Error('RUNTIME_WORK_DRAIN_HALTED');
  if (state.loopPromise || state.processingPromise) return false;
  const delayMs = getRemainingRuntimeFrameDelayMs(env);
  if (delayMs > 0) {
    await sleep(Math.min(remaining, delayMs, 25));
  } else {
    await deps.processRuntime(env);
  }
  return true;
};

export const waitForRuntimeWorkDrained = async (
  env: RuntimeReplica,
  deps: RuntimeDrainDeps,
  timeoutMs = 10_000,
  quietMs = 250,
  options: RuntimeDrainOptions = {},
): Promise<boolean> => {
  const startedAt = Date.now();
  let idleSince: number | null = null;
  requestRuntimeLoopWake(env);
  while (true) {
    const now = Date.now();
    const remaining = timeoutMs - (now - startedAt);
    if (remaining <= 0) return false;
    await waitForProcessingCycle(env, remaining);
    const hasDrainableWork = deps.hasRuntimeWork(env);
    const hasWork =
      hasDrainableWork ||
      hasRuntimeDrainBlocker(env, options) ||
      Boolean(env.infrastructure?.processingPromise);
    if (!hasWork) {
      idleSince ??= Date.now();
      const quietFor = Date.now() - idleSince;
      if (quietFor >= quietMs) return true;
      await sleep(Math.min(25, quietMs - quietFor));
      continue;
    }
    idleSince = null;
    if (
      hasDrainableWork &&
      !options.allowPersistencePaused &&
      await drainInactiveRuntime(env, remaining, deps)
    ) {
      continue;
    }
    if (
      hasDrainableWork &&
      options.allowPersistencePaused &&
      !env.infrastructure?.loopPromise &&
      !env.infrastructure?.processingPromise
    ) {
      await deps.processRuntime(env);
      continue;
    }
    requestRuntimeLoopWake(env);
    await sleep(10);
  }
};
