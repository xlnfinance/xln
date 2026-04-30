import { deserializeTaggedJson } from '../serialization-utils';
import { decodeBinaryPayload, encodeBinaryPayload } from '../storage/binary-codec';

const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;

const asBytes = (raw: ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
};

export const runtimeAdapterMaxMessageBytes = (): number => {
  const raw = typeof process !== 'undefined' ? process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] : undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_MESSAGE_BYTES;
};

export const runtimeAdapterMessageByteLength = (raw: unknown): number => {
  if (typeof raw === 'string') return new TextEncoder().encode(raw).byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return 0;
};

export const assertRuntimeAdapterMessageSize = (raw: unknown): void => {
  const byteLength = runtimeAdapterMessageByteLength(raw);
  const maxBytes = runtimeAdapterMaxMessageBytes();
  if (byteLength > maxBytes) {
    throw new Error(`RADAPTER_MESSAGE_TOO_LARGE: bytes=${byteLength} max=${maxBytes}`);
  }
};

export const encodeRuntimeAdapterMessage = (message: unknown): Uint8Array =>
  encodeBinaryPayload(message, 'msgpack');

export const decodeRuntimeAdapterMessage = <T = unknown>(raw: unknown): T => {
  assertRuntimeAdapterMessageSize(raw);
  if (typeof raw === 'string') return deserializeTaggedJson<T>(raw);
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    return decodeBinaryPayload<T>(asBytes(raw));
  }
  throw new Error(`RADAPTER_UNSUPPORTED_WIRE_MESSAGE: ${typeof raw}`);
};
