import { RemoteRuntimeAdapter } from '../../../../../core/api/runtime-adapter/remote';
import { RuntimeWsClient, type RuntimeWsClientOptions } from '../../../../../core/network/p2p/ws-client';
import { deriveEncryptionKeyPair } from '../../../../../core/protocol/crypto/p2p-crypto';
import { directRuntimeWsAudience } from '../../../../../core/network/p2p/ws-protocol';
import { RuntimeQueryClient } from '#lib/stores/runtimeQueryClient.ts';
import {
  assertRemoteRuntimeTokenFresh,
  remoteRuntimeIdForWsUrl,
  readStoredRemoteRuntimeImports,
  readRemoteRuntimeTokenAudience,
  type StoredRemoteRuntimeImportEntry,
} from '#lib/utils/onboarding/remoteRuntimeImport.ts';
import type { RuntimeRecoveryPeerSource } from '#lib/stores/vault/vaultStore.ts';
import type { RuntimeAdapter } from '../../../../../core/api/runtime-adapter/types';

const normalizeRuntimeId = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase();

const normalizeAddressRuntimeId = (value: unknown): string => {
  const normalized = normalizeRuntimeId(value);
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : '';
};

const remoteRuntimeRecoveryPeerId = (entry: Pick<StoredRemoteRuntimeImportEntry, 'runtimeId' | 'wsUrl'>): string =>
  normalizeRuntimeId(entry.runtimeId) || remoteRuntimeIdForWsUrl(entry.wsUrl);

type RuntimeRecoveryWsClient = {
  connect: () => Promise<void>;
  isOpen: () => boolean;
  requestRecoveryBundles: <T = unknown>(to: string, lookupKey: string, timeoutMs?: number) => Promise<T>;
  close: () => void;
};

export type RuntimeWsRecoveryPeerEndpoint = {
  id?: string;
  label?: string;
  peerRuntimeId: string;
  wsUrl: string;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const waitForRuntimeWsOpen = async (
  client: RuntimeRecoveryWsClient,
  label: string,
  timeoutMs: number,
): Promise<void> => {
  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 5_000;
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    if (client.isOpen()) return;
    await sleep(10);
  }
  throw new Error(`RUNTIME_WS_RECOVERY_CONNECT_TIMEOUT:${label}`);
};

export const buildRuntimeWsRecoveryPeerSource = (options: {
  requesterRuntimeId: string;
  requesterSeed: string;
  endpoint: RuntimeWsRecoveryPeerEndpoint;
  requesterSignerId?: string;
  openTimeoutMs?: number;
  requestTimeoutMs?: number;
  createClient?: (clientOptions: RuntimeWsClientOptions) => RuntimeRecoveryWsClient;
}): RuntimeRecoveryPeerSource => {
  const requesterRuntimeId = normalizeAddressRuntimeId(options.requesterRuntimeId);
  const peerRuntimeId = normalizeAddressRuntimeId(options.endpoint.peerRuntimeId);
  const wsUrl = String(options.endpoint.wsUrl || '').trim();
  const requesterSeed = String(options.requesterSeed || '').trim();
  if (!requesterRuntimeId) throw new Error('RUNTIME_WS_RECOVERY_REQUESTER_RUNTIME_INVALID');
  if (!peerRuntimeId) throw new Error('RUNTIME_WS_RECOVERY_PEER_RUNTIME_INVALID');
  if (!wsUrl) throw new Error('RUNTIME_WS_RECOVERY_PEER_WS_URL_MISSING');
  if (!requesterSeed) throw new Error('RUNTIME_WS_RECOVERY_REQUESTER_SEED_MISSING');
  const label = String(options.endpoint.label || options.endpoint.id || peerRuntimeId).trim() || peerRuntimeId;
  const makeClientOptions = (): RuntimeWsClientOptions => ({
    url: wsUrl,
    runtimeId: requesterRuntimeId,
    helloAudience: directRuntimeWsAudience(peerRuntimeId),
    signerId: options.requesterSignerId || '1',
    seed: requesterSeed,
    encryptionKeyPair: deriveEncryptionKeyPair(requesterSeed),
  });

  return {
    id: options.endpoint.id || peerRuntimeId,
    label,
    fetchBundles: async request => {
      const requestedRuntimeId = normalizeAddressRuntimeId(request.runtimeId);
      if (requestedRuntimeId && requestedRuntimeId !== requesterRuntimeId) {
        throw new Error(`RUNTIME_WS_RECOVERY_RUNTIME_MISMATCH:${requestedRuntimeId}:${requesterRuntimeId}`);
      }
      const clientOptions = makeClientOptions();
      const client = options.createClient?.(clientOptions) ?? new RuntimeWsClient(clientOptions);
      try {
        await client.connect();
        await waitForRuntimeWsOpen(client, label, options.openTimeoutMs ?? 5_000);
        return await client.requestRecoveryBundles(peerRuntimeId, request.lookupKey, options.requestTimeoutMs ?? 5_000);
      } finally {
        client.close();
      }
    },
  };
};

export const buildRuntimeWsRecoveryPeerSources = (options: {
  requesterRuntimeId: string;
  requesterSeed: string;
  endpoints?: RuntimeWsRecoveryPeerEndpoint[];
  requesterSignerId?: string;
  openTimeoutMs?: number;
  requestTimeoutMs?: number;
  createClient?: (clientOptions: RuntimeWsClientOptions) => RuntimeRecoveryWsClient;
}): RuntimeRecoveryPeerSource[] => {
  const sources: RuntimeRecoveryPeerSource[] = [];
  const seen = new Set<string>();
  for (const endpoint of options.endpoints ?? []) {
    const peerRuntimeId = normalizeAddressRuntimeId(endpoint.peerRuntimeId);
    const wsUrl = String(endpoint.wsUrl || '').trim();
    if (!peerRuntimeId) throw new Error('RUNTIME_WS_RECOVERY_PEER_RUNTIME_INVALID');
    if (!wsUrl) throw new Error('RUNTIME_WS_RECOVERY_PEER_WS_URL_MISSING');
    const key = `${peerRuntimeId}:${wsUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(
      buildRuntimeWsRecoveryPeerSource({
        requesterRuntimeId: options.requesterRuntimeId,
        requesterSeed: options.requesterSeed,
        endpoint,
        ...(options.requesterSignerId ? { requesterSignerId: options.requesterSignerId } : {}),
        ...(options.openTimeoutMs !== undefined ? { openTimeoutMs: options.openTimeoutMs } : {}),
        ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        ...(options.createClient ? { createClient: options.createClient } : {}),
      }),
    );
  }
  return sources;
};

export const buildRemoteRuntimeRecoveryPeerSources = (
  options: {
    entries?: StoredRemoteRuntimeImportEntry[];
    runtimeId?: string;
    createAdapter?: (entry: StoredRemoteRuntimeImportEntry) => RuntimeAdapter;
    now?: number;
  } = {},
): RuntimeRecoveryPeerSource[] => {
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
      fetchBundles: async request => {
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
          const expectedAuthLevel = 'admin';
          if (adapter.authLevel !== expectedAuthLevel) {
            throw new Error(
              `REMOTE_RUNTIME_ACCESS_MISMATCH:${entry.label}:${expectedAuthLevel}:${adapter.authLevel || 'none'}`,
            );
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
