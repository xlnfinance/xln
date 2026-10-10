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

const HUB_MARKET_FETCH_TIMEOUT_MS = 2_000;

type HubTextResponse = Readonly<{ ok: boolean; status: number; text: string }>;

// The deadline covers the body too: a hub that stalls after its headers must
// not hang market-cap refresh or snapshot fan-out.
const fetchTextWithTimeout = async (url: string): Promise<HubTextResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HUB_MARKET_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, status: response.status, text: await response.text() };
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
    const response = await fetchTextWithTimeout(
      `http://${location.host}:${location.apiPort}/api/market/snapshots?${params.toString()}`,
    );
    if (!response.ok) throw new MarketSnapshotUnavailableError(`Market snapshots unavailable for hub: ${location.hubEntityId}`);
    const envelope = requireBoundaryRecord(JSON.parse(response.text), 'MARKET_SNAPSHOT_ENVELOPE_INVALID');
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
  const response = await fetchTextWithTimeout(
    `http://${location.host}:${location.apiPort}/api/market/catalog?hubEntityId=${encodeURIComponent(location.hubEntityId)}`,
  );
  if (!response.ok) throw new Error(`MARKET_CAP_CATALOG_UNAVAILABLE:${location.hubEntityId}:${response.status}`);
  return decodeMarketPairCatalogPayload(JSON.parse(response.text));
};

export const fetchMarketTokensFromHub = async (
  location: HubMarketLocation,
): Promise<MarketCapToken[]> => {
  const response = await fetchTextWithTimeout(`http://${location.host}:${location.apiPort}/api/tokens`);
  if (!response.ok) throw new Error(`MARKET_CAP_TOKENS_UNAVAILABLE:${location.hubEntityId}:${response.status}`);
  return decodeMarketCapTokens(safeParse(response.text));
};
