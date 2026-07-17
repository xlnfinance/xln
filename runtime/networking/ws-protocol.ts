/**
 * XLN WebSocket Protocol
 *
 * SECURITY MODEL: P2P layer is a "dumb pipe" - transport only.
 *
 * This layer does NOT provide replay protection for messages. That's intentional:
 * - Account consensus layer handles replay protection via frame heights
 * - Each accountFrame has monotonic height - can't replay height=5 after height=6 exists
 * - Entity transactions are signed and verified at consensus layer
 *
 * Hello auth proves runtimeId ownership and binds the advertised encryption key
 * to a server-issued, single-use challenge. This prevents a recorded hello from
 * claiming a later socket or replacing the transport key after disconnect.
 *
 * Message IDs and nonces are for correlation/debugging, not cryptographic security.
 */

import { serializeTaggedJson } from '../protocol/serialization';
import { keccak256, toUtf8Bytes } from 'ethers';
import { decodeValidatedBinaryPayload, encodeBinaryPayload } from '../storage/binary-codec';
import type { Codec } from '../protocol/codec';
import { XLN_PROTOCOL_VERSION, type XlnProtocolVersion } from '../protocol/version';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../protocol/boundary-validation';

const DEFAULT_MAX_WS_MESSAGE_BYTES = 16 * 1024 * 1024;

export type RuntimeWsMessageType =
  | 'hello'
  | 'hello_challenge'
  | 'hello_ack'
  | 'entity_input'
  | 'entity_input_receipt'
  | 'debug_event'
  | 'gossip_request'
  | 'gossip_response'
  | 'gossip_announce'
  | 'gossip_subscribed'
  | 'gossip_subscribe'
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
  optional,
  `WS_MESSAGE_FIELDS_INVALID:type=${String(message['type'] || 'missing')}`,
);

const requireStringFields = (
  message: Record<string, unknown>,
  fields: readonly string[],
): void => {
  for (const field of fields) {
    if (message[field] !== undefined && typeof message[field] !== 'string') {
      throw new Error(`WS_MESSAGE_FIELD_TYPE_INVALID:field=${field}`);
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
      requiredFields(message, ['from', 'fromEncryptionPubKey', 'timestamp'], ['auth']);
      validateWsAuth(message['auth']);
      break;
    case 'hello_challenge':
      requiredFields(message, ['challenge'], []);
      break;
    case 'hello_ack':
      requiredFields(message, ['to'], ['from', 'fromEncryptionPubKey']);
      break;
    case 'entity_input':
      requiredFields(
        message,
        ['from', 'to', 'payload', 'encrypted'],
        ['id', 'fromEncryptionPubKey', 'timestamp', 'entityId', 'txs'],
      );
      if (typeof message['encrypted'] !== 'boolean' || typeof message['payload'] !== 'string') {
        throw new Error('WS_MESSAGE_ENTITY_INPUT_ENCRYPTION_INVALID');
      }
      break;
    case 'entity_input_receipt':
      requiredFields(message, ['from', 'to', 'payload'], ['id', 'fromEncryptionPubKey', 'timestamp']);
      requireBoundaryRecord(message['payload'], 'WS_MESSAGE_RECEIPT_INVALID');
      break;
    case 'gossip_request':
    case 'gossip_response':
    case 'gossip_announce':
    case 'gossip_subscribed':
    case 'gossip_subscribe':
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
  'entity_input',
  'entity_input_receipt',
  'debug_event',
  'gossip_request',
  'gossip_response',
  'gossip_announce',
  'gossip_subscribed',
  'gossip_subscribe',
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

const wsMaxMessageBytes = (): number => {
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

export const validateRuntimeWsMessage = (value: unknown): RuntimeWsMessage =>
  stripRuntimeWsEnvelope(validateRuntimeWsEnvelope(value));

export const serializeWsMessage = (msg: RuntimeWsMessage): Uint8Array =>
  runtimeWsEnvelopeCodec.encode(buildRuntimeWsEnvelope(msg));

export const serializeWsMessageForDebug = (msg: RuntimeWsMessage): string =>
  serializeTaggedJson(buildRuntimeWsEnvelope(msg));

export const deserializeWsMessage = (
  raw: string | Buffer | Uint8Array | ArrayBuffer,
): RuntimeWsMessage => {
  const byteLength = wsMessageByteLength(raw);
  const maxBytes = wsMaxMessageBytes();
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
let helloNonceCounter = 0;

export const makeMessageId = (): string => {
  const id = messageCounter;
  messageCounter += 1;
  return `msg_${id}`;
};

const HELLO_DOMAIN = `xln-ws-hello:v${XLN_PROTOCOL_VERSION}`;

export const buildHelloMessage = (
  runtimeId: string,
  encryptionPubKey: string,
  timestamp: number,
  nonce: string,
): string => {
  return `${HELLO_DOMAIN}:${runtimeId}:${encryptionPubKey.toLowerCase()}:${timestamp}:${nonce}`;
};

export const hashHelloMessage = (runtimeId: string, encryptionPubKey: string, timestamp: number, nonce: string): string => {
  return keccak256(toUtf8Bytes(buildHelloMessage(runtimeId, encryptionPubKey, timestamp, nonce)));
};

export const makeHelloNonce = (): string => {
  const id = helloNonceCounter;
  helloNonceCounter += 1;
  return `nonce_${id}`;
};
