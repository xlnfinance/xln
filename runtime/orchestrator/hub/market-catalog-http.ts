import { getEntityReplicaById } from '../../entity/replica/replica-lookup';
import { buildMarketPairCatalogForReplica, normalizeMarketEntityId } from '../../network/relay/market/snapshot';
import { safeStringify } from '../../protocol/serialization';
import type { RuntimeReplica } from '../../runtime/types';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

export const handleMarketPairCatalogRequest = (
  env: RuntimeReplica,
  request: Request,
  url: URL,
  defaultHubEntityId: string,
): Response | null => {
  if (url.pathname !== '/api/market/catalog' || request.method !== 'GET') return null;
  const requestedRaw = url.searchParams.get('hubEntityId') || url.searchParams.get('hub') || '';
  const hubEntityId = requestedRaw ? normalizeMarketEntityId(requestedRaw) : defaultHubEntityId;
  if (!hubEntityId) {
    return new Response(safeStringify({ error: 'Invalid hubEntityId', code: 'E_BAD_QUERY' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }
  const replica = getEntityReplicaById(env, hubEntityId);
  if (!replica) {
    return new Response(safeStringify({ error: `Unknown market hub: ${hubEntityId}`, code: 'E_UNKNOWN_HUB' }), {
      status: 404,
      headers: JSON_HEADERS,
    });
  }
  return new Response(safeStringify(buildMarketPairCatalogForReplica(replica, hubEntityId)), {
    headers: JSON_HEADERS,
  });
};
