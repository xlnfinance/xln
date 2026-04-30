import type { EntityState, Env, RuntimeInput } from '../types';
import { encodeRuntimeAdapterMessage } from './codec';
import type { StorageFrameRecord, StorageHead } from '../storage/types';
import { RuntimeAdapterError, toRuntimeAdapterErrorPayload } from './errors';
import { consumeToken, createTokenBucket, tokenRetryAfterMs, type TokenBucket } from './rate-limit';
import { resolveRuntimeAdapterRead } from './resolve';
import type {
  RuntimeAdapterAuthLevel,
  RuntimeAdapterRequest,
  RuntimeAdapterResponse,
} from './types';
import {
  resolveRuntimeAdapterAuthSeed,
  verifyRuntimeAdapterAuthCredential,
} from './auth';

type AdapterSocket = {
  send: (message: string | Uint8Array) => unknown;
};

type AdapterClientState = {
  authLevel: RuntimeAdapterAuthLevel | null;
  authExpiresAtMs: number | null;
  controlBucket: TokenBucket;
  readBucket: TokenBucket;
  sendBucket: TokenBucket;
};

export type RuntimeAdapterServerDeps = {
  readHead?: (env: Env) => Promise<StorageHead | null>;
  readFrame?: (env: Env, height: number) => Promise<StorageFrameRecord | null>;
  listCheckpoints?: (env: Env) => Promise<number[]>;
  loadEntityState?: (env: Env, entityId: string, height: number) => Promise<EntityState | null>;
  listEntityIdsAtHeight?: (env: Env, height: number) => Promise<string[]>;
  enqueueRuntimeInput: (env: Env, input: RuntimeInput) => void;
};

const clients = new Map<AdapterSocket, AdapterClientState>();
let attachedEnv: Env | null = null;
let detachEnvChange: (() => void) | null = null;

const getClientState = (ws: AdapterSocket): AdapterClientState => {
  let state = clients.get(ws);
  if (!state) {
    state = {
      authLevel: null,
      authExpiresAtMs: null,
      controlBucket: createTokenBucket(100, 50),
      readBucket: createTokenBucket(100, 50),
      sendBucket: createTokenBucket(10, 5),
    };
    clients.set(ws, state);
  }
  return state;
};

const sendResponse = (ws: AdapterSocket, response: RuntimeAdapterResponse): void => {
  const buffered = (ws as AdapterSocket & { getBufferedAmount?: () => number }).getBufferedAmount?.() ?? 0;
  if (buffered > 2 * 1024 * 1024) {
    throw new RuntimeAdapterError('E_RATE_LIMITED', 'runtime adapter socket backpressure', true);
  }
  ws.send(encodeRuntimeAdapterMessage(response));
};

const sendOk = (ws: AdapterSocket, inReplyTo: string, payload: unknown): void => {
  sendResponse(ws, { v: 1, inReplyTo, ok: true, payload });
};

const sendErr = (ws: AdapterSocket, inReplyTo: string, error: unknown): void => {
  sendResponse(ws, { v: 1, inReplyTo, ok: false, error: toRuntimeAdapterErrorPayload(error) });
};

const isRuntimeAdapterRequest = (msg: Record<string, unknown>): msg is RuntimeAdapterRequest => {
  return msg['v'] === 1 && typeof msg['id'] === 'string' && typeof msg['op'] === 'string';
};

const requireAuth = (
  state: AdapterClientState,
  level: RuntimeAdapterAuthLevel,
): void => {
  if (state.authExpiresAtMs !== null && state.authExpiresAtMs <= Date.now()) {
    state.authLevel = null;
    state.authExpiresAtMs = null;
  }
  if (state.authLevel === 'admin') return;
  if (level === 'inspect' && state.authLevel === 'inspect') return;
  throw new RuntimeAdapterError('E_UNAUTHORIZED', `${level} auth required`);
};

const requireBucket = (bucket: TokenBucket, label: string): void => {
  if (consumeToken(bucket)) return;
  throw new RuntimeAdapterError(
    'E_RATE_LIMITED',
    `runtime adapter ${label} rate limit exceeded`,
    true,
    tokenRetryAfterMs(bucket),
  );
};

export const forgetRuntimeAdapterClient = (ws: AdapterSocket): void => {
  clients.delete(ws);
};

export const runtimeAdapterClientCount = (): number => clients.size;

export const broadcastRuntimeAdapterTick = (env: Env): void => {
  if (clients.size === 0) return;
  const height = Math.max(0, Math.floor(Number(env.height ?? 0)));
  const message = encodeRuntimeAdapterMessage({ v: 1, op: 'tick', height });
  for (const [ws, state] of clients.entries()) {
    if (!state.authLevel) continue;
    try {
      ws.send(message);
    } catch {
      clients.delete(ws);
    }
  }
};

export const attachRuntimeAdapterTicker = (
  env: Env,
  registerEnvChangeCallback: (env: Env, cb: (env: Env) => void) => (() => void),
): void => {
  if (attachedEnv === env) return;
  detachEnvChange?.();
  attachedEnv = env;
  detachEnvChange = registerEnvChangeCallback(env, broadcastRuntimeAdapterTick);
};

export const handleRuntimeAdapterMessage = async (
  ws: AdapterSocket,
  msg: Record<string, unknown>,
  env: Env | null,
  deps: RuntimeAdapterServerDeps,
): Promise<boolean> => {
  if (!isRuntimeAdapterRequest(msg)) return false;
  const state = getClientState(ws);
  if (!consumeToken(state.controlBucket)) {
    sendErr(ws, msg.id, new RuntimeAdapterError(
      'E_RATE_LIMITED',
      'runtime adapter rate limit exceeded',
      true,
      tokenRetryAfterMs(state.controlBucket),
    ));
    return true;
  }
  if (!env) {
    sendErr(ws, msg.id, new RuntimeAdapterError('E_INTERNAL', 'runtime not ready', true));
    return true;
  }

  try {
    if (msg.op === 'auth') {
      const authSeed = resolveRuntimeAdapterAuthSeed(env);
      const auth = verifyRuntimeAdapterAuthCredential(authSeed, msg.key);
      if (!auth) throw new RuntimeAdapterError('E_UNAUTHORIZED', 'invalid runtime adapter auth key');
      state.authLevel = auth.level;
      state.authExpiresAtMs = auth.expiresAtMs;
      sendOk(ws, msg.id, {
        authLevel: auth.level,
        expiresAtMs: auth.expiresAtMs,
        legacy: auth.legacy,
        currentHeight: Math.max(0, Math.floor(Number(env.height ?? 0))),
      });
      return true;
    }

    if (msg.op === 'read') {
      requireAuth(state, 'inspect');
      requireBucket(state.readBucket, 'read');
      const payload = await resolveRuntimeAdapterRead({
        env,
        ...(deps.readHead ? { readHead: () => deps.readHead?.(env) ?? Promise.resolve(null) } : {}),
        ...(deps.readFrame ? { readFrame: (height) => deps.readFrame?.(env, height) ?? Promise.resolve(null) } : {}),
        ...(deps.listCheckpoints ? { listCheckpoints: () => deps.listCheckpoints?.(env) ?? Promise.resolve([]) } : {}),
        ...(deps.loadEntityState ? { loadEntityState: (entityId, height) => deps.loadEntityState?.(env, entityId, height) ?? Promise.resolve(null) } : {}),
        ...(deps.listEntityIdsAtHeight ? { listEntityIdsAtHeight: (height) => deps.listEntityIdsAtHeight?.(env, height) ?? Promise.resolve([]) } : {}),
      }, msg.path, msg.query);
      sendOk(ws, msg.id, payload);
      return true;
    }

    if (msg.op === 'send') {
      requireAuth(state, 'admin');
      requireBucket(state.sendBucket, 'send');
      deps.enqueueRuntimeInput(env, msg.input);
      sendOk(ws, msg.id, { height: Math.max(0, Math.floor(Number(env.height ?? 0))) });
      return true;
    }

    sendErr(ws, msg.id, new RuntimeAdapterError('E_BAD_PATH', `unsupported runtime adapter op: ${(msg as { op?: unknown }).op}`));
    return true;
  } catch (error) {
    sendErr(ws, msg.id, error);
    return true;
  }
};
