import type { RuntimeAdapterEntitySummary } from '@xln/core/api/public/runtime-module';
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

/** Gossip summaries have no signer. Only a replica served by this Runtime owns readable Accounts. */
export function selectOrderbookSource(input: {
  hubId: string;
  runtimeId: string;
  summaries: readonly RuntimeAdapterEntitySummary[];
  crossMarket: boolean;
}): 'hosted' | 'relay' {
  if (input.crossMarket) return 'relay';
  return input.summaries.some(
    summary =>
      summary.entityId.toLowerCase() === input.hubId &&
      Boolean(summary.signerId) &&
      summary.runtimeId?.toLowerCase() === input.runtimeId.toLowerCase(),
  )
    ? 'hosted'
    : 'relay';
}
