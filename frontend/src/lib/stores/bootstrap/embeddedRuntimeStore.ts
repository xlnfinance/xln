import { derived, get, writable } from 'svelte/store';
import type { RuntimeReplica } from '@xln/core/api/public/runtime-module';
import { activeRuntimeId, runtimes } from '../runtimeStore';
import { createDetachedRuntimeViewEnv, createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/runtime/liveRuntimeEnv';
import { registerDebugSurface } from '$lib/utils/runtime/debugSurface';
import { errorLog } from '../errorLogStore';
import { hasConnectedJurisdictionAdapter } from '../vault/vault-helpers';
import { getXLN } from './xlnRuntimeLoader';

const bootstrapEnvironment = writable<RuntimeReplica | null>(null);

// TEMP DIAGNOSTIC: pinpoint what makes xlnEnvironment drop entities. Edge-
// triggered so it only fires when this derived store's resolved env actually
// loses its entity replicas, not on every commit-driven recompute.
let lastXlnEnvEntityCountDiag = -1;

// Active env is derived from selected runtime in dropdown. A selected remote
// runtime intentionally has no RuntimeReplica; remote UI reads RuntimeView projections.
export const xlnEnvironment = derived(
  [bootstrapEnvironment, runtimes, activeRuntimeId],
  ([$bootstrapEnvironment, $runtimes, $activeRuntimeId]) => {
    const selectedRuntimeId = String($activeRuntimeId || '').toLowerCase();
    let resolved: RuntimeReplica | null;
    let branch: string;
    let runtimeEntryFound: boolean | null = null;
    if (selectedRuntimeId) {
      const runtimeEntry = $runtimes.get(selectedRuntimeId);
      runtimeEntryFound = !!runtimeEntry;
      resolved = runtimeEntry?.env ?? null;
      branch = 'runtimes.get(selectedRuntimeId)';
    } else {
      resolved = $bootstrapEnvironment;
      branch = 'bootstrapEnvironment';
    }
    const entityCount = resolved?.state?.eReplicas instanceof Map ? resolved.state.eReplicas.size : -1;
    if (lastXlnEnvEntityCountDiag > 0 && entityCount <= 0) {
      console.warn('[XLN-BLINK] xlnEnvironment dropped entities', {
        branch,
        selectedRuntimeId: selectedRuntimeId || null,
        runtimeEntryFound,
        knownRuntimeIds: Array.from($runtimes.keys()),
        resolvedEnvPresent: !!resolved,
        entityCount,
        previousEntityCount: lastXlnEnvEntityCountDiag,
        timestamp: Date.now(),
      });
      console.trace('[XLN-BLINK] xlnEnvironment drop trace');
    }
    lastXlnEnvEntityCountDiag = entityCount;
    return resolved;
  },
);

let localDebugEnv: RuntimeReplica | null = null;
let localRuntimeEnv: RuntimeReplica | null = null;
registerDebugSurface('env', () => localDebugEnv);
registerDebugSurface('runtimeConnectivity', () => {
  const selectedRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
  const selectedEnv = selectedRuntimeId ? get(runtimes).get(selectedRuntimeId)?.env : null;
  const runtimeEnv = unwrapLiveRuntimeEnv(selectedEnv) ?? localRuntimeEnv;
  const p2p = runtimeEnv?.infrastructure?.p2p;
  return {
    selectedRuntimeId,
    hasSelectedEnv: Boolean(selectedEnv),
    runtimeId: String(runtimeEnv?.runtimeId || ''),
    lifecyclePhase: runtimeEnv?.infrastructure?.lifecyclePhase ?? null,
    loopActive: runtimeEnv?.infrastructure?.loopActive === true,
    persistencePaused: runtimeEnv?.infrastructure?.persistencePaused === true,
    connected: Boolean(p2p?.isConnected?.()),
    connecting: Boolean(p2p?.isConnecting?.()),
    relayClientCount: p2p?.getRelayClientCount?.() ?? 0,
    relayUrls: [...(runtimeEnv?.infrastructure?.lastP2PConfig?.relayUrls ?? [])],
    profiles: (runtimeEnv?.gossip.getProfiles() ?? []).map(profile => ({
      entityId: profile.entityId,
      runtimeId: profile.runtimeId,
      wsUrl: profile.wsUrl,
      isHub: profile.metadata?.isHub === true,
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
registerDebugSurface('jurisdictionConnectivity', () => ({
  runtimeId: String(localRuntimeEnv?.runtimeId || ''),
  jurisdictions: Array.from(localRuntimeEnv?.state.jReplicas.keys() ?? [], name => {
    const replica = localRuntimeEnv?.state.jReplicas.get(name);
    const adapter = localRuntimeEnv?.infrastructure?.liveJAdapters?.get(name);
    return {
      name: String(name),
      chainId: Number(replica?.chainId ?? 0),
      depositoryAddress: String(replica?.contracts?.depository ?? ''),
      connected: localRuntimeEnv ? hasConnectedJurisdictionAdapter(localRuntimeEnv, name) : false,
      mode: adapter?.mode ?? null,
      watching: Boolean(adapter?.isWatching?.()),
      scannedThroughHeight: Number(adapter?.getWatcherScanProgress?.().scannedThroughHeight ?? 0),
    };
  }),
}));
registerDebugSurface('runtimePersistence', () => ({
  runtimeId: String(localRuntimeEnv?.runtimeId || ''),
  snapshotPeriodFrames: localRuntimeEnv?.runtimeConfig?.storage?.snapshotPeriodFrames ?? null,
  setSnapshotPeriodFrames: (frames: number) => {
    if (!localRuntimeEnv) throw new Error('RUNTIME_PERSISTENCE_ENV_UNAVAILABLE');
    if (!localRuntimeEnv.runtimeConfig) throw new Error('RUNTIME_PERSISTENCE_CONFIG_UNAVAILABLE');
    if (!Number.isSafeInteger(frames) || frames < 1) {
      throw new Error(`RUNTIME_PERSISTENCE_SNAPSHOT_PERIOD_INVALID:${frames}`);
    }
    localRuntimeEnv.runtimeConfig = {
      ...localRuntimeEnv.runtimeConfig,
      storage: {
        ...(localRuntimeEnv.runtimeConfig?.storage ?? {}),
        snapshotPeriodFrames: frames,
      },
    };
    return frames;
  },
  readAccountRebalanceFees: async (input: {
    entityId: string;
    counterpartyId: string;
    afterHeight: number;
    throughHeight: number;
    tokenId: number;
  }) => {
    if (!localRuntimeEnv) throw new Error('RUNTIME_PERSISTENCE_ENV_UNAVAILABLE');
    const { afterHeight, throughHeight, tokenId } = input;
    if (
      !Number.isSafeInteger(afterHeight) || afterHeight < 0 ||
      !Number.isSafeInteger(throughHeight) || throughHeight < afterHeight ||
      throughHeight - afterHeight > 1_000 ||
      !Number.isSafeInteger(tokenId) || tokenId < 0
    ) throw new Error('RUNTIME_ACCOUNT_FEE_QUERY_BOUNDARY_INVALID');
    const xln = await getXLN();
    const frames = await xln.readPersistedAccountFrameHistory(
      localRuntimeEnv,
      input.entityId,
      input.counterpartyId,
      Math.max(1, throughHeight - afterHeight + 1),
      { maxAccountHeight: throughHeight },
    );
    return frames
      .filter(frame => frame.height > afterHeight && frame.height <= throughHeight)
      .flatMap(frame => frame.accountTxs.flatMap(tx => {
        if (tx.type !== 'request_collateral' || tx.data.tokenId !== tokenId) return [];
        return [{
          height: frame.height,
          feeTokenId: tx.data.feeTokenId ?? tx.data.tokenId,
          feeAmount: tx.data.feeAmount.toString(),
        }];
      }));
  },
}));

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
