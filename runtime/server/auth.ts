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
export const DEFAULT_CONTROL_BODY_MAX_BYTES = 256 * 1024;
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

export class ControlBodyTooLargeError extends Error {
  readonly status = 413;

  constructor(bytes: number, maxBytes: number) {
    super(`CONTROL_BODY_TOO_LARGE: bytes=${bytes} max=${maxBytes}`);
    this.name = 'ControlBodyTooLargeError';
  }
}

const parseContentLength = (req: Request): number | null => {
  const raw = req.headers.get('content-length');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};

const readCappedControlBody = async (req: Request, maxBytes: number): Promise<string> => {
  const contentLength = parseContentLength(req);
  if (contentLength !== null && contentLength > maxBytes) {
    throw new ControlBodyTooLargeError(contentLength, maxBytes);
  }
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new ControlBodyTooLargeError(total, maxBytes);
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
};

export const getControlBodyErrorStatus = (error: unknown, fallbackStatus: number): number => {
  if (error instanceof ControlBodyTooLargeError) return error.status;
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('CONTROL_BODY_TOO_LARGE') ? 413 : fallbackStatus;
};

export const parseTaggedControlBody = async <T>(
  req: Request,
  maxBytes = DEFAULT_CONTROL_BODY_MAX_BYTES,
): Promise<T> => {
  const raw = await readCappedControlBody(req, maxBytes);
  if (!raw.trim()) return {} as T;
  return deserializeTaggedJson<T>(raw);
};
