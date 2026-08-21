import type { RuntimeEntityInputsEnvelope } from '../../runtime/types';
import {
  deliveryAccepted,
  deliveryDeferred,
  deliveryFailure,
  type DeliveryResult,
} from '../../protocol/payments/delivery-result';
import { compareCanonicalText } from '../../orderbook/swap-keys';
import {
  decryptJSON,
  decryptSessionJSON,
  deriveEncryptionKeyPair,
  encryptJSON,
  encryptSessionJSON,
  generateEphemeralKeyPair,
  hexToPubKey,
  pubKeyToHex,
  x25519SharedSecret,
} from '../../protocol/crypto/p2p-crypto';
import { deriveSignerAddressSync, signDigest } from '../../account/crypto';
import {
  deserializeWsMessage,
  directRuntimeWsAudience,
  hashRuntimeWsFrame,
  deriveRuntimeWsSessionKeys,
  macRuntimeWsFrame,
  type RuntimeWsSessionKeys,
  makeMessageId,
  resolveRuntimeWsMaxMessageBytes,
  serializeWsMessage,
  type RuntimeWsMessage,
} from './ws-protocol';
import { isRuntimeId, normalizeRuntimeId } from './auth/runtime-id';
import { verifyHelloAuth, verifyRuntimeWsFrameAuth } from './auth/hello-auth';
import { createHelloChallengeRegistry } from './auth/hello-challenge';
import { decodeRuntimeEntityInputsEnvelope } from './auth/entity-input-envelope';
import {
  classifyWebSocketSendResult,
  type WebSocketSendResult,
} from '../websocket-send-result';
import { createStructuredLogger } from '../../support/logger';

const directWsLog = createStructuredLogger('network.direct_ws');

type DirectRuntimeWsOptions = {
  runtimeId: string;
  runtimeSeed: Uint8Array | string;
  path?: string;
  helloSkewMs?: number;
  onEntityInputs: (from: string, envelope: RuntimeEntityInputsEnvelope, timestamp?: number) => Promise<void> | void;
  onRecoveryBundleRequest?: (from: string, lookupKey: string) => Promise<unknown> | unknown;
};

export type DirectWebSocket = {
  readyState?: number;
  send(data: string | Uint8Array): WebSocketSendResult;
  getBufferedAmount?(): number;
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
  authAudience: string | null;
  authNonce: string | null;
  lastAuthTimestamp: number;
  outboundAuthTimestamp: number;
  /** Direction keys derived from the hello-bound ephemeral exchange; null = per-frame ECDSA session. */
  sessionKeys: RuntimeWsSessionKeys | null;
  outboundEncSeq: number;
  lastSeen: number;
  /** `send() === -1` means queued by Bun, not dropped. Retain the streak only
   *  for observability and a time-bounded stuck-socket watchdog; never send the
   *  same financial envelope through a second route after Bun accepted it. */
  consecutiveBackpressuredSends: number;
  backpressureStartedAt: number;
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

const signSessionFrame = (
  context: DirectRuntimeWsContext,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
): RuntimeWsMessage => {
  if (!session.authAudience || !session.authNonce) throw new Error('DIRECT_SESSION_AUTH_BINDING_MISSING');
  const timestamp = ++session.outboundAuthTimestamp;
  const unsigned = {
    ...msg,
    from: msg.from || context.serverRuntimeId,
    fromEncryptionPubKey: msg.fromEncryptionPubKey || pubKeyToHex(context.keyPair.publicKey),
  };
  // hello_ack carries the server ephemeral key and must be runtime-signed;
  // every later frame of a keyed session is authenticated by the s2c MAC.
  if (session.sessionKeys && msg.type !== 'hello_ack') {
    return {
      ...unsigned,
      auth: {
        nonce: session.authNonce,
        timestamp,
        mac: macRuntimeWsFrame(session.sessionKeys.s2c, unsigned, session.authAudience, session.authNonce, timestamp),
      },
    };
  }
  return {
    ...unsigned,
    auth: {
      nonce: session.authNonce,
      timestamp,
      signature: signDigest(
        context.options.runtimeSeed,
        '1',
        hashRuntimeWsFrame(unsigned, session.authAudience, session.authNonce, timestamp),
      ),
    },
  };
};

const sendSession = (
  context: DirectRuntimeWsContext,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
): void => send(session.ws, signSessionFrame(context, session, msg));

type DirectSendAttempt =
  | { sent: true; backpressured: boolean }
  | { sent: false; error?: string };

const trySend = (ws: DirectWebSocket, msg: RuntimeWsMessage): DirectSendAttempt => {
  if (!isSocketOpen(ws)) return { sent: false };
  let result: WebSocketSendResult;
  try {
    result = ws.send(serializeWsMessage(msg));
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
  const disposition = classifyWebSocketSendResult(result);
  if (disposition === 'dropped') return { sent: false };
  return { sent: true, backpressured: disposition === 'backpressured' };
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
    authAudience: null,
    authNonce: null,
    lastAuthTimestamp: 0,
    outboundAuthTimestamp: 0,
    sessionKeys: null,
    outboundEncSeq: 0,
    lastSeen: Date.now(),
    consecutiveBackpressuredSends: 0,
    backpressureStartedAt: 0,
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
    existing.duplicateClosing = true;
  }
  session.runtimeId = runtimeId;
  session.handshakeDone = true;
  session.lastSeen = Date.now();
  context.sessionsByRuntime.set(runtimeId, session);
  if (existing && existing.ws !== session.ws) {
    existing.ws.close(4009, 'session-replaced');
  }
  return true;
};

const sendRecoveryBundleResponse = (
  context: DirectRuntimeWsContext,
  session: DirectWsSession,
  toRuntimeId: string,
  requestId: string | undefined,
  body: { payload: unknown } | { error: string },
): void => sendSession(context, session, {
  type: 'recovery_bundle_response',
  id: makeMessageId(),
  from: context.serverRuntimeId,
  fromEncryptionPubKey: pubKeyToHex(context.keyPair.publicKey),
  to: toRuntimeId,
  timestamp: Date.now(),
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

// Bun's ServerWebSocket.send() reports 0 ("dropped") both when the peer is
// truly gone and when an otherwise-healthy socket hits a transient
// backpressure/queue-full condition while readyState still reads OPEN
// (github.com/oven-sh/bun#9368). Forgetting the session on every dropped
// send orphans a live client: its next authenticated frame lands on the
// same still-open socket, finds no session, and gets bounced as
// "Handshake required" even though it never saw a close/error and has no
// reason to re-send hello. Only forget once the transport itself confirms
// the socket is no longer open; a live socket's failed send is retryable.
const forgetIfDisconnected = (context: DirectRuntimeWsContext, ws: DirectWebSocket): void => {
  if (!isSocketOpen(ws)) forgetSession(context, ws);
};

const STUCK_BACKPRESSURE_THRESHOLD = 4;
export const DIRECT_STUCK_BACKPRESSURE_MS = 10_000;

const resetBackpressure = (session: DirectWsSession): void => {
  session.consecutiveBackpressuredSends = 0;
  session.backpressureStartedAt = 0;
};

const noteSendOutcome = (
  context: DirectRuntimeWsContext,
  session: DirectWsSession,
  attempt: DirectSendAttempt,
): void => {
  if (!attempt.sent || !attempt.backpressured) {
    if (attempt.sent) resetBackpressure(session);
    return;
  }
  const now = Date.now();
  session.consecutiveBackpressuredSends += 1;
  if (session.backpressureStartedAt === 0) session.backpressureStartedAt = now;
  directWsLog.info('entity_inputs.backpressured', {
    runtimeId: session.runtimeId,
    consecutive: session.consecutiveBackpressuredSends,
    ageMs: now - session.backpressureStartedAt,
    bufferedAmount: session.ws.getBufferedAmount?.() ?? null,
  });
  if (
    session.consecutiveBackpressuredSends < STUCK_BACKPRESSURE_THRESHOLD ||
    now - session.backpressureStartedAt < DIRECT_STUCK_BACKPRESSURE_MS
  ) return;
  resetBackpressure(session);
  directWsLog.warn('entity_inputs.stuck_backpressure_closed', {
    runtimeId: session.runtimeId,
    bufferedAmount: session.ws.getBufferedAmount?.() ?? null,
  });
  session.ws.close(4010, 'stuck-backpressure');
  forgetSession(context, session.ws);
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
    'ROUTE_DIRECT_MISS_FAILOVER',
  );
  if (!('session' in target)) return target;
  const peerKey = normalizeEncryptionPubKey(target.session.peerEncryptionPubKey);
  if (!peerKey) return deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_TARGET_KEY_MISSING' });
  let msg: RuntimeWsMessage;
  try {
    const sessionKeys = target.session.sessionKeys;
    const encSeq = sessionKeys ? ++target.session.outboundEncSeq : undefined;
    msg = {
      type: 'entity_inputs',
      id: makeMessageId(),
      from: context.serverRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(context.keyPair.publicKey),
      to: target.targetKey,
      timestamp: typeof ingressTimestamp === 'number' && Number.isFinite(ingressTimestamp)
        ? ingressTimestamp
        : Date.now(),
      payload: sessionKeys && encSeq !== undefined
        ? encryptSessionJSON(envelope, sessionKeys.s2c, encSeq)
        : encryptJSON(envelope, hexToPubKey(peerKey)),
      ...(encSeq !== undefined ? { encSeq } : {}),
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
  const attempt = trySend(target.session.ws, signSessionFrame(context, target.session, msg));
  if (!attempt.sent) forgetIfDisconnected(context, target.session.ws);
  noteSendOutcome(context, target.session, attempt);
  directWsLog.debug('entity_inputs.send_attempt', {
    id: msg.id,
    to: targetRuntimeId,
    encSeq: msg.encSeq ?? null,
    entities: envelope.entityInputs.length,
    sent: attempt.sent,
    backpressured: attempt.sent ? attempt.backpressured : false,
  });
  return resultFromSendAttempt(attempt, 'ROUTE_DIRECT_DELIVERED', 'ROUTE_DIRECT_SEND_FAILED');
};


const handleHandshake = (
  context: DirectRuntimeWsContext,
  ws: DirectWebSocket,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
): boolean => {
  if (session.handshakeDone) return false;
  if (msg.type !== 'hello' || typeof msg.from !== 'string') {
    send(ws, {
      type: 'error',
      error: `Handshake required: send hello with runtimeId (got type=${String(msg.type || 'missing')})`,
    });
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
  const binding = context.helloChallenges.consume(ws, {
    challenge: msg.auth?.nonce,
    audience: msg.audience,
  });
  const peerSessionPubKey = msg.sessionPubKey === undefined ? undefined : normalizeEncryptionPubKey(msg.sessionPubKey);
  if (peerSessionPubKey === null) {
    send(ws, { type: 'error', error: 'Invalid sessionPubKey' });
    ws.close();
    return true;
  }
  const authError = binding
    ? verifyHelloAuth(
        normalizedFrom,
        peerKey,
        msg.auth,
        context.options.helloSkewMs ?? DEFAULT_HELLO_SKEW_MS,
        binding.audience,
        peerSessionPubKey,
      )
    : 'Hello challenge missing, expired, or already consumed';
  if (authError) {
    send(ws, { type: 'error', error: authError });
    ws.close();
    return true;
  }
  session.authAudience = binding!.audience;
  session.authNonce = binding!.challenge;
  session.lastAuthTimestamp = 0;
  session.outboundAuthTimestamp = 0;
  session.outboundEncSeq = 0;
  session.peerEncryptionPubKey = peerKey;
  session.sessionKeys = null;
  let ackSessionPubKey: string | undefined;
  if (peerSessionPubKey) {
    // Peer offered an ephemeral key bound by its hello signature: answer with
    // our own (bound by the signed hello_ack) and switch the session to
    // HKDF-derived direction keys (HMAC frames, counter-nonce AEAD payloads).
    const ephemeral = generateEphemeralKeyPair();
    session.sessionKeys = deriveRuntimeWsSessionKeys(
      x25519SharedSecret(ephemeral.privateKey, hexToPubKey(peerSessionPubKey)),
      binding!.challenge,
      binding!.audience,
    );
    ackSessionPubKey = pubKeyToHex(ephemeral.publicKey);
  }
  if (!rememberRuntimeSession(context, session, normalizedFrom)) {
    session.duplicateClosing = true;
    ws.close(4009, 'duplicate-runtime');
    return true;
  }
  sendSession(context, session, {
    type: 'hello_ack',
    from: context.serverRuntimeId,
    fromEncryptionPubKey: pubKeyToHex(context.keyPair.publicKey),
    to: normalizedFrom,
    ...(ackSessionPubKey ? { sessionPubKey: ackSessionPubKey } : {}),
  });
  return true;
};

const sessionRuntimeId = (session: DirectWsSession): string =>
  normalizeRuntimeId(session.runtimeId || '');

const rejectDirectMessage = (
  context: DirectRuntimeWsContext,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
  error: string,
): void => {
  const to = sessionRuntimeId(session);
  sendSession(context, session, {
    type: 'error',
    id: makeMessageId(),
    error,
    ...(msg.id ? { inReplyTo: msg.id } : {}),
    ...(to ? { to } : {}),
  });
};

const validateMessageRoute = (
  context: DirectRuntimeWsContext,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
  prefix: string,
): string | null => {
  const fromRuntimeId = sessionRuntimeId(session);
  if (!fromRuntimeId) {
    rejectDirectMessage(context, session, msg, 'Missing source runtimeId');
    return null;
  }
  if (msg.from && normalizeRuntimeId(msg.from) !== fromRuntimeId) {
    rejectDirectMessage(context, session, msg, `${prefix} source runtimeId mismatch`);
    return null;
  }
  if (normalizeRuntimeId(msg.to || '') !== context.serverRuntimeId) {
    rejectDirectMessage(context, session, msg, `${prefix} target runtimeId mismatch`);
    return null;
  }
  return fromRuntimeId;
};

const handleRecoveryRequest = async (
  context: DirectRuntimeWsContext,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
): Promise<boolean> => {
  if (msg.type !== 'recovery_bundle_request') return false;
  const fromRuntimeId = sessionRuntimeId(session);
  if (!fromRuntimeId) {
    sendSession(context, session, { type: 'error', error: 'Missing source runtimeId' });
    return true;
  }
  const respond = (body: { payload: unknown } | { error: string }): void =>
    sendRecoveryBundleResponse(context, session, fromRuntimeId, msg.id, body);
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


const handleEntityInputs = async (
  context: DirectRuntimeWsContext,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
): Promise<void> => {
  if (msg.type !== 'entity_inputs') {
    rejectDirectMessage(context, session, msg, 'Unsupported direct ws message type');
    return;
  }
  if (normalizeRuntimeId(msg.to || '') !== context.serverRuntimeId) {
    rejectDirectMessage(context, session, msg, 'Direct target runtimeId mismatch');
    return;
  }
  if (!msg.encrypted || typeof msg.payload !== 'string') {
    rejectDirectMessage(context, session, msg, 'Direct entity_inputs must be encrypted');
    return;
  }
  const fromRuntimeId = validateMessageRoute(context, session, msg, 'Direct');
  if (!fromRuntimeId) return;
  try {
    const sessionKeys = session.sessionKeys;
    if (sessionKeys && msg.encSeq === undefined) throw new Error('Direct session entity_inputs must carry encSeq');
    const envelope = decodeRuntimeEntityInputsEnvelope(
      sessionKeys && msg.encSeq !== undefined
        ? decryptSessionJSON(msg.payload, sessionKeys.c2s, msg.encSeq)
        : decryptJSON(msg.payload, context.keyPair.privateKey),
    );
    directWsLog.debug('entity_inputs.received', {
      id: msg.id,
      from: fromRuntimeId,
      encSeq: msg.encSeq ?? null,
      entities: envelope.entityInputs.length,
    });
    await context.options.onEntityInputs(
      fromRuntimeId,
      envelope,
      typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
    );
  } catch (error) {
    directWsLog.warn('entity_inputs.receive_failed', {
      id: msg.id,
      from: fromRuntimeId,
      encSeq: msg.encSeq ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    rejectDirectMessage(
      context,
      session,
      msg,
      `Direct delivery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const handleDirectMessage = async (
  context: DirectRuntimeWsContext,
  ws: DirectWebSocket,
  raw: string | Buffer | ArrayBuffer,
): Promise<void> => {
  const session = ensureSession(context, ws);
  if (session.duplicateClosing) {
    directWsLog.warn('wire_message.rejected_replaced_session', {
      runtimeId: session.runtimeId,
      bytes: typeof raw === 'string' ? raw.length : raw.byteLength,
    });
    return;
  }
  let msg: RuntimeWsMessage;
  try {
    msg = deserializeWsMessage(raw);
  } catch (error) {
    directWsLog.warn('wire_message.deserialize_failed', {
      bytes: typeof raw === 'string' ? raw.length : raw.byteLength,
      error: error instanceof Error ? error.message : String(error),
    });
    send(ws, { type: 'error', error: `Invalid wire message: ${(error as Error).message}` });
    return;
  }
  if (handleHandshake(context, ws, session, msg)) return;
  const peerKey = normalizeEncryptionPubKey(msg.fromEncryptionPubKey);
  const verifiedError = peerKey !== session.peerEncryptionPubKey
    ? 'Direct session encryption key mismatch'
    : verifyRuntimeWsFrameAuth(
        sessionRuntimeId(session),
        msg,
        msg.auth,
        session.authAudience || '',
        session.authNonce || '',
        session.lastAuthTimestamp,
        session.sessionKeys?.c2s,
      );
  if (verifiedError) {
    rejectDirectMessage(context, session, msg, verifiedError);
    ws.close(4003, 'session-auth-invalid');
    return;
  }
  session.lastAuthTimestamp = msg.auth!.timestamp;
  if (msg.type === 'ping') {
    session.lastSeen = Date.now();
    sendSession(context, session, { type: 'pong', inReplyTo: msg.id || makeMessageId() });
    return;
  }
  if (msg.type === 'hello' || msg.type === 'debug_event') return;
  session.lastSeen = Date.now();
  if (await handleRecoveryRequest(context, session, msg)) return;
  await handleEntityInputs(context, session, msg);
};

export const createDirectRuntimeWsRoute = (options: DirectRuntimeWsOptions) => {
  const serverRuntimeId = normalizeRuntimeId(options.runtimeId);
  if (!serverRuntimeId || !isRuntimeId(serverRuntimeId)) {
    throw new Error(`DIRECT_RUNTIME_WS_INVALID_RUNTIME_ID: ${String(options.runtimeId || '')}`);
  }
  if (deriveSignerAddressSync(options.runtimeSeed, '1').toLowerCase() !== serverRuntimeId) {
    throw new Error('DIRECT_RUNTIME_WS_SIGNING_KEY_MISMATCH');
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
    getSessionState: (): Array<{
      runtimeId: string;
      open: boolean;
      lastSeen: number;
      consecutiveBackpressuredSends: number;
      backpressureAgeMs: number;
      bufferedAmount: number | null;
    }> =>
      Array.from(context.sessionsByRuntime.values())
        .map(session => ({
          runtimeId: session.runtimeId || '',
          open: isSocketOpen(session.ws),
          lastSeen: session.lastSeen,
          consecutiveBackpressuredSends: session.consecutiveBackpressuredSends,
          backpressureAgeMs: session.backpressureStartedAt === 0
            ? 0
            : Math.max(0, Date.now() - session.backpressureStartedAt),
          bufferedAmount: session.ws.getBufferedAmount?.() ?? null,
        }))
        .filter(session => session.runtimeId.length > 0)
        .sort((left, right) => compareCanonicalText(left.runtimeId, right.runtimeId)),
    sendEntityInputsDelivery: (
      targetRuntimeId: string,
      envelope: RuntimeEntityInputsEnvelope,
      ingressTimestamp?: number,
    ): DeliveryResult => sendEntityInputsDelivery(context, targetRuntimeId, envelope, ingressTimestamp),
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
      maxPayloadLength: resolveRuntimeWsMaxMessageBytes(),
      open(ws: DirectWebSocket): void {
        ensureSession(context, ws);
        context.helloChallenges.issue(ws, directRuntimeWsAudience(context.serverRuntimeId));
      },
      message: (ws: DirectWebSocket, raw: string | Buffer | ArrayBuffer): Promise<void> =>
        handleDirectMessage(context, ws, raw),
      drain(ws: DirectWebSocket): void {
        const session = context.sessions.get(ws);
        if (session) resetBackpressure(session);
      },
      close(ws: DirectWebSocket): void {
        forgetSession(context, ws);
      },
    },
  };
};
