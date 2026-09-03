import { deriveSignerAddressSync } from '../account/crypto';
import { dbRootPath } from '../runtime/replica/platform';
import type { RuntimeReplica } from '../runtime/types';
import { createStructuredLogger } from '../support/logger';
import { nodeProcess } from '../support/process/runtime-process';

const storageLog = createStructuredLogger('runtime.storage');
const DEFAULT_DB_NAMESPACE = 'default';

type RuntimeDbKind = 'core' | 'infra';

const formatStorageError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export const normalizeDbNamespace = (value: string): string => value.trim().toLowerCase();

export const deriveRuntimeIdFromSeed = (seed?: string | null): string | null => {
  if (!seed) return null;
  try {
    return deriveSignerAddressSync(seed, '1').toLowerCase();
  } catch (error) {
    storageLog.warn('namespace.derive_runtime_id_failed', { error: formatStorageError(error) });
    return null;
  }
};

export const resolveDbNamespace = (
  options: { env?: RuntimeReplica | null; runtimeId?: string | null; runtimeSeed?: string | null } = {},
): string => {
  const explicit = options.env?.dbNamespace;
  if (explicit) return normalizeDbNamespace(explicit);
  const runtimeId = options.runtimeId ?? options.env?.runtimeId;
  if (runtimeId) return normalizeDbNamespace(runtimeId);
  const seed = options.runtimeSeed ?? options.env?.runtimeSeed;
  const derived = deriveRuntimeIdFromSeed(seed ?? null);
  return derived ?? DEFAULT_DB_NAMESPACE;
};

export const resolveDbPath = (env: RuntimeReplica, kind: RuntimeDbKind = 'core'): string => {
  const namespace = resolveDbNamespace({ env });
  const suffix = kind === 'core' ? '' : '-infra';
  return nodeProcess
    ? `${dbRootPath}/${namespace}${suffix}`
    : `${dbRootPath}-${namespace}${suffix}`;
};
