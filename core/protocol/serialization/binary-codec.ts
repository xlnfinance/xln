import { Packr } from 'msgpackr';
import {
  deserializeTaggedJson,
  serializeCanonicalTaggedJson,
} from './';

export type XlnBinaryCodecName = 'json' | 'msgpack';

// 0x01 was msgpack with structured-clone reference markers (XLN_BINARY_FORMAT_V1);
// 0x03 is value-only msgpack (moreTypes, Buffer folded into Uint8Array). A V1
// payload is refused by magic rather than decoded into a different value graph.
const XLN_BINARY_CODEC_MAGIC: Record<XlnBinaryCodecName, number> = {
  msgpack: 0x03,
  json: 0x02,
};

export const XLN_BINARY_MSGPACK_MAGIC = XLN_BINARY_CODEC_MAGIC.msgpack;

const XLN_BINARY_CODEC_BY_MAGIC = new Map<number, XlnBinaryCodecName>(
  Object.entries(XLN_BINARY_CODEC_MAGIC).map(([codec, magic]) => [magic, codec as XlnBinaryCodecName]),
);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ALREADY_CANONICAL = Symbol.for('xln.binary-codec.canonical');

const isAlreadyCanonical = (value: object): boolean =>
  (value as Record<symbol, unknown>)[ALREADY_CANONICAL] === true;

const markCanonical = <T extends object>(value: T): T => {
  Object.defineProperty(value, ALREADY_CANONICAL, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return value;
};
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
// moreTypes keeps Map/Set/typed arrays/undefined round-tripping exactly.
// structuredClone was NOT used: it adds reference markers for repeated object
// instances, so bytes depended on object sharing rather than value.
const msgpackCodec = new Packr({
  mapsAsObjects: false,
  moreTypes: true,
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
  omitSymbolKeys: boolean,
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
  if (isAlreadyCanonical(value)) return value;
  if (stack.has(value)) throw new Error(`XLN_BINARY_CODEC_CYCLE:path=${path}`);

  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return unsupported(path, 'invalid-date');
    return new Date(value.getTime());
  }
  // Buffer and Uint8Array are the same bytes; one msgpack form for both.
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return new Uint8Array(value);
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
      return markCanonical(value.map((entry, index) => {
        if (!(index in value)) return unsupported(`${path}[${index}]`, 'sparse-array');
        return canonicalize(entry, `${path}[${index}]`, stack, preserveUndefined, omitSymbolKeys);
      }));
    }
    if (value instanceof Map) {
      const entries = Array.from(value.entries()).map(([key, entryValue], index) => {
        const canonicalKey = canonicalize(key, `${path}.key[${index}]`, stack, preserveUndefined, omitSymbolKeys);
        const canonicalValue = canonicalize(entryValue, `${path}.value[${index}]`, stack, preserveUndefined, omitSymbolKeys);
        return {
          key: canonicalKey,
          value: canonicalValue,
          keyBytes: canonicalSortBytes(canonicalKey),
          valueBytes: undefined as Uint8Array | undefined,
        };
      });
      entries.sort((left, right) => {
        const byKey = compareBytes(left.keyBytes, right.keyBytes);
        if (byKey !== 0) return byKey;
        // A Map normally has unique canonical scalar keys. Only pay to encode
        // entire values when two distinct host keys collapse to identical
        // canonical bytes and a deterministic tie-break is actually needed.
        left.valueBytes ??= canonicalSortBytes(left.value);
        right.valueBytes ??= canonicalSortBytes(right.value);
        return compareBytes(left.valueBytes, right.valueBytes);
      });
      return markCanonical(new Map(entries.map(entry => [entry.key, entry.value])));
    }
    if (value instanceof Set) {
      const entries = Array.from(value.values()).map((entry, index) => {
        const canonical = canonicalize(entry, `${path}[${index}]`, stack, preserveUndefined, omitSymbolKeys);
        return { value: canonical, bytes: canonicalSortBytes(canonical) };
      });
      entries.sort((left, right) => compareBytes(left.bytes, right.bytes));
      return markCanonical(new Set(entries.map(entry => entry.value)));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupported(path, `prototype=${value.constructor?.name ?? 'unknown'}`);
    }
    if (!omitSymbolKeys && Object.getOwnPropertySymbols(value).length > 0) {
      return unsupported(path, 'symbol-key');
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        return unsupported(`${path}.${key}`, 'non-data-property');
      }
      output[key] = canonicalize(descriptor.value, `${path}.${key}`, stack, preserveUndefined, omitSymbolKeys);
    }
    return markCanonical(output);
  } finally {
    stack.delete(value);
  }
};

const packCanonical = (canonical: unknown, codec: XlnBinaryCodecName): Uint8Array => {
  const body = codec === 'json'
    ? textEncoder.encode(serializeCanonicalTaggedJson(canonical))
    : asBytes(msgpackCodec.pack(canonical));
  const encoded = new Uint8Array(1 + body.byteLength);
  encoded[0] = XLN_BINARY_CODEC_MAGIC[codec];
  encoded.set(body, 1);
  return encoded;
};

/**
 * Transport values are never hashed, so they skip the canonical key-order
 * walk and go straight through the structured-clone MessagePack codec
 * (exact bigint / Uint8Array / undefined round trip). Decoders still run the
 * boundary validators on the unpacked value.
 */
export const packTransportValue = (value: unknown): Uint8Array => asBytes(msgpackCodec.pack(value));

/**
 * Payload-framed (magic-prefixed) pack WITHOUT the canonical walk. Only for
 * values the caller has already put in canonical shape (sorted plain keys,
 * scalars and bytes): the bytes then equal encodeBinaryPayload's.
 */
export const packPreorderedBinaryPayload = (value: unknown): Uint8Array => {
  const body = asBytes(msgpackCodec.pack(value));
  const encoded = new Uint8Array(1 + body.byteLength);
  encoded[0] = XLN_BINARY_CODEC_MAGIC.msgpack;
  encoded.set(body, 1);
  return encoded;
};
export const unpackTransportValue = (bytes: Uint8Array): unknown => msgpackCodec.unpack(bytes);

/** Canonical (sorted, marked) copy of a value; later encodes of it skip the walk. */
export const canonicalizeBinaryPayload = <T>(value: T, options: { omitSymbolKeys?: boolean } = {}): T =>
  canonicalize(value, '$', new Set(), true, options.omitSymbolKeys === true) as T;

export const encodeBinaryPayloadWithCanonical = (
  value: unknown,
  codec: XlnBinaryCodecName = 'msgpack',
  options: { omitSymbolKeys?: boolean } = {},
): { bytes: Uint8Array; canonical: unknown } => {
  const canonical = canonicalize(value, '$', new Set(), codec === 'msgpack', options.omitSymbolKeys === true);
  return { bytes: packCanonical(canonical, codec), canonical };
};

/**
 * Strict canonical msgpack bytes for consensus hashing: `undefined` is
 * rejected rather than preserved, so a hash never silently covers a missing
 * field. No framing magic: the bytes are an input to keccak, not a payload.
 */
export const encodeCanonicalConsensusBytes = (value: unknown): Uint8Array =>
  asBytes(msgpackCodec.pack(canonicalize(value, '$', new Set(), false, false)));

export const encodeBinaryPayload = (
  value: unknown,
  codec: XlnBinaryCodecName = 'msgpack',
  options: { omitSymbolKeys?: boolean } = {},
): Uint8Array => encodeBinaryPayloadWithCanonical(value, codec, options).bytes;

export const decodeBinaryPayload = (
  bytes: Uint8Array,
): unknown => {
  const magic = bytes[0];
  const codec = magic === undefined ? undefined : XLN_BINARY_CODEC_BY_MAGIC.get(magic);
  if (!codec) {
    throw new Error(`XLN_BINARY_CODEC_MAGIC_MISSING: firstByte=${magic ?? 'none'}`);
  }
  const body = bytes.subarray(1);
  if (codec === 'json') return deserializeTaggedJson(textDecoder.decode(body));
  return msgpackCodec.unpack(body) as unknown;
};

export const decodeValidatedBinaryPayload = <T>(
  bytes: Uint8Array,
  validator: BinaryPayloadValidator<T>,
): T => validator(decodeBinaryPayload(bytes));
import { Buffer } from '../../support/platform-crypto';
