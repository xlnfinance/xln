import { TIMING } from './constants';
import type { Env, JInput, RoutedEntityInput, RuntimeInput, RuntimeTx } from './types';
import { getWallClockMs } from './utils';

export type RuntimeInputQueueDeps = {
  ensureRuntimeState: (env: Env) => NonNullable<Env['runtimeState']>;
  requestRuntimeLoopWake: (env: Env) => void;
};

const hasMeaningfulEnqueuedWork = (inputs?: RoutedEntityInput[], runtimeTxs?: RuntimeTx[]): boolean => {
  if ((runtimeTxs?.length ?? 0) > 0) return true;
  return (inputs ?? []).some((input) => {
    const hasEntityTxs = (input.entityTxs?.length ?? 0) > 0;
    const hasProposal = !!input.proposedFrame;
    const hasHashPrecommits = !!input.hashPrecommits && input.hashPrecommits.size > 0;
    return hasEntityTxs || hasProposal || hasHashPrecommits;
  });
};

export const ensureRuntimeMempool = (env: Env): RuntimeInput => {
  if (!env.runtimeMempool) {
    const base = env.runtimeInput ?? { runtimeTxs: [], entityInputs: [] };
    env.runtimeMempool = base;
    env.runtimeInput = base;
  } else if (env.runtimeInput !== env.runtimeMempool) {
    env.runtimeInput = env.runtimeMempool;
  }
  return env.runtimeMempool;
};

const normalizeIngressTimestamp = (env: Env, explicitTimestamp?: number): number => {
  if (typeof explicitTimestamp === 'number' && Number.isFinite(explicitTimestamp) && explicitTimestamp > 0) {
    const sanitizedTimestamp = Math.floor(explicitTimestamp);
    if (env.scenarioMode) return sanitizedTimestamp;
    const logicalNow = env.timestamp ?? 0;
    const maxAcceptedTimestamp = Math.max(logicalNow, getWallClockMs() + TIMING.TIMESTAMP_DRIFT_MS);
    return Math.max(logicalNow, Math.min(sanitizedTimestamp, maxAcceptedTimestamp));
  }
  return env.timestamp ?? 0;
};

/**
 * Normalize all runtime ingress into one mutable mempool object. This is still
 * pre-consensus: queued inputs are observable work, not committed state.
 */
export const enqueueRuntimeInputs = (
  env: Env,
  deps: RuntimeInputQueueDeps,
  inputs?: RoutedEntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
): void => {
  const mempool = ensureRuntimeMempool(env);
  const runtimeState = deps.ensureRuntimeState(env);
  const normalizedTimestamp = normalizeIngressTimestamp(env, explicitTimestamp);
  if (runtimeTxs && runtimeTxs.length > 0) {
    mempool.runtimeTxs.push(...runtimeTxs);
  }
  if (inputs && inputs.length > 0) {
    mempool.entityInputs.push(...inputs);
  }
  if (jInputs && jInputs.length > 0) {
    mempool.jInputs = [...(mempool.jInputs ?? []), ...jInputs];
  }
  const interestingEntityInputs = (inputs || [])
    .map((input) => ({
      entityId: String(input.entityId || ''),
      signerId: String(input.signerId || ''),
      txTypes: Array.isArray(input.entityTxs) ? input.entityTxs.map((tx) => String(tx?.type || '')) : [],
    }))
    .filter((input) => input.txTypes.some((type) => type.startsWith('j_') || type.startsWith('dispute')));
  if (interestingEntityInputs.length > 0) {
    console.log(
      `[enqueueRuntimeInput] interesting entityInputs=${JSON.stringify({
        runtimeId: env.runtimeId,
        queuedAt: mempool.queuedAt,
        totalEntityInputs: mempool.entityInputs.length,
        totalRuntimeTxs: mempool.runtimeTxs.length,
        inputs: interestingEntityInputs,
      })}`,
    );
  }
  if (inputs?.length || runtimeTxs?.length || jInputs?.length) {
    const targetQueuedAt = normalizedTimestamp;
    mempool.queuedAt =
      mempool.queuedAt === undefined
        ? targetQueuedAt
        : Math.max(mempool.queuedAt, targetQueuedAt);
    if (hasMeaningfulEnqueuedWork(inputs, runtimeTxs) || (jInputs?.length ?? 0) > 0) {
      runtimeState.clockPrimed = true;
    }
    deps.requestRuntimeLoopWake(env);
  }
};
