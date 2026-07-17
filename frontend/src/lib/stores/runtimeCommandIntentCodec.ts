import { keccak256, toUtf8Bytes } from 'ethers';
import type { RuntimeInput } from '@xln/runtime/xln-api';
import { safeParse, safeStringify } from '@xln/runtime/protocol/serialization';

export type RemoteRuntimeCommandIntentStatus = 'pending' | 'accepted';

export type RemoteRuntimeCommandIntent = {
  commandId: string;
  commandSequence: number;
  runtimeId: string;
  serverFingerprint: string;
  inputHash: string;
  input: RuntimeInput;
  status: RemoteRuntimeCommandIntentStatus;
  createdAt: number;
  upstreamReceiptId: string | null;
  statusUrl: string | null;
};

export const MAX_UNRESOLVED_REMOTE_INTENTS = 100;
export const MAX_RUNTIME_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_RUNTIME_ID_BYTES = 512;
export const MAX_RECEIPT_ID_BYTES = 512;
export const MAX_STATUS_URL_BYTES = 4 * 1024;

const SAFE_COMMAND_ID = /^[A-Za-z0-9._:-]{16,128}$/;
const SAFE_FINGERPRINT = /^0x[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export const normalizeBoundedText = (value: unknown, field: string, maxBytes: number): string => {
  const normalized = String(value ?? '').trim();
  if (encoder.encode(normalized).byteLength > maxBytes) {
    throw new Error(`RUNTIME_COMMAND_INTENT_${field}_LIMIT_EXCEEDED`);
  }
  return normalized;
};

export const normalizeRuntimeId = (runtimeId: unknown): string =>
  normalizeBoundedText(runtimeId, 'RUNTIME_ID', MAX_RUNTIME_ID_BYTES).toLowerCase() || 'remote';

export const normalizeRuntimeCommandId = (commandId: string): string => {
  const normalized = String(commandId || '').trim();
  if (!SAFE_COMMAND_ID.test(normalized)) {
    throw new Error('RUNTIME_COMMAND_ID_INVALID: commandId must be 16-128 safe characters');
  }
  return normalized;
};

export const normalizeRuntimeCommandSequence = (value: unknown): number => {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error(`RUNTIME_COMMAND_SEQUENCE_INVALID:${String(value)}`);
  }
  return sequence;
};

export const normalizeRuntimeServerFingerprint = (fingerprint: unknown): string => {
  const normalized = String(fingerprint || '').trim().toLowerCase();
  if (!SAFE_FINGERPRINT.test(normalized)) {
    throw new Error('RUNTIME_COMMAND_SERVER_FINGERPRINT_INVALID');
  }
  return normalized;
};

export const createRuntimeCommandId = (): string => {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('RUNTIME_COMMAND_ID_CRYPTO_UNAVAILABLE');
  }
  return normalizeRuntimeCommandId(`runtime-command:${globalThis.crypto.randomUUID()}`);
};

export const canonicalRuntimeInput = (
  input: RuntimeInput,
): { encoded: string; input: RuntimeInput; hash: string } => {
  const encoded = safeStringify(input);
  const payloadBytes = encoder.encode(encoded).byteLength;
  if (payloadBytes > MAX_RUNTIME_INPUT_BYTES) {
    throw new Error(`RUNTIME_COMMAND_INTENT_PAYLOAD_LIMIT_EXCEEDED:${payloadBytes}:${MAX_RUNTIME_INPUT_BYTES}`);
  }
  return {
    encoded,
    input: safeParse<RuntimeInput>(encoded),
    hash: keccak256(toUtf8Bytes(encoded)).toLowerCase(),
  };
};
