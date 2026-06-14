import { normalizeRuntimeId } from '../networking/runtime-id';

export type MarketMakerTransportState = {
  connected?: boolean;
  directPeers?: Array<{ runtimeId?: string; open?: boolean }>;
};

export type MarketMakerTransportHub = {
  runtimeId?: string;
};

export const areMarketMakerHubTransportsReady = (
  p2pState: MarketMakerTransportState,
  hubs: readonly MarketMakerTransportHub[],
): boolean => {
  const requiredRuntimeIds = new Set(
    hubs
      .map(hub => normalizeRuntimeId(hub.runtimeId || ''))
      .filter(runtimeId => runtimeId.length > 0),
  );
  if (requiredRuntimeIds.size === 0) return false;

  const openRuntimeIds = new Set(
    (p2pState.directPeers || [])
      .filter(peer => peer.open === true)
      .map(peer => normalizeRuntimeId(peer.runtimeId || ''))
      .filter(runtimeId => runtimeId.length > 0),
  );
  return Array.from(requiredRuntimeIds).every(runtimeId => openRuntimeIds.has(runtimeId));
};
