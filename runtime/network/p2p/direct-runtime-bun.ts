import type { ReliableDeliveryReceipt, RuntimeEntityInputsEnvelope } from '../../runtime/types';
import {
  deliveryAccepted,
  deliveryDeferred,
  deliveryFailure,
  type DeliveryResult,
} from '../../protocol/payments/delivery-result';
import { compareCanonicalText } from '../../orderbook/swap-keys';
import { decryptJSON, deriveEncryptionKeyPair, encryptJSON, hexToPubKey, pubKeyToHex } from '../../protocol/p2p-crypto';
import { deserializeWsMessage, makeMessageId, serializeWsMessage, type RuntimeWsMessage } from './ws-protocol';
import { isRuntimeId, normalizeRuntimeId } from './runtime-id';
import { verifyHelloAuth } from './hello-auth';
import { createHelloChallengeRegistry } from './hello-challenge';
import { decodeRuntimeEntityInputsEnvelope } from './entity-input-envelope';
import {
  classifyWebSocketSendResult,
  type WebSocketSendResult,
} from '../websocket-send-result';

type DirectRuntimeWsOptions = {
  runtimeId: string;
  runtimeSeed: Uint8Array | string;
  path?: string;
  requireHelloAuth?: boolean;
  helloSkewMs?: number;
  onEntityInputs: (from: string, envelope: RuntimeEntityInputsEnvelope, timestamp?: number) => Promise<void> | void;
  onReliableReceipt?: (from: string, receipt: ReliableDeliveryReceipt) => Promise<void> | void;
  onRecoveryBundleRequest?: (from: string, lookupKey: string) => Promise<unknown> | unknown;
};

export type DirectWebSocket = {
  readyState?: number;
  send(data: string | Uint8Array): WebSocketSendResult;
  close(code?: number, reason?: string): unknown;
};

type DirectUpgradeServer = {
  upgrade(request: Request, options: { data: { type: 'direct-runtime' } }): boolean;
};

type DirectUpgradeDecision =
  | { handled: false }
  | { handled: true; response?: Response };

type DirectWsSession = {
  runtimeId: string | null;
  ws: DirectWebSocket;
  handshakeDone: boolean;
  duplicateClosing: boolean;
  peerEncryptionPubKey: string | null;
  lastSeen: number;
};

type DirectRuntimeWsContext = {
  options: DirectRuntimeWsOptions;
  routePath: string;
  serverRuntimeId: string;
  keyPair: ReturnType<typeof deriveEncryptionKeyPair>;
  sessions: Map<DirectWebSocket, DirectWsSession>;
  sessionsByRuntime: Map<string, DirectWsSession>;
  helloChallenges: ReturnType<typeof createHelloChallengeRegistry>;
};

const DEFAULT_HELLO_SKEW_MS = 5 * 60 * 1000;
let directWsTimestampCounter = 0;

const nextTimestamp = (): number => {
  const now = Date.now();
  directWsTimestampCounter = now <= directWsTimestampCounter ? directWsTimestampCounter + 1 : now;
  return directWsTimestampCounter;
};

const isSocketOpen = (ws: DirectWebSocket | null | undefined): boolean => {
  if (!ws) return false;
  const readyState = Number(ws.readyState);
  return !Number.isFinite(readyState) || readyState === 1;
};

const normalizeEncryptionPubKey = (pubKey: unknown): string | null => {
  if (typeof pubKey !== 'string') return null;
  const normalized = pubKey.startsWith('0x') ? pubKey.toLowerCase() : `0x${pubKey.toLowerCase()}`;
  return /^0x[0-9a-f]{64}$/.test(normalized) ? normalized : null;
};

const send = (ws: DirectWebSocket, msg: RuntimeWsMessage): void => {
  ws.send(serializeWsMessage(msg));
};

type DirectSendAttempt =
  | { sent: true }
  | { sent: false; error?: string };

const trySend = (ws: DirectWebSocket, msg: RuntimeWsMessage): DirectSendAttempt => {
  if (!isSocketOpen(ws)) return { sent: false };
  let result: WebSocketSendResult;
  try {
    result = ws.send(serializeWsMessage(msg));
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
  return classifyWebSocketSendResult(result) === 'dropped' ? { sent: false } : { sent: true };
};

const readRecoveryLookupKey = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return '';
  return String((payload as { lookupKey?: unknown }).lookupKey || '').trim();
};

const ensureSession = (context: DirectRuntimeWsContext, ws: DirectWebSocket): DirectWsSession => {
  const existing = context.sessions.get(ws);
  if (existing) return existing;
  const created: DirectWsSession = {
    runtimeId: null,
    ws,
    handshakeDone: false,
    duplicateClosing: false,
    peerEncryptionPubKey: null,
    lastSeen: Date.now(),
  };
  context.sessions.set(ws, created);
  return created;
};

const forgetSession = (context: DirectRuntimeWsContext, ws: DirectWebSocket): void => {
  context.helloChallenges.forget(ws);
  const session = context.sessions.get(ws);
  if (!session) return;
  context.sessions.delete(ws);
  if (session.runtimeId && context.sessionsByRuntime.get(session.runtimeId)?.ws === ws) {
    context.sessionsByRuntime.delete(session.runtimeId);
  }
};

const rememberRuntimeSession = (
  context: DirectRuntimeWsContext,
  session: DirectWsSession,
  runtimeId: string,
): boolean => {
  const existing = context.sessionsByRuntime.get(runtimeId);
  if (existing && existing.ws !== session.ws) {
    if (isSocketOpen(existing.ws)) return false;
    context.sessions.delete(existing.ws);
  }
  session.runtimeId = runtimeId;
  session.handshakeDone = true;
  session.lastSeen = Date.now();
  context.sessionsByRuntime.set(runtimeId, session);
  return true;
};

const sendRecoveryBundleResponse = (
  context: DirectRuntimeWsContext,
  ws: DirectWebSocket,
  toRuntimeId: string,
  requestId: string | undefined,
  body: { payload: unknown } | { error: string },
): void => send(ws, {
  type: 'recovery_bundle_response',
  id: makeMessageId(),
  from: context.serverRuntimeId,
  fromEncryptionPubKey: pubKeyToHex(context.keyPair.publicKey),
  to: toRuntimeId,
  timestamp: nextTimestamp(),
  ...(requestId ? { inReplyTo: requestId } : {}),
  ...body,
});

const resultFromSendAttempt = (
  attempt: DirectSendAttempt,
  acceptedCode: string,
  failureCode: string,
): DeliveryResult => {
  if (attempt.sent) return deliveryAccepted(acceptedCode);
  if (attempt.error !== undefined) {
    return deliveryFailure({
      category: 'TransientRace',
      code: failureCode,
      message: attempt.error,
      terminal: false,
    });
  }
  return deliveryDeferred({ outcome: 'deferred', code: failureCode });
};

const getDeliverableSession = (
  context: DirectRuntimeWsContext,
  targetRuntimeId: string,
  invalidCode: string,
  missingCode: string,
): { targetKey: string; session: DirectWsSession } | DeliveryResult => {
  const targetKey = normalizeRuntimeId(targetRuntimeId);
  if (!targetKey) return deliveryDeferred({ outcome: 'deferred', code: invalidCode });
  const session = context.sessionsByRuntime.get(targetKey);
  if (!session || !session.handshakeDone || !isSocketOpen(session.ws)) {
    if (session && !isSocketOpen(session.ws)) forgetSession(context, session.ws);
    return deliveryDeferred({ outcome: 'deferred', code: missingCode });
  }
  return { targetKey, session };
};

const sendEntityInputsDelivery = (
  context: DirectRuntimeWsContext,
  targetRuntimeId: string,
  envelope: RuntimeEntityInputsEnvelope,
  ingressTimestamp?: number,
): DeliveryResult => {
  const target = getDeliverableSession(
    context,
    targetRuntimeId,
    'ROUTE_DIRECT_TARGET_RUNTIME_INVALID',
    'ROUTE_DIRECT_MISS_FALLBACK',
  );
  if (!('session' in target)) return target;
  const peerKey = normalizeEncryptionPubKey(target.session.peerEncryptionPubKey);
  if (!peerKey) return deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_TARGET_KEY_MISSING' });
  let msg: RuntimeWsMessage;
  try {
    msg = {
      type: 'entity_inputs',
      id: makeMessageId(),
      from: context.serverRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(context.keyPair.publicKey),
      to: target.targetKey,
      timestamp: typeof ingressTimestamp === 'number' && Number.isFinite(ingressTimestamp)
        ? ingressTimestamp
        : nextTimestamp(),
      payload: encryptJSON(envelope, hexToPubKey(peerKey)),
      encrypted: true,
      ...(envelope.entityInputs.length === 1 && envelope.entityInputs[0]
        ? { entityId: envelope.entityInputs[0].entityId }
        : {}),
      txs: envelope.entityInputs.reduce((count, input) => count + (input.entityTxs?.length ?? 0), 0),
    };
  } catch (error) {
    return deliveryFailure({
      category: 'TransientRace',
      code: 'ROUTE_DIRECT_SEND_FAILED',
      message: error instanceof Error ? error.message : String(error),
      terminal: false,
    });
  }
  const attempt = trySend(target.session.ws, msg);
  if (!attempt.sent) forgetSession(context, target.session.ws);
  return resultFromSendAttempt(attempt, 'ROUTE_DIRECT_DELIVERED', 'ROUTE_DIRECT_SEND_FAILED');
};

const sendReliableReceiptDelivery = (
  context: DirectRuntimeWsContext,
  targetRuntimeId: string,
  receipt: ReliableDeliveryReceipt,
): DeliveryResult => {
  const target = getDeliverableSession(
    context,
    targetRuntimeId,
    'ROUTE_DIRECT_RECEIPT_TARGET_RUNTIME_INVALID',
    'ROUTE_DIRECT_RECEIPT_MISS_FALLBACK',
  );
  if (!('session' in target)) return target;
  const attempt = trySend(target.session.ws, {
    type: 'entity_input_receipt',
    id: makeMessageId(),
    from: context.serverRuntimeId,
    to: target.targetKey,
    timestamp: nextTimestamp(),
    payload: receipt,
  });
  if (!attempt.sent) forgetSession(context, target.session.ws);
  return resultFromSendAttempt(
    attempt,
    'ROUTE_DIRECT_RECEIPT_DELIVERED',
    'ROUTE_DIRECT_RECEIPT_SEND_FAILED',
  );
};

const handleHandshake = (
  context: DirectRuntimeWsContext,
  ws: DirectWebSocket,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
): boolean => {
  if (session.handshakeDone) return false;
  if (msg.type !== 'hello' || typeof msg.from !== 'string') {
    send(ws, { type: 'error', error: 'Handshake required: send hello with runtimeId' });
    ws.close();
    return true;
  }
  const normalizedFrom = normalizeRuntimeId(msg.from);
  if (!normalizedFrom || normalizedFrom === context.serverRuntimeId) {
    const error = normalizedFrom
      ? 'Direct runtime websocket only accepts inter-runtime peers'
      : 'Invalid runtimeId in hello';
    send(ws, { type: 'error', error });
    ws.close();
    return true;
  }
  const peerKey = normalizeEncryptionPubKey(msg.fromEncryptionPubKey);
  if (!peerKey) {
    send(ws, { type: 'error', error: 'Missing or invalid fromEncryptionPubKey' });
    ws.close();
    return true;
  }
  if (context.options.requireHelloAuth !== false) {
    const challengeAccepted = context.helloChallenges.consume(ws, msg.auth?.nonce);
    const authError = challengeAccepted
      ? verifyHelloAuth(
          normalizedFrom,
          peerKey,
          msg.auth,
          context.options.helloSkewMs ?? DEFAULT_HELLO_SKEW_MS,
        )
      : 'Hello challenge missing, expired, or already consumed';
    if (authError) {
      send(ws, { type: 'error', error: authError });
      ws.close();
      return true;
    }
  }
  session.peerEncryptionPubKey = peerKey;
  if (!rememberRuntimeSession(context, session, normalizedFrom)) {
    session.duplicateClosing = true;
    ws.close(4009, 'duplicate-runtime');
    return true;
  }
  send(ws, {
    type: 'hello_ack',
    from: context.serverRuntimeId,
    fromEncryptionPubKey: pubKeyToHex(context.keyPair.publicKey),
    to: normalizedFrom,
  });
  return true;
};

const sessionRuntimeId = (session: DirectWsSession): string =>
  normalizeRuntimeId(session.runtimeId || '');

const validateMessageRoute = (
  context: DirectRuntimeWsContext,
  ws: DirectWebSocket,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
  prefix: string,
): string | null => {
  const fromRuntimeId = sessionRuntimeId(session);
  if (!fromRuntimeId) {
    send(ws, { type: 'error', error: 'Missing source runtimeId' });
    return null;
  }
  if (msg.from && normalizeRuntimeId(msg.from) !== fromRuntimeId) {
    send(ws, { type: 'error', error: `${prefix} source runtimeId mismatch` });
    return null;
  }
  if (normalizeRuntimeId(msg.to || '') !== context.serverRuntimeId) {
    send(ws, { type: 'error', error: `${prefix} target runtimeId mismatch` });
    return null;
  }
  return fromRuntimeId;
};

const handleRecoveryRequest = async (
  context: DirectRuntimeWsContext,
  ws: DirectWebSocket,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
): Promise<boolean> => {
  if (msg.type !== 'recovery_bundle_request') return false;
  const fromRuntimeId = sessionRuntimeId(session);
  if (!fromRuntimeId) {
    send(ws, { type: 'error', error: 'Missing source runtimeId' });
    return true;
  }
  const respond = (body: { payload: unknown } | { error: string }): void =>
    sendRecoveryBundleResponse(context, ws, fromRuntimeId, msg.id, body);
  if (msg.from && normalizeRuntimeId(msg.from) !== fromRuntimeId) {
    respond({ error: 'Direct source runtimeId mismatch' });
    return true;
  }
  if (normalizeRuntimeId(msg.to || '') !== context.serverRuntimeId) {
    respond({ error: 'Direct target runtimeId mismatch' });
    return true;
  }
  const lookupKey = readRecoveryLookupKey(msg.payload);
  if (!lookupKey) {
    respond({ error: 'Recovery lookupKey is required' });
    return true;
  }
  if (!context.options.onRecoveryBundleRequest) {
    respond({ error: 'Direct recovery bundle reads unavailable' });
    return true;
  }
  try {
    respond({ payload: await context.options.onRecoveryBundleRequest(fromRuntimeId, lookupKey) });
  } catch (error) {
    respond({ error: `Recovery bundle request failed: ${(error as Error).message}` });
  }
  return true;
};

const handleReliableReceipt = async (
  context: DirectRuntimeWsContext,
  ws: DirectWebSocket,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
): Promise<boolean> => {
  if (msg.type !== 'entity_input_receipt') return false;
  const fromRuntimeId = validateMessageRoute(context, ws, session, msg, 'Direct receipt');
  if (!fromRuntimeId) return true;
  if (!context.options.onReliableReceipt) {
    send(ws, { type: 'error', error: 'Direct reliable receipt handler unavailable' });
    return true;
  }
  try {
    await context.options.onReliableReceipt(fromRuntimeId, msg.payload as ReliableDeliveryReceipt);
  } catch (error) {
    send(ws, { type: 'error', error: `Direct receipt failed: ${(error as Error).message}` });
  }
  return true;
};

const handleEntityInputs = async (
  context: DirectRuntimeWsContext,
  ws: DirectWebSocket,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
): Promise<void> => {
  if (msg.type !== 'entity_inputs') {
    send(ws, { type: 'error', error: 'Unsupported direct ws message type' });
    return;
  }
  if (normalizeRuntimeId(msg.to || '') !== context.serverRuntimeId) {
    send(ws, { type: 'error', error: 'Direct target runtimeId mismatch' });
    return;
  }
  if (!msg.encrypted || typeof msg.payload !== 'string') {
    send(ws, { type: 'error', error: 'Direct entity_inputs must be encrypted' });
    return;
  }
  const fromRuntimeId = validateMessageRoute(context, ws, session, msg, 'Direct');
  if (!fromRuntimeId) return;
  try {
    const envelope = decodeRuntimeEntityInputsEnvelope(
      decryptJSON(msg.payload, context.keyPair.privateKey),
    );
    await context.options.onEntityInputs(
      fromRuntimeId,
      envelope,
      typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
    );
  } catch (error) {
    send(ws, { type: 'error', error: `Direct delivery failed: ${(error as Error).message}` });
  }
};

const handleDirectMessage = async (
  context: DirectRuntimeWsContext,
  ws: DirectWebSocket,
  raw: string | Buffer | ArrayBuffer,
): Promise<void> => {
  const session = ensureSession(context, ws);
  if (session.duplicateClosing) return;
  let msg: RuntimeWsMessage;
  try {
    msg = deserializeWsMessage(raw);
  } catch (error) {
    send(ws, { type: 'error', error: `Invalid wire message: ${(error as Error).message}` });
    return;
  }
  if (handleHandshake(context, ws, session, msg)) return;
  if (msg.type === 'ping') {
    session.lastSeen = Date.now();
    send(ws, { type: 'pong', inReplyTo: msg.id || makeMessageId() });
    return;
  }
  if (msg.type === 'hello' || msg.type === 'debug_event') return;
  session.lastSeen = Date.now();
  const peerKey = normalizeEncryptionPubKey(msg.fromEncryptionPubKey);
  if (peerKey) session.peerEncryptionPubKey = peerKey;
  if (await handleRecoveryRequest(context, ws, session, msg)) return;
  if (await handleReliableReceipt(context, ws, session, msg)) return;
  await handleEntityInputs(context, ws, session, msg);
};

export const createDirectRuntimeWsRoute = (options: DirectRuntimeWsOptions) => {
  const serverRuntimeId = normalizeRuntimeId(options.runtimeId);
  if (!serverRuntimeId || !isRuntimeId(serverRuntimeId)) {
    throw new Error(`DIRECT_RUNTIME_WS_INVALID_RUNTIME_ID: ${String(options.runtimeId || '')}`);
  }
  const context: DirectRuntimeWsContext = {
    options,
    routePath: options.path || '/ws',
    serverRuntimeId,
    keyPair: deriveEncryptionKeyPair(options.runtimeSeed),
    sessions: new Map(),
    sessionsByRuntime: new Map(),
    helloChallenges: createHelloChallengeRegistry(),
  };
  return {
    path: context.routePath,
    getSessionState: (): Array<{ runtimeId: string; open: boolean; lastSeen: number }> =>
      Array.from(context.sessionsByRuntime.values())
        .map(session => ({
          runtimeId: session.runtimeId || '',
          open: isSocketOpen(session.ws),
          lastSeen: session.lastSeen,
        }))
        .filter(session => session.runtimeId.length > 0)
        .sort((left, right) => compareCanonicalText(left.runtimeId, right.runtimeId)),
    sendEntityInputsDelivery: (
      targetRuntimeId: string,
      envelope: RuntimeEntityInputsEnvelope,
      ingressTimestamp?: number,
    ): DeliveryResult => sendEntityInputsDelivery(context, targetRuntimeId, envelope, ingressTimestamp),
    sendReliableReceiptDelivery: (
      targetRuntimeId: string,
      receipt: ReliableDeliveryReceipt,
    ): DeliveryResult => sendReliableReceiptDelivery(context, targetRuntimeId, receipt),
    maybeUpgrade(request: Request, serverRef: DirectUpgradeServer): DirectUpgradeDecision {
      const url = new URL(request.url);
      if (request.headers.get('upgrade') !== 'websocket' || url.pathname !== context.routePath) {
        return { handled: false };
      }
      const upgraded = serverRef.upgrade(request, { data: { type: 'direct-runtime' } });
      return upgraded
        ? { handled: true }
        : { handled: true, response: new Response('WebSocket upgrade failed', { status: 400 }) };
    },
    websocket: {
      open(ws: DirectWebSocket): void {
        ensureSession(context, ws);
        if (options.requireHelloAuth !== false) context.helloChallenges.issue(ws);
      },
      message: (ws: DirectWebSocket, raw: string | Buffer | ArrayBuffer): Promise<void> =>
        handleDirectMessage(context, ws, raw),
      close(ws: DirectWebSocket): void {
        forgetSession(context, ws);
      },
    },
  };
};
