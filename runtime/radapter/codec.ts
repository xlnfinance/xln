import { deserializeTaggedJson, serializeTaggedJson } from '../protocol/serialization';
import { decodeValidatedBinaryPayload, encodeBinaryPayload } from '../storage/binary-codec';
import type { Codec } from '../protocol/codec';
import {
  validateRuntimeAdapterWireMessage,
  type RuntimeAdapterWireMessage,
} from './wire-schema';
import type { RuntimeAdapterRequest } from './types';

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

const assertRuntimeAdapterMessagePack = (bytes: Uint8Array): void => {
  const magic = bytes[0];
  if (magic !== 0x01) throw new Error(`RADAPTER_WIRE_MESSAGEPACK_REQUIRED:magic=${magic ?? 'none'}`);
};

const runtimeAdapterWireCodec: Codec<RuntimeAdapterWireMessage> = {
  encode: (message) => encodeBinaryPayload(validateRuntimeAdapterWireMessage(message), 'msgpack'),
  decode: (bytes) => {
    assertRuntimeAdapterMessagePack(bytes);
    return decodeValidatedBinaryPayload(bytes, validateRuntimeAdapterWireMessage);
  },
};

export const encodeRuntimeAdapterMessage = (message: RuntimeAdapterWireMessage): Uint8Array =>
  runtimeAdapterWireCodec.encode(message);

export const encodeRuntimeAdapterMessageForDebug = (message: unknown): string =>
  serializeTaggedJson(message);

export const encodeRuntimeAdapterMessageForBrowser = (message: RuntimeAdapterWireMessage): string =>
  serializeTaggedJson(validateRuntimeAdapterWireMessage(message));

export const decodeRuntimeAdapterBrowserMessage = (raw: unknown): RuntimeAdapterWireMessage => {
  assertRuntimeAdapterMessageSize(raw);
  if (typeof raw !== 'string') throw new Error('RADAPTER_BROWSER_JSON_REQUIRED');
  return validateRuntimeAdapterWireMessage(deserializeTaggedJson<unknown>(raw));
};

export const decodeRuntimeAdapterMessage = (raw: unknown): RuntimeAdapterWireMessage => {
  assertRuntimeAdapterMessageSize(raw);
  if (typeof raw === 'string') throw new Error('RADAPTER_WIRE_BINARY_REQUIRED');
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    return runtimeAdapterWireCodec.decode(asBytes(raw));
  }
  throw new Error(`RADAPTER_WIRE_BINARY_REQUIRED:${typeof raw}`);
};

export const decodeRuntimeAdapterRequest = (raw: unknown): RuntimeAdapterRequest => {
  const message = decodeRuntimeAdapterMessage(raw);
  if (!('id' in message)) throw new Error('RADAPTER_CLIENT_REQUEST_REQUIRED');
  return message;
};
