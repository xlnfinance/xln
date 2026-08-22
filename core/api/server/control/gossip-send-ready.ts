import { getP2P } from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../protocol/boundary-validation';
import { serializeTaggedJson } from '../../../protocol/serialization';
import { parseTaggedControlBody, requireDaemonControlAuth } from './auth';

const ENTITY_ID = /^0x[0-9a-f]{64}$/;
const RUNTIME_ID = /^0x[0-9a-f]{40}$/;
const ENCRYPTION_KEY = /^0x[0-9a-f]{64}$/;

export const handleGossipProfilesSendReady = async (
  request: Request,
  env: RuntimeReplica,
  headers: HeadersInit,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, env);
  if (authError) return authError;
  const body = requireBoundaryRecord(
    await parseTaggedControlBody(request),
    'CONTROL_GOSSIP_SEND_READY_REQUEST_INVALID',
  );
  requireExactBoundaryKeys(body, ['targets'], [], 'CONTROL_GOSSIP_SEND_READY_REQUEST_FIELDS_INVALID');
  const rawTargets = body['targets'];
  if (!Array.isArray(rawTargets) || rawTargets.length < 1 || rawTargets.length > 2_000) {
    throw new Error('CONTROL_GOSSIP_SEND_READY_TARGETS_INVALID');
  }
  const targets = rawTargets.map((value, index) => {
    const target = requireBoundaryRecord(value, `CONTROL_GOSSIP_SEND_READY_TARGET_INVALID:${index}`);
    requireExactBoundaryKeys(
      target,
      ['entityId', 'runtimeId'],
      [],
      `CONTROL_GOSSIP_SEND_READY_TARGET_FIELDS_INVALID:${index}`,
    );
    const entityId = String(target['entityId'] || '').trim().toLowerCase();
    const runtimeId = String(target['runtimeId'] || '').trim().toLowerCase();
    if (!ENTITY_ID.test(entityId) || !RUNTIME_ID.test(runtimeId)) {
      throw new Error(`CONTROL_GOSSIP_SEND_READY_TARGET_ID_INVALID:${index}`);
    }
    return { entityId, runtimeId };
  });
  const missingProfiles = targets
    .map(target => target.entityId)
    .filter(entityId => !env.gossip.profiles.has(entityId));
  // All users have announced before this one-shot barrier. Drain new relay
  // sequence pages once, then wait locally; never exact-fetch hundreds of IDs.
  if (missingProfiles.length > 0) {
    await getP2P(env)?.refreshSeedProfilesAndWait(missingProfiles, 10_000);
  }
  const missing = targets.filter(target => {
    const profile = env.gossip.profiles.get(target.entityId);
    return !profile || profile.runtimeId?.toLowerCase() !== target.runtimeId ||
      !ENCRYPTION_KEY.test(String(profile.runtimeEncPubKey || ''));
  }).map(target => target.entityId);
  return new Response(serializeTaggedJson({ ok: true, ready: missing.length === 0, missing }), { headers });
};
