import {
  resolveRuntimeAdapterAuthAudience,
  resolveRuntimeAdapterAuthSeed,
  runtimeAdapterRevokedTokenIds,
  verifyRuntimeAdapterAuthCredential,
} from '../radapter/auth';
import type { RuntimeAdapterAuthLevel } from '../radapter/types';
import { safeStringify, deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';
import type { Env } from '../types';

type RpcSocket = { send(data: string): unknown };

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const authLevelRank = (level: RuntimeAdapterAuthLevel): number => level === 'admin' ? 2 : 1;

const extractBearerAuth = (header: string | null): string => {
  const match = String(header || '').trim().match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : '';
};

const verifyDaemonCapability = (
  env: Env | null,
  key: unknown,
  requiredLevel: RuntimeAdapterAuthLevel,
): boolean => {
  if (!env) return false;
  const auth = verifyRuntimeAdapterAuthCredential(resolveRuntimeAdapterAuthSeed(env), key, {
    audience: resolveRuntimeAdapterAuthAudience(env),
    revokedTokenIds: runtimeAdapterRevokedTokenIds(),
  });
  return !!auth && authLevelRank(auth.level) >= authLevelRank(requiredLevel);
};

export const requireDaemonControlAuth = (
  req: Request,
  env: Env | null,
  requiredLevel: RuntimeAdapterAuthLevel = 'admin',
): Response | null => {
  if (!env) {
    return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers: JSON_HEADERS });
  }
  if (verifyDaemonCapability(env, extractBearerAuth(req.headers.get('authorization')), requiredLevel)) return null;
  return new Response(serializeTaggedJson({ ok: false, error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS });
};

export const requireDaemonRpcAuth = (
  ws: RpcSocket,
  id: unknown,
  msg: Record<string, unknown>,
  env: Env | null,
  requiredLevel: RuntimeAdapterAuthLevel,
): boolean => {
  if (!env) {
    ws.send(safeStringify({ type: 'error', inReplyTo: id, code: 'E_INTERNAL', error: 'Runtime not ready' }));
    return false;
  }
  if (verifyDaemonCapability(env, msg['key'], requiredLevel)) return true;
  ws.send(safeStringify({ type: 'error', inReplyTo: id, code: 'E_UNAUTHORIZED', error: 'runtime adapter capability required' }));
  return false;
};

export const parseTaggedControlBody = async <T>(req: Request): Promise<T> => {
  const raw = await req.text();
  if (!raw.trim()) return {} as T;
  return deserializeTaggedJson<T>(raw);
};
