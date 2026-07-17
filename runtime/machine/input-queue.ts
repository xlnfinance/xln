import { TIMING } from '../constants';
import type {
  EntityInput,
  Env,
  JInput,
  ReliableDeliveryReceipt,
  RuntimeInput,
  RuntimeTx,
} from '../types';
import { getWallClockMs } from '../utils';
import { createStructuredLogger } from '../infra/logger';

const runtimeInputQueueLog = createStructuredLogger('runtime.input_queue');

export type RuntimeInputQueueDeps = {
  ensureRuntimeState: (env: Env) => NonNullable<Env['runtimeState']>;
  requestRuntimeLoopWake: (env: Env) => void;
};

export type RuntimeInputQueueOptions = {
  /** Pre-fence work, including a deterministic continuation of that work. */
  acceptedBeforeQuiesce?: boolean;
};

const shouldLogRuntimeInputDebug = (): boolean => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.['XLN_RUNTIME_INPUT_DEBUG'] === '1';
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
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
  reliableReceipts?: ReliableDeliveryReceipt[],
  options: RuntimeInputQueueOptions = {},
): void => {
  const mempool = ensureRuntimeMempool(env);
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
