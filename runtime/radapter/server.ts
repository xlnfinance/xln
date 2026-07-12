import type { RuntimeActivityFilters } from '../api/activity-history';
import type { EntityState, Env, RuntimeInput } from '../types';
import { assertRuntimeAdapterMessageSize, encodeRuntimeAdapterMessage, runtimeAdapterMaxMessageBytes } from './codec';
import type { StorageFrameRecord, StorageHead } from '../storage/types';
import type { StorageAccountDoc, StorageEntityViewPage } from '../storage';
import type { RegisterReceiptOptions, RuntimeIngressReceipt } from '../server/ingress-receipts';
import { RuntimeAdapterError, toRuntimeAdapterErrorPayload } from './errors';
import { consumeToken, createTokenBucket, tokenRetryAfterMs, type TokenBucket } from './rate-limit';
import { resolveRuntimeAdapterRead } from './resolve';
import { createStructuredLogger } from '../infra/logger';
import { safeStringify } from '../protocol/serialization';
import { keccak256, toUtf8Bytes } from 'ethers';
import type {
  RuntimeAdapterAuthLevel,
  RuntimeAdapterActivityPage,
  RuntimeAdapterReadQuery,
  RuntimeAdapterRequest,
  RuntimeAdapterResponse,
} from './types';
import {
  resolveRuntimeAdapterAuthAudience,
  resolveRuntimeAdapterAuthSeed,
  runtimeAdapterRevokedTokenIds,
  verifyRuntimeAdapterAuthCredential,
} from './auth';

export type RuntimeAdapterSocket = {
  send: (message: string | Uint8Array) => unknown;
  close?: (code?: number, reason?: string) => unknown;
};

type AdapterClientState = {
  authLevel: RuntimeAdapterAuthLevel | null;
  authExpiresAtMs: number | null;
  controlBucket: TokenBucket;
  readBucket: TokenBucket;
  sendBucket: TokenBucket;
};

type RuntimeAdapterResponseDiagnostic = {
  env?: Env | null;
  op?: string;
  path?: string;
  query?: RuntimeAdapterReadQuery;
  authLevel?: RuntimeAdapterAuthLevel | null;
};

export type RuntimeAdapterServerDeps = {
  readHead?: (env: Env) => Promise<StorageHead | null>;
  readFrame?: (env: Env, height: number) => Promise<StorageFrameRecord | null>;
  listCheckpoints?: (env: Env) => Promise<number[]>;
  loadEntityState?: (env: Env, entityId: string, height: number) => Promise<EntityState | null>;
  loadEntityAccountDoc?: (env: Env, entityId: string, counterpartyId: string, height: number) => Promise<StorageAccountDoc | null>;
  loadEntityViewPage?: (env: Env, entityId: string, height: number, query?: RuntimeAdapterReadQuery) => Promise<StorageEntityViewPage | null>;
  listEntityIdsAtHeight?: (env: Env, height: number) => Promise<string[]>;
	  readActivityPage?: (
    env: Env,
    opts: RuntimeActivityFilters & {
      beforeHeight?: number | undefined;
      limit?: number | undefined;
      scanLimit?: number | undefined;
    },
	  ) => Promise<RuntimeAdapterActivityPage>;
	  enqueueRuntimeInput: (env: Env, input: RuntimeInput) => void;
	  validateRuntimeInputAdmission?: (env: Env, input: RuntimeInput) => void;
	  registerReceipt?: (input: RegisterReceiptOptions) => RuntimeIngressReceipt;
	  readReceipt?: (id: string) => RuntimeIngressReceipt | null;
	  buildRuntimeInputStatusUrl?: (id: string) => string;
	};

const clients = new Map<RuntimeAdapterSocket, AdapterClientState>();
let attachedEnv: Env | null = null;
let detachEnvChange: (() => void) | null = null;
const RUNTIME_ADAPTER_BACKPRESSURE_DEFAULT_BYTES = 2 * 1024 * 1024;
const runtimeAdapterLog = createStructuredLogger('runtime.radapter');
const RUNTIME_ADAPTER_COMMAND_RESULT_LIMIT = 1_024;

const normalizeCommandId = (value: unknown): string => {
  const commandId = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(commandId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'runtime adapter commandId must be 16-128 safe characters');
  }
  return commandId;
};

const runtimeInputHash = (input: RuntimeInput): string => keccak256(toUtf8Bytes(safeStringify(input)));

const rememberCommandResult = (
  env: Env,
  commandId: string,
  inputHash: string,
  result: { height: number; receipt?: RuntimeIngressReceipt; statusUrl?: string },
): void => {
  env.runtimeState ??= {};
  const results = env.runtimeState.runtimeAdapterCommandResults ?? new Map();
  results.set(commandId, { inputHash, result: structuredClone(result), recordedAt: env.timestamp });
  while (results.size > RUNTIME_ADAPTER_COMMAND_RESULT_LIMIT) {
    const oldest = results.keys().next().value;
    if (typeof oldest !== 'string') break;
    results.delete(oldest);
  }
  env.runtimeState.runtimeAdapterCommandResults = results;
};

const readPositiveNumberEnv = (name: string, fallback: number): number => {
  const raw = typeof process !== 'undefined' ? process.env[name] : undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const createConfiguredBucket = (
  label: 'CONTROL' | 'READ' | 'SEND',
  defaultCapacity: number,
  defaultRefillPerSecond: number,
): TokenBucket => createTokenBucket(
  readPositiveNumberEnv(`XLN_RADAPTER_${label}_BURST`, defaultCapacity),
  readPositiveNumberEnv(`XLN_RADAPTER_${label}_PER_SEC`, defaultRefillPerSecond),
);

const runtimeAdapterBackpressureBytes = (): number =>
  readPositiveNumberEnv('XLN_RADAPTER_BACKPRESSURE_BYTES', RUNTIME_ADAPTER_BACKPRESSURE_DEFAULT_BYTES);

const compactReadQueryForLog = (query: RuntimeAdapterReadQuery | undefined): Record<string, unknown> | undefined => {
  if (!query) return undefined;
  const keys: Array<keyof RuntimeAdapterReadQuery> = [
    'atHeight',
    'entityId',
    'limit',
    'accountsLimit',
    'booksLimit',
    'accountsPage',
    'booksPage',
    'accountId',
    'cursor',
    'accountsCursor',
    'booksCursor',
    'beforeHeight',
    'scanLimit',
    'fromTimestamp',
    'toTimestamp',
  ];
  const compact: Record<string, unknown> = {};
  for (const key of keys) {
    const value = query[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') compact[key] = value;
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
};

const encodedByteLengthForLog = (value: unknown): number | null => {
  try {
    return encodeRuntimeAdapterMessage(value).byteLength;
  } catch {
    return null;
  }
};

const countRuntimeInput = (input: RuntimeInput): RegisterReceiptOptions['counts'] => ({
  runtimeTxs: Array.isArray(input.runtimeTxs) ? input.runtimeTxs.length : 0,
  entityInputs: Array.isArray(input.entityInputs) ? input.entityInputs.length : 0,
  jInputs: Array.isArray(input.jInputs) ? input.jInputs.length : 0,
});

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const byteBreakdownForLog = (value: unknown, limit = 20): Record<string, number | null> | undefined => {
  const record = recordOf(value);
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record)
    .slice(0, limit)
    .map(([key, entry]) => [key, encodedByteLengthForLog(entry)]));
};

const emitRuntimeAdapterResponseTooLarge = (
  diagnostic: RuntimeAdapterResponseDiagnostic | undefined,
  response: RuntimeAdapterResponse,
  bytes: number,
  maxBytes: number,
): void => {
  const env = diagnostic?.env ?? null;
  const payload = response.ok && response.payload && typeof response.payload === 'object'
    ? response.payload as Record<string, unknown>
    : null;
  const activeEntity = recordOf(payload?.['activeEntity']);
  const activeCore = recordOf(activeEntity?.['core']);
  const event = {
    code: 'RADAPTER_RESPONSE_TOO_LARGE',
    bytes,
    maxBytes,
    inReplyTo: response.inReplyTo,
    ok: response.ok,
    op: diagnostic?.op ?? null,
    path: diagnostic?.path ?? null,
    query: compactReadQueryForLog(diagnostic?.query),
    authLevel: diagnostic?.authLevel ?? null,
    runtimeId: String(env?.runtimeId || '') || null,
    height: Math.max(0, Math.floor(Number(env?.height ?? 0))),
    payloadKeys: payload ? Object.keys(payload).slice(0, 20) : [],
    payloadBytes: byteBreakdownForLog(payload),
    activeEntityBytes: byteBreakdownForLog(activeEntity),
    activeCoreBytes: byteBreakdownForLog(activeCore),
  };
  if (typeof env?.emit === 'function') {
    try {
      env.emit('RuntimeAdapterResponseTooLarge', event);
    } catch (error) {
      runtimeAdapterLog.warn('response_too_large.emit_failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  runtimeAdapterLog.warn('response_too_large', event);
};

const getClientState = (ws: RuntimeAdapterSocket): AdapterClientState => {
  let state = clients.get(ws);
  if (!state) {
    state = {
      authLevel: null,
      authExpiresAtMs: null,
      controlBucket: createConfiguredBucket('CONTROL', 100, 50),
      readBucket: createConfiguredBucket('READ', 100, 50),
      sendBucket: createConfiguredBucket('SEND', 10, 5),
    };
    clients.set(ws, state);
  }
  return state;
};

const sendResponse = (
  ws: RuntimeAdapterSocket,
  response: RuntimeAdapterResponse,
  diagnostic?: RuntimeAdapterResponseDiagnostic,
): void => {
  const buffered = (ws as RuntimeAdapterSocket & { getBufferedAmount?: () => number }).getBufferedAmount?.() ?? 0;
  if (buffered > runtimeAdapterBackpressureBytes()) {
    ws.close?.(1013, 'runtime adapter socket backpressure');
    return;
  }
  const encoded = encodeRuntimeAdapterMessage(response);
  const maxBytes = runtimeAdapterMaxMessageBytes();
  if (encoded.byteLength > maxBytes) {
    emitRuntimeAdapterResponseTooLarge(diagnostic, response, encoded.byteLength, maxBytes);
  }
  try {
    assertRuntimeAdapterMessageSize(encoded);
  } catch (error) {
    if (!response.ok) {
      ws.close?.(1009, 'runtime adapter error response too large');
      return;
    }
    const capped = encodeRuntimeAdapterMessage({
      v: 1,
      inReplyTo: response.inReplyTo,
      ok: false,
      error: toRuntimeAdapterErrorPayload(new RuntimeAdapterError('E_INTERNAL', 'runtime adapter response too large', true)),
    } satisfies RuntimeAdapterResponse);
    try {
      assertRuntimeAdapterMessageSize(capped);
      ws.send(capped);
    } catch {
      // The configured cap is too small even for the structured error. The
      // close code is the only reliable signal left.
    }
    ws.close?.(1009, 'runtime adapter response too large');
    return;
  }
  ws.send(encoded);
};

const sendOk = (
  ws: RuntimeAdapterSocket,
  inReplyTo: string,
  payload: unknown,
  diagnostic?: RuntimeAdapterResponseDiagnostic,
): void => {
  sendResponse(ws, { v: 1, inReplyTo, ok: true, payload }, diagnostic);
};

const sendErr = (
  ws: RuntimeAdapterSocket,
  inReplyTo: string,
  error: unknown,
  diagnostic?: RuntimeAdapterResponseDiagnostic,
): void => {
  sendResponse(ws, { v: 1, inReplyTo, ok: false, error: toRuntimeAdapterErrorPayload(error) }, diagnostic);
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

export const forgetRuntimeAdapterClient = (ws: RuntimeAdapterSocket): void => {
  clients.delete(ws);
};

export const runtimeAdapterClientCount = (): number => clients.size;

export const closeInvalidRuntimeAdapterMessage = (ws: RuntimeAdapterSocket, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error || '');
  ws.close?.(message.includes('RADAPTER_MESSAGE_TOO_LARGE') ? 1009 : 1003, 'Invalid runtime adapter message');
};

export const broadcastRuntimeAdapterTick = (env: Env): void => {
  if (clients.size === 0) return;
  const height = Math.max(0, Math.floor(Number(env.height ?? 0)));
  const message = encodeRuntimeAdapterMessage({ v: 1, op: 'tick', height });
  const now = Date.now();
  for (const [ws, state] of clients.entries()) {
    if (state.authExpiresAtMs !== null && state.authExpiresAtMs <= now) {
      state.authLevel = null;
      state.authExpiresAtMs = null;
    }
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
  ws: RuntimeAdapterSocket,
  msg: Record<string, unknown>,
  env: Env | null,
  deps: RuntimeAdapterServerDeps,
): Promise<boolean> => {
  if (!isRuntimeAdapterRequest(msg)) return false;
  const state = getClientState(ws);
  const diagnostic = (): RuntimeAdapterResponseDiagnostic => {
    const raw = msg as Record<string, unknown>;
    const info: RuntimeAdapterResponseDiagnostic = {
      env,
      op: String(msg.op || ''),
      authLevel: state.authLevel,
    };
    if (typeof raw['path'] === 'string') info.path = raw['path'];
    if (raw['query'] && typeof raw['query'] === 'object') info.query = raw['query'] as RuntimeAdapterReadQuery;
    return info;
  };
  if (!consumeToken(state.controlBucket)) {
    sendErr(ws, msg.id, new RuntimeAdapterError(
      'E_RATE_LIMITED',
      'runtime adapter rate limit exceeded',
      true,
      tokenRetryAfterMs(state.controlBucket),
    ), diagnostic());
    return true;
  }
  if (!env) {
    sendErr(ws, msg.id, new RuntimeAdapterError('E_INTERNAL', 'runtime not ready', true), diagnostic());
    return true;
  }

  try {
    if (msg.op === 'auth') {
      const authSeed = resolveRuntimeAdapterAuthSeed(env);
      const auth = verifyRuntimeAdapterAuthCredential(authSeed, msg.key, {
        audience: resolveRuntimeAdapterAuthAudience(env),
        revokedTokenIds: runtimeAdapterRevokedTokenIds(),
      });
      if (!auth) throw new RuntimeAdapterError('E_UNAUTHORIZED', 'invalid runtime adapter auth key');
      state.authLevel = auth.level;
      state.authExpiresAtMs = auth.expiresAtMs;
      sendOk(ws, msg.id, {
        authLevel: auth.level,
        expiresAtMs: auth.expiresAtMs,
        currentHeight: Math.max(0, Math.floor(Number(env.height ?? 0))),
        runtimeId: String(env.runtimeId || '').trim().toLowerCase(),
      }, diagnostic());
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
        ...(deps.loadEntityAccountDoc ? { loadEntityAccountDoc: (entityId, counterpartyId, height) => deps.loadEntityAccountDoc?.(env, entityId, counterpartyId, height) ?? Promise.resolve(null) } : {}),
        ...(deps.loadEntityViewPage ? { loadEntityViewPage: (entityId, height, query) => deps.loadEntityViewPage?.(env, entityId, height, query) ?? Promise.resolve(null) } : {}),
        ...(deps.listEntityIdsAtHeight ? { listEntityIdsAtHeight: (height) => deps.listEntityIdsAtHeight?.(env, height) ?? Promise.resolve([]) } : {}),
        ...(deps.readActivityPage ? { readActivityPage: (opts) => deps.readActivityPage?.(env, opts) ?? Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'activity reader did not return')) } : {}),
        ...(deps.readReceipt ? { readReceipt: (id) => deps.readReceipt?.(id) ?? null } : {}),
      }, msg.path, msg.query);
      sendOk(ws, msg.id, payload, diagnostic());
      return true;
    }

	    if (msg.op === 'send') {
	      requireAuth(state, 'admin');
	      requireBucket(state.sendBucket, 'send');
	      const commandId = normalizeCommandId(msg.commandId);
	      const inputHash = runtimeInputHash(msg.input);
	      const prior = env.runtimeState?.runtimeAdapterCommandResults?.get(commandId);
	      if (prior) {
	        if (prior.inputHash !== inputHash) {
	          throw new RuntimeAdapterError('E_BAD_QUERY', 'runtime adapter commandId was reused with a different payload');
	        }
	        sendOk(ws, msg.id, structuredClone(prior.result), diagnostic());
	        return true;
	      }
	      deps.validateRuntimeInputAdmission?.(env, msg.input);
	      const acceptedHeight = Math.max(0, Math.floor(Number(env.height ?? 0)));
	      deps.enqueueRuntimeInput(env, msg.input);
	      const receipt = deps.registerReceipt?.({
	        kind: 'radapter-runtime-input',
	        counts: countRuntimeInput(msg.input),
	        enqueuedHeight: acceptedHeight,
	        runtimeInput: msg.input,
	        note: 'Runtime adapter command accepted into the runtime queue; poll account/entity projections for semantic commit details.',
	      });
	      const result = {
	        height: acceptedHeight,
	        ...(receipt ? { receipt } : {}),
	        ...(receipt && deps.buildRuntimeInputStatusUrl ? { statusUrl: deps.buildRuntimeInputStatusUrl(receipt.id) } : {}),
	      };
	      rememberCommandResult(env, commandId, inputHash, result);
	      sendOk(ws, msg.id, result, diagnostic());
	      return true;
	    }

    sendErr(ws, msg.id, new RuntimeAdapterError('E_BAD_PATH', `unsupported runtime adapter op: ${(msg as { op?: unknown }).op}`), diagnostic());
    return true;
  } catch (error) {
    sendErr(ws, msg.id, error, diagnostic());
    return true;
  }
};
