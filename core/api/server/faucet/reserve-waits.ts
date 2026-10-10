import type { RuntimeReplica } from '../../../runtime/types';
import type { JAdapter } from '../../../jurisdiction/adapter';
import { DEV_CHAIN_IDS } from '../../../jurisdiction/adapter';
import { createStructuredLogger } from '../../../support/logger';
import { getEntityReplicaById } from '../entities/lookup';
import { withRuntimeCommittedRead } from '../../../runtime/frame/lifecycle/writer-lock';
import { createBoundedLock } from '../../../support/bounded-lock';

const faucetLog = createStructuredLogger('server.faucet');

// One reserve request at a time; each holds the lock through up to ~45 s of
// chain waits, so the queue and the wait for it are bounded.
export const reserveFaucetLock = createBoundedLock({
  name: 'reserve-faucet',
  maxWaiters: 8,
  acquireTimeoutMs: 60_000,
});

const runtimePollMs = (adapter: JAdapter | null): number => {
  if (!adapter) return 100;
  if (adapter.mode === 'browservm') return 10;
  return DEV_CHAIN_IDS.has(adapter.chainId) ? 25 : 100;
};

const reservePollMs = (adapter: JAdapter): number => {
  if (adapter.mode === 'browservm') return 10;
  return DEV_CHAIN_IDS.has(adapter.chainId) ? 50 : 300;
};

const hasPendingRuntimeWork = (env: RuntimeReplica): boolean => {
  if (env.pendingOutputs?.length || env.networkInbox?.length) return true;
  if (env.runtimeMempool.runtimeTxs.length || env.runtimeMempool.entityInputs.length) return true;
  return Array.from(env.state.jReplicas?.values() ?? []).some(replica => (replica.mempool?.length ?? 0) > 0);
};

const pollUntil = async (
  predicate: () => boolean | Promise<boolean>,
  pollMs: number,
  timeoutMs: number,
): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return await predicate();
};

export const waitForRuntimeIdle = (
  env: RuntimeReplica,
  adapter: JAdapter,
  timeoutMs = 5000,
): Promise<boolean> => pollUntil(
  () => withRuntimeCommittedRead(env, () => !hasPendingRuntimeWork(env)),
  runtimePollMs(adapter),
  timeoutMs,
);

export const waitForJBatchClear = (
  env: RuntimeReplica,
  adapter: JAdapter,
  timeoutMs = 10000,
): Promise<boolean> => pollUntil(
  () => withRuntimeCommittedRead(
    env,
    () => !Array.from(env.state.jReplicas?.values() ?? [])
      .some(j => (j.mempool?.length ?? 0) > 0) &&
      !hasPendingRuntimeWork(env),
  ),
  runtimePollMs(adapter),
  timeoutMs,
);

export const waitForEntityBroadcastWindow = (
  env: RuntimeReplica,
  adapter: JAdapter,
  entityId: string,
  timeoutMs = 10000,
): Promise<boolean> => pollUntil(
  () => withRuntimeCommittedRead(
    env,
    () => !getEntityReplicaById(env, entityId)?.state?.jBatchState?.sentBatch,
  ),
  runtimePollMs(adapter),
  timeoutMs,
);

export const waitForReserveUpdate = async (
  adapter: JAdapter,
  entityId: string,
  tokenId: number,
  expectedMin: bigint,
  timeoutMs = 10000,
): Promise<bigint | null> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const current = await adapter.getReserves(entityId, tokenId);
      if (current >= expectedMin) return current;
    } catch (error) {
      // A watcher may briefly race chain availability. Keep retrying, but make
      // every failed observation visible instead of silently treating it as 0.
      faucetLog.warn('reserve.poll_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await new Promise(resolve => setTimeout(resolve, reservePollMs(adapter)));
  }
  return null;
};
