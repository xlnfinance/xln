import {
  DEFAULT_SNAPSHOT_INTERVAL_FRAMES,
} from './platform';
import {
  isProductionRuntime,
  readRuntimeEnv,
} from '../infra/runtime-process';
import { safeStringify } from '../protocol/serialization';
import { ensureRuntimeState } from './runtime-state';
import type { RuntimeState, RuntimeInput } from '../types';

export const ENV_APPLY_ALLOWED_KEY = Symbol.for('xln.runtime.env.apply.allowed');
export const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');

export const readRuntimeMetadata = (env: RuntimeState, key: PropertyKey): unknown =>
  Reflect.get(env, key);

export const writeRuntimeMetadata = (
  env: RuntimeState,
  key: PropertyKey,
  value: unknown,
): void => {
  if (!Reflect.set(env, key, value)) {
    throw new Error(`RUNTIME_METADATA_WRITE_FAILED:${String(key)}`);
  }
};

export const deleteRuntimeMetadata = (env: RuntimeState, key: PropertyKey): void => {
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
  env: RuntimeState,
  callback: (env: RuntimeState) => void,
): (() => void) => {
  const state = ensureRuntimeState(env);
  state.envChangeCallbacks ??= new Set();
  state.envChangeCallbacks.add(callback);
  return () => state.envChangeCallbacks?.delete(callback);
};

export const registerRuntimeFrameCommitCallback = (
  env: RuntimeState,
  callback: (frame: { height: number; runtimeInput: RuntimeInput }) => void,
): (() => void) => {
  const state = ensureRuntimeState(env);
  state.runtimeFrameCommitCallbacks ??= new Set();
  state.runtimeFrameCommitCallbacks.add(callback);
  return () => state.runtimeFrameCommitCallbacks?.delete(callback);
};

export const registerRecoveryBackupBarrier = (
  env: RuntimeState,
  callback: (
    env: RuntimeState,
    info: { height: number; remoteOutputCount: number; jInputCount: number },
  ) => Promise<void>,
): (() => void) => {
  const state = ensureRuntimeState(env);
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

export const ensureRuntimeConfig = (env: RuntimeState): NonNullable<RuntimeState['runtimeConfig']> => {
  env.runtimeConfig ??= {
    minFrameDelayMs: 0,
    loopIntervalMs: isProductionRuntime ? 25 : 0,
    snapshotIntervalFrames: DEFAULT_SNAPSHOT_INTERVAL_FRAMES,
  };
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
  if (
    !Number.isFinite(env.runtimeConfig.snapshotIntervalFrames ?? NaN) ||
    (env.runtimeConfig.snapshotIntervalFrames ?? 0) < 1
  ) {
    env.runtimeConfig.snapshotIntervalFrames = DEFAULT_SNAPSHOT_INTERVAL_FRAMES;
  }
  for (const [name, value] of Object.entries(env.runtimeConfig.performance ?? {})) {
    if (!Number.isFinite(value) || Number(value) <= 0) {
      throw new Error(`RUNTIME_CONFIG_PERFORMANCE_${name.toUpperCase()}_INVALID:${String(value)}`);
    }
  }
  return env.runtimeConfig;
};
