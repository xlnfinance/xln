import { runtimeOperations } from '#lib/stores/runtimeStore.ts';
import type { RemoteRuntimeImportEntry, StoredRemoteRuntimeImportEntry } from './remoteRuntimeImport';
import type { RemoteRuntimeValidationProgress } from './remoteRuntimeValidation';
import { validateRemoteRuntimeImportEntries, writeRemoteRuntimeImportSummary } from './remoteRuntimeImportValidation';

export type RemoteRuntimeImportFlowResult = {
  importedAt: number;
  total: number;
  validated: StoredRemoteRuntimeImportEntry[];
  failed: Array<{ entry: RemoteRuntimeImportEntry; reason: string }>;
  persisted: StoredRemoteRuntimeImportEntry[];
};

export const persistActiveRemoteRuntimeImport = (entry: StoredRemoteRuntimeImportEntry): void => {
  if (typeof localStorage === 'undefined' || typeof sessionStorage === 'undefined') return;
  localStorage.setItem('xln-runtime-adapter-mode', 'remote');
  localStorage.setItem('xln-runtime-adapter-ws', entry.wsUrl);
  localStorage.setItem('xln-runtime-adapter-access', entry.access);
  localStorage.removeItem('xln-runtime-adapter-key');
  sessionStorage.setItem('xln-runtime-adapter-key', entry.token);
};

export const importRemoteRuntimeEntries = async (
  entries: RemoteRuntimeImportEntry[],
  options: {
    activateFirst?: boolean;
    onProgress?: (progress: RemoteRuntimeValidationProgress) => void;
  } = {},
): Promise<RemoteRuntimeImportFlowResult> => {
  const importedAt = Date.now();
  const results = await validateRemoteRuntimeImportEntries(entries, {
    importedAt,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  const validated = results.flatMap(result => (result.ok ? [result.stored] : []));
  const failed = results.flatMap(result => (result.ok ? [] : [{ entry: result.entry, reason: result.reason }]));
  writeRemoteRuntimeImportSummary(results, entries.length, importedAt);
  if (validated.length === 0) {
    throw new Error(failed[0]?.reason || 'REMOTE_RUNTIME_IMPORT_EMPTY');
  }
  const persisted = runtimeOperations.upsertRemoteRuntimeImports(validated);
  if (options.activateFirst === true) {
    const first = validated[0]!;
    const activated = await runtimeOperations.activateRemoteRuntime(first.runtimeId, { href: '/app' });
    if (!activated) throw new Error(`${first.label}: connected but could not activate the runtime`);
  }
  return {
    importedAt,
    total: entries.length,
    validated,
    failed,
    persisted,
  };
};
