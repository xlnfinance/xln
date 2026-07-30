import { TIMING } from '../config/constants';
import type { EntityInput } from '../entity/types';
import type { RuntimeReplica, ReliableDeliveryReceipt, RuntimeInput, RuntimeTx } from './types';
import type { JInput } from '../jurisdiction/input';
import { getWallClockMs } from '../infra/time';
import { createStructuredLogger } from '../infra/logger';
import { ensureRuntimeState } from './runtime-state';

const runtimeInputQueueLog = createStructuredLogger('runtime.input_queue');

export type RuntimeInputQueueDeps = {
  ensureRuntimeState: (env: RuntimeReplica) => NonNullable<RuntimeReplica['infrastructure']>;
  requestRuntimeLoopWake: (env: RuntimeReplica) => void;
};

export type RuntimeInputQueueOptions = {
  /** Pre-fence work, including a deterministic continuation of that work. */
  acceptedBeforeQuiesce?: boolean;
};

export const requestRuntimeLoopWake = (env: RuntimeReplica): void => {
  const state = ensureRuntimeState(env);
  if (state.halted) return;
  const wakeLoop = state.wakeLoop;
  if (wakeLoop) {
    state.wakeLoop = null;
    wakeLoop();
    return;
  }
  state.wakeRequested = true;
};

const shouldLogRuntimeInputDebug = (): boolean => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.['XLN_RUNTIME_INPUT_DEBUG'] === '1';
};

export const requireRuntimeMempool = (env: RuntimeReplica): RuntimeInput => {
  if (!env.runtimeMempool) throw new Error('RUNTIME_MEMPOOL_MISSING');
  return env.runtimeMempool;
};

const normalizeIngressTimestamp = (env: RuntimeReplica, explicitTimestamp?: number): number => {
  if (typeof explicitTimestamp === 'number' && Number.isFinite(explicitTimestamp) && explicitTimestamp > 0) {
    const sanitizedTimestamp = Math.floor(explicitTimestamp);
    if (env.scenarioMode) return sanitizedTimestamp;
    const logicalNow = env.state.timestamp ?? 0;
    const maxAcceptedTimestamp = Math.max(logicalNow, getWallClockMs() + TIMING.TIMESTAMP_DRIFT_MS);
    return Math.max(logicalNow, Math.min(sanitizedTimestamp, maxAcceptedTimestamp));
  }
  return env.state.timestamp ?? 0;
};

/**
 * Normalize all runtime ingress into one mutable mempool object. This is still
 * pre-consensus: queued inputs are observable work, not committed state.
 */
export const enqueueRuntimeInputsWithDeps = (
  env: RuntimeReplica,
  deps: RuntimeInputQueueDeps,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
  reliableReceipts?: ReliableDeliveryReceipt[],
  options: RuntimeInputQueueOptions = {},
): void => {
  const mempool = requireRuntimeMempool(env);
  const state = deps.ensureRuntimeState(env);
  const hasIncomingWork = Boolean(
    inputs?.length || runtimeTxs?.length || jInputs?.length || reliableReceipts?.length,
  );
  if (
    hasIncomingWork &&
    state.persistenceQuiescing &&
    state.persistencePaused &&
    options.acceptedBeforeQuiesce !== true
  ) {
    const runtimeTxTypes = (runtimeTxs ?? []).map((tx) => tx.type).join(',') || 'none';
    throw new Error(
      `RUNTIME_INPUT_INGRESS_AFTER_PERSISTENCE_PAUSE:` +
      `runtime=${String(env.runtimeId || '<unknown>')}:runtimeTxs=${runtimeTxTypes}:` +
      `entityInputs=${inputs?.length ?? 0}:jInputs=${jInputs?.length ?? 0}:` +
      `reliableReceipts=${reliableReceipts?.length ?? 0}`,
    );
  }
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
  if (reliableReceipts && reliableReceipts.length > 0) {
    mempool.reliableReceipts = [
      ...(mempool.reliableReceipts ?? []),
      ...reliableReceipts,
    ];
  }
  if (shouldLogRuntimeInputDebug()) {
    const interestingEntityInputs = (inputs || [])
      .map((input) => ({
        entityId: String(input.entityId || ''),
        signerId: String(input.signerId || ''),
        txTypes: Array.isArray(input.entityTxs) ? input.entityTxs.map((tx) => String(tx?.type || '')) : [],
      }))
      .filter((input) => input.txTypes.some((type) => type.startsWith('j_') || type.startsWith('dispute')));
    if (interestingEntityInputs.length > 0) {
      runtimeInputQueueLog.info('interesting_entity_inputs', {
        runtimeId: env.runtimeId,
        queuedAt: mempool.queuedAt,
        totalEntityInputs: mempool.entityInputs.length,
        totalRuntimeTxs: mempool.runtimeTxs.length,
        inputs: interestingEntityInputs,
      });
    }
  }
  if (inputs?.length || runtimeTxs?.length || jInputs?.length || reliableReceipts?.length) {
    const targetQueuedAt = normalizedTimestamp;
    mempool.queuedAt =
      mempool.queuedAt === undefined
        ? targetQueuedAt
        : Math.max(mempool.queuedAt, targetQueuedAt);
    deps.requestRuntimeLoopWake(env);
  }
};

export const enqueueRuntimeInput = (env: RuntimeReplica, runtimeInput: RuntimeInput): void => {
  const ingressTimestamp = env.scenarioMode
    ? (runtimeInput.timestamp ?? env.state.timestamp ?? 0)
    : (runtimeInput.timestamp ?? getWallClockMs());
  enqueueRuntimeInputsWithDeps(
    env,
    { ensureRuntimeState, requestRuntimeLoopWake },
    runtimeInput.entityInputs,
    runtimeInput.runtimeTxs,
    runtimeInput.jInputs,
    ingressTimestamp,
    runtimeInput.reliableReceipts,
  );
};
