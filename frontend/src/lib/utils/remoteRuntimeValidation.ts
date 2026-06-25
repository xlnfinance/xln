import { RemoteRuntimeAdapter } from '@xln/runtime/radapter/remote';
import type { RuntimeAdapterEntitySummary } from '@xln/runtime/radapter/types';
import type { StorageHead } from '@xln/runtime/storage/types';
import {
  assertRemoteRuntimeTokenFresh,
  remoteRuntimeIdForWsUrl,
  type RemoteRuntimeImportEntry,
  type StoredRemoteRuntimeImportEntry,
} from '$lib/utils/remoteRuntimeImport';

export type RemoteRuntimeValidationProgress = {
  index: number;
  status: 'checking' | 'connected' | 'error';
  detail: string;
};

export const validateRemoteRuntimeEntry = async (
  entry: RemoteRuntimeImportEntry,
  options: {
    index?: number;
    importedAt?: number;
    onProgress?: (progress: RemoteRuntimeValidationProgress) => void;
  } = {},
): Promise<StoredRemoteRuntimeImportEntry> => {
  const adapter = new RemoteRuntimeAdapter();
  const index = options.index ?? 0;
  const importedAt = options.importedAt ?? Date.now();
  options.onProgress?.({ index, status: 'checking', detail: 'connecting' });
  try {
    assertRemoteRuntimeTokenFresh(entry, importedAt);
    await adapter.connect({
      mode: 'remote',
      wsUrl: entry.wsUrl,
      authKey: entry.token,
      reconnectMaxMs: 1_000,
      requestTimeoutMs: 10_000,
    });
    if (adapter.status !== 'connected') {
      throw new Error(`REMOTE_RUNTIME_CONNECT_FAILED:${entry.wsUrl}:${adapter.status}`);
    }
    const expectedAuthLevel = entry.access === 'admin' ? 'admin' : 'inspect';
    if (adapter.authLevel !== expectedAuthLevel) {
      throw new Error(`REMOTE_RUNTIME_ACCESS_MISMATCH:${entry.label}:${expectedAuthLevel}:${adapter.authLevel || 'none'}`);
    }
    const head = await adapter.read<StorageHead>('head');
    const entities = await adapter.read<RuntimeAdapterEntitySummary[]>('entities');
    const entityCount = entities.length;
    if (entityCount < 1) throw new Error(`REMOTE_RUNTIME_EMPTY:${entry.label}`);
    const height = Math.max(0, Math.floor(Number(head.latestHeight ?? adapter.currentHeight ?? 0)));
    options.onProgress?.({ index, status: 'connected', detail: `${entityCount} entities at height ${height}` });
    return {
      ...entry,
      runtimeId: remoteRuntimeIdForWsUrl(entry.wsUrl),
      authLevel: expectedAuthLevel,
      height,
      entityCount,
      importedAt,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.onProgress?.({ index, status: 'error', detail });
    throw error;
  } finally {
    adapter.disconnect();
  }
};
