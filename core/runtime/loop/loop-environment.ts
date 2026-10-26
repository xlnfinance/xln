import {
} from '../replica/platform.ts';
import {
  isProductionRuntime,
  readRuntimeEnv,
  runtimeIsBrowser,
} from '../../support/process/runtime-process.ts';
import { resolveRuntimeMinFrameDelayMs } from '../config/frame-cadence.ts';
import { safeStringify } from '../../protocol/serialization';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope.ts';
import type { RuntimeReplica, RuntimeInput } from '../types.ts';
import {
  getRuntimeCommandReadiness,
  inferRuntimeLifecyclePhase,
  type RuntimeLifecyclePhase,
} from '../replica/lifecycle.ts';

export const ENV_APPLY_ALLOWED_KEY = Symbol.for('xln.runtime.env.apply.allowed');
export const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');

export const readRuntimeMetadata = (env: RuntimeReplica, key: PropertyKey): unknown =>
  Reflect.get(env, key);

export const writeRuntimeMetadata = (
  env: RuntimeReplica,
  key: PropertyKey,
  value: unknown,
): void => {
  if (!Reflect.set(env, key, value)) {
    throw new Error(`RUNTIME_METADATA_WRITE_FAILED:${String(key)}`);
  }
};

export const deleteRuntimeMetadata = (env: RuntimeReplica, key: PropertyKey): void => {
  if (!Reflect.deleteProperty(env, key)) {
    throw new Error(`RUNTIME_METADATA_DELETE_FAILED:${String(key)}`);
  }
};

export const failfastAssert: (
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => asserts condition = (condition, code, message, details) => {
  if (condition) return;
  const detailText = details ? ` ${safeStringify(details)}` : '';
  throw new Error(`${code}: ${message}${detailText}`);
};

export const registerEnvChangeCallback = (
  env: RuntimeReplica,
  callback: (env: RuntimeReplica) => void,
): (() => void) => {
  const state = ensureRuntimeInfrastructure(env);
  state.envChangeCallbacks ??= new Set();
  state.envChangeCallbacks.add(callback);
  return () => state.envChangeCallbacks?.delete(callback);
};

export type RuntimePublishedNotice = Readonly<{
  runtimeId: string;
  height: number;
  timestamp: number;
  lifecyclePhase: RuntimeLifecyclePhase;
  commandReady: boolean;
  commandReadyReason: string | null;
}>;

/**
 * Public observers receive values, never the mutable Runtime object.
 *
 * Runtime owns and mutates its State in place while it constructs the next
 * frame. Letting a UI retain that object would expose H+1 before WAL commits.
 * This adapter deliberately publishes only an immutable scalar notice; callers
 * fetch bounded, owned projections through RuntimeAdapter reads.
 */
const runtimePublishedNotice = (env: RuntimeReplica): RuntimePublishedNotice => {
  const state = ensureRuntimeInfrastructure(env);
  if (state.stateMutationInFlight) throw new Error('RUNTIME_PUBLISHED_NOTICE_BEFORE_COMMIT');
  const readiness = getRuntimeCommandReadiness(env);
  return Object.freeze({
    runtimeId: String(env.runtimeId || '').trim().toLowerCase(),
    height: Math.max(0, Math.floor(Number(env.state.height || 0))),
    timestamp: Math.max(0, Math.floor(Number(env.state.timestamp || 0))),
    lifecyclePhase: inferRuntimeLifecyclePhase(state),
    commandReady: readiness.ready,
    commandReadyReason: readiness.reason,
  });
};

export const registerRuntimePublishedCallback = (
  env: RuntimeReplica,
  callback: (notice: RuntimePublishedNotice) => void,
): (() => void) => {
  const state = ensureRuntimeInfrastructure(env);
  let committed = state.stateMutationInFlight ? null : runtimePublishedNotice(env);
  const offCommit = registerEnvChangeCallback(env, next => {
    committed = runtimePublishedNotice(next);
    callback(committed);
  });
  const onHalt = () => {
    // A transport/storage halt may interrupt H+1. Publish only readiness and the
    // cached committed H; never expose the partially mutated financial state.
    if (committed) callback(Object.freeze({ ...committed, lifecyclePhase: 'halted',
      commandReady: false, commandReadyReason: 'HALTED_REQUIRES_OPERATOR' }));
  };
  state.runtimeHaltCallbacks ??= new Set();
  state.runtimeHaltCallbacks.add(onHalt);
  return () => { offCommit(); state.runtimeHaltCallbacks?.delete(onHalt); };
};

export const registerRuntimeFrameCommitCallback = (
  env: RuntimeReplica,
  callback: (frame: { height: number; runtimeInput: RuntimeInput }) => void,
): (() => void) => {
  const state = ensureRuntimeInfrastructure(env);
  state.runtimeFrameCommitCallbacks ??= new Set();
  state.runtimeFrameCommitCallbacks.add(callback);
  return () => state.runtimeFrameCommitCallbacks?.delete(callback);
};

export const registerRecoveryBackupBarrier = (
  env: RuntimeReplica,
  callback: (
    env: RuntimeReplica,
    info: { height: number; remoteOutputCount: number; jInputCount: number },
  ) => Promise<void>,
): (() => void) => {
  const state = ensureRuntimeInfrastructure(env);
  state.recoveryBackupBarrier = callback;
  return () => {
    if (state.recoveryBackupBarrier === callback) state.recoveryBackupBarrier = null;
  };
};

const readPositiveInteger = (name: string): number | undefined => {
  const raw = readRuntimeEnv(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`RUNTIME_CONFIG_${name.slice(4)}_INVALID:${raw}`);
  }
  return value;
};

/**
 * A Runtime frame costs about the same whether it carries one transaction or a
 * hundred: the fixed apply/commit/persist work dominates the marginal per-tx
 * cost. Holding a frame back therefore buys throughput almost for free, at the
 * price of up to this much added latency per hop. Every production Runtime uses
 * the same default; tests and scenarios remain unpaced unless configured.
 */
const runtimeMinFrameDelayMs = (): number =>
  resolveRuntimeMinFrameDelayMs(
    readRuntimeEnv('XLN_RUNTIME_MIN_FRAME_DELAY_MS'),
    isProductionRuntime,
  );

/**
 * Recovery replays every frame after the last materialized graph through full
 * Entity/Account consensus (~40-90 ms per wallet frame). A browser Runtime is
 * reopened on every unlock and reload, so the hub cadence of 100 frames made
 * each unlock replay up to 99 frames. Materializing at each quiescent frame
 * bounds that replay to the in-flight suffix: a frame whose Entity replicas
 * are not quiescent keeps accumulating until the next quiescent one.
 */
export const BROWSER_RUNTIME_STORAGE_CONFIG = { materializePeriodFrames: 1 } as const;

/** New replicas persist the resolved cadence before their first frame. */
export const createRuntimeConfig = (): RuntimeReplica['runtimeConfig'] => ({
  minFrameDelayMs: runtimeMinFrameDelayMs(),
  loopIntervalMs: isProductionRuntime ? 25 : 0,
  ...(runtimeIsBrowser ? { storage: { ...BROWSER_RUNTIME_STORAGE_CONFIG } } : {}),
});

export const ensureRuntimeConfig = (env: RuntimeReplica): NonNullable<RuntimeReplica['runtimeConfig']> => {
  if (!Number.isSafeInteger(env.runtimeConfig.minFrameDelayMs) || env.runtimeConfig.minFrameDelayMs < 0) {
    throw new Error(`RUNTIME_MIN_FRAME_DELAY_MS_INVALID:${String(env.runtimeConfig.minFrameDelayMs)}`);
  }
  const epochMaxBytes = readPositiveInteger('XLN_STORAGE_EPOCH_MAX_BYTES');
  if (epochMaxBytes !== undefined && env.runtimeConfig.storage?.epochMaxBytes === undefined) {
    env.runtimeConfig.storage = { ...env.runtimeConfig.storage, epochMaxBytes };
  }
  const snapshotPeriodFrames = readPositiveInteger('XLN_STORAGE_SNAPSHOT_PERIOD_FRAMES');
  if (
    snapshotPeriodFrames !== undefined &&
    env.runtimeConfig.storage?.snapshotPeriodFrames === undefined
  ) {
    env.runtimeConfig.storage = { ...env.runtimeConfig.storage, snapshotPeriodFrames };
  }
  const materializePeriodFrames = readPositiveInteger('XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES');
  if (
    materializePeriodFrames !== undefined &&
    env.runtimeConfig.storage?.materializePeriodFrames === undefined
  ) {
    env.runtimeConfig.storage = { ...env.runtimeConfig.storage, materializePeriodFrames };
  }
  for (const [name, value] of Object.entries(env.runtimeConfig.performance ?? {})) {
    if (!Number.isFinite(value) || Number(value) <= 0) {
      throw new Error(`RUNTIME_CONFIG_PERFORMANCE_${name.toUpperCase()}_INVALID:${String(value)}`);
    }
  }
  return env.runtimeConfig;
};
