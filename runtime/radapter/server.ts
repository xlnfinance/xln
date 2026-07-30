import type { RuntimeActivityFilters } from '../storage/views/activity-types';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { EntityState } from '../entity/types';
import type { RuntimeReplica, RuntimeInput } from '../runtime/types';
import {
  assertRuntimeAdapterMessageSize,
  encodeRuntimeAdapterMessageForBrowser,
  runtimeAdapterMessageByteLength,
  runtimeAdapterMaxMessageBytes,
} from './codec';
import type { StorageFrameRecord, StorageHead } from '../storage/types';
import type { StorageAccountDoc, StorageEntityViewPage } from '../storage';
import {
  fingerprintRuntimeIngressInput,
  projectRuntimeIngressReceiptForWire,
  type RegisterReceiptOptions,
  type RuntimeIngressReceipt,
} from '../runtime/ingress-receipts';
import { RuntimeAdapterError, toRuntimeAdapterErrorPayload } from './errors';
import { consumeToken, createTokenBucket, tokenRetryAfterMs, type TokenBucket } from './rate-limit';
import { resolveRuntimeAdapterRead } from './resolve';
import { createStructuredLogger } from '../infra/logger';
import { assertRuntimeCommandReady, getRuntimeCommandReadiness } from '../runtime/lifecycle';
import { safeStringify } from '../protocol/serialization';
import { keccak256, toUtf8Bytes } from 'ethers';
import type {
  RuntimeAdapterAuthLevel,
  RuntimeAdapterActivityPage,
  RuntimeAdapterControlAction,
  RuntimeAdapterFrameReceiptResponse,
  RuntimeAdapterPaymentRoutesResponse,
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
import {
  normalizeRuntimeAdapterIdentityChallenge,
} from './server-identity';
import { signRuntimeAdapterServerIdentity } from './server-identity-signer';
import {
  countActiveRuntimeAdapterCommandLanes,
  MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES,
  normalizeRuntimeAdapterCommandSequence,
  readRuntimeAdapterCommandFrontier,
  runtimeAdapterCommandLaneId,
  runtimeAdapterOwnerCommandLaneId,
} from './command-frontier';
import { markLocalRuntimeAdapterCommandTx } from './command-frontier-auth';
import { verifyRuntimeAdapterOwnerBinding } from './owner-binding';
import { encodeBinaryPayload } from '../storage/binary-codec';
import { XLN_PROTOCOL_VERSION } from '../protocol/version';

export type RuntimeAdapterSocket = {
  send: (message: string | Uint8Array) => unknown;
  close?: (code?: number, reason?: string) => unknown;
};

type AdapterClientState = {
  authLevel: RuntimeAdapterAuthLevel | null;
  authExpiresAtMs: number | null;
  commandLaneId: string | null;
  commandLaneKind: 'owner' | 'capability' | null;
  commandFrontierExpiresAtMs: number | null;
  controlBucket: TokenBucket;
  readBucket: TokenBucket;
  sendBucket: TokenBucket;
};

type RuntimeAdapterResponseDiagnostic = {
  env?: RuntimeReplica | null;
  op?: string;
  path?: string;
  query?: RuntimeAdapterReadQuery;
  authLevel?: RuntimeAdapterAuthLevel | null;
};

export type RuntimeAdapterServerDeps = {
  readHead?: (env: RuntimeReplica) => Promise<StorageHead | null>;
  readFrame?: (env: RuntimeReplica, height: number) => Promise<StorageFrameRecord | null>;
  listCheckpoints?: (env: RuntimeReplica) => Promise<number[]>;
  loadEntityState?: (env: RuntimeReplica, entityId: string, height: number) => Promise<EntityState | null>;
  loadEntityAccountDoc?: (env: RuntimeReplica, entityId: string, counterpartyId: string, height: number) => Promise<StorageAccountDoc | null>;
  loadEntityViewPage?: (env: RuntimeReplica, entityId: string, height: number, query?: RuntimeAdapterReadQuery) => Promise<StorageEntityViewPage | null>;
  listEntityIdsAtHeight?: (env: RuntimeReplica, height: number) => Promise<string[]>;
	  readActivityPage?: (
    env: RuntimeReplica,
    opts: RuntimeActivityFilters & {
      beforeHeight?: number | undefined;
      limit?: number | undefined;
      scanLimit?: number | undefined;
    },
	  ) => Promise<RuntimeAdapterActivityPage>;
	  enqueueRuntimeInput: (env: RuntimeReplica, input: RuntimeInput) => void;
	  submitCrossJurisdictionIntent?: (env: RuntimeReplica, route: CrossJurisdictionSwapRoute) => Promise<unknown>;
	  controlRuntime?: (env: RuntimeReplica, action: RuntimeAdapterControlAction) => Promise<unknown>;
	  validateRuntimeInputAdmission?: (env: RuntimeReplica, input: RuntimeInput) => void;
	  registerReceipt?: (input: RegisterReceiptOptions) => RuntimeIngressReceipt;
	  readReceipt?: (id: string) => RuntimeIngressReceipt | null;
	  readFrameReceipts?: (env: RuntimeReplica, query?: RuntimeAdapterReadQuery) => Promise<RuntimeAdapterFrameReceiptResponse>;
	  findPaymentRoutes?: (env: RuntimeReplica, query?: RuntimeAdapterReadQuery) => Promise<RuntimeAdapterPaymentRoutesResponse>;
	  buildRuntimeInputStatusUrl?: (id: string) => string;
	  isMutatingIngressReady?: () => boolean;
	};

const clients = new Map<RuntimeAdapterSocket, AdapterClientState>();
let attachedEnv: RuntimeReplica | null = null;
let detachEnvChange: (() => void) | null = null;
const RUNTIME_ADAPTER_BACKPRESSURE_DEFAULT_BYTES = 2 * 1024 * 1024;
const RUNTIME_ADAPTER_PENDING_READ_LOG_MS = 1_000;
const runtimeAdapterLog = createStructuredLogger('runtime.radapter');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const requireRuntimeCommandReady = (env: RuntimeReplica): void => {
  try {
    assertRuntimeCommandReady(env);
  } catch (error) {
    throw new RuntimeAdapterError('E_COMMAND_PENDING', errorMessage(error), true, 250);
  }
};

type PendingRuntimeAdapterCommand = {
  sequence: number;
  commandId: string;
  inputHash: string;
  expiresAtMs: number | null;
  result: {
    height: number;
    status: 'pending';
    commandSequence: number;
    receipt?: RuntimeIngressReceipt;
    statusUrl?: string;
  };
};

const pendingRuntimeAdapterCommands = new Map<RuntimeReplica, Map<string, PendingRuntimeAdapterCommand>>();

const pendingCommandsFor = (env: RuntimeReplica): Map<string, PendingRuntimeAdapterCommand> => {
  const existing = pendingRuntimeAdapterCommands.get(env);
  if (existing) return existing;
  const created = new Map<string, PendingRuntimeAdapterCommand>();
  pendingRuntimeAdapterCommands.set(env, created);
  return created;
};

const normalizeCommandId = (value: unknown): string => {
  const commandId = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(commandId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'runtime adapter commandId must be 16-128 safe characters');
  }
  return commandId;
};

const runtimeInputHash = (input: RuntimeInput): string => keccak256(toUtf8Bytes(safeStringify(input)));

const commandSequenceOrThrow = (value: unknown): number => {
  try {
    return normalizeRuntimeAdapterCommandSequence(value);
  } catch {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'runtime adapter commandSequence must be a positive safe integer');
  }
};

const reconcilePendingCommand = (env: RuntimeReplica, laneId: string): PendingRuntimeAdapterCommand | undefined => {
  const commands = pendingRuntimeAdapterCommands.get(env);
  if (!commands) return undefined;
  const pending = commands.get(laneId);
  if (!pending) return undefined;
  const committed = readRuntimeAdapterCommandFrontier(env, laneId);
  if (
    (pending.expiresAtMs !== null && pending.expiresAtMs <= Date.now())
    || (committed && committed.lastContiguousSequence >= pending.sequence)
  ) {
    commands.delete(laneId);
    return undefined;
  }
  return pending;
};

const prunePendingCommands = (env: RuntimeReplica): void => {
  const commands = pendingRuntimeAdapterCommands.get(env);
  if (!commands) return;
  for (const laneId of commands.keys()) reconcilePendingCommand(env, laneId);
  if (commands.size === 0) pendingRuntimeAdapterCommands.delete(env);
};

const countUncommittedPendingLanes = (env: RuntimeReplica): number => {
  let count = 0;
  for (const laneId of pendingRuntimeAdapterCommands.get(env)?.keys() ?? []) {
    if (!readRuntimeAdapterCommandFrontier(env, laneId)) count += 1;
  }
  return count;
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
    return encodeBinaryPayload(value, 'msgpack').byteLength;
  } catch (error) {
    runtimeAdapterLog.debug('response_size_field_encode_failed', { reason: errorMessage(error) });
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
      commandLaneId: null,
      commandLaneKind: null,
      commandFrontierExpiresAtMs: null,
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
  const encoded = encodeRuntimeAdapterMessageForBrowser(response);
  const encodedBytes = runtimeAdapterMessageByteLength(encoded);
  const maxBytes = runtimeAdapterMaxMessageBytes();
  if (encodedBytes > maxBytes) {
    emitRuntimeAdapterResponseTooLarge(diagnostic, response, encodedBytes, maxBytes);
  }
  try {
    assertRuntimeAdapterMessageSize(encoded);
  } catch (error) {
    if (!response.ok) {
      ws.close?.(1009, 'runtime adapter error response too large');
      return;
    }
    const capped = encodeRuntimeAdapterMessageForBrowser({
      v: XLN_PROTOCOL_VERSION,
      inReplyTo: response.inReplyTo,
      ok: false,
      error: toRuntimeAdapterErrorPayload(new RuntimeAdapterError('E_INTERNAL', 'runtime adapter response too large', true)),
    } satisfies RuntimeAdapterResponse);
    try {
      assertRuntimeAdapterMessageSize(capped);
      ws.send(capped);
    } catch (error) {
      runtimeAdapterLog.warn('response_too_large.error_send_failed', {
        inReplyTo: response.inReplyTo,
        reason: errorMessage(error),
      });
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
  sendResponse(ws, { v: XLN_PROTOCOL_VERSION, inReplyTo, ok: true, payload }, diagnostic);
};

const sendErr = (
  ws: RuntimeAdapterSocket,
  inReplyTo: string,
  error: unknown,
  diagnostic?: RuntimeAdapterResponseDiagnostic,
): void => {
  sendResponse(ws, { v: XLN_PROTOCOL_VERSION, inReplyTo, ok: false, error: toRuntimeAdapterErrorPayload(error) }, diagnostic);
};

const requireAuth = (
  state: AdapterClientState,
  level: RuntimeAdapterAuthLevel,
): void => {
  if (state.authExpiresAtMs !== null && state.authExpiresAtMs <= Date.now()) {
    state.authLevel = null;
    state.authExpiresAtMs = null;
    state.commandLaneId = null;
    state.commandLaneKind = null;
    state.commandFrontierExpiresAtMs = null;
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

export const closeInvalidRuntimeAdapterMessage = (ws: RuntimeAdapterSocket, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error || '');
  ws.close?.(message.includes('RADAPTER_MESSAGE_TOO_LARGE') ? 1009 : 1003, 'Invalid runtime adapter message');
};

export const broadcastRuntimeAdapterTick = (env: RuntimeReplica): void => {
  prunePendingCommands(env);
  if (clients.size === 0) return;
  const height = Math.max(0, Math.floor(Number(env.height ?? 0)));
  const readiness = getRuntimeCommandReadiness(env);
  const message = encodeRuntimeAdapterMessageForBrowser({
    v: XLN_PROTOCOL_VERSION,
    op: 'tick',
    height,
    commandReady: readiness.ready,
    commandReadyReason: readiness.reason,
  });
  const now = Date.now();
  for (const [ws, state] of clients.entries()) {
    if (state.authExpiresAtMs !== null && state.authExpiresAtMs <= now) {
      state.authLevel = null;
      state.authExpiresAtMs = null;
      state.commandLaneId = null;
      state.commandLaneKind = null;
      state.commandFrontierExpiresAtMs = null;
    }
    if (!state.authLevel) continue;
    try {
      ws.send(message);
    } catch (error) {
      runtimeAdapterLog.debug('tick_send_failed', { reason: errorMessage(error) });
      clients.delete(ws);
    }
  }
};

export const attachRuntimeAdapterTicker = (
  env: RuntimeReplica,
  registerEnvChangeCallback: (env: RuntimeReplica, cb: (env: RuntimeReplica) => void) => (() => void),
): void => {
  if (attachedEnv === env) return;
  detachEnvChange?.();
  if (attachedEnv) pendingRuntimeAdapterCommands.delete(attachedEnv);
  attachedEnv = env;
  detachEnvChange = registerEnvChangeCallback(env, broadcastRuntimeAdapterTick);
};

type RuntimeAdapterRequestByOp<Op extends RuntimeAdapterRequest['op']> =
  Extract<RuntimeAdapterRequest, { op: Op }>;

type RuntimeAdapterDiagnostic = () => RuntimeAdapterResponseDiagnostic;

const handleRuntimeAdapterAuth = (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'auth'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  diagnostic: RuntimeAdapterDiagnostic,
): void => {
  state.authLevel = null;
  state.authExpiresAtMs = null;
  state.commandLaneId = null;
  state.commandLaneKind = null;
  state.commandFrontierExpiresAtMs = null;
  const auth = verifyRuntimeAdapterAuthCredential(
    resolveRuntimeAdapterAuthSeed(env),
    msg.key,
    {
      audience: resolveRuntimeAdapterAuthAudience(env),
      revokedTokenIds: runtimeAdapterRevokedTokenIds(),
    },
  );
  if (!auth) {
    throw new RuntimeAdapterError(
      'E_UNAUTHORIZED',
      'invalid runtime adapter auth key',
    );
  }
  let challenge: string;
  try {
    challenge = normalizeRuntimeAdapterIdentityChallenge(msg.challenge);
  } catch {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      'runtime adapter auth challenge must be 32-byte hex',
    );
  }
  const identity = signRuntimeAdapterServerIdentity(env, challenge);
  const ownerSignature =
    typeof msg.ownerSignature === 'string' ? msg.ownerSignature.trim() : '';
  if (
    ownerSignature &&
    !verifyRuntimeAdapterOwnerBinding(
      identity.runtimeId,
      challenge,
      String(msg.key || ''),
      ownerSignature,
    )
  ) {
    throw new RuntimeAdapterError(
      'E_UNAUTHORIZED',
      'runtime adapter vault-owner binding is invalid',
    );
  }
  const commandLaneKind = ownerSignature ? 'owner' : 'capability';
  state.authLevel = auth.level;
  state.authExpiresAtMs = auth.expiresAtMs;
  state.commandLaneKind = commandLaneKind;
  state.commandLaneId =
    commandLaneKind === 'owner'
      ? runtimeAdapterOwnerCommandLaneId(identity.runtimeId)
      : runtimeAdapterCommandLaneId(auth.keyId, auth.tokenId);
  state.commandFrontierExpiresAtMs =
    commandLaneKind === 'owner' ? null : auth.expiresAtMs;
  prunePendingCommands(env);
  const commandFrontier = readRuntimeAdapterCommandFrontier(
    env,
    state.commandLaneId,
  );
  const readiness = getRuntimeCommandReadiness(env);
  sendOk(
    ws,
    msg.id,
    {
      authLevel: auth.level,
      commandLaneKind,
      expiresAtMs: auth.expiresAtMs,
      currentHeight: Math.max(0, Math.floor(Number(env.height ?? 0))),
      commandReady: readiness.ready,
      commandReadyReason: readiness.reason,
      nextCommandSequence:
        (commandFrontier?.lastContiguousSequence ?? 0) + 1,
      ...identity,
    },
    diagnostic(),
  );
};

const buildRuntimeAdapterReadContext = (
  env: RuntimeReplica,
  deps: RuntimeAdapterServerDeps,
) => ({
  env,
  ...(deps.readHead
    ? { readHead: () => deps.readHead?.(env) ?? Promise.resolve(null) }
    : {}),
  ...(deps.readFrame
    ? {
        readFrame: (height: number) =>
          deps.readFrame?.(env, height) ?? Promise.resolve(null),
      }
    : {}),
  ...(deps.listCheckpoints
    ? {
        listCheckpoints: () =>
          deps.listCheckpoints?.(env) ?? Promise.resolve([]),
      }
    : {}),
  ...(deps.loadEntityState
    ? {
        loadEntityState: (entityId: string, height: number) =>
          deps.loadEntityState?.(env, entityId, height) ??
          Promise.resolve(null),
      }
    : {}),
  ...(deps.loadEntityAccountDoc
    ? {
        loadEntityAccountDoc: (
          entityId: string,
          counterpartyId: string,
          height: number,
        ) =>
          deps.loadEntityAccountDoc?.(
            env,
            entityId,
            counterpartyId,
            height,
          ) ?? Promise.resolve(null),
      }
    : {}),
  ...(deps.loadEntityViewPage
    ? {
        loadEntityViewPage: (
          entityId: string,
          height: number,
          query?: RuntimeAdapterReadQuery,
        ) =>
          deps.loadEntityViewPage?.(env, entityId, height, query) ??
          Promise.resolve(null),
      }
    : {}),
  ...(deps.listEntityIdsAtHeight
    ? {
        listEntityIdsAtHeight: (height: number) =>
          deps.listEntityIdsAtHeight?.(env, height) ?? Promise.resolve([]),
      }
    : {}),
  ...(deps.readActivityPage
    ? {
        readActivityPage: (
          opts: RuntimeActivityFilters & {
            beforeHeight?: number | undefined;
            limit?: number | undefined;
            scanLimit?: number | undefined;
          },
        ) =>
          deps.readActivityPage?.(env, opts) ??
          Promise.reject(
            new RuntimeAdapterError(
              'E_INTERNAL',
              'activity reader did not return',
            ),
          ),
      }
    : {}),
  ...(deps.readReceipt
    ? { readReceipt: (id: string) => deps.readReceipt?.(id) ?? null }
    : {}),
  ...(deps.readFrameReceipts
    ? {
        readFrameReceipts: (query?: RuntimeAdapterReadQuery) =>
          deps.readFrameReceipts?.(env, query) ??
          Promise.reject(
            new RuntimeAdapterError(
              'E_INTERNAL',
              'frame receipt reader did not return',
            ),
          ),
      }
    : {}),
  ...(deps.findPaymentRoutes
    ? {
        findPaymentRoutes: (query?: RuntimeAdapterReadQuery) =>
          deps.findPaymentRoutes?.(env, query) ??
          Promise.reject(
            new RuntimeAdapterError(
              'E_INTERNAL',
              'payment route reader did not return',
            ),
          ),
      }
    : {}),
});

const handleRuntimeAdapterRead = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'read'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): Promise<void> => {
  requireAuth(state, 'inspect');
  requireBucket(state.readBucket, 'read');
  const startedAt = Date.now();
  const readDiagnostic = {
    path: msg.path,
    query: compactReadQueryForLog(msg.query),
    runtimeId: String(env.runtimeId || '') || null,
    height: Math.max(0, Math.floor(Number(env.height ?? 0))),
  };
  const pendingTimer = setTimeout(() => {
    runtimeAdapterLog.warn('read.pending', {
      ...readDiagnostic,
      elapsedMs: Date.now() - startedAt,
    });
  }, RUNTIME_ADAPTER_PENDING_READ_LOG_MS);
  try {
    const payload = await resolveRuntimeAdapterRead(
      buildRuntimeAdapterReadContext(env, deps),
      msg.path,
      msg.query,
    );
    const resolvedAt = Date.now();
    sendOk(ws, msg.id, payload, diagnostic());
    const completedAt = Date.now();
    if (completedAt - startedAt >= RUNTIME_ADAPTER_PENDING_READ_LOG_MS) {
      runtimeAdapterLog.warn('read.slow', {
        ...readDiagnostic,
        resolveMs: resolvedAt - startedAt,
        encodeSendMs: completedAt - resolvedAt,
        totalMs: completedAt - startedAt,
      });
    }
  } finally {
    clearTimeout(pendingTimer);
  }
};

const requireMutatingRuntimeAdapterReady = (
  env: RuntimeReplica,
  deps: RuntimeAdapterServerDeps,
): void => {
  requireRuntimeCommandReady(env);
  if (deps.isMutatingIngressReady?.() === false) {
    throw new RuntimeAdapterError(
      'E_COMMAND_PENDING',
      'RUNTIME_STARTUP_J_CATCHUP_PENDING',
      true,
      250,
    );
  }
};

const handleRuntimeAdapterCrossJIntent = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'cross-j-intent'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): Promise<void> => {
  requireAuth(state, 'admin');
  requireBucket(state.sendBucket, 'send');
  requireMutatingRuntimeAdapterReady(env, deps);
  if (!deps.submitCrossJurisdictionIntent) {
    throw new RuntimeAdapterError(
      'E_INTERNAL',
      'cross-j intent transport is unavailable',
    );
  }
  await deps.submitCrossJurisdictionIntent(env, msg.route);
  sendOk(ws, msg.id, { delivered: true }, diagnostic());
};

const handleRuntimeAdapterControl = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'control'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): Promise<void> => {
  requireAuth(state, 'admin');
  requireBucket(state.sendBucket, 'control');
  if (!deps.controlRuntime) {
    throw new RuntimeAdapterError(
      'E_INTERNAL',
      'runtime admin control is unavailable',
    );
  }
  sendOk(
    ws,
    msg.id,
    await deps.controlRuntime(env, msg.action),
    diagnostic(),
  );
};

const sendCommittedRuntimeAdapterCommand = (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'send'>,
  env: RuntimeReplica,
  laneId: string,
  commandId: string,
  commandSequence: number,
  inputHash: string,
  diagnostic: RuntimeAdapterDiagnostic,
): boolean => {
  const committed = readRuntimeAdapterCommandFrontier(env, laneId);
  const committedSequence = committed?.lastContiguousSequence ?? 0;
  if (commandSequence > committedSequence) return false;
  if (
    commandSequence === committedSequence &&
    (committed?.lastInputHash !== inputHash ||
      committed.lastCommandId !== commandId)
  ) {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      'runtime adapter commandId was reused with a different payload',
    );
  }
  sendOk(
    ws,
    msg.id,
    {
      height:
        committed?.observedHeight ??
        Math.max(0, Math.floor(Number(env.height ?? 0))),
      status: 'observed',
      commandSequence,
    },
    diagnostic(),
  );
  return true;
};

const sendPendingRuntimeAdapterCommand = (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'send'>,
  pending: PendingRuntimeAdapterCommand | undefined,
  commandId: string,
  commandSequence: number,
  inputHash: string,
  diagnostic: RuntimeAdapterDiagnostic,
): boolean => {
  if (!pending) return false;
  if (
    pending.sequence === commandSequence &&
    pending.commandId === commandId &&
    pending.inputHash === inputHash
  ) {
    sendOk(ws, msg.id, structuredClone(pending.result), diagnostic());
    return true;
  }
  if (pending.sequence === commandSequence) {
    throw new RuntimeAdapterError(
      'E_COMMAND_PENDING',
      'runtime adapter command sequence is occupied by another pending command',
      true,
      250,
    );
  }
  throw new RuntimeAdapterError(
    'E_COMMAND_PENDING',
    `runtime adapter command ${pending.sequence} is not durable yet`,
    true,
    250,
  );
};

const assertRuntimeAdapterCommandCapacity = (
  env: RuntimeReplica,
  laneId: string,
): void => {
  if (readRuntimeAdapterCommandFrontier(env, laneId)) return;
  const activeLaneCount = countActiveRuntimeAdapterCommandLanes(env);
  const pendingLaneCount = countUncommittedPendingLanes(env);
  if (
    activeLaneCount + pendingLaneCount <
    MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES
  ) {
    return;
  }
  throw new RuntimeAdapterError(
    'E_RATE_LIMITED',
    `runtime adapter active command lane capacity exceeded: ${activeLaneCount + pendingLaneCount}`,
    true,
    1_000,
  );
};

const enqueueRuntimeAdapterCommand = (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'send'>,
  env: RuntimeReplica,
  deps: RuntimeAdapterServerDeps,
  laneId: string,
  commandId: string,
  commandSequence: number,
  inputHash: string,
  expiresAtMs: number | null,
  diagnostic: RuntimeAdapterDiagnostic,
): void => {
  if (
    msg.input.runtimeTxs.some(
      tx => tx.type === 'recordRuntimeAdapterCommand',
    )
  ) {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      'runtime adapter command marker is server-internal',
    );
  }
  const markedInput = structuredClone(msg.input);
  const commandMarker = markLocalRuntimeAdapterCommandTx({
    type: 'recordRuntimeAdapterCommand',
    data: {
      laneId,
      sequence: commandSequence,
      commandId,
      inputHash,
      expiresAtMs,
    },
  });
  markedInput.runtimeTxs.push(commandMarker);
  deps.validateRuntimeInputAdmission?.(env, markedInput);
  const acceptedHeight = Math.max(0, Math.floor(Number(env.height ?? 0)));
  deps.enqueueRuntimeInput(env, markedInput);
  // The marker shares the exact Runtime frame with the command. It is the
  // durable idempotency authority even when an Entity reducer canonicalizes
  // or replaces the original financial input before commit.
  const registeredReceipt = deps.registerReceipt?.({
    kind: 'radapter-runtime-input',
    counts: countRuntimeInput(markedInput),
    enqueuedHeight: acceptedHeight,
    inputFingerprints: fingerprintRuntimeIngressInput({
      runtimeTxs: [commandMarker],
      entityInputs: [],
    }),
    note: 'Runtime adapter command accepted into the runtime queue; poll account/entity projections for semantic commit details.',
  });
  const receipt = registeredReceipt
    ? projectRuntimeIngressReceiptForWire(registeredReceipt)
    : undefined;
  const result = {
    height: acceptedHeight,
    status: 'pending' as const,
    commandSequence,
    ...(receipt ? { receipt } : {}),
    ...(receipt && deps.buildRuntimeInputStatusUrl
      ? { statusUrl: deps.buildRuntimeInputStatusUrl(receipt.id) }
      : {}),
  };
  pendingCommandsFor(env).set(laneId, {
    sequence: commandSequence,
    commandId,
    inputHash,
    expiresAtMs,
    result: structuredClone(result),
  });
  sendOk(ws, msg.id, result, diagnostic());
};

const handleRuntimeAdapterSend = (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'send'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): void => {
  requireAuth(state, 'admin');
  requireBucket(state.sendBucket, 'send');
  requireMutatingRuntimeAdapterReady(env, deps);
  const laneId = state.commandLaneId;
  const expiresAtMs = state.commandFrontierExpiresAtMs;
  if (
    !laneId ||
    !state.commandLaneKind ||
    (state.commandLaneKind === 'capability' && !expiresAtMs)
  ) {
    throw new RuntimeAdapterError(
      'E_UNAUTHORIZED',
      'runtime adapter command lane is unavailable',
    );
  }
  const commandId = normalizeCommandId(msg.commandId);
  const commandSequence = commandSequenceOrThrow(msg.commandSequence);
  const inputHash = runtimeInputHash(msg.input);
  if (
    sendCommittedRuntimeAdapterCommand(
      ws,
      msg,
      env,
      laneId,
      commandId,
      commandSequence,
      inputHash,
      diagnostic,
    )
  ) {
    return;
  }
  const committedSequence =
    readRuntimeAdapterCommandFrontier(env, laneId)?.lastContiguousSequence ?? 0;
  const expectedSequence = committedSequence + 1;
  if (commandSequence !== expectedSequence) {
    throw new RuntimeAdapterError(
      'E_COMMAND_PENDING',
      `runtime adapter command sequence gap: expected=${expectedSequence} actual=${commandSequence}`,
      true,
      250,
    );
  }
  if (
    sendPendingRuntimeAdapterCommand(
      ws,
      msg,
      reconcilePendingCommand(env, laneId),
      commandId,
      commandSequence,
      inputHash,
      diagnostic,
    )
  ) {
    return;
  }
  assertRuntimeAdapterCommandCapacity(env, laneId);
  enqueueRuntimeAdapterCommand(
    ws,
    msg,
    env,
    deps,
    laneId,
    commandId,
    commandSequence,
    inputHash,
    expiresAtMs,
    diagnostic,
  );
};

export const handleRuntimeAdapterMessage = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequest,
  env: RuntimeReplica | null,
  deps: RuntimeAdapterServerDeps,
): Promise<boolean> => {
  const state = getClientState(ws);
  const diagnostic = (): RuntimeAdapterResponseDiagnostic => {
    const info: RuntimeAdapterResponseDiagnostic = {
      env,
      op: String(msg.op || ''),
      authLevel: state.authLevel,
    };
    if ('path' in msg) info.path = msg.path;
    if ('query' in msg && msg.query) info.query = msg.query;
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
      handleRuntimeAdapterAuth(ws, msg, env, state, diagnostic);
      return true;
    }

    if (msg.op === 'read') {
      await handleRuntimeAdapterRead(
        ws,
        msg,
        env,
        state,
        deps,
        diagnostic,
      );
      return true;
    }

    if (msg.op === 'cross-j-intent') {
      await handleRuntimeAdapterCrossJIntent(
        ws,
        msg,
        env,
        state,
        deps,
        diagnostic,
      );
      return true;
    }

    if (msg.op === 'control') {
      await handleRuntimeAdapterControl(
        ws,
        msg,
        env,
        state,
        deps,
        diagnostic,
      );
      return true;
    }

    if (msg.op === 'send') {
      handleRuntimeAdapterSend(ws, msg, env, state, deps, diagnostic);
      return true;
    }

    return true;
  } catch (error) {
    sendErr(ws, msg.id, error, diagnostic());
    return true;
  }
};
