import type { RuntimeWsMessage } from '@xln/runtime/network/p2p/ws-protocol';
import {
  deserializeWsMessage,
  serializeWsMessage,
} from '@xln/runtime/network/p2p/ws-protocol';
import {
  decodeRuntimeAdapterBrowserMessage,
  decodeRuntimeAdapterMessage,
  encodeRuntimeAdapterMessage,
} from '@xln/runtime/api/runtime-adapter/codec';
import type { RuntimeAdapterWireMessage } from '@xln/runtime/api/runtime-adapter/wire-schema';
import { XLN_PROTOCOL_VERSION } from '@xln/runtime/protocol/version';
import { deserializeTaggedJson, serializeTaggedJson } from '@xln/runtime/protocol/serialization';
import { decodeBinaryPayload } from '@xln/runtime/storage/codec/binary-codec';
import { registerDebugSurface } from './debugSurface';

type WireBytes = Uint8Array | ArrayBuffer | ArrayBufferView;

const asBytes = (raw: WireBytes): Uint8Array => {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
};

export const wireDebug = {
  protocolVersion: XLN_PROTOCOL_VERSION,
  decode: (raw: WireBytes): unknown => decodeBinaryPayload(asBytes(raw)),
  decodeWs: (raw: WireBytes): RuntimeWsMessage => deserializeWsMessage(asBytes(raw)),
  encodeWs: (message: RuntimeWsMessage): Uint8Array => serializeWsMessage(message),
  decodeRadapter: (raw: WireBytes | string): RuntimeAdapterWireMessage =>
    typeof raw === 'string'
      ? decodeRuntimeAdapterBrowserMessage(raw)
      : decodeRuntimeAdapterMessage(asBytes(raw)),
  encodeRadapter: (message: RuntimeAdapterWireMessage): Uint8Array =>
    encodeRuntimeAdapterMessage(message),
  parseJson: (raw: string): unknown => deserializeTaggedJson(raw),
  stringifyJson: (value: unknown): string => serializeTaggedJson(value),
} as const;

registerDebugSurface('wire', () => wireDebug);
