import type {
  RuntimeAdapterBrainVaultRecovery,
  RuntimeAdapterBrainVaultResult,
  NumberedRegistrationCommandResult,
} from '../types';
import { RuntimeAdapterError } from '../errors';

// Client-side parsers for the payloads a remote runtime-adapter node answers:
// each rejects a malformed or contradictory payload with a typed error.

const recordOrNull = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const parseBrainVaultResult = (value: unknown): RuntimeAdapterBrainVaultResult => {
  const result = recordOrNull(value);
  if (!result) throw new RuntimeAdapterError('E_INTERNAL', 'BrainVault node returned an invalid result');
  for (const key of ['specId', 'ethereumAddress', 'entityId'] as const) {
    if (typeof result[key] !== 'string' || !result[key]) {
      throw new RuntimeAdapterError('E_INTERNAL', `BrainVault node omitted ${key}`);
    }
  }
  if (result['backend'] !== 'native-node') {
    throw new RuntimeAdapterError('E_INTERNAL', 'BrainVault node returned the wrong backend');
  }
  for (const key of ['shardCount', 'factor', 'workers', 'derivationTimeMs', 'height'] as const) {
    if (!Number.isSafeInteger(result[key]) || Number(result[key]) < 0) {
      throw new RuntimeAdapterError('E_INTERNAL', `BrainVault node returned invalid ${key}`);
    }
  }
  if (typeof result['created'] !== 'boolean') {
    throw new RuntimeAdapterError('E_INTERNAL', 'BrainVault node returned invalid owner state');
  }
  return result as RuntimeAdapterBrainVaultResult;
};

export const parseBrainVaultRecovery = (value: unknown): RuntimeAdapterBrainVaultRecovery => {
  const result = recordOrNull(value);
  if (!result || typeof result['mnemonic24'] !== 'string' || !result['mnemonic24'].trim()) {
    throw new RuntimeAdapterError('E_INTERNAL', 'BrainVault node returned an invalid mnemonic');
  }
  return { mnemonic24: result['mnemonic24'] };
};

export const parseNumberedRegistrationResult = (value: unknown): NumberedRegistrationCommandResult => {
  const result = recordOrNull(value);
  if (
    !result ||
    typeof result['intentId'] !== 'string' ||
    typeof result['transactionHash'] !== 'string' ||
    !Number.isSafeInteger(result['committedHeight']) ||
    !Array.isArray(result['entities'])
  ) {
    throw new RuntimeAdapterError('E_INTERNAL', 'numbered registration returned an invalid result');
  }
  for (const entity of result['entities']) {
    const record = recordOrNull(entity);
    if (
      !record ||
      typeof record['entityId'] !== 'string' ||
      !Number.isSafeInteger(record['entityNumber']) ||
      !recordOrNull(record['config']) ||
      (record['localSignerId'] !== null && typeof record['localSignerId'] !== 'string') ||
      typeof record['isProposer'] !== 'boolean' ||
      typeof record['imported'] !== 'boolean'
    ) {
      throw new RuntimeAdapterError('E_INTERNAL', 'numbered registration returned an invalid entity');
    }
  }
  return result as NumberedRegistrationCommandResult;
};

export const heightFromPayload = (payload: unknown): number => {
  const record = recordOrNull(payload);
  if (!record) return 0;
  const direct = Math.max(0, Math.floor(Number(record['latestHeight'] ?? record['height'] ?? 0)));
  const head = recordOrNull(record['head']);
  const headHeight = Math.max(0, Math.floor(Number(head?.['latestHeight'] ?? 0)));
  return Math.max(direct, headHeight);
};

export const parseCommandReadiness = (
  value: Record<string, unknown>,
): { ready: boolean; reason: string | null } => {
  const ready = value['commandReady'];
  const reason = value['commandReadyReason'];
  if (typeof ready !== 'boolean') {
    throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter server omitted canonical command readiness');
  }
  if (ready) {
    if (reason !== null) {
      throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter server returned contradictory command readiness');
    }
    return { ready: true, reason: null };
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter server omitted command readiness reason');
  }
  return { ready: false, reason: reason.trim() };
};
