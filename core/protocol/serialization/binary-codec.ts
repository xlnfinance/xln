import { Packr, addExtension } from 'msgpackr';

/** The only durable/wire payload format: canonical value-only MessagePack. */
export const XLN_BINARY_MSGPACK_MAGIC = 0x03;
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

const HEX_BYTES_EXTENSION = 0x48;
const HEX_BYTES_MIN_LENGTH = 16;
const CANONICAL_HEX_BYTES = /^0x[0-9a-f]+$/;

class CanonicalHexBytes {
  readonly bytes: Uint8Array;

  constructor(value: string) {
    this.bytes = hexBytes(value);
  }
}

const isCanonicalHexBytes = (value: string): boolean => {
  if (value.length < 2 + HEX_BYTES_MIN_LENGTH * 2 || !value.startsWith('0x') || value.length % 2 !== 0) {
    return false;
  }
  return CANONICAL_HEX_BYTES.test(value);
};

const hexBytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const offset = 2 + index * 2;
    const high = value.charCodeAt(offset);
    const low = value.charCodeAt(offset + 1);
    bytes[index] = ((high <= 57 ? high - 48 : high - 87) << 4)
      | (low <= 57 ? low - 48 : low - 87);
  }
  return bytes;
};

const hexText = (bytes: Uint8Array): string => {
  if (bytes.length < HEX_BYTES_MIN_LENGTH) throw new Error(`BINARY_CODEC_HEX_BYTES_TOO_SHORT:${bytes.length}`);
  return `0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')}`;
};

addExtension({
  Class: CanonicalHexBytes,
  type: HEX_BYTES_EXTENSION,
  pack: (value: CanonicalHexBytes): Uint8Array => value.bytes,
  unpack: (bytes: Uint8Array): string => hexText(bytes),
});

const projectBinaryScalar = (value: unknown): unknown =>
  typeof value === 'string' && isCanonicalHexBytes(value) ? new CanonicalHexBytes(value) : value;

const projectBinaryValue = (value: unknown): unknown => {
  const scalar = projectBinaryScalar(value);
  if (scalar !== value || value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return scalar;
  if (Array.isArray(value)) return value.map(projectBinaryValue);
  if (value instanceof Map) {
    return new Map(Array.from(value, ([key, entry]) => [projectBinaryValue(key), projectBinaryValue(entry)]));
  }
  if (value instanceof Set) return new Set(Array.from(value, projectBinaryValue));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const projected = Object.create(prototype) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) projected[key] = projectBinaryValue(entry);
  return projected;
};

const packBinaryValue = (value: unknown): Uint8Array =>
  asBytes(msgpackCodec.pack(projectBinaryValue(value)));

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

const canonicalSortBytes = (value: unknown): Uint8Array => packBinaryValue(value);

const canonicalize = (
  value: unknown,
  path: string,
  stack: Set<object>,
  preserveUndefined: boolean,
  omitSymbolKeys: boolean,
  projectHex: boolean,
): unknown => {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'string') return projectHex ? projectBinaryScalar(value) : value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      return unsupported(path, `number=${String(value)}`);
    }
    if (Object.is(value, -0)) return unsupported(path, 'negative-zero');
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
      if (!omitSymbolKeys && Object.getOwnPropertySymbols(value).length > 0) {
        return unsupported(path, 'symbol-key');
      }
      const output = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          return unsupported(`${path}[${index}]`, 'sparse-array');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          return unsupported(`${path}[${index}]`, 'non-data-property');
        }
        output[index] = canonicalize(
          descriptor.value,
          `${path}[${index}]`,
          stack,
          preserveUndefined,
          omitSymbolKeys,
          projectHex,
        );
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1) return unsupported(path, 'array-extra-property');
      return markCanonical(output);
    }
    if (value instanceof Map) {
      const entries = Array.from(value.entries()).map(([key, entryValue], index) => {
        const canonicalKey = canonicalize(key, `${path}.key[${index}]`, stack, preserveUndefined, omitSymbolKeys, projectHex);
        const canonicalValue = canonicalize(entryValue, `${path}.value[${index}]`, stack, preserveUndefined, omitSymbolKeys, projectHex);
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
        const canonical = canonicalize(entry, `${path}[${index}]`, stack, preserveUndefined, omitSymbolKeys, projectHex);
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
    // Null prototype prevents an own `__proto__` data key from invoking the
    // host setter and disappearing from the signed bytes.
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        return unsupported(`${path}.${key}`, 'non-data-property');
      }
      output[key] = canonicalize(descriptor.value, `${path}.${key}`, stack, preserveUndefined, omitSymbolKeys, projectHex);
    }
    return markCanonical(output);
  } finally {
    stack.delete(value);
  }
};

const packCanonical = (canonical: unknown): Uint8Array => {
  const body = packBinaryValue(canonical);
  const encoded = new Uint8Array(1 + body.byteLength);
  encoded[0] = XLN_BINARY_MSGPACK_MAGIC;
  encoded.set(body, 1);
  return encoded;
};

/**
 * Transport values are never hashed, so they skip the canonical key-order
 * walk and go straight through the structured-clone MessagePack codec
 * (exact bigint / Uint8Array / undefined round trip). Decoders still run the
 * boundary validators on the unpacked value.
 */
export const packTransportValue = (value: unknown): Uint8Array => packBinaryValue(value);

/**
 * Payload-framed (magic-prefixed) pack WITHOUT the canonical walk. Only for
 * values the caller has already put in canonical shape (sorted plain keys,
 * scalars and bytes): the bytes then equal encodeBinaryPayload's.
 */
export const packPreorderedBinaryPayload = (value: unknown): Uint8Array => {
  const body = packBinaryValue(value);
  const encoded = new Uint8Array(1 + body.byteLength);
  encoded[0] = XLN_BINARY_MSGPACK_MAGIC;
  encoded.set(body, 1);
  return encoded;
};
export const unpackTransportValue = (bytes: Uint8Array): unknown => msgpackCodec.unpack(bytes);

/**
 * One ordered, process-local transport stream. Record structures are learned
 * once per long-lived sender/receiver pair; these bytes are never durable,
 * hashed, replayed, or accepted by a different protocol boundary.
 */
export const createSequentialTransportValueCodec = (): Readonly<{
  pack(value: unknown): Uint8Array;
  unpack(bytes: Uint8Array): unknown;
}> => {
  const codec = new Packr({ mapsAsObjects: false, moreTypes: true, sequential: true });
  return {
    pack: value => asBytes(codec.pack(projectBinaryValue(value))),
    unpack: bytes => codec.unpack(bytes),
  };
};

/** Canonical (sorted, marked) copy of a value; later encodes of it skip the walk. */
export const canonicalizeBinaryPayload = <T>(value: T, options: { omitSymbolKeys?: boolean } = {}): T =>
  canonicalize(value, '$', new Set(), true, options.omitSymbolKeys === true, false) as T;

export const encodeBinaryPayloadWithCanonical = (
  value: unknown,
  options: { omitSymbolKeys?: boolean } = {},
): { bytes: Uint8Array; canonical: unknown } => {
  const canonical = canonicalize(value, '$', new Set(), true, options.omitSymbolKeys === true, false);
  return { bytes: packCanonical(canonical), canonical };
};

/**
 * Strict canonical msgpack bytes for consensus hashing: `undefined` is
 * rejected rather than preserved, so a hash never silently covers a missing
 * field. No framing magic: the bytes are an input to keccak, not a payload.
 */
export const encodeCanonicalConsensusBytes = (value: unknown): Uint8Array =>
  // Canonicalization already walks every node. Project hex scalars during
  // that same walk, then pack directly; the old path walked and cloned the
  // complete canonical tree a second time in `projectBinaryValue`.
  asBytes(msgpackCodec.pack(canonicalize(value, '$', new Set(), false, false, true)));

export const compareCanonicalConsensusValues = (left: unknown, right: unknown): number =>
  compareBytes(encodeCanonicalConsensusBytes(left), encodeCanonicalConsensusBytes(right));

export const canonicalConsensusValuesEqual = (left: unknown, right: unknown): boolean =>
  compareCanonicalConsensusValues(left, right) === 0;

export const encodeBinaryPayload = (
  value: unknown,
  options: { omitSymbolKeys?: boolean } = {},
): Uint8Array => encodeBinaryPayloadWithCanonical(value, options).bytes;

export const decodeBinaryPayload = (
  bytes: Uint8Array,
): unknown => {
  const magic = bytes[0];
  if (magic !== XLN_BINARY_MSGPACK_MAGIC) {
    throw new Error(`XLN_BINARY_CODEC_MAGIC_MISSING: firstByte=${magic ?? 'none'}`);
  }
  const body = bytes.subarray(1);
  return msgpackCodec.unpack(body) as unknown;
};

export const decodeValidatedBinaryPayload = <T>(
  bytes: Uint8Array,
  validator: BinaryPayloadValidator<T>,
): T => validator(decodeBinaryPayload(bytes));
import { Buffer } from '../../support/platform-crypto';
