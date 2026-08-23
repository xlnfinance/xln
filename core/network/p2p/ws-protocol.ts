/**
 * XLN WebSocket Protocol
 *
 * SECURITY MODEL: P2P layer is a "dumb pipe" - transport only.
 *
 * Transport rejects replayed or reordered signed frames within each WebSocket
 * session. Account/Entity consensus still owns semantic transaction replay via
 * committed frame heights; the transport fence only prevents socket injection.
 *
 * Hello auth proves runtimeId ownership and binds the advertised encryption key
 * to a server-issued, single-use challenge. This prevents a recorded hello from
 * claiming a later socket or replacing the transport key after disconnect.
 *
 * Message IDs and nonces are for correlation/debugging, not cryptographic security.
 */

import { serializeTaggedJson } from '../../protocol/serialization';
import { keccak256, toUtf8Bytes } from 'ethers';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hmacSha256 } from '../../protocol/crypto/fast/fast-sha256';
import {
  decodeValidatedBinaryPayload,
  encodeBinaryPayload,
  packPreorderedBinaryPayload,
} from '../../protocol/serialization/binary-codec';
import type { Codec } from '../../protocol/serialization/codec';
import { LIMITS } from '../../config/constants';
import { XLN_PROTOCOL_VERSION, type XlnProtocolVersion } from '../../protocol/version';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';

/**
 * One encrypted 10 MB frame expands to ~13.4 MB in base64. Atomic cross-j
 * delivery must keep two Account legs in one authenticated envelope, so the
 * shared direct/relay receiver cap needs room for both plus protocol metadata.
 */
export const DEFAULT_MAX_WS_MESSAGE_BYTES = LIMITS.MAX_RUNTIME_WS_MESSAGE_BYTES;
const WS_STRING_FIELD_MAX_BYTES: Readonly<Record<string, number>> = {
  id: 128,
  from: 128,
  fromEncryptionPubKey: 256,
  to: 128,
  entityId: 128,
  challenge: 128,
  audience: 512,
  inReplyTo: 128,
  nonce: 128,
  signature: 256,
  mac: 128,
  sessionPubKey: 66,
  error: 4 * 1024,
};
const utf8Encoder = new TextEncoder();

/**
 * Transport is intentionally best-effort. Do not add entity-input delivery
 * receipts or rejections here: bilateral Account ACK is the financial
 * completion protocol. A second acknowledgement layer creates conflicting
 * liveness state and must never prune Runtime outbox.
 */
type RuntimeWsMessageType =
  | 'hello'
  | 'hello_challenge'
  | 'hello_ack'
  | 'entity_inputs'
  | 'debug_event'
  | 'gossip_request'
  | 'gossip_response'
  | 'gossip_announce'
  | 'gossip_update'
  | 'recovery_bundle_request'
  | 'recovery_bundle_response'
  | 'error'
  | 'ping'
  | 'pong';

export type RuntimeWsAuth = {
  nonce: string;
  /** Runtime-key ECDSA over the frame digest (hello, hello_ack, non-session frames). */
  signature?: string;
  /** HMAC-SHA256 under the per-session direction key (frames after a session handshake). */
  mac?: string;
  timestamp: number;
};

export type RuntimeWsMessage = {
  type: RuntimeWsMessageType;
  id?: string;
  from?: string;
  fromEncryptionPubKey?: string;
  to?: string;
  timestamp?: number;
  payload?: unknown;
  encrypted?: boolean;        // If true, payload is ciphertext bytes
  entityId?: string;
  txs?: number;
  auth?: RuntimeWsAuth;
  challenge?: string;
  audience?: string;
  inReplyTo?: string;
  error?: string;
  /** Ephemeral X25519 public key (hex) offered in hello / hello_ack for session keys. */
  sessionPubKey?: string;
  /** Present when `payload` is sealed under the session key; the encryption nonce counter. */
  encSeq?: number;
};

export type RuntimeWsEnvelope = RuntimeWsMessage & {
  v: XlnProtocolVersion;
};

const requiredFields = (
  message: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void => requireExactBoundaryKeys(
  message,
  ['v', 'type', ...required],
  optional.includes('auth') ? optional : [...optional, 'auth'],
  `WS_MESSAGE_FIELDS_INVALID:type=${String(message['type'] || 'missing')}`,
);

const requireStringFields = (
  message: Record<string, unknown>,
  fields: readonly string[],
): void => {
  for (const field of fields) {
    const value = message[field];
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`WS_MESSAGE_FIELD_TYPE_INVALID:field=${field}`);
    }
    const maxBytes = WS_STRING_FIELD_MAX_BYTES[field];
    if (typeof value === 'string' && maxBytes !== undefined) {
      if (value.length * 4 <= maxBytes) continue;
      const bytes = utf8Encoder.encode(value).byteLength;
      if (bytes > maxBytes) {
        throw new Error(`WS_MESSAGE_FIELD_TOO_LONG:field=${field}:bytes=${bytes}:max=${maxBytes}`);
      }
    }
  }
};

const validateWsAuth = (value: unknown): void => {
  if (value === undefined) return;
  const auth = requireBoundaryRecord(value, 'WS_MESSAGE_AUTH_INVALID');
  requireExactBoundaryKeys(auth, ['nonce', 'timestamp'], ['signature', 'mac'], 'WS_MESSAGE_AUTH_FIELDS_INVALID');
  if ((auth['signature'] === undefined) === (auth['mac'] === undefined)) {
    throw new Error('WS_MESSAGE_AUTH_FIELDS_INVALID:signature-xor-mac');
  }
  requireStringFields(auth, ['nonce', 'signature', 'mac']);
  requireBoundaryInteger(auth['timestamp'], 'WS_MESSAGE_AUTH_TIMESTAMP_INVALID');
};

const validateRuntimeWsEnvelope = (value: unknown): RuntimeWsEnvelope => {
  const message = requireBoundaryRecord(value, 'WS_MESSAGE_OBJECT_INVALID');
  if (message['v'] !== XLN_PROTOCOL_VERSION) {
    throw new Error(`WS_MESSAGE_VERSION_INVALID:${String(message['v'] ?? 'missing')}`);
  }
  const type = message['type'];
  if (typeof type !== 'string' || !RUNTIME_WS_MESSAGE_TYPES.has(type as RuntimeWsMessageType)) {
    throw new Error(`WS_MESSAGE_TYPE_INVALID:${String(type)}`);
  }

  switch (type as RuntimeWsMessageType) {
    case 'hello':
      requiredFields(message, ['from', 'fromEncryptionPubKey', 'timestamp'], ['auth', 'audience', 'sessionPubKey']);
      validateWsAuth(message['auth']);
      break;
    case 'hello_challenge':
      requiredFields(message, ['challenge', 'audience'], []);
      break;
    case 'hello_ack':
      requiredFields(message, ['to'], ['from', 'fromEncryptionPubKey', 'sessionPubKey']);
      break;
    case 'entity_inputs':
      requiredFields(
        message,
        ['id', 'from', 'to', 'payload', 'encrypted'],
        ['fromEncryptionPubKey', 'timestamp', 'entityId', 'txs', 'encSeq'],
      );
      if (typeof message['encrypted'] !== 'boolean' || !(message['payload'] instanceof Uint8Array)) {
        throw new Error('WS_MESSAGE_ENTITY_INPUTS_ENCRYPTION_INVALID');
      }
      if (message['encSeq'] !== undefined) requireBoundaryInteger(message['encSeq'], 'WS_MESSAGE_ENC_SEQ_INVALID');
      break;
    case 'gossip_request':
    case 'gossip_response':
    case 'gossip_announce':
    case 'gossip_update':
      requiredFields(message, ['from', 'payload'], ['id', 'fromEncryptionPubKey', 'to', 'timestamp', 'inReplyTo']);
      break;
    case 'recovery_bundle_request':
      requiredFields(message, ['from', 'to', 'payload'], ['id', 'fromEncryptionPubKey', 'timestamp']);
      break;
    case 'recovery_bundle_response': {
      const hasPayload = Object.hasOwn(message, 'payload');
      const hasError = Object.hasOwn(message, 'error');
      if (hasPayload === hasError) throw new Error('WS_MESSAGE_RECOVERY_RESULT_INVALID');
      requiredFields(
        message,
        ['from', 'to', hasPayload ? 'payload' : 'error'],
        ['id', 'fromEncryptionPubKey', 'timestamp', 'inReplyTo'],
      );
      break;
    }
    case 'debug_event':
      requiredFields(message, ['payload'], ['id', 'from', 'fromEncryptionPubKey', 'to', 'timestamp']);
      break;
    case 'error':
      requiredFields(message, ['error'], ['id', 'from', 'fromEncryptionPubKey', 'to', 'timestamp', 'inReplyTo']);
      break;
    case 'ping':
      requiredFields(message, [], ['id', 'from', 'fromEncryptionPubKey', 'to', 'timestamp']);
      break;
    case 'pong':
      requiredFields(message, [], ['id', 'from', 'fromEncryptionPubKey', 'to', 'timestamp', 'inReplyTo']);
      break;
  }

  requireStringFields(message, [
    'id',
    'from',
    'fromEncryptionPubKey',
    'to',
    'entityId',
    'challenge',
    'audience',
    'inReplyTo',
    'error',
    'sessionPubKey',
  ]);
  if (message['timestamp'] !== undefined) {
    requireBoundaryInteger(message['timestamp'], 'WS_MESSAGE_TIMESTAMP_INVALID');
  }
  if (message['txs'] !== undefined) requireBoundaryInteger(message['txs'], 'WS_MESSAGE_TXS_INVALID');
  if (message['encrypted'] !== undefined && typeof message['encrypted'] !== 'boolean') {
    throw new Error('WS_MESSAGE_ENCRYPTED_INVALID');
  }
  validateWsAuth(message['auth']);
  return message as RuntimeWsEnvelope;
};

const stripRuntimeWsEnvelope = (envelope: RuntimeWsEnvelope): RuntimeWsMessage => {
  const { v: _version, ...message } = envelope;
  return message;
};

const RUNTIME_WS_MESSAGE_TYPES = new Set<RuntimeWsMessageType>([
  'hello',
  'hello_challenge',
  'hello_ack',
  'entity_inputs',
  'debug_event',
  'gossip_request',
  'gossip_response',
  'gossip_announce',
  'gossip_update',
  'recovery_bundle_request',
  'recovery_bundle_response',
  'error',
  'ping',
  'pong',
]);

const wsMessageByteLength = (raw: string | Buffer | Uint8Array | ArrayBuffer): number => {
  if (typeof raw === 'string') return new TextEncoder().encode(raw).byteLength;
  return raw.byteLength;
};

export const toRuntimeWsBytes = (raw: string | Buffer | Uint8Array | ArrayBuffer): Uint8Array => {
  if (typeof raw === 'string') throw new Error('WS_WIRE_BINARY_REQUIRED');
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return raw;
  return new Uint8Array(raw);
};

let cachedWsMaxMessageEnv: string | undefined;
let cachedWsMaxMessageBytes: number | undefined;

export const resolveRuntimeWsMaxMessageBytes = (): number => {
  const configured = typeof process === 'undefined' ? undefined : process.env['XLN_WS_MAX_MESSAGE_BYTES'];
  if (cachedWsMaxMessageBytes !== undefined && cachedWsMaxMessageEnv === configured) {
    return cachedWsMaxMessageBytes;
  }
  const parsed = Number(configured);
  cachedWsMaxMessageEnv = configured;
  cachedWsMaxMessageBytes = Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_WS_MESSAGE_BYTES;
  return cachedWsMaxMessageBytes;
};

const assertRuntimeWsMessagePack = (bytes: Uint8Array): void => {
  const magic = bytes[0];
  if (magic !== 0x01) throw new Error(`WS_WIRE_MESSAGEPACK_REQUIRED:magic=${magic ?? 'none'}`);
};

const runtimeWsEnvelopeCodec: Codec<RuntimeWsEnvelope> = {
  encode: (envelope) => encodeBinaryPayload(validateRuntimeWsEnvelope(envelope), 'msgpack'),
  decode: (bytes) => {
    assertRuntimeWsMessagePack(bytes);
    return decodeValidatedBinaryPayload(bytes, validateRuntimeWsEnvelope);
  },
};

const buildRuntimeWsEnvelope = (message: RuntimeWsMessage): RuntimeWsEnvelope => ({
  ...message,
  v: XLN_PROTOCOL_VERSION,
});

/**
 * Name what actually filled an oversized envelope.
 *
 * The size limit is enforced by the receiver, so a producer that builds a
 * message past it learns nothing: the bytes leave, the peer refuses them, and
 * the sender sees a transport error with no attribution. Encoding each payload
 * element on its own costs nothing on the failure path and turns "1.3MB
 * arrived" into "element 7 of 60 is 40KB".
 */
const oversizedWsPayloadCensus = (payload: unknown): string => {
  const encodedSize = (value: unknown): number => {
    try {
      return encodeBinaryPayload(value as never, 'msgpack').byteLength;
    } catch {
      return -1;
    }
  };
  if (Array.isArray(payload)) {
    const sizes = payload.map(encodedSize);
    const ranked = sizes
      .map((bytes, index) => ({ index, bytes }))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 5);
    return `array elements=${payload.length} ` +
      `largest=${ranked.map(entry => `[${entry.index}]=${entry.bytes}`).join(',')}`;
  }
  if (payload && typeof payload === 'object') {
    const ranked = Object.entries(payload as Record<string, unknown>)
      .map(([key, value]) => ({ key, bytes: encodedSize(value) }))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 5);
    return `object keys=${Object.keys(payload as object).length} ` +
      `largest=${ranked.map(entry => `${entry.key}=${entry.bytes}`).join(',')}`;
  }
  return `scalar bytes=${encodedSize(payload)}`;
};

export const serializeWsMessage = (msg: RuntimeWsMessage): Uint8Array => {
  const encoded = runtimeWsEnvelopeCodec.encode(buildRuntimeWsEnvelope(msg));
  const maxBytes = resolveRuntimeWsMaxMessageBytes();
  if (encoded.byteLength > maxBytes) {
    throw new Error(
      `WS_MESSAGE_TOO_LARGE_TO_SEND:bytes=${encoded.byteLength}:max=${maxBytes}` +
      `:type=${msg.type}:entityId=${msg.entityId ?? 'none'}` +
      `:payload=${oversizedWsPayloadCensus(msg.payload)}`,
    );
  }
  return encoded;
};

export const serializeWsMessageForDebug = (msg: RuntimeWsMessage): string =>
  serializeTaggedJson(buildRuntimeWsEnvelope(msg));

export const deserializeWsMessage = (
  raw: string | Buffer | Uint8Array | ArrayBuffer,
): RuntimeWsMessage => {
  const byteLength = wsMessageByteLength(raw);
  const maxBytes = resolveRuntimeWsMaxMessageBytes();
  if (byteLength > maxBytes) throw new Error(`WS_MESSAGE_TOO_LARGE:bytes=${byteLength}:max=${maxBytes}`);
  if (typeof raw === 'string') throw new Error('WS_WIRE_BINARY_REQUIRED');
  const bytes = toRuntimeWsBytes(raw);
  return stripRuntimeWsEnvelope(runtimeWsEnvelopeCodec.decode(bytes));
};

let messageCounter = 0;

export const makeMessageId = (): string => {
  const id = messageCounter;
  messageCounter += 1;
  return `msg_${id}`;
};

const HELLO_DOMAIN = `xln-ws-hello:v${XLN_PROTOCOL_VERSION}`;
const FRAME_DOMAIN = `xln-ws-frame:v${XLN_PROTOCOL_VERSION}`;

export const canonicalizeRuntimeWsAudience = (input: string): string => {
  const parsed = new URL(input);
  const protocol = parsed.protocol === 'http:' ? 'ws:' : parsed.protocol === 'https:' ? 'wss:' : parsed.protocol;
  if (protocol !== 'ws:' && protocol !== 'wss:') {
    throw new Error(`WS_AUDIENCE_PROTOCOL_INVALID:${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) throw new Error('WS_AUDIENCE_CREDENTIALS_FORBIDDEN');
  const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname || '/';
  return `${protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
};

export const resolveRuntimeWsRelayAudience = (
  requestUrl: string,
  internalUrl: string,
  publicUrl?: string | null,
): string | null => {
  const requestAudience = canonicalizeRuntimeWsAudience(requestUrl);
  if (publicUrl) return canonicalizeRuntimeWsAudience(publicUrl);
  const internalAudience = canonicalizeRuntimeWsAudience(internalUrl);
  return requestAudience === internalAudience ? internalAudience : null;
};

export const directRuntimeWsAudience = (runtimeId: string): string =>
  `xln-runtime:${runtimeId.toLowerCase()}`;

const buildHelloMessage = (
  runtimeId: string,
  encryptionPubKey: string,
  timestamp: number,
  nonce: string,
  audience: string,
  sessionPubKey?: string,
): string => {
  const base = `${HELLO_DOMAIN}:${audience}:${runtimeId}:${encryptionPubKey.toLowerCase()}:${timestamp}:${nonce}`;
  // The ephemeral session key is bound by the runtime signature so a proxy
  // cannot substitute its own and derive the session MAC/cipher keys.
  return sessionPubKey ? `${base}:session:${sessionPubKey.toLowerCase()}` : base;
};

export const hashHelloMessage = (
  runtimeId: string,
  encryptionPubKey: string,
  timestamp: number,
  nonce: string,
  audience: string,
  sessionPubKey?: string,
): string => keccak256(toUtf8Bytes(buildHelloMessage(runtimeId, encryptionPubKey, timestamp, nonce, audience, sessionPubKey)));

const SESSION_INFO = `xln-ws-session:v${XLN_PROTOCOL_VERSION}`;

export type RuntimeWsSessionKeys = { c2s: Uint8Array; s2c: Uint8Array };

/**
 * Per-session direction keys from the two hello-bound ephemeral X25519 keys.
 * The single-use hello challenge salts the derivation; the endpoint audience
 * lands in the info string so a key never authenticates a different endpoint.
 */
export const deriveRuntimeWsSessionKeys = (
  sharedSecret: Uint8Array,
  challenge: string,
  audience: string,
): RuntimeWsSessionKeys => {
  const salt = toUtf8Bytes(challenge);
  return {
    c2s: hkdf(sha256, sharedSecret, salt, toUtf8Bytes(`${SESSION_INFO}:${audience}:c2s`), 32),
    s2c: hkdf(sha256, sharedSecret, salt, toUtf8Bytes(`${SESSION_INFO}:${audience}:s2c`), 32),
  };
};

const frameAuthPreimage = (
  message: RuntimeWsMessage,
  audience: string,
  nonce: string,
  authTimestamp: number,
): Uint8Array => {
  const { auth: _auth, ...unsigned } = message;
  // The frame itself is MessagePack. Authenticate the same binary value
  // directly instead of canonical-JSON encoding every ciphertext to base64
  // and then sending that ciphertext as MessagePack a second time.
  const flat = flatSortedFrame(unsigned);
  if (flat) {
    // Same bytes as the canonical walk for a flat frame (scalars and raw
    // ciphertext only), without cloning the multi-kilobyte payload per MAC.
    return packPreorderedBinaryPayload([FRAME_DOMAIN, audience, nonce, authTimestamp, flat]);
  }
  return encodeBinaryPayload(
    [FRAME_DOMAIN, audience, nonce, authTimestamp, unsigned],
    'msgpack',
  );
};

/** Sorted-key copy of a frame whose values are all scalars or bytes; null when nested. */
const flatSortedFrame = (frame: Record<string, unknown>): Record<string, unknown> | null => {
  if (Object.getPrototypeOf(frame) !== Object.prototype) return null;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(frame).sort()) {
    const value = frame[key];
    if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) return null;
    output[key] = value;
  }
  return output;
};

/** Session-key frame authenticator: same preimage as the signed digest, HMAC instead of ECDSA. */
export const macRuntimeWsFrame = (
  key: Uint8Array,
  message: RuntimeWsMessage,
  audience: string,
  nonce: string,
  authTimestamp: number,
): string => bytesToHex(hmacSha256(key, frameAuthPreimage(message, audience, nonce, authTimestamp)));

export const runtimeWsMacEquals = (left: string, right: string): boolean => {
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
};

export const hashRuntimeWsFrame = (
  message: RuntimeWsMessage,
  audience: string,
  nonce: string,
  authTimestamp: number,
): string =>
  // A signed hello alone is insufficient: a transparent proxy can forward the
  // handshake and then inject a different application request. Bind every
  // client frame to the single-use hello nonce and exact endpoint audience.
  keccak256(frameAuthPreimage(message, audience, nonce, authTimestamp));
