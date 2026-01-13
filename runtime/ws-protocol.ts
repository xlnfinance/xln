import { safeStringify } from './serialization-utils';
import { keccak256, toUtf8Bytes } from 'ethers';

export type RuntimeWsMessageType =
  | 'hello'
  | 'runtime_input'
  | 'entity_input'
  | 'gossip_request'
  | 'gossip_response'
  | 'gossip_announce'
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
  to?: string;
  timestamp?: number;
  payload?: unknown;
  auth?: RuntimeWsAuth;
  status?: 'delivered' | 'queued' | 'failed';
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

export const makeMessageId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const HELLO_DOMAIN = 'xln-ws-hello';

export const buildHelloMessage = (runtimeId: string, timestamp: number, nonce: string): string => {
  return `${HELLO_DOMAIN}:${runtimeId}:${timestamp}:${nonce}`;
};

export const hashHelloMessage = (runtimeId: string, timestamp: number, nonce: string): string => {
  return keccak256(toUtf8Bytes(buildHelloMessage(runtimeId, timestamp, nonce)));
};

export const makeHelloNonce = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `nonce_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};
