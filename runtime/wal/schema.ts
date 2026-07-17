import type { FrameLogEntry, RoutedEntityInput, RuntimeInput } from '../types';
import { validateEntityInput } from '../validation-utils';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  validateFrameLogEntries,
  validateRuntimeInputEnvelope,
} from '../protocol/boundary-validation';
import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
} from '../protocol/runtime-input-clone';
import { validateDurableRuntimeMachineSnapshot } from './runtime-machine-schema';

export type PersistedFrameJournal = {
  height: number;
  timestamp: number;
  /** Exact validator-local replica metadata commitment for deterministic replay. */
  replicaMetaDigest: string;
  runtimeInput: RuntimeInput;
  runtimeOutputs?: RoutedEntityInput[];
  /** Exact durable R-machine snapshot immediately before runtimeInput. */
  runtimeMachineBeforeApply?: Record<string, unknown>;
  /** Exact durable R-machine snapshot published by this frame. */
  runtimeMachine?: Record<string, unknown>;
  runtimeStateHash?: string;
  logs: FrameLogEntry[];
};

const requireBytes32 = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(code);
  return value.toLowerCase();
};

const validateRuntimeSnapshot = (value: unknown, code: string): Record<string, unknown> => {
  return validateDurableRuntimeMachineSnapshot(value, code);
};

export const validatePersistedFrameJournal = (
  value: unknown,
  expectedHeight: number,
): PersistedFrameJournal => {
  const decoded = requireBoundaryRecord(value, 'WAL_FRAME_INVALID');
  requireExactBoundaryKeys(
    decoded,
    ['height', 'timestamp', 'replicaMetaDigest', 'runtimeInput', 'logs'],
    ['runtimeOutputs', 'runtimeMachineBeforeApply', 'runtimeMachine', 'runtimeStateHash'],
    'WAL_FIELDS_INVALID',
  );
  const height = requireBoundaryInteger(decoded['height'], 'WAL_HEIGHT_INVALID', 1);
  if (expectedHeight > 0 && height !== expectedHeight) {
    throw new Error(`WAL_HEIGHT_KEY_MISMATCH:key=${expectedHeight}:frame=${height}`);
  }
  const runtimeInput = cloneIsolatedRuntimeInput(
    validateRuntimeInputEnvelope(decoded['runtimeInput'], `WAL_RUNTIME_INPUT:height=${height}`),
  );
  const frame: PersistedFrameJournal = {
    height,
    timestamp: requireBoundaryInteger(decoded['timestamp'], `WAL_TIMESTAMP_INVALID:height=${height}`),
    replicaMetaDigest: requireBytes32(
      decoded['replicaMetaDigest'],
      `WAL_REPLICA_META_DIGEST_INVALID:height=${height}`,
    ),
    runtimeInput,
    logs: validateFrameLogEntries(decoded['logs'], `WAL_LOGS_INVALID:height=${height}`),
  };
  if (decoded['runtimeOutputs'] !== undefined) {
    if (!Array.isArray(decoded['runtimeOutputs'])) throw new Error(`WAL_RUNTIME_OUTPUTS_INVALID:height=${height}`);
    decoded['runtimeOutputs'].forEach(validateEntityInput);
    frame.runtimeOutputs = cloneIsolatedRoutedEntityInputs(decoded['runtimeOutputs'] as RoutedEntityInput[]);
  }
  if (decoded['runtimeMachineBeforeApply'] !== undefined) {
    frame.runtimeMachineBeforeApply = validateRuntimeSnapshot(
      decoded['runtimeMachineBeforeApply'],
      `WAL_RUNTIME_MACHINE_BEFORE_INVALID:height=${height}`,
    );
  }
  if (decoded['runtimeMachine'] !== undefined) {
    frame.runtimeMachine = validateRuntimeSnapshot(
      decoded['runtimeMachine'],
      `WAL_RUNTIME_MACHINE_INVALID:height=${height}`,
    );
  }
  if (decoded['runtimeStateHash'] !== undefined) {
    frame.runtimeStateHash = requireBytes32(
      decoded['runtimeStateHash'],
      `WAL_RUNTIME_STATE_HASH_INVALID:height=${height}`,
    );
  }
  return frame;
};

export const parsePersistedPositiveInteger = (value: Uint8Array, code: string): number => {
  const text = Buffer.from(value).toString();
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${code}:${text || 'empty'}`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${code}:${text}`);
  return parsed;
};
