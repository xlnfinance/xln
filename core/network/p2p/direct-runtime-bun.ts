import type { RuntimeEntityInputsEnvelope } from '../../runtime/types';
import { accountInputProposal } from '../../account/consensus/flush';
import {
  deliveryAccepted,
  deliveryFailure,
  type DeliveryResult,
} from '../../protocol/payments/delivery-result';
import { compareCanonicalText } from '../../orderbook/swap-keys';
import {
  decryptPayload,
  decryptSessionPayload,
  deriveEncryptionKeyPair,
  encryptPayload,
  encryptSessionPayload,
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
import { countOp, OP_COUNTERS_ENABLED, recordOpEvent } from '../../support/performance/op-counters';
import { getPerfMs } from '../../support/time';
import { isRuntimeId, normalizeRuntimeId } from './auth/runtime-id';
import { verifyHelloAuth, verifyRuntimeWsFrameAuth } from './auth/hello-auth';
import { createHelloChallengeRegistry } from './auth/hello-challenge';
import { decodeRuntimeEntityInputsEnvelope } from './auth/entity-input-envelope';
import {
  classifyWebSocketSendResult,
  type WebSocketSendResult,
} from '../websocket-send-result';
import { createStructuredLogger } from '../../support/logger';
import { traceAccountDeliveryHop } from '../../support/performance/account-delivery-trace';

const directWsLog = createStructuredLogger('network.direct_ws');

type DirectRuntimeWsOptions = {
  runtimeId: string;
  runtimeSeed: Uint8Array | string;
  path?: string;
  helloSkewMs?: number;
  onEntityInputs: (
    from: string,
    envelope: RuntimeEntityInputsEnvelope,
    timestamp?: number,
    sessionAuthenticated?: boolean,
  ) => Promise<void> | void;
  /** Signs an envelope for a session without keys; keyed sessions send unsigned. */
  signEnvelope?: (to: string, envelope: RuntimeEntityInputsEnvelope) => RuntimeEntityInputsEnvelope;
  /**
   * Negative delivery signal only. There are deliberately no positive
   * transport receipts and no retries: the owning Runtime must halt and dump
   * the rejected committed Account envelope for operator investigation.
   */
  onDeliveryFailure?: (failure: Readonly<{
    direction: 'inbound' | 'outbound';
    peerRuntimeId: string;
    messageId: string;
    error: string;
    envelope?: RuntimeEntityInputsEnvelope;
  }>) => void;
  onSessionClose?: (failure: Readonly<{
    peerRuntimeId: string;
    code: number;
    reason: string;
    bufferedAmount: number | null;
  }>) => void;
  onRecoveryBundleRequest?: (from: string, lookupKey: string) => Promise<unknown> | unknown;
};

export const isCleanDirectRuntimeSessionClose = (close: Readonly<{
  code: number;
  bufferedAmount: number | null;
}>): boolean => close.code === 1000 && close.bufferedAmount === 0;

/**
 * A peer going offline is not a protocol contradiction. Account consensus
 * detects missing ACKs and resends from committed state after reconnect. Only
 * bytes still buffered in this process are concrete evidence that a committed
 * envelope was accepted by the transport but did not leave the socket.
 */
export const hasUndeliveredDirectRuntimeSessionBytes = (close: Readonly<{
  bufferedAmount: number | null;
}>): boolean => close.bufferedAmount === null || close.bufferedAmount > 0;

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
   *  for observability; never close, retry, or send the same financial
   *  envelope through a second route after Bun accepted it. */
  consecutiveBackpressuredSends: number;
  backpressureStartedAt: number;
};

export type DirectRuntimeSessionState = Readonly<{
  runtimeId: string;
  open: boolean;
  lastSeen: number;
  consecutiveBackpressuredSends: number;
  backpressureAgeMs: number;
  bufferedAmount: number | null;
}>;

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

const countEntityInputEnvelopeKinds = (
  prefix: string,
  envelope: RuntimeEntityInputsEnvelope,
  route: Readonly<{ fromRuntimeId: string; toRuntimeId: string }>,
): void => {
  let entityTxs = 0;
  let accountInputs = 0;
  let accountFrames = 0;
  let frameAcks = 0;
  let acks = 0;
  let htlcLocks = 0;
  let htlcResolves = 0;
  countOp(`${prefix}.envelopes`);
  for (const input of envelope.entityInputs) {
    countOp(`${prefix}.entityInputs`);
    for (const tx of input.entityTxs ?? []) {
      entityTxs += 1;
      countOp(`${prefix}.entityTx.${tx.type}`);
      if (tx.type !== 'accountInput') continue;
      accountInputs += 1;
      countOp(`${prefix}.accountInput.${tx.data.kind}`);
      if (tx.data.kind === 'frame') accountFrames += 1;
      else if (tx.data.kind === 'frame_ack') frameAcks += 1;
      else if (tx.data.kind === 'ack') acks += 1;
      for (const accountTx of accountInputProposal(tx.data)?.frame.accountTxs ?? []) {
        countOp(`${prefix}.accountTx.${accountTx.type}`);
        if (accountTx.type === 'htlc_lock') htlcLocks += 1;
        else if (accountTx.type === 'htlc_resolve') htlcResolves += 1;
      }
    }
  }
  recordOpEvent(`${prefix}.envelope`, {
    fromRuntimeId: route.fromRuntimeId,
    toRuntimeId: route.toRuntimeId,
    entityInputs: envelope.entityInputs.length,
    entityTxs,
    accountInputs,
    accountFrames,
    frameAcks,
    acks,
    htlcLocks,
    htlcResolves,
  });
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
  const payload = serializeWsMessage(msg);
  countOp(`socket.directServer.out.${msg.type}`, payload.length);
  recordOpEvent('socket.directServer.out.wire', {
    type: msg.type,
    fromRuntimeId: String(msg.from ?? ''),
    toRuntimeId: String(msg.to ?? ''),
    bytes: payload.length,
  });
  ws.send(payload);
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
    const payload = serializeWsMessage(msg);
    countOp(`socket.directServer.out.${msg.type}`, payload.length);
    recordOpEvent('socket.directServer.out.wire', {
      type: msg.type,
      fromRuntimeId: String(msg.from ?? ''),
      toRuntimeId: String(msg.to ?? ''),
      bytes: payload.length,
    });
    result = ws.send(payload);
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
    if (isSocketOpen(existing.ws)) {
      directWsLog.error('session.duplicate_rejected', {
        runtimeId,
        existingBufferedAmount: existing.ws.getBufferedAmount?.() ?? null,
      });
      return false;
    }
    forgetSession(context, existing.ws);
  }
  session.runtimeId = runtimeId;
  session.handshakeDone = true;
  session.lastSeen = Date.now();
  context.sessionsByRuntime.set(runtimeId, session);
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
  return deliveryFailure({
    category: 'Contradiction',
    code: failureCode,
    message: attempt.error ?? 'WebSocket send returned dropped',
    terminal: true,
  });
};

const getDeliverableSession = (
  context: DirectRuntimeWsContext,
  targetRuntimeId: string,
): { targetKey: string; session: DirectWsSession } | DeliveryResult => {
  const targetKey = normalizeRuntimeId(targetRuntimeId);
  if (!targetKey) {
    return deliveryFailure({
      category: 'Contradiction',
      code: 'ROUTE_DIRECT_TARGET_RUNTIME_INVALID',
      message: `Invalid target Runtime id: ${targetRuntimeId}`,
      terminal: true,
    });
  }
  const session = context.sessionsByRuntime.get(targetKey);
  if (!session || !session.handshakeDone || !isSocketOpen(session.ws)) {
    if (session && !isSocketOpen(session.ws)) forgetSession(context, session.ws);
    return deliveryFailure({
      category: 'Contradiction',
      code: 'ROUTE_DIRECT_SESSION_MISSING',
      message: `No open authenticated direct session for Runtime ${targetKey}`,
      terminal: true,
    });
  }
  return { targetKey, session };
};

// Bun's ServerWebSocket.send() reports 0 ("dropped") both when the peer is
// truly gone and when an otherwise-healthy socket hits queue pressure. Keep
// the authenticated session while the socket is open so the failure remains
// explicit; the caller halts with its durable outbox intact. Never retry or
// substitute a second route here.
const forgetIfDisconnected = (context: DirectRuntimeWsContext, ws: DirectWebSocket): void => {
  if (!isSocketOpen(ws)) forgetSession(context, ws);
};

const resetBackpressure = (session: DirectWsSession): void => {
  session.consecutiveBackpressuredSends = 0;
  session.backpressureStartedAt = 0;
};

const noteSendOutcome = (
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
  // Bun -1 means the bytes were queued. Closing this authenticated socket on
  // queue age destroys its accepted FIFO and can strand bilateral ACKs. The
  // drain callback resets telemetry; only an actual send failure is fatal.
};

const sendEntityInputsDelivery = (
  context: DirectRuntimeWsContext,
  targetRuntimeId: string,
  envelope: RuntimeEntityInputsEnvelope,
  ingressTimestamp?: number,
): DeliveryResult => {
  const target = getDeliverableSession(context, targetRuntimeId);
  if (!('session' in target)) return target;
  const peerKey = normalizeEncryptionPubKey(target.session.peerEncryptionPubKey);
  if (!peerKey) {
    return deliveryFailure({
      category: 'Contradiction',
      code: 'ROUTE_DIRECT_SESSION_KEY_MISSING',
      message: `Authenticated direct session has no peer encryption key: ${target.targetKey}`,
      terminal: true,
    });
  }
  let msg: RuntimeWsMessage;
  try {
    countEntityInputEnvelopeKinds('socket.directServer.out', envelope, {
      fromRuntimeId: context.serverRuntimeId,
      toRuntimeId: target.targetKey,
    });
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
        ? encryptSessionPayload(envelope, sessionKeys.s2c, encSeq)
        : encryptPayload(
            envelope.sourceSignature
              ? envelope
              : (() => {
                  const signed = context.options.signEnvelope?.(target.targetKey, envelope);
                  if (!signed?.sourceSignature) throw new Error('DIRECT_UNKEYED_ENVELOPE_UNSIGNED');
                  return signed;
                })(),
            hexToPubKey(peerKey),
          ),
      ...(encSeq !== undefined ? { encSeq } : {}),
      encrypted: true,
      ...(envelope.entityInputs.length === 1 && envelope.entityInputs[0]
        ? { entityId: envelope.entityInputs[0].entityId }
        : {}),
      txs: envelope.entityInputs.reduce((count, input) => count + (input.entityTxs?.length ?? 0), 0),
    };
  } catch (error) {
    return deliveryFailure({
      category: 'Contradiction',
      code: 'ROUTE_DIRECT_SEND_FAILED',
      message: error instanceof Error ? error.message : String(error),
      terminal: true,
    });
  }
  const attempt = trySend(target.session.ws, signSessionFrame(context, target.session, msg));
  if (!attempt.sent) forgetIfDisconnected(context, target.session.ws);
  noteSendOutcome(target.session, attempt);
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
    sendSession(context, session, {
      type: 'error',
      error: `DIRECT_DUPLICATE_RUNTIME_SESSION:${normalizedFrom}`,
    });
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
  if (!msg.encrypted || !(msg.payload instanceof Uint8Array)) {
    rejectDirectMessage(context, session, msg, 'Direct entity_inputs must be encrypted');
    return;
  }
  const fromRuntimeId = validateMessageRoute(context, session, msg, 'Direct');
  if (!fromRuntimeId) return;
  let envelope: RuntimeEntityInputsEnvelope | undefined;
  const sessionKeys = session.sessionKeys;
  try {
    if (sessionKeys && msg.encSeq === undefined) throw new Error('Direct session entity_inputs must carry encSeq');
    const decryptAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    const plaintext = sessionKeys && msg.encSeq !== undefined
      ? decryptSessionPayload(msg.payload, sessionKeys.c2s, msg.encSeq)
      : decryptPayload(msg.payload, context.keyPair.privateKey);
    const decodeAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    envelope = decodeRuntimeEntityInputsEnvelope(plaintext);
    if (OP_COUNTERS_ENABLED) {
      countOp('socket.directServer.in.decrypt', msg.payload.byteLength, Math.round((decodeAt - decryptAt) * 1_000));
      countOp('socket.directServer.in.decodeEnvelope', 0, Math.round((getPerfMs() - decodeAt) * 1_000));
    }
    countEntityInputEnvelopeKinds('socket.directServer.in', envelope, {
      fromRuntimeId,
      toRuntimeId: context.serverRuntimeId,
    });
    directWsLog.debug('entity_inputs.received', {
      id: msg.id,
      from: fromRuntimeId,
      encSeq: msg.encSeq ?? null,
      entities: envelope.entityInputs.length,
    });
    traceAccountDeliveryHop('direct-decoded', envelope, {
      runtimeId: context.serverRuntimeId,
      peerRuntimeId: fromRuntimeId,
      messageId: msg.id,
      encSeq: msg.encSeq ?? null,
    });
    const admitAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    await context.options.onEntityInputs(
      fromRuntimeId,
      envelope,
      typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
      Boolean(sessionKeys && msg.encSeq !== undefined),
    );
    countOp('socket.directServer.in.onEntityInputs', 0, OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - admitAt) * 1_000) : 0);
    traceAccountDeliveryHop('direct-admitted', envelope, {
      runtimeId: context.serverRuntimeId,
      peerRuntimeId: fromRuntimeId,
      messageId: msg.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    directWsLog.warn('entity_inputs.receive_failed', {
      id: msg.id,
      from: fromRuntimeId,
      encSeq: msg.encSeq ?? null,
      error: message,
    });
    context.options.onDeliveryFailure?.({
      direction: 'inbound',
      peerRuntimeId: fromRuntimeId,
      messageId: String(msg.id || ''),
      error: message,
      ...(envelope ? { envelope } : {}),
    });
    rejectDirectMessage(
      context,
      session,
      msg,
      `Direct delivery failed: ${message}`.slice(0, 3_500),
    );
  }
};

const handlePeerDeliveryFailure = (
  context: DirectRuntimeWsContext,
  session: DirectWsSession,
  msg: RuntimeWsMessage,
): boolean => {
  if (msg.type !== 'error' || typeof msg.inReplyTo !== 'string') return false;
  const fromRuntimeId = validateMessageRoute(context, session, msg, 'Direct error');
  if (!fromRuntimeId) return true;
  context.options.onDeliveryFailure?.({
    direction: 'outbound',
    peerRuntimeId: fromRuntimeId,
    messageId: msg.inReplyTo,
    error: String(msg.error || 'Unknown peer delivery failure'),
  });
  return true;
};

const handleDirectMessage = async (
  context: DirectRuntimeWsContext,
  ws: DirectWebSocket,
  raw: string | Buffer | ArrayBuffer,
): Promise<void> => {
  const session = ensureSession(context, ws);
  // A replacement hello may close the old socket while already-authenticated
  // frames are queued in Bun. They remain valid Runtime-authorized input and
  // must be drained through normal replay fences. Returning here used to erase
  // committed Account ACKs without either admission or a negative signal.
  let msg: RuntimeWsMessage;
  const receivedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  try {
    msg = deserializeWsMessage(raw);
    const wireBytes = typeof raw === 'string' ? raw.length : raw.byteLength;
    countOp(`socket.directServer.in.${msg.type}`, wireBytes);
    countOp('socket.directServer.in.deserialize', wireBytes, OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - receivedAt) * 1_000) : 0);
    recordOpEvent('socket.directServer.in.wire', {
      type: msg.type,
      fromRuntimeId: String(msg.from ?? ''),
      toRuntimeId: String(msg.to ?? ''),
      bytes: wireBytes,
    });
  } catch (error) {
    directWsLog.warn('wire_message.deserialize_failed', {
      bytes: typeof raw === 'string' ? raw.length : raw.byteLength,
      error: error instanceof Error ? error.message : String(error),
    });
    send(ws, { type: 'error', error: `Invalid wire message: ${(error as Error).message}` });
    return;
  }
  if (handleHandshake(context, ws, session, msg)) return;
  const verifyAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
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
  countOp('socket.directServer.in.verifyAuth', 0, OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - verifyAt) * 1_000) : 0);
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
  if (handlePeerDeliveryFailure(context, session, msg)) return;
  if (await handleRecoveryRequest(context, session, msg)) return;
  const inputsAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  await handleEntityInputs(context, session, msg);
  countOp('socket.directServer.in.handleEntityInputs', 0, OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - inputsAt) * 1_000) : 0);
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
    hasOpenSession: (runtimeId: string): boolean => {
      const targetRuntimeId = normalizeRuntimeId(runtimeId);
      if (!targetRuntimeId) return false;
      const session = context.sessionsByRuntime.get(targetRuntimeId);
      return Boolean(session?.handshakeDone && isSocketOpen(session.ws));
    },
    getSessionState: (): DirectRuntimeSessionState[] =>
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
      message(ws: DirectWebSocket, raw: string | Buffer | ArrayBuffer): void {
        void handleDirectMessage(context, ws, raw).catch(error => {
          const session = context.sessions.get(ws);
          const message = error instanceof Error ? error.message : String(error);
          directWsLog.error('wire_message.unhandled_failure', {
            runtimeId: session?.runtimeId ?? null,
            bytes: typeof raw === 'string' ? raw.length : raw.byteLength,
            error: message,
          });
          context.options.onDeliveryFailure?.({
            direction: 'inbound',
            peerRuntimeId: sessionRuntimeId(session ?? ensureSession(context, ws)),
            messageId: '',
            error: `DIRECT_UNHANDLED_MESSAGE_FAILURE:${message}`,
          });
          ws.close(1011, 'direct-message-failure');
        });
      },
      drain(ws: DirectWebSocket): void {
        const session = context.sessions.get(ws);
        if (session) resetBackpressure(session);
      },
      close(ws: DirectWebSocket, code = 0, reasonRaw: string | Buffer = ''): void {
        const session = context.sessions.get(ws);
        const runtimeId = session ? sessionRuntimeId(session) : '';
        if (runtimeId) {
          const reason = Buffer.isBuffer(reasonRaw) ? reasonRaw.toString('utf8') : String(reasonRaw || '');
          const close = {
            runtimeId,
            code,
            reason,
            bufferedAmount: ws.getBufferedAmount?.() ?? null,
          };
          const clean = isCleanDirectRuntimeSessionClose(close);
          const undelivered = hasUndeliveredDirectRuntimeSessionBytes(close);
          countOp(`socket.directServer.close.${clean ? 'clean' : 'abnormal'}`);
          directWsLog[clean ? 'info' : undelivered ? 'error' : 'warn']('session.closed', close);
          context.options.onSessionClose?.({
            peerRuntimeId: runtimeId,
            code,
            reason,
            bufferedAmount: close.bufferedAmount,
          });
        }
        forgetSession(context, ws);
      },
    },
  };
};
