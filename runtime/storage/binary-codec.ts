import { Packr } from 'msgpackr';
import {
  deserializeTaggedJson,
  serializeCanonicalTaggedJson,
} from '../protocol/serialization';

export type XlnBinaryCodecName = 'json' | 'msgpack';

const XLN_BINARY_CODEC_MAGIC: Record<XlnBinaryCodecName, number> = {
  msgpack: 0x01,
  json: 0x02,
};

const XLN_BINARY_CODEC_BY_MAGIC = new Map<number, XlnBinaryCodecName>(
  Object.entries(XLN_BINARY_CODEC_MAGIC).map(([codec, magic]) => [magic, codec as XlnBinaryCodecName]),
);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const SUPPORTED_TYPED_ARRAYS = new Set([
  'Uint8Array',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);
const msgpackCodec = new Packr({
  mapsAsObjects: false,
  structuredClone: true,
});

type BinaryPayloadValidator<T> = (value: unknown) => T;

const asBytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const limit = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < limit; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
};

const unsupported = (path: string, detail: string): never => {
  throw new Error(`XLN_BINARY_CODEC_UNSUPPORTED:path=${path}:detail=${detail}`);
};

const canonicalSortBytes = (value: unknown): Uint8Array => asBytes(msgpackCodec.pack(value));

const canonicalize = (
  value: unknown,
  path: string,
  stack: Set<object>,
  preserveUndefined: boolean,
): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      return unsupported(path, `number=${String(value)}`);
    }
    return value;
  }
  if (value === undefined) {
    if (preserveUndefined) return undefined;
    return unsupported(path, 'type=undefined');
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return unsupported(path, `type=${typeof value}`);
  }
  if (typeof value !== 'object') return unsupported(path, `type=${typeof value}`);
  if (stack.has(value)) throw new Error(`XLN_BINARY_CODEC_CYCLE:path=${path}`);

  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return unsupported(path, 'invalid-date');
    return new Date(value.getTime());
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return unsupported(path, 'array-buffer-use-uint8array');
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return unsupported(path, 'data-view');
    if (!SUPPORTED_TYPED_ARRAYS.has(value.constructor.name)) {
      return unsupported(path, `typed-array=${value.constructor.name}`);
    }
    const bytes = Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    const TypedArray = value.constructor as new (buffer: ArrayBuffer) => ArrayBufferView;
    return new TypedArray(bytes.buffer as ArrayBuffer);
  }

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (!(index in value)) return unsupported(`${path}[${index}]`, 'sparse-array');
        return canonicalize(entry, `${path}[${index}]`, stack, preserveUndefined);
      });
    }
    if (value instanceof Map) {
      const entries = Array.from(value.entries()).map(([key, entryValue], index) => {
        const canonicalKey = canonicalize(key, `${path}.key[${index}]`, stack, preserveUndefined);
        const canonicalValue = canonicalize(entryValue, `${path}.value[${index}]`, stack, preserveUndefined);
        return {
          key: canonicalKey,
          value: canonicalValue,
          keyBytes: canonicalSortBytes(canonicalKey),
          valueBytes: canonicalSortBytes(canonicalValue),
        };
      });
      entries.sort((left, right) => {
        const byKey = compareBytes(left.keyBytes, right.keyBytes);
        return byKey !== 0 ? byKey : compareBytes(left.valueBytes, right.valueBytes);
      });
      return new Map(entries.map(entry => [entry.key, entry.value]));
    }
    if (value instanceof Set) {
      const entries = Array.from(value.values()).map((entry, index) => {
        const canonical = canonicalize(entry, `${path}[${index}]`, stack, preserveUndefined);
        return { value: canonical, bytes: canonicalSortBytes(canonical) };
      });
      entries.sort((left, right) => compareBytes(left.bytes, right.bytes));
      return new Set(entries.map(entry => entry.value));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupported(path, `prototype=${value.constructor?.name ?? 'unknown'}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) return unsupported(path, 'symbol-key');
    const output: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        return unsupported(`${path}.${key}`, 'non-data-property');
      }
      Object.defineProperty(output, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: canonicalize(descriptor.value, `${path}.${key}`, stack, preserveUndefined),
      });
    }
    return output;
  } finally {
    stack.delete(value);
  }
};

export const encodeBinaryPayload = (
  value: unknown,
  codec: XlnBinaryCodecName = 'msgpack',
): Uint8Array => {
  const canonical = canonicalize(value, '$', new Set(), codec === 'msgpack');
  const body = codec === 'json'
    ? textEncoder.encode(serializeCanonicalTaggedJson(canonical))
    : asBytes(msgpackCodec.pack(canonical));
  const encoded = new Uint8Array(1 + body.byteLength);
  encoded[0] = XLN_BINARY_CODEC_MAGIC[codec];
  encoded.set(body, 1);
  return encoded;
};

export const decodeBinaryPayload = <T>(
  bytes: Uint8Array,
): T => {
  const magic = bytes[0];
  const codec = magic === undefined ? undefined : XLN_BINARY_CODEC_BY_MAGIC.get(magic);
  if (!codec) {
    throw new Error(`XLN_BINARY_CODEC_MAGIC_MISSING: firstByte=${magic ?? 'none'}`);
  }
  const body = bytes.subarray(1);
  if (codec === 'json') return deserializeTaggedJson<T>(textDecoder.decode(body));
  return msgpackCodec.unpack(body) as T;
};

export const decodeValidatedBinaryPayload = <T>(
  bytes: Uint8Array,
  validator: BinaryPayloadValidator<T>,
): T => validator(decodeBinaryPayload<unknown>(bytes));
