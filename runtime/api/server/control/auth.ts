import {
  resolveRuntimeAdapterAuthAudience,
  resolveRuntimeAdapterAuthSeed,
  runtimeAdapterRevokedTokenIds,
  verifyRuntimeAdapterAuthCredential,
} from '../../runtime-adapter/security/auth';
import type { RuntimeAdapterAuthLevel } from '../../runtime-adapter/types';
import { deserializeTaggedJson, serializeTaggedJson } from '../../../protocol/serialization';
import type { RuntimeReplica } from '../../../runtime/types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const DEFAULT_CONTROL_BODY_MAX_BYTES = 256 * 1024;
const authLevelRank = (level: RuntimeAdapterAuthLevel): number => level === 'admin' ? 2 : 1;

const extractBearerAuth = (header: string | null): string => {
  const match = String(header || '').trim().match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : '';
};

const verifyDaemonCapability = (
  env: RuntimeReplica | null,
  key: unknown,
  requiredLevel: RuntimeAdapterAuthLevel,
): boolean => {
  if (!env) return false;
  const auth = verifyRuntimeAdapterAuthCredential(resolveRuntimeAdapterAuthSeed(), key, {
    audience: resolveRuntimeAdapterAuthAudience(env),
    revokedTokenIds: runtimeAdapterRevokedTokenIds(),
  });
  return !!auth && authLevelRank(auth.level) >= authLevelRank(requiredLevel);
};

export const hasDaemonControlAuth = (
  req: Request,
  env: RuntimeReplica | null,
  requiredLevel: RuntimeAdapterAuthLevel = 'admin',
): boolean => env !== null && verifyDaemonCapability(
  env,
  extractBearerAuth(req.headers.get('authorization')),
  requiredLevel,
);

export const requireDaemonControlAuth = (
  req: Request,
  env: RuntimeReplica | null,
  requiredLevel: RuntimeAdapterAuthLevel = 'admin',
): Response | null => {
  if (!env) {
    return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers: JSON_HEADERS });
  }
  if (hasDaemonControlAuth(req, env, requiredLevel)) return null;
  return new Response(serializeTaggedJson({ ok: false, error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS });
};

class ControlBodyTooLargeError extends Error {
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

export const getControlBodyErrorStatus = (error: unknown, defaultStatus: number): number => {
  if (error instanceof ControlBodyTooLargeError) return error.status;
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('CONTROL_BODY_TOO_LARGE') ? 413 : defaultStatus;
};

export const parseTaggedControlBody = async (
  req: Request,
  maxBytes = DEFAULT_CONTROL_BODY_MAX_BYTES,
): Promise<unknown> => {
  const raw = await readCappedControlBody(req, maxBytes);
  if (!raw.trim()) return {};
  return deserializeTaggedJson<unknown>(raw);
};
