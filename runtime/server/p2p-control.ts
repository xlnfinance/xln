import type { Env } from '../types';
import { serializeTaggedJson } from '../serialization-utils';
import { getControlBodyErrorStatus } from './auth';
import type { parseTaggedControlBody as parseTaggedControlBodyType } from './auth';
import type { startP2P as startP2PType } from '../runtime';

type P2PControlDeps = {
  parseTaggedControlBody: typeof parseTaggedControlBodyType;
  startP2P: typeof startP2PType;
};

export const handleP2PControl = async (
  req: Request,
  headers: HeadersInit,
  env: Env | null,
  deps: P2PControlDeps,
): Promise<Response> => {
  if (!env) {
    return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
  }
  try {
    const body = await deps.parseTaggedControlBody<{
      relayUrls?: unknown;
      advertiseEntityIds?: unknown;
      gossipPollMs?: unknown;
    }>(req);
    const relayUrls = Array.isArray(body?.relayUrls)
      ? body.relayUrls.map(value => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
      : undefined;
    const advertiseEntityIds = Array.isArray(body?.advertiseEntityIds)
      ? body.advertiseEntityIds.map(value => (typeof value === 'string' ? value.trim().toLowerCase() : '')).filter(Boolean)
      : undefined;
    const gossipPollMs = Number.isFinite(Number(body?.gossipPollMs))
      ? Math.max(250, Math.floor(Number(body?.gossipPollMs)))
      : undefined;

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
      serializeTaggedJson({ ok: false, error: (error as Error).message || 'Failed to update P2P config' }),
      { status: getControlBodyErrorStatus(error, 500), headers },
    );
  }
};
