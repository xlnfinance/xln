import { RemoteRuntimeAdapter } from '../../../../../core/api/runtime-adapter/remote';
import type { RuntimeAdapterEntitySummary } from '../../../../../core/api/runtime-adapter/types';
import type { StorageHead } from '../../../../../core/storage/types';
import {
  assertRemoteRuntimeTokenFresh,
  describeRemoteRuntimeImportError,
  remoteRuntimeIdForWsUrl,
  readRemoteRuntimeTokenAudience,
  type RemoteRuntimeImportEntry,
  type RemoteRuntimeHubSummary,
  type StoredRemoteRuntimeImportEntry,
} from './remoteRuntimeImport';

export type RemoteRuntimeValidationProgress = {
  index: number;
  status: 'checking' | 'connected' | 'error';
  detail: string;
};

const remoteHubSummaryFromEntity = (entity: RuntimeAdapterEntitySummary): RemoteRuntimeHubSummary | null => {
  if (entity?.isHub !== true) return null;
  return remoteEntitySummaryFromEntity(entity);
};

const remoteEntitySummaryFromEntity = (entity: RuntimeAdapterEntitySummary): RemoteRuntimeHubSummary | null => {
  const entityId = String(entity.entityId || '')
    .trim()
    .toLowerCase();
  if (!entityId) return null;
  const runtimeId = String(entity.runtimeId || '')
    .trim()
    .toLowerCase();
  return {
    entityId,
    ...(runtimeId ? { runtimeId } : {}),
    label: String(entity.label || entityId).trim(),
    height: Math.max(0, Math.floor(Number(entity.height || 0))),
    ...(entity.jurisdiction ? { jurisdiction: entity.jurisdiction } : {}),
  };
};

const normalizeHubLabel = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^remote\s+/, '');

const hubLabelMatchesImportLabel = (hubLabel: string, importLabel: string): boolean => {
  const hub = normalizeHubLabel(hubLabel);
  const imported = normalizeHubLabel(importLabel);
  if (!hub || !imported) return false;
  return hub === imported || hub.startsWith(`${imported} `) || hub.startsWith(`${imported}(`);
};

export const selectPrimaryRemoteHubSummary = (
  hubEntities: RemoteRuntimeHubSummary[],
  importLabel: string,
  runtimeId = '',
): RemoteRuntimeHubSummary | null => {
  if (hubEntities.length === 0) return null;
  const normalizedRuntimeId = String(runtimeId || '')
    .trim()
    .toLowerCase();
  if (normalizedRuntimeId) {
    return (
      hubEntities.find(
        hub =>
          String(hub.runtimeId || '')
            .trim()
            .toLowerCase() === normalizedRuntimeId && hubLabelMatchesImportLabel(hub.label, importLabel),
      ) ??
      hubEntities.find(
        hub =>
          String(hub.runtimeId || '')
            .trim()
            .toLowerCase() === normalizedRuntimeId,
      ) ??
      hubEntities.find(hub => hubLabelMatchesImportLabel(hub.label, importLabel)) ??
      hubEntities[0]! ??
      null
    );
  }
  return hubEntities.find(hub => hubLabelMatchesImportLabel(hub.label, importLabel)) ?? hubEntities[0]! ?? null;
};

export const selectPrimaryRemoteEntitySummary = (
  entitySummaries: RemoteRuntimeHubSummary[],
  importLabel: string,
  runtimeId = '',
): RemoteRuntimeHubSummary | null => {
  if (entitySummaries.length === 0) return null;
  const normalizedRuntimeId = String(runtimeId || '')
    .trim()
    .toLowerCase();
  const runtimeScoped = normalizedRuntimeId
    ? entitySummaries.filter(
        entity =>
          String(entity.runtimeId || '')
            .trim()
            .toLowerCase() === normalizedRuntimeId,
      )
    : entitySummaries;
  return (
    runtimeScoped.find(entity => hubLabelMatchesImportLabel(entity.label, importLabel)) ??
    entitySummaries.find(entity => hubLabelMatchesImportLabel(entity.label, importLabel)) ??
    (runtimeScoped.length === 1 ? runtimeScoped[0]! : null) ??
    (entitySummaries.length === 1 ? entitySummaries[0]! : null)
  );
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
      requestTimeoutMs: 5_000,
    });
    if (adapter.status !== 'connected') {
      throw new Error(`REMOTE_RUNTIME_CONNECT_FAILED:${entry.wsUrl}:${adapter.status}`);
    }
    const expectedAuthLevel = 'admin';
    if (adapter.authLevel !== expectedAuthLevel) {
      throw new Error(
        `REMOTE_RUNTIME_ACCESS_MISMATCH:${entry.label}:${expectedAuthLevel}:${adapter.authLevel || 'none'}`,
      );
    }
    const runtimeId =
      String(adapter.runtimeId || readRemoteRuntimeTokenAudience(entry.token))
        .trim()
        .toLowerCase() || remoteRuntimeIdForWsUrl(entry.wsUrl);
    const head = await adapter.read<StorageHead>('head');
    const entities = await adapter.read<RuntimeAdapterEntitySummary[]>('entities');
    const entityCount = entities.length;
    if (entityCount < 1) throw new Error(`REMOTE_RUNTIME_EMPTY:${entry.label}`);
    const height = Math.max(0, Math.floor(Number(head.latestHeight ?? adapter.currentHeight ?? 0)));
    const entitySummaries = entities.flatMap(entity => {
      const summary = remoteEntitySummaryFromEntity(entity);
      return summary ? [summary] : [];
    });
    const hubEntities = entities.flatMap(entity => {
      const summary = remoteHubSummaryFromEntity(entity);
      return summary ? [summary] : [];
    });
    const primaryHub = selectPrimaryRemoteHubSummary(hubEntities, entry.label, runtimeId);
    const primaryEntity =
      selectPrimaryRemoteEntitySummary(entitySummaries, entry.label, runtimeId) ??
      (entitySummaries.length <= 1 ? primaryHub : null);
    options.onProgress?.({ index, status: 'connected', detail: `${entityCount} entities at height ${height}` });
    return {
      ...entry,
      runtimeId,
      authLevel: expectedAuthLevel,
      height,
      entityCount,
      importedAt,
      ...(primaryEntity
        ? {
            hubEntityId: primaryEntity.entityId,
            hubName: primaryEntity.label,
            ...(primaryEntity.jurisdiction ? { hubJurisdiction: primaryEntity.jurisdiction } : {}),
          }
        : {}),
      ...(hubEntities.length > 0 ? { hubEntities } : {}),
    };
  } catch (error) {
    options.onProgress?.({ index, status: 'error', detail: describeRemoteRuntimeImportError(error, entry) });
    throw error;
  } finally {
    adapter.disconnect();
  }
};
