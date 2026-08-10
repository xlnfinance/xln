import { derived, get, writable } from 'svelte/store';
import type { RuntimeReplica } from '@xln/runtime/api/public/runtime-module';
import { activeRuntimeId, runtimes } from './runtimeStore';
import { createDetachedRuntimeViewEnv, createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import { registerDebugSurface } from '$lib/utils/debugSurface';
import { errorLog } from './errorLogStore';

const bootstrapEnvironment = writable<RuntimeReplica | null>(null);

// Active env is derived from selected runtime in dropdown. A selected remote
// runtime intentionally has no RuntimeReplica; remote UI reads RuntimeView projections.
export const xlnEnvironment = derived(
  [bootstrapEnvironment, runtimes, activeRuntimeId],
  ([$bootstrapEnvironment, $runtimes, $activeRuntimeId]) => {
    const selectedRuntimeId = String($activeRuntimeId || '').toLowerCase();
    if (selectedRuntimeId) {
      const runtimeEntry = $runtimes.get(selectedRuntimeId);
      return runtimeEntry?.env ?? null;
    }
    return $bootstrapEnvironment;
  },
);

let localDebugEnv: RuntimeReplica | null = null;
let localRuntimeEnv: RuntimeReplica | null = null;
registerDebugSurface('env', () => localDebugEnv);
registerDebugSurface('runtimeConnectivity', () => {
  const p2p = localRuntimeEnv?.infrastructure?.p2p;
  return {
    runtimeId: String(localRuntimeEnv?.runtimeId || ''),
    connected: Boolean(p2p?.isConnected?.()),
    connecting: Boolean(p2p?.isConnecting?.()),
    relayUrls: [...(localRuntimeEnv?.infrastructure?.lastP2PConfig?.relayUrls ?? [])],
    profiles: (localRuntimeEnv?.gossip.getProfiles() ?? []).map(profile => ({
      entityId: profile.entityId,
      runtimeId: profile.runtimeId,
      wsUrl: profile.wsUrl,
    })),
    directPeers: p2p?.getDirectPeerState?.() ?? [],
    queue: p2p?.getQueueState?.() ?? null,
    reconnectState: p2p?.getReconnectState?.() ?? null,
    connect: () => p2p?.connect?.(),
    reconnect: () => p2p?.reconnect?.(),
    refreshGossip: () => p2p?.refreshGossip?.(),
    ensureProfiles: (entityIds: string[]) => p2p?.ensureProfiles?.(entityIds) ?? Promise.resolve(false),
  };
});

export function setXlnEnvironment(env: RuntimeReplica | null): void {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  if (!runtimeEnv) {
    bootstrapEnvironment.set(null);
    localDebugEnv = null;
    localRuntimeEnv = null;
    return;
  }

  const viewEnv = createRuntimeViewEnv(runtimeEnv);
  const selectedRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
  const envRuntimeId = String(runtimeEnv.runtimeId || '').toLowerCase();
  const canPublishActiveEnv = !selectedRuntimeId || (envRuntimeId !== '' && envRuntimeId === selectedRuntimeId);

  if (canPublishActiveEnv) {
    bootstrapEnvironment.set(viewEnv);
    localDebugEnv = createDetachedRuntimeViewEnv(runtimeEnv);
    localRuntimeEnv = runtimeEnv;
  } else {
    const message = `RUNTIME_STORE_ENV_OVERWRITE_REFUSED: refusing to publish env ${envRuntimeId || '<missing>'} while runtime ${selectedRuntimeId} is selected`;
    errorLog.log(message, 'Runtime RuntimeReplica', { envRuntimeId: envRuntimeId || null, selectedRuntimeId });
    throw new Error(message);
  }

  const targetRuntimeId = envRuntimeId || (canPublishActiveEnv ? selectedRuntimeId : '');
  if (!targetRuntimeId) return;

  runtimes.update((map) => {
    const runtimeEntry = map.get(targetRuntimeId);
    if (!runtimeEntry) return map;
    const updated = new Map(map);
    updated.set(targetRuntimeId, {
      ...runtimeEntry,
      env: viewEnv,
      lastSynced: Date.now(),
    });
    return updated;
  });
}
