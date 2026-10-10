import type { RuntimeActivityFilters } from '../../../storage/views/activity-types';
import type { AccountFrame } from '../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityState } from '../../../entity/types';
import type { RuntimeReplica, RuntimeInput } from '../../../runtime/types';
import {
  assertRuntimeAdapterMessageSize,
  encodeRuntimeAdapterMessageForBrowser,
  runtimeAdapterMessageByteLength,
  runtimeAdapterMaxMessageBytes,
} from '../codec';
import type { RuntimeFrame, StorageHead } from '../../../storage/types';
import type { StorageAccountDoc, StorageEntityViewPage } from '../../../storage';
import { RuntimeAdapterError, requireRuntimeAdapterCommandReady, toRuntimeAdapterErrorPayload } from '../errors';
import { consumeToken, createTokenBucket, tokenRetryAfterMs, type TokenBucket } from '../security/rate-limit';
import { createStructuredLogger } from '../../../support/logger';
import type {
  RuntimeAdapterAuthLevel,
  RuntimeAdapterActivityPage,
  RuntimeAdapterBrainVaultInput,
  RuntimeAdapterBrainVaultProgress,
  RuntimeAdapterBrainVaultRecovery,
  RuntimeAdapterBrainVaultResult,
  RuntimeAdapterControlAction,
  RuntimeAdapterFrameReceiptResponse,
  RuntimeAdapterPaymentRoutesResponse,
  RuntimeAdapterReadQuery,
  RuntimeAdapterSwapHistoryPage,
  RuntimeAdapterRequest,
  RuntimeAdapterResponse,
  RuntimeAdapterPush,
} from '../types';
import { encodeBinaryPayload } from '../../../protocol/serialization/binary-codec';
import { XLN_PROTOCOL_VERSION } from '../../../protocol/version';
import {
  classifyWebSocketSendResult,
  type WebSocketSendResult,
} from '../../../network/websocket-send-result';
import { countOp } from '../../../support/performance/op-counters';

// The session context every runtime-adapter handler shares: socket, client
// state and host dependency types, the radapter logger, response encoding and
// sending, and the auth, rate and readiness guards.

export type RuntimeAdapterSocket = {
  send: (message: string | Uint8Array) => unknown;
  close?: (code?: number, reason?: string) => unknown;
  getBufferedAmount?: () => number;
};

export type AdapterClientState = {
  env: RuntimeReplica | null;
  authLevel: RuntimeAdapterAuthLevel | null;
  authExpiresAtMs: number | null;
  commandLaneId: string | null;
  commandLaneKind: 'owner' | 'capability' | null;
  commandFrontierExpiresAtMs: number | null;
  controlBucket: TokenBucket;
  readBucket: TokenBucket;
  sendBucket: TokenBucket;
};

export type RuntimeAdapterResponseDiagnostic = {
  env?: RuntimeReplica | null;
  op?: string;
  path?: string;
  query?: RuntimeAdapterReadQuery;
  authLevel?: RuntimeAdapterAuthLevel | null;
};

export type RuntimeAdapterServerDeps = {
  readHead?: (env: RuntimeReplica) => Promise<StorageHead | null>;
  readFrame?: (env: RuntimeReplica, height: number) => Promise<RuntimeFrame | null>;
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
	  readAccountSwapHistoryPage?: (
    env: RuntimeReplica,
    entityId: string,
    counterpartyId: string,
    options: Readonly<{ limit?: number; cursor?: Readonly<{ height: number; offerId: string }> }>,
  ) => Promise<RuntimeAdapterSwapHistoryPage>;
	  readAccountFrameHistory?: (
    env: RuntimeReplica,
    entityId: string,
    counterpartyId: string,
    limit: number,
  ) => Promise<AccountFrame[]>;
	  enqueueRuntimeInput: (env: RuntimeReplica, input: RuntimeInput) => void;
	  submitCrossJurisdictionIntent?: (env: RuntimeReplica, route: CrossJurisdictionSwapRoute) => Promise<unknown>;
	  controlRuntime?: (env: RuntimeReplica, action: RuntimeAdapterControlAction) => Promise<unknown>;
	  validateRuntimeInputAdmission?: (env: RuntimeReplica, input: RuntimeInput) => void;
	  readFrameReceipts?: (env: RuntimeReplica, query?: RuntimeAdapterReadQuery) => Promise<RuntimeAdapterFrameReceiptResponse>;
	  findPaymentRoutes?: (env: RuntimeReplica, query?: RuntimeAdapterReadQuery) => Promise<RuntimeAdapterPaymentRoutesResponse>;
	  isMutatingIngressReady?: () => boolean;
	  deriveBrainVault?: (
	    env: RuntimeReplica,
	    input: RuntimeAdapterBrainVaultInput,
	    options: Readonly<{
	      signal: AbortSignal;
	      onProgress: (progress: RuntimeAdapterBrainVaultProgress) => void;
	    }>,
	  ) => Promise<RuntimeAdapterBrainVaultResult>;
	  revealBrainVaultMnemonic?: () => Promise<RuntimeAdapterBrainVaultRecovery>;
	};

export type RuntimeAdapterRequestByOp<Op extends RuntimeAdapterRequest['op']> =
  Extract<RuntimeAdapterRequest, { op: Op }>;

export type RuntimeAdapterDiagnostic = () => RuntimeAdapterResponseDiagnostic;

const RUNTIME_ADAPTER_BACKPRESSURE_DEFAULT_BYTES = 2 * 1024 * 1024;

export const runtimeAdapterLog = createStructuredLogger('runtime.radapter');
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const readPositiveNumberEnv = (name: string, defaultValue: number): number => {
  const raw = typeof process !== 'undefined' ? process.env[name] : undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
};

export const createConfiguredBucket = (
  label: 'CONTROL' | 'READ' | 'SEND',
  defaultCapacity: number,
  defaultRefillPerSecond: number,
): TokenBucket => createTokenBucket(
  readPositiveNumberEnv(`XLN_RADAPTER_${label}_BURST`, defaultCapacity),
  readPositiveNumberEnv(`XLN_RADAPTER_${label}_PER_SEC`, defaultRefillPerSecond),
);

const runtimeAdapterBackpressureBytes = (): number =>
  readPositiveNumberEnv('XLN_RADAPTER_BACKPRESSURE_BYTES', RUNTIME_ADAPTER_BACKPRESSURE_DEFAULT_BYTES);

export const compactReadQueryForLog = (query: RuntimeAdapterReadQuery | undefined): Record<string, unknown> | undefined => {
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
    return encodeBinaryPayload(value).byteLength;
  } catch (error) {
    runtimeAdapterLog.debug('response_size_field_encode_failed', { reason: errorMessage(error) });
    return null;
  }
};

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
    height: Math.max(0, Math.floor(Number(env?.state.height ?? 0))),
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

const closeRuntimeAdapterSocketIfBackpressured = (ws: RuntimeAdapterSocket): boolean => {
  const buffered = ws.getBufferedAmount?.() ?? 0;
  if (buffered <= runtimeAdapterBackpressureBytes()) return false;
  ws.close?.(1013, 'runtime adapter socket backpressure');
  return true;
};

export const sendRuntimeAdapterEncoded = (ws: RuntimeAdapterSocket, encoded: string | Uint8Array): void => {
  if (closeRuntimeAdapterSocketIfBackpressured(ws)) return;
  countOp(
    'socket.radapter.out.response',
    typeof encoded === 'string' ? new TextEncoder().encode(encoded).byteLength : encoded.byteLength,
  );
  const disposition = classifyWebSocketSendResult(ws.send(encoded) as WebSocketSendResult);
  if (disposition === 'accepted') return;
  if (disposition === 'backpressured') {
    // Bun/uWS returns -1 after accepting the complete payload into its socket
    // backpressure queue. Closing here discarded the queued RPC response and
    // manufactured a 1013 disconnect on every sufficiently large HLT frame
    // summary. The next send still enforces the explicit buffered-byte ceiling;
    // a zero return remains an unambiguous drop and closes loudly below.
    runtimeAdapterLog.warn('send.queued_backpressure', {
      bytes: typeof encoded === 'string'
        ? new TextEncoder().encode(encoded).byteLength
        : encoded.byteLength,
      bufferedAmount: ws.getBufferedAmount?.() ?? null,
    });
    return;
  }
  ws.close?.(1013, 'runtime adapter socket backpressure');
};

const sendResponse = (
  ws: RuntimeAdapterSocket,
  response: RuntimeAdapterResponse,
  diagnostic?: RuntimeAdapterResponseDiagnostic,
): void => {
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
      sendRuntimeAdapterEncoded(ws, capped);
    } catch (error) {
      runtimeAdapterLog.warn('response_too_large.error_send_failed', {
        inReplyTo: response.inReplyTo,
        reason: errorMessage(error),
      });
      ws.close?.(1009, 'runtime adapter response too large');
    }
    // Keep the socket. A too-large *payload* is a request error; the client
    // must be able to retry a smaller page. Close only when even the cap fails.
    return;
  }
  sendRuntimeAdapterEncoded(ws, encoded);
};

export const sendOk = (
  ws: RuntimeAdapterSocket,
  inReplyTo: string,
  payload: unknown,
  diagnostic?: RuntimeAdapterResponseDiagnostic,
): void => {
  sendResponse(ws, { v: XLN_PROTOCOL_VERSION, inReplyTo, ok: true, payload }, diagnostic);
};

export const sendPush = (ws: RuntimeAdapterSocket, message: RuntimeAdapterPush): void => {
  const encoded = encodeRuntimeAdapterMessageForBrowser(message);
  assertRuntimeAdapterMessageSize(encoded);
  sendRuntimeAdapterEncoded(ws, encoded);
};

export const sendErr = (
  ws: RuntimeAdapterSocket,
  inReplyTo: string,
  error: unknown,
  diagnostic?: RuntimeAdapterResponseDiagnostic,
): void => {
  sendResponse(ws, { v: XLN_PROTOCOL_VERSION, inReplyTo, ok: false, error: toRuntimeAdapterErrorPayload(error) }, diagnostic);
};

export const requireAuth = (
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

export const requireOwnerLane = (state: AdapterClientState): void => {
  requireAuth(state, 'admin');
  if (state.commandLaneKind !== 'owner') {
    throw new RuntimeAdapterError('E_UNAUTHORIZED', 'vault-owner lane required');
  }
};

export const requireBucket = (bucket: TokenBucket, label: string): void => {
  if (consumeToken(bucket)) return;
  throw new RuntimeAdapterError(
    'E_RATE_LIMITED',
    `runtime adapter ${label} rate limit exceeded`,
    true,
    tokenRetryAfterMs(bucket),
  );
};

export const requireMutatingRuntimeAdapterReady = (
  env: RuntimeReplica,
  deps: RuntimeAdapterServerDeps,
): void => {
  requireRuntimeAdapterCommandReady(env);
  if (deps.isMutatingIngressReady?.() === false) {
    throw new RuntimeAdapterError(
      'E_COMMAND_PENDING',
      'RUNTIME_STARTUP_J_CATCHUP_PENDING',
      true,
      250,
    );
  }
};
