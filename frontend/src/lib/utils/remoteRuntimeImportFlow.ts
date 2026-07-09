import { runtimeOperations } from '$lib/stores/runtimeStore';
import {
  REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY,
  describeRemoteRuntimeImportError,
  parseRemoteRuntimeImportSourcePayload,
  type RemoteRuntimeImportEntry,
  type StoredRemoteRuntimeImportEntry,
} from './remoteRuntimeImport';
import { validateRemoteRuntimeEntry, type RemoteRuntimeValidationProgress } from './remoteRuntimeValidation';

export const REMOTE_RUNTIME_IMPORT_CONCURRENCY = 4;

export type RemoteRuntimeImportValidationResult =
  | { ok: true; index: number; entry: RemoteRuntimeImportEntry; stored: StoredRemoteRuntimeImportEntry }
  | { ok: false; index: number; entry: RemoteRuntimeImportEntry; reason: string };

export type RemoteRuntimeImportFlowResult = {
  importedAt: number;
  total: number;
  validated: StoredRemoteRuntimeImportEntry[];
  failed: Array<{ entry: RemoteRuntimeImportEntry; reason: string }>;
  persisted: StoredRemoteRuntimeImportEntry[];
};

type RemoteRuntimeImportSummaryEntry = {
  label: string;
  access: RemoteRuntimeImportEntry['access'];
  wsUrl: string;
  runtimeId: string;
  height: number;
  entityCount: number;
};

type RemoteRuntimeImportSummaryFailure = {
  index: number;
  label: string;
  access: RemoteRuntimeImportEntry['access'];
  wsUrl: string;
  reason: string;
};

type RemoteRuntimeImportSummaryCheckedRow =
  | ({ index: number; ok: true } & RemoteRuntimeImportSummaryEntry)
  | ({ ok: false } & RemoteRuntimeImportSummaryFailure);

export const fetchRemoteRuntimeImportSource = async (
  source: string,
): Promise<RemoteRuntimeImportEntry[]> => {
  if (typeof window === 'undefined') return [];
  const url = new URL(source, window.location.href);
  if (url.origin !== window.location.origin) {
    throw new Error(`REMOTE_RUNTIME_IMPORT_SOURCE_ORIGIN_INVALID:${url.origin}`);
  }
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`REMOTE_RUNTIME_IMPORT_SOURCE_FAILED:${response.status}`);
  return parseRemoteRuntimeImportSourcePayload(await response.json());
};

const summarizeStoredRemoteRuntimeEntry = (
  entry: StoredRemoteRuntimeImportEntry,
): RemoteRuntimeImportSummaryEntry => ({
  label: entry.label,
  access: entry.access,
  wsUrl: entry.wsUrl,
  runtimeId: entry.runtimeId,
  height: entry.height,
  entityCount: entry.entityCount,
});

const summarizeFailedRemoteRuntimeEntry = (
  result: Extract<RemoteRuntimeImportValidationResult, { ok: false }>,
): RemoteRuntimeImportSummaryFailure => ({
  index: result.index,
  label: result.entry.label,
  access: result.entry.access,
  wsUrl: result.entry.wsUrl,
  reason: result.reason,
});

export const writeRemoteRuntimeImportSummary = (
  results: RemoteRuntimeImportValidationResult[],
  total: number,
  importedAt: number,
): void => {
  if (typeof sessionStorage === 'undefined') return;
  const entries = results.flatMap((result) => result.ok ? [summarizeStoredRemoteRuntimeEntry(result.stored)] : []);
  const failed = results.flatMap((result) => result.ok ? [] : [summarizeFailedRemoteRuntimeEntry(result)]);
  const checked: RemoteRuntimeImportSummaryCheckedRow[] = results.map((result) => result.ok
    ? { index: result.index, ok: true, ...summarizeStoredRemoteRuntimeEntry(result.stored) }
    : { ok: false, ...summarizeFailedRemoteRuntimeEntry(result) });
  sessionStorage.setItem(REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY, JSON.stringify({
    ok: true,
    importedAt,
    count: entries.length,
    total,
    failedCount: failed.length,
    entries,
    failed,
    checked,
  }));
};

export const persistActiveRemoteRuntimeImport = (entry: StoredRemoteRuntimeImportEntry): void => {
  if (typeof localStorage === 'undefined' || typeof sessionStorage === 'undefined') return;
  localStorage.setItem('xln-runtime-adapter-mode', 'remote');
  localStorage.setItem('xln-runtime-adapter-ws', entry.wsUrl);
  localStorage.setItem('xln-runtime-adapter-access', entry.access);
  localStorage.removeItem('xln-runtime-adapter-key');
  sessionStorage.setItem('xln-runtime-adapter-key', entry.token);
};

export const validateRemoteRuntimeImportEntries = async (
  entries: RemoteRuntimeImportEntry[],
  options: {
    importedAt: number;
    onProgress?: (progress: RemoteRuntimeValidationProgress) => void;
  },
): Promise<RemoteRuntimeImportValidationResult[]> => {
  const results: RemoteRuntimeImportValidationResult[] = new Array(entries.length);
  let nextIndex = 0;
  const workerCount = Math.min(REMOTE_RUNTIME_IMPORT_CONCURRENCY, entries.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index]!;
      try {
        results[index] = {
          ok: true,
          index,
          entry,
          stored: await validateRemoteRuntimeEntry(entry, {
            index,
            importedAt: options.importedAt,
            ...(options.onProgress ? { onProgress: options.onProgress } : {}),
          }),
        };
      } catch (error) {
        results[index] = {
          ok: false,
          index,
          entry,
          reason: describeRemoteRuntimeImportError(error, entry),
        };
      }
    }
  });
  await Promise.allSettled(workers);
  return results;
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
  const validated = results.flatMap((result) => result.ok ? [result.stored] : []);
  const failed = results.flatMap((result) => result.ok ? [] : [{ entry: result.entry, reason: result.reason }]);
  if (validated.length === 0) {
    throw new Error(failed[0]?.reason || 'REMOTE_RUNTIME_IMPORT_EMPTY');
  }
  const persisted = runtimeOperations.upsertRemoteRuntimeImports(validated);
  writeRemoteRuntimeImportSummary(results, entries.length, importedAt);
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
