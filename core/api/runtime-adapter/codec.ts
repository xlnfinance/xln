import { XLN_BINARY_MSGPACK_MAGIC } from '../../protocol/serialization/binary-codec';
import { deserializeTaggedJson, serializeTaggedJson } from '../../protocol/serialization';
import { LIMITS } from '../../config/constants';
import { decodeValidatedBinaryPayload, encodeBinaryPayload } from '../../protocol/serialization/binary-codec';
import type { Codec } from '../../protocol/serialization/codec';
import {
  validateRuntimeAdapterWireMessage,
  type RuntimeAdapterWireMessage,
} from './wire-schema';
import type { RuntimeAdapterRequest } from './types';
import { XLN_PROTOCOL_VERSION } from '../../protocol/version';
import { countOp } from '../../support/performance/op-counters';

const DEFAULT_MAX_MESSAGE_BYTES = LIMITS.MAX_RUNTIME_ADAPTER_MESSAGE_BYTES;

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
  if (magic !== XLN_BINARY_MSGPACK_MAGIC) throw new Error(`RADAPTER_WIRE_MESSAGEPACK_REQUIRED:magic=${magic ?? 'none'}`);
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

export const encodeRuntimeAdapterMessageForBrowser = (message: RuntimeAdapterWireMessage): string =>
  serializeTaggedJson(validateRuntimeAdapterWireMessage(message));

export const decodeRuntimeAdapterBrowserMessage = (raw: unknown): RuntimeAdapterWireMessage => {
  assertRuntimeAdapterMessageSize(raw);
  if (typeof raw !== 'string') throw new Error('RADAPTER_BROWSER_JSON_REQUIRED');
  return validateRuntimeAdapterWireMessage(deserializeTaggedJson(raw));
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
  countOp(`socket.radapter.in.${message.op}`, runtimeAdapterMessageByteLength(raw));
  return message;
};

/**
 * Give an embedded caller the same owned payload that a remote caller receives.
 *
 * Adapter projections may contain codec-supported values such as BigInt and
 * Map which are not reliably detached by every host's `structuredClone`.
 * A canonical wire round-trip both removes references into live Runtime state
 * and prevents embedded/remote behavior from drifting.
 */
export const detachRuntimeAdapterPayload = <T>(payload: T): T => {
  const message = decodeRuntimeAdapterMessage(encodeRuntimeAdapterMessage({
    v: XLN_PROTOCOL_VERSION,
    inReplyTo: 'embedded-projection',
    ok: true,
    payload,
  }));
  if (!('ok' in message) || !message.ok) {
    throw new Error('RADAPTER_PROJECTION_ROUNDTRIP_INVALID');
  }
  return message.payload as T;
};
