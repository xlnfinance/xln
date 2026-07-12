import type { Env } from '../types';
import { summarizeLendingState } from '../extensions/lending';
import { safeStringify } from '../protocol/serialization';
import { isEntityId32 } from './utils';
import { getEntityReplicaById } from './entity-lookup';

const parseTokenId = (value: unknown): number | null => {
  const tokenId = Math.floor(Number(value ?? 1));
  return Number.isFinite(tokenId) && tokenId > 0 ? tokenId : null;
};

const bigintFieldsToStrings = <T>(value: T): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(bigintFieldsToStrings);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = bigintFieldsToStrings(entry);
  return out;
};

export const handleLendingStateRequest = async (input: {
  req: Request;
  env: Env | null;
  headers: HeadersInit;
  activeHubEntityIds: string[];
}): Promise<Response> => {
  const { req, env, headers } = input;
  if (!env) return new Response(safeStringify({ success: false, error: 'Runtime not initialized' }), { status: 503, headers });
  const url = new URL(req.url);
  const hubEntityId = String(url.searchParams.get('hubEntityId') || '').trim().toLowerCase();
  if (!isEntityId32(hubEntityId)) {
    return new Response(safeStringify({ success: false, error: 'Invalid hubEntityId' }), { status: 400, headers });
  }
  const allowed = new Set(input.activeHubEntityIds.map(value => value.toLowerCase()));
  const replica = getEntityReplicaById(env, hubEntityId);
  if (!replica || (allowed.size > 0 && !allowed.has(hubEntityId))) {
    return new Response(safeStringify({ success: false, error: 'Requested hub is not available', hubEntityId }), { status: 404, headers });
  }
  const tokenId = url.searchParams.has('tokenId') ? parseTokenId(url.searchParams.get('tokenId')) : undefined;
  if (tokenId === null) {
    return new Response(safeStringify({ success: false, error: 'Invalid tokenId' }), { status: 400, headers });
  }
  const userEntityId = String(url.searchParams.get('userEntityId') || '').trim().toLowerCase();
  if (userEntityId && !isEntityId32(userEntityId)) {
    return new Response(safeStringify({ success: false, error: 'Invalid userEntityId' }), { status: 400, headers });
  }
  const summary = summarizeLendingState(replica.state, {
    ...(userEntityId ? { userEntityId } : {}),
    ...(tokenId !== undefined ? { tokenId } : {}),
  });
  return new Response(safeStringify({
    success: true,
    hubEntityId,
    ...bigintFieldsToStrings(summary) as Record<string, unknown>,
  }), { headers });
};
