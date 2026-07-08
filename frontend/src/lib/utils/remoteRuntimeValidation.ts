import { RemoteRuntimeAdapter } from '../../../../runtime/radapter/remote';
import { RuntimeQueryClient } from '$lib/stores/runtimeQueryClient';
import {
  assertRemoteRuntimeTokenFresh,
  describeRemoteRuntimeImportError,
  remoteRuntimeIdForWsUrl,
  readStoredRemoteRuntimeImports,
  readRemoteRuntimeTokenAudience,
  type RemoteRuntimeImportEntry,
  type RemoteRuntimeHubSummary,
  type StoredRemoteRuntimeImportEntry,
} from '$lib/utils/remoteRuntimeImport';
import type { RuntimeRecoveryPeerSource } from '$lib/stores/vaultStore';
import type { RuntimeAdapter } from '../../../../runtime/radapter/types';

export type RemoteRuntimeValidationProgress = {
  index: number;
  status: 'checking' | 'connected' | 'error';
  detail: string;
};

const remoteHubSummaryFromEntity = (
  entity: Awaited<ReturnType<RuntimeQueryClient['readEntities']>>[number],
): RemoteRuntimeHubSummary | null => {
  if (entity?.isHub !== true) return null;
  const entityId = String(entity.entityId || '').trim().toLowerCase();
  if (!entityId) return null;
  const runtimeId = String(entity.runtimeId || '').trim().toLowerCase();
  return {
    entityId,
    ...(runtimeId ? { runtimeId } : {}),
    label: String(entity.label || entityId).trim(),
    height: Math.max(0, Math.floor(Number(entity.height || 0))),
    ...(entity.jurisdiction ? { jurisdiction: entity.jurisdiction } : {}),
  };
};

const normalizeHubLabel = (value: unknown): string =>
  String(value || '').trim().toLowerCase().replace(/^remote\s+/, '');

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
  const normalizedRuntimeId = String(runtimeId || '').trim().toLowerCase();
  if (normalizedRuntimeId) {
    return hubEntities.find((hub) =>
      String(hub.runtimeId || '').trim().toLowerCase() === normalizedRuntimeId &&
      hubLabelMatchesImportLabel(hub.label, importLabel)
    )
      ?? hubEntities.find((hub) => String(hub.runtimeId || '').trim().toLowerCase() === normalizedRuntimeId)
      ?? hubEntities.find((hub) => hubLabelMatchesImportLabel(hub.label, importLabel))
      ?? hubEntities[0]!
      ?? null;
  }
  return hubEntities.find((hub) => hubLabelMatchesImportLabel(hub.label, importLabel))
    ?? hubEntities[0]!
    ?? null;
};

const normalizeRuntimeId = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const normalizeAddressRuntimeId = (value: unknown): string => {
  const normalized = normalizeRuntimeId(value);
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : '';
};

const remoteRuntimeRecoveryPeerId = (entry: Pick<StoredRemoteRuntimeImportEntry, 'runtimeId' | 'wsUrl'>): string =>
  normalizeRuntimeId(entry.runtimeId) || remoteRuntimeIdForWsUrl(entry.wsUrl);

export const buildRemoteRuntimeRecoveryPeerSources = (options: {
  entries?: StoredRemoteRuntimeImportEntry[];
  runtimeId?: string;
  createAdapter?: (entry: StoredRemoteRuntimeImportEntry) => RuntimeAdapter;
  now?: number;
} = {}): RuntimeRecoveryPeerSource[] => {
  const targetRuntimeId = normalizeRuntimeId(options.runtimeId);
  const entries = options.entries ?? readStoredRemoteRuntimeImports();
  const sources: RuntimeRecoveryPeerSource[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const runtimeId = remoteRuntimeRecoveryPeerId(entry);
    const audience = normalizeAddressRuntimeId(readRemoteRuntimeTokenAudience(entry.token));
    const comparableRuntimeId = audience || runtimeId;
    if (targetRuntimeId && comparableRuntimeId && comparableRuntimeId !== targetRuntimeId) continue;
    if (!runtimeId || seen.has(runtimeId)) continue;
    seen.add(runtimeId);

    sources.push({
      id: runtimeId,
      label: entry.hubName || entry.label || runtimeId,
      fetchBundles: async (request) => {
        const requestedRuntimeId = normalizeRuntimeId(request.runtimeId);
        if (targetRuntimeId && requestedRuntimeId && requestedRuntimeId !== targetRuntimeId) {
          throw new Error(`REMOTE_RECOVERY_RUNTIME_MISMATCH:${requestedRuntimeId}:${targetRuntimeId}`);
        }
        assertRemoteRuntimeTokenFresh(entry, options.now ?? Date.now());
        const adapter = options.createAdapter?.(entry) ?? new RemoteRuntimeAdapter();
        try {
          await adapter.connect({
            mode: 'remote',
            runtimeId: entry.runtimeId,
            wsUrl: entry.wsUrl,
            authKey: entry.token,
            reconnectMaxMs: 1_000,
            requestTimeoutMs: 5_000,
          });
          if (adapter.status !== 'connected') {
            throw new Error(`REMOTE_RUNTIME_CONNECT_FAILED:${entry.wsUrl}:${adapter.status}`);
          }
          const expectedAuthLevel = entry.access === 'admin' ? 'admin' : 'inspect';
          if (adapter.authLevel !== expectedAuthLevel) {
            throw new Error(`REMOTE_RUNTIME_ACCESS_MISMATCH:${entry.label}:${expectedAuthLevel}:${adapter.authLevel || 'none'}`);
          }
          const connectedRuntimeId = normalizeRuntimeId(adapter.runtimeId || audience || runtimeId);
          const queryClient = new RuntimeQueryClient(() => adapter, connectedRuntimeId);
          return queryClient.readRecoveryBundles(request.lookupKey);
        } finally {
          adapter.disconnect();
        }
      },
    });
  }

  return sources;
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
    const expectedAuthLevel = entry.access === 'admin' ? 'admin' : 'inspect';
    if (adapter.authLevel !== expectedAuthLevel) {
      throw new Error(`REMOTE_RUNTIME_ACCESS_MISMATCH:${entry.label}:${expectedAuthLevel}:${adapter.authLevel || 'none'}`);
    }
    const runtimeId = String(adapter.runtimeId || readRemoteRuntimeTokenAudience(entry.token)).trim().toLowerCase() || remoteRuntimeIdForWsUrl(entry.wsUrl);
    const queryClient = new RuntimeQueryClient(() => adapter, runtimeId);
    const head = await queryClient.readHead();
    const entities = await queryClient.readEntities();
    const entityCount = entities.length;
    if (entityCount < 1) throw new Error(`REMOTE_RUNTIME_EMPTY:${entry.label}`);
    const height = Math.max(0, Math.floor(Number(head.latestHeight ?? adapter.currentHeight ?? 0)));
    const hubEntities = entities.flatMap((entity) => {
      const summary = remoteHubSummaryFromEntity(entity);
      return summary ? [summary] : [];
    });
    const primaryHub = selectPrimaryRemoteHubSummary(hubEntities, entry.label, runtimeId);
    options.onProgress?.({ index, status: 'connected', detail: `${entityCount} entities at height ${height}` });
    return {
      ...entry,
      runtimeId,
      authLevel: expectedAuthLevel,
      height,
      entityCount,
      importedAt,
      ...(primaryHub ? {
        hubEntityId: primaryHub.entityId,
        hubName: primaryHub.label,
        ...(primaryHub.jurisdiction ? { hubJurisdiction: primaryHub.jurisdiction } : {}),
      } : {}),
      ...(hubEntities.length > 0 ? { hubEntities } : {}),
    };
  } catch (error) {
    options.onProgress?.({ index, status: 'error', detail: describeRemoteRuntimeImportError(error, entry) });
    throw error;
  } finally {
    adapter.disconnect();
  }
};
