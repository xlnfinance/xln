import type { RuntimeReplica } from '../../../runtime/types';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary/boundary-primitives';
import { serializeTaggedJson } from '../../../protocol/serialization';
import { getControlBodyErrorStatus } from './auth';
import type { parseTaggedControlBody } from './auth';
import type { startP2P } from '../../../runtime';

type P2PControlDeps = {
  parseTaggedControlBody: typeof parseTaggedControlBody;
  startP2P: typeof startP2P;
};

type P2PControlBody = {
  relayUrls?: string[];
  advertiseEntityIds?: string[];
  gossipPollMs?: number;
};

const decodeStringList = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`${code}:index=${index}`);
    }
    return entry.trim();
  });
};

export const decodeP2PControlBody = (value: unknown): P2PControlBody => {
  const body = requireBoundaryRecord(value, 'P2P_CONTROL_BODY_INVALID');
  requireExactBoundaryKeys(
    body,
    [],
    ['relayUrls', 'advertiseEntityIds', 'gossipPollMs'],
    'P2P_CONTROL_FIELDS_INVALID',
  );
  const relayUrls = body['relayUrls'] === undefined
    ? undefined
    : decodeStringList(body['relayUrls'], 'P2P_CONTROL_RELAY_URLS_INVALID');
  const advertiseEntityIds = body['advertiseEntityIds'] === undefined
    ? undefined
    : decodeStringList(
      body['advertiseEntityIds'],
      'P2P_CONTROL_ENTITY_IDS_INVALID',
    ).map(entityId => entityId.toLowerCase());
  const gossipPollMs = body['gossipPollMs'] === undefined
    ? undefined
    : requireBoundaryInteger(
      body['gossipPollMs'],
      'P2P_CONTROL_GOSSIP_POLL_MS_INVALID',
      250,
    );
  return {
    ...(relayUrls === undefined ? {} : { relayUrls }),
    ...(advertiseEntityIds === undefined ? {} : { advertiseEntityIds }),
    ...(gossipPollMs === undefined ? {} : { gossipPollMs }),
  };
};

export const handleP2PControl = async (
  req: Request,
  headers: HeadersInit,
  env: RuntimeReplica | null,
  deps: P2PControlDeps,
): Promise<Response> => {
  if (!env) {
    return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
  }
  let body: P2PControlBody;
  try {
    body = decodeP2PControlBody(await deps.parseTaggedControlBody(req));
  } catch (error) {
    return new Response(
      serializeTaggedJson({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { status: getControlBodyErrorStatus(error, 400), headers },
    );
  }
  const { relayUrls, advertiseEntityIds, gossipPollMs } = body;

  try {
    deps.startP2P(env, {
      ...(relayUrls ? { relayUrls } : {}),
      ...(advertiseEntityIds ? { advertiseEntityIds } : {}),
      ...(gossipPollMs !== undefined ? { gossipPollMs } : {}),
    });

    return new Response(
      serializeTaggedJson({
        ok: true,
        config: {
          relayUrls: relayUrls ?? null,
          advertiseEntityIds: advertiseEntityIds ?? null,
          gossipPollMs: gossipPollMs ?? null,
        },
      }),
      { headers },
    );
  } catch (error) {
    return new Response(
      serializeTaggedJson({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to update P2P config',
      }),
      { status: getControlBodyErrorStatus(error, 500), headers },
    );
  }
};
