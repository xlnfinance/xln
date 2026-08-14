import { safeParse } from '../../protocol/serialization';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import type { MarketCapToken } from '../../network/relay/market/cap/market-cap';
import { decodeMarketCapTokens } from '../../network/relay/market/cap/market-cap-wire';
import type { MarketPairCatalogPayload, MarketSnapshotPayload } from '../../network/relay/market/snapshot';
import {
  decodeMarketPairCatalogPayload,
  decodeMarketSnapshotPayload,
} from '../../network/relay/market/wire';
import type { HubChild } from '../orchestrator-types';

type HubMarketLocation = Readonly<{
  host: string;
  apiPort: number;
  hubEntityId: string;
}>;

class MarketSnapshotUnavailableError extends Error {
  readonly code = 'E_MARKET_SNAPSHOT_UNAVAILABLE';
}

export const listConnectedMarketHubEntityIds = (children: readonly HubChild[]): string[] => Array.from(new Set(
  children.flatMap(child => {
    if (child.proc?.exitCode !== null || child.proc?.signalCode !== null || !child.lastHealth) return [];
    return [
      child.lastInfo?.entityId,
      child.lastHealth.entityId,
      ...(child.lastInfo?.hubEntities ?? []).map(entry => entry.entityId),
    ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
  }),
)).sort();

const fetchWithTimeout = async (url: string): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export const fetchMarketSnapshotsFromHub = async (
  location: HubMarketLocation,
  pairIds: string[],
  depth: number,
): Promise<MarketSnapshotPayload[]> => {
  const params = new URLSearchParams({ hubEntityId: location.hubEntityId, depth: String(depth) });
  for (const pairId of pairIds) params.append('pair', pairId);
  try {
    const response = await fetchWithTimeout(
      `http://${location.host}:${location.apiPort}/api/market/snapshots?${params.toString()}`,
    );
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new MarketSnapshotUnavailableError(`Market snapshots unavailable for hub: ${location.hubEntityId}`);
    const envelope = requireBoundaryRecord(payload, 'MARKET_SNAPSHOT_ENVELOPE_INVALID');
    requireExactBoundaryKeys(envelope, ['hubEntityId', 'depth', 'snapshots'], [], 'MARKET_SNAPSHOT_ENVELOPE_FIELDS_INVALID');
    if (envelope['hubEntityId'] !== location.hubEntityId || !Array.isArray(envelope['snapshots'])) {
      throw new Error('MARKET_SNAPSHOT_ENVELOPE_VALUES_INVALID');
    }
    requireBoundaryInteger(envelope['depth'], 'MARKET_SNAPSHOT_ENVELOPE_DEPTH_INVALID', 1);
    return envelope['snapshots'].map(decodeMarketSnapshotPayload);
  } catch (error) {
    if (error instanceof MarketSnapshotUnavailableError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new MarketSnapshotUnavailableError(`Market snapshots unavailable for hub: ${location.hubEntityId}:${detail}`);
  }
};

export const fetchMarketPairCatalogFromHub = async (
  location: HubMarketLocation,
): Promise<MarketPairCatalogPayload> => {
  const response = await fetchWithTimeout(
    `http://${location.host}:${location.apiPort}/api/market/catalog?hubEntityId=${encodeURIComponent(location.hubEntityId)}`,
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`MARKET_CAP_CATALOG_UNAVAILABLE:${location.hubEntityId}:${response.status}`);
  return decodeMarketPairCatalogPayload(payload);
};

export const fetchMarketTokensFromHub = async (
  location: HubMarketLocation,
): Promise<MarketCapToken[]> => {
  const response = await fetchWithTimeout(`http://${location.host}:${location.apiPort}/api/tokens`);
  const raw = await response.text();
  if (!response.ok) throw new Error(`MARKET_CAP_TOKENS_UNAVAILABLE:${location.hubEntityId}:${response.status}`);
  return decodeMarketCapTokens(safeParse(raw));
};
