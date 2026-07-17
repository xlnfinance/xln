import type { RuntimeActivityFilters } from '../api/activity-history';
import type { EntityState, Env, RuntimeInput } from '../types';
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
} from '../server/ingress-receipts';
import { RuntimeAdapterError, toRuntimeAdapterErrorPayload } from './errors';
import { consumeToken, createTokenBucket, tokenRetryAfterMs, type TokenBucket } from './rate-limit';
import { resolveRuntimeAdapterRead } from './resolve';
import { createStructuredLogger } from '../infra/logger';
import { safeStringify } from '../protocol/serialization';
import { keccak256, toUtf8Bytes } from 'ethers';
import type {
  RuntimeAdapterAuthLevel,
  RuntimeAdapterActivityPage,
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
	  readFrameReceipts?: (env: Env, query?: RuntimeAdapterReadQuery) => Promise<RuntimeAdapterFrameReceiptResponse>;
	  findPaymentRoutes?: (env: Env, query?: RuntimeAdapterReadQuery) => Promise<RuntimeAdapterPaymentRoutesResponse>;
	  buildRuntimeInputStatusUrl?: (id: string) => string;
	  isMutatingIngressReady?: () => boolean;
	};

const clients = new Map<RuntimeAdapterSocket, AdapterClientState>();
let attachedEnv: Env | null = null;
let detachEnvChange: (() => void) | null = null;
const RUNTIME_ADAPTER_BACKPRESSURE_DEFAULT_BYTES = 2 * 1024 * 1024;
const runtimeAdapterLog = createStructuredLogger('runtime.radapter');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

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

const pendingRuntimeAdapterCommands = new Map<Env, Map<string, PendingRuntimeAdapterCommand>>();

const pendingCommandsFor = (env: Env): Map<string, PendingRuntimeAdapterCommand> => {
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

const reconcilePendingCommand = (env: Env, laneId: string): PendingRuntimeAdapterCommand | undefined => {
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

const prunePendingCommands = (env: Env): void => {
  const commands = pendingRuntimeAdapterCommands.get(env);
  if (!commands) return;
  for (const laneId of commands.keys()) reconcilePendingCommand(env, laneId);
  if (commands.size === 0) pendingRuntimeAdapterCommands.delete(env);
};

const countUncommittedPendingLanes = (env: Env): number => {
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

export const runtimeAdapterClientCount = (): number => clients.size;

export const closeInvalidRuntimeAdapterMessage = (ws: RuntimeAdapterSocket, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error || '');
  ws.close?.(message.includes('RADAPTER_MESSAGE_TOO_LARGE') ? 1009 : 1003, 'Invalid runtime adapter message');
};

export const broadcastRuntimeAdapterTick = (env: Env): void => {
  prunePendingCommands(env);
  if (clients.size === 0) return;
  const height = Math.max(0, Math.floor(Number(env.height ?? 0)));
  const message = encodeRuntimeAdapterMessageForBrowser({ v: XLN_PROTOCOL_VERSION, op: 'tick', height });
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
  env: Env,
  registerEnvChangeCallback: (env: Env, cb: (env: Env) => void) => (() => void),
): void => {
  if (attachedEnv === env) return;
  detachEnvChange?.();
  if (attachedEnv) pendingRuntimeAdapterCommands.delete(attachedEnv);
  attachedEnv = env;
  detachEnvChange = registerEnvChangeCallback(env, broadcastRuntimeAdapterTick);
};

export const handleRuntimeAdapterMessage = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequest,
  env: Env | null,
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
      state.authLevel = null;
      state.authExpiresAtMs = null;
      state.commandLaneId = null;
      state.commandLaneKind = null;
      state.commandFrontierExpiresAtMs = null;
      const authSeed = resolveRuntimeAdapterAuthSeed(env);
      const auth = verifyRuntimeAdapterAuthCredential(authSeed, msg.key, {
        audience: resolveRuntimeAdapterAuthAudience(env),
        revokedTokenIds: runtimeAdapterRevokedTokenIds(),
      });
      if (!auth) throw new RuntimeAdapterError('E_UNAUTHORIZED', 'invalid runtime adapter auth key');
      let challenge: string;
      try {
        challenge = normalizeRuntimeAdapterIdentityChallenge(msg.challenge);
      } catch {
        throw new RuntimeAdapterError('E_BAD_QUERY', 'runtime adapter auth challenge must be 32-byte hex');
      }
      const identity = signRuntimeAdapterServerIdentity(env, challenge);
      const ownerSignature = typeof msg.ownerSignature === 'string'
        ? msg.ownerSignature.trim()
        : '';
      if (ownerSignature && !verifyRuntimeAdapterOwnerBinding(
        identity.runtimeId,
        challenge,
        String(msg.key || ''),
        ownerSignature,
      )) {
        throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter vault-owner binding is invalid');
      }
      const commandLaneKind = ownerSignature ? 'owner' as const : 'capability' as const;
      state.authLevel = auth.level;
      state.authExpiresAtMs = auth.expiresAtMs;
      state.commandLaneKind = commandLaneKind;
      state.commandLaneId = commandLaneKind === 'owner'
        ? runtimeAdapterOwnerCommandLaneId(identity.runtimeId)
        : runtimeAdapterCommandLaneId(auth.keyId, auth.tokenId);
      state.commandFrontierExpiresAtMs = commandLaneKind === 'owner' ? null : auth.expiresAtMs;
      prunePendingCommands(env);
      const commandFrontier = readRuntimeAdapterCommandFrontier(env, state.commandLaneId);
      sendOk(ws, msg.id, {
        authLevel: auth.level,
        commandLaneKind,
        expiresAtMs: auth.expiresAtMs,
        currentHeight: Math.max(0, Math.floor(Number(env.height ?? 0))),
        nextCommandSequence: (commandFrontier?.lastContiguousSequence ?? 0) + 1,
        ...identity,
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
        ...(deps.readFrameReceipts ? {
          readFrameReceipts: (query?: RuntimeAdapterReadQuery) =>
            deps.readFrameReceipts?.(env, query) ?? Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'frame receipt reader did not return')),
        } : {}),
        ...(deps.findPaymentRoutes ? {
          findPaymentRoutes: (query?: RuntimeAdapterReadQuery) =>
            deps.findPaymentRoutes?.(env, query) ?? Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'payment route reader did not return')),
        } : {}),
      }, msg.path, msg.query);
      sendOk(ws, msg.id, payload, diagnostic());
      return true;
    }

    if (msg.op === 'send') {
      requireAuth(state, 'admin');
      requireBucket(state.sendBucket, 'send');
      if (deps.isMutatingIngressReady?.() === false) {
        throw new RuntimeAdapterError(
          'E_COMMAND_PENDING',
          'RUNTIME_STARTUP_J_CATCHUP_PENDING',
          true,
          250,
        );
      }
      const laneId = state.commandLaneId;
      const expiresAtMs = state.commandFrontierExpiresAtMs;
      if (!laneId || !state.commandLaneKind || (state.commandLaneKind === 'capability' && !expiresAtMs)) {
        throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter command lane is unavailable');
      }
      const commandId = normalizeCommandId(msg.commandId);
      const commandSequence = commandSequenceOrThrow(msg.commandSequence);
      const inputHash = runtimeInputHash(msg.input);
      const committed = readRuntimeAdapterCommandFrontier(env, laneId);
      const committedSequence = committed?.lastContiguousSequence ?? 0;
      if (commandSequence <= committedSequence) {
        if (
          commandSequence === committedSequence
          && (committed?.lastInputHash !== inputHash || committed.lastCommandId !== commandId)
        ) {
          throw new RuntimeAdapterError('E_BAD_QUERY', 'runtime adapter commandId was reused with a different payload');
        }
        sendOk(ws, msg.id, {
          height: committed?.observedHeight ?? Math.max(0, Math.floor(Number(env.height ?? 0))),
          status: 'observed',
          commandSequence,
        }, diagnostic());
        return true;
      }
      const expectedSequence = committedSequence + 1;
      if (commandSequence !== expectedSequence) {
        throw new RuntimeAdapterError(
          'E_COMMAND_PENDING',
          `runtime adapter command sequence gap: expected=${expectedSequence} actual=${commandSequence}`,
          true,
          250,
        );
      }
      const pending = reconcilePendingCommand(env, laneId);
      if (pending) {
        if (
          pending.sequence === commandSequence
          && pending.commandId === commandId
          && pending.inputHash === inputHash
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
      }
      const activeLaneCount = countActiveRuntimeAdapterCommandLanes(env);
      const pendingLaneCount = countUncommittedPendingLanes(env);
      if (!committed && activeLaneCount + pendingLaneCount >= MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES) {
        throw new RuntimeAdapterError(
          'E_RATE_LIMITED',
          `runtime adapter active command lane capacity exceeded: ${activeLaneCount + pendingLaneCount}`,
          true,
          1_000,
        );
      }
      if (msg.input.runtimeTxs.some(tx => tx.type === 'recordRuntimeAdapterCommand')) {
        throw new RuntimeAdapterError('E_BAD_QUERY', 'runtime adapter command marker is server-internal');
      }
      const markedInput = structuredClone(msg.input);
      const commandMarker = markLocalRuntimeAdapterCommandTx({
        type: 'recordRuntimeAdapterCommand',
        data: { laneId, sequence: commandSequence, commandId, inputHash, expiresAtMs },
      });
      markedInput.runtimeTxs.push(commandMarker);
      deps.validateRuntimeInputAdmission?.(env, markedInput);
      const acceptedHeight = Math.max(0, Math.floor(Number(env.height ?? 0)));
      deps.enqueueRuntimeInput(env, markedInput);
      const registeredReceipt = deps.registerReceipt?.({
        kind: 'radapter-runtime-input',
        counts: countRuntimeInput(markedInput),
        enqueuedHeight: acceptedHeight,
        // HTLC ingress intentionally replaces the raw payment with its sealed
        // proposer-authored envelope before commit. The server marker is in the
        // same R-frame and is the immutable authority for observed/retry state.
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
        ...(receipt && deps.buildRuntimeInputStatusUrl ? { statusUrl: deps.buildRuntimeInputStatusUrl(receipt.id) } : {}),
      };
      pendingCommandsFor(env).set(laneId, {
        sequence: commandSequence,
        commandId,
        inputHash,
        expiresAtMs,
        result: structuredClone(result),
      });
      sendOk(ws, msg.id, result, diagnostic());
      return true;
    }

    return true;
  } catch (error) {
    sendErr(ws, msg.id, error, diagnostic());
    return true;
  }
};
