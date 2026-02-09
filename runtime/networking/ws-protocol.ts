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
 * Hello auth exists only for basic connection authentication (proving runtimeId ownership),
 * not for transaction security. Even if hello is replayed, attacker gains nothing because:
 * 1. They can't forge entity transactions (need validator private keys)
 * 2. They can't replay old frames (height check fails)
 * 3. They can't spoof profiles (signature verification)
 *
 * Message IDs and nonces are for correlation/debugging, not cryptographic security.
 */

import { safeStringify } from '../serialization-utils';
import { keccak256, toUtf8Bytes } from 'ethers';

export type RuntimeWsMessageType =
  | 'hello'
  | 'runtime_input'
  | 'entity_input'
  | 'debug_event'
  | 'gossip_request'
  | 'gossip_response'
  | 'gossip_announce'
  | 'gossip_subscribed'
  | 'gossip_subscribe'
  | 'gossip_update'
  | 'ack'
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
  auth?: RuntimeWsAuth;
  status?: 'delivered' | 'queued' | 'failed' | 'stored';
  count?: number;
  inReplyTo?: string;
  error?: string;
};

type JsonValue = any;

const jsonReplacer = (_key: string, value: JsonValue): JsonValue => {
  if (value instanceof Map) {
    return { _type: 'Map', value: Array.from(value.entries()) };
  }
  if (typeof value === 'bigint') {
    return { _type: 'BigInt', value: value.toString() };
  }
  return value;
};

const jsonReviver = (_key: string, value: JsonValue): JsonValue => {
  if (value && typeof value === 'object') {
    if (value._type === 'Map') return new Map(value.value);
    if (value._type === 'BigInt') return BigInt(value.value);
  }
  return value;
};

export const serializeWsMessage = (msg: RuntimeWsMessage): string => {
  try {
    return JSON.stringify(msg, jsonReplacer);
  } catch (error) {
    return safeStringify({
      type: 'error',
      error: `serialize failed: ${(error as Error).message}`,
    });
  }
};

export const deserializeWsMessage = (raw: string | Buffer | ArrayBuffer): RuntimeWsMessage => {
  const text =
    typeof raw === 'string'
      ? raw
      : raw instanceof ArrayBuffer
        ? new TextDecoder().decode(new Uint8Array(raw))
        : typeof Buffer !== 'undefined'
          ? Buffer.from(raw as Buffer).toString()
          : String(raw);
  return JSON.parse(text, jsonReviver) as RuntimeWsMessage;
};

let messageCounter = 0;
let helloNonceCounter = 0;

export const makeMessageId = (): string => {
  const id = messageCounter;
  messageCounter += 1;
  return `msg_${id}`;
};

const HELLO_DOMAIN = 'xln-ws-hello';

export const buildHelloMessage = (runtimeId: string, timestamp: number, nonce: string): string => {
  return `${HELLO_DOMAIN}:${runtimeId}:${timestamp}:${nonce}`;
};

export const hashHelloMessage = (runtimeId: string, timestamp: number, nonce: string): string => {
  return keccak256(toUtf8Bytes(buildHelloMessage(runtimeId, timestamp, nonce)));
};

export const makeHelloNonce = (): string => {
  const id = helloNonceCounter;
  helloNonceCounter += 1;
  return `nonce_${id}`;
};
