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

import { deserializeTaggedJson, serializeTaggedJson } from '../protocol/serialization';
import { keccak256, toUtf8Bytes } from 'ethers';
import { decodeBinaryPayload, encodeBinaryPayload } from '../storage/binary-codec';

export type RuntimeWsMessageType =
  | 'hello'
  | 'hello_challenge'
  | 'entity_input'
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

export const serializeWsMessage = (msg: RuntimeWsMessage): Uint8Array =>
  encodeBinaryPayload(msg, 'msgpack');

export const serializeWsMessageForDebug = (msg: RuntimeWsMessage): string =>
  serializeTaggedJson(msg);

export const deserializeWsMessage = (
  raw: string | Buffer | Uint8Array | ArrayBuffer,
): RuntimeWsMessage => {
  if (typeof raw === 'string') return deserializeTaggedJson<RuntimeWsMessage>(raw);
  const bytes = raw instanceof ArrayBuffer
    ? new Uint8Array(raw)
    : raw instanceof Uint8Array
      ? raw
      : new Uint8Array(raw);
  return decodeBinaryPayload<RuntimeWsMessage>(bytes);
};

let messageCounter = 0;
let helloNonceCounter = 0;

export const makeMessageId = (): string => {
  const id = messageCounter;
  messageCounter += 1;
  return `msg_${id}`;
};

const HELLO_DOMAIN = 'xln-ws-hello';

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
