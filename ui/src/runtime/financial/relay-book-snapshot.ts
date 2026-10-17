import type { RelayMarketSnapshotPayload } from '@xln/core/network/relay/market/aggregate';

/** The wallet subscribes to one hub and pair; aggregate or previous-market quotes cannot price its ticket. */
export function selectRelaySnapshot(
  snapshot: RelayMarketSnapshotPayload | null,
  hubId: string,
  pairId: string,
): RelayMarketSnapshotPayload | null {
  return snapshot?.pairId === pairId && snapshot.sources.length === 1 && snapshot.sources[0]?.hubEntityId === hubId
    ? snapshot
    : null;
}
