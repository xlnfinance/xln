import { ensureGossipProfiles } from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../protocol/boundary-validation';
import { serializeTaggedJson } from '../../../protocol/serialization';
import { parseTaggedControlBody, requireDaemonControlAuth } from './auth';

export const handleGossipProfileCounterparties = async (
  request: Request,
  env: RuntimeReplica,
  headers: HeadersInit,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, env);
  if (authError) return authError;
  const body = requireBoundaryRecord(
    await parseTaggedControlBody(request),
    'CONTROL_GOSSIP_COUNTERPARTIES_REQUEST_INVALID',
  );
  requireExactBoundaryKeys(
    body,
    ['entityIds'],
    [],
    'CONTROL_GOSSIP_COUNTERPARTIES_REQUEST_FIELDS_INVALID',
  );
  const rawEntityIds = body['entityIds'];
  if (!Array.isArray(rawEntityIds) || rawEntityIds.length > 2_000) {
    throw new Error('CONTROL_GOSSIP_COUNTERPARTIES_ENTITY_IDS_INVALID');
  }
  const entityIds = rawEntityIds.map(value => String(value).trim().toLowerCase());
  if (entityIds.some(entityId => !/^0x[0-9a-f]{64}$/.test(entityId))) {
    throw new Error('CONTROL_GOSSIP_COUNTERPARTIES_ENTITY_ID_INVALID');
  }
  const missing = entityIds.filter(entityId => !env.gossip.profiles.has(entityId));
  if (missing.length > 0) await ensureGossipProfiles(env, missing);
  const counterparties = Object.fromEntries(entityIds.map(entityId => {
    const profile = env.gossip.profiles.get(entityId);
    return [
      entityId,
      profile ? profile.accounts.map(account => account.counterpartyId.toLowerCase()) : null,
    ];
  }));
  return new Response(serializeTaggedJson({ ok: true, counterparties }), { headers });
};
