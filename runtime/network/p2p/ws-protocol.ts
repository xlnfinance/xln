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
import { decodeValidatedBinaryPayload, encodeBinaryPayload } from '../../storage/codec/binary-codec';
import type { Codec } from '../../protocol/serialization/codec';
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
export const DEFAULT_MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024;
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
  error: 4 * 1024,
};
const utf8Encoder = new TextEncoder();

type RuntimeWsMessageType =
  | 'hello'
  | 'hello_challenge'
  | 'hello_ack'
  | 'entity_inputs'
  | 'entity_input_receipt'
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
  signature: string;
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
  encrypted?: boolean;        // If true, payload is encrypted base64 string
  entityId?: string;
  txs?: number;
  auth?: RuntimeWsAuth;
  challenge?: string;
  audience?: string;
  inReplyTo?: string;
  error?: string;
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
  requireExactBoundaryKeys(auth, ['nonce', 'signature', 'timestamp'], [], 'WS_MESSAGE_AUTH_FIELDS_INVALID');
  requireStringFields(auth, ['nonce', 'signature']);
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
      requiredFields(message, ['from', 'fromEncryptionPubKey', 'timestamp'], ['auth', 'audience']);
      validateWsAuth(message['auth']);
      break;
    case 'hello_challenge':
      requiredFields(message, ['challenge', 'audience'], []);
      break;
    case 'hello_ack':
      requiredFields(message, ['to'], ['from', 'fromEncryptionPubKey']);
      break;
    case 'entity_inputs':
      requiredFields(
        message,
        ['from', 'to', 'payload', 'encrypted'],
        ['id', 'fromEncryptionPubKey', 'timestamp', 'entityId', 'txs'],
      );
      if (typeof message['encrypted'] !== 'boolean' || typeof message['payload'] !== 'string') {
        throw new Error('WS_MESSAGE_ENTITY_INPUTS_ENCRYPTION_INVALID');
      }
      break;
    case 'entity_input_receipt':
      requiredFields(message, ['from', 'to', 'payload'], ['id', 'fromEncryptionPubKey', 'timestamp']);
      requireBoundaryRecord(message['payload'], 'WS_MESSAGE_RECEIPT_INVALID');
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
  'entity_input_receipt',
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

export const resolveRuntimeWsMaxMessageBytes = (): number => {
  const configured = typeof process === 'undefined' ? undefined : process.env['XLN_WS_MAX_MESSAGE_BYTES'];
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_WS_MESSAGE_BYTES;
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
  const bytes = raw instanceof ArrayBuffer
    ? new Uint8Array(raw)
    : raw instanceof Uint8Array
      ? raw
      : new Uint8Array(raw);
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
): string => {
  return `${HELLO_DOMAIN}:${audience}:${runtimeId}:${encryptionPubKey.toLowerCase()}:${timestamp}:${nonce}`;
};

export const hashHelloMessage = (
  runtimeId: string,
  encryptionPubKey: string,
  timestamp: number,
  nonce: string,
  audience: string,
): string => keccak256(toUtf8Bytes(buildHelloMessage(runtimeId, encryptionPubKey, timestamp, nonce, audience)));

export const hashRuntimeWsFrame = (
  message: RuntimeWsMessage,
  audience: string,
  nonce: string,
  authTimestamp: number,
): string => {
  // A signed hello alone is insufficient: a transparent proxy can forward the
  // handshake and then inject a different application request. Bind every
  // client frame to the single-use hello nonce and exact endpoint audience.
  const { auth: _auth, ...unsigned } = message;
  return keccak256(toUtf8Bytes(serializeTaggedJson([FRAME_DOMAIN, audience, nonce, authTimestamp, unsigned])));
};
