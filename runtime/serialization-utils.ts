/**
 * Deterministic, BigInt-safe serialization utilities.
 * One canonical codec is used for logs, network payloads, and persisted snapshots.
 */

const ALWAYS_EXCLUDED_KEYS = new Set(['clonedForValidation', 'provider', 'ethersProvider']);

type JsonPrimitive = string | number | boolean | null;

type TaggedBigInt = { __xlnType: 'BigInt'; value: string };
type TaggedMap = { __xlnType: 'Map'; value: Array<[TaggedJsonValue, TaggedJsonValue]> };
type TaggedSet = { __xlnType: 'Set'; value: TaggedJsonValue[] };
type TaggedBuffer = { __xlnType: 'Buffer'; value: number[] };
type TaggedDate = { __xlnType: 'Date'; value: string };
type TaggedTypedArray = { __xlnType: 'TypedArray'; kind: TypedArrayKind; value: string };

type TaggedJsonRecord = { [key: string]: TaggedJsonValue };

export type TaggedJsonValue =
  | JsonPrimitive
  | TaggedBigInt
  | TaggedMap
  | TaggedSet
  | TaggedTypedArray
  | TaggedBuffer
  | TaggedDate
  | TaggedJsonValue[]
  | TaggedJsonRecord;

type TaggedEnvelope = TaggedBigInt | TaggedMap | TaggedSet | TaggedTypedArray | TaggedBuffer | TaggedDate;

type SerializeOptions = {
  excludeKeys?: ReadonlySet<string>;
  space?: number;
};

type TypedArrayCtor =
  | typeof Uint8Array
  | typeof Int8Array
  | typeof Uint16Array
  | typeof Int16Array
  | typeof Uint32Array
  | typeof Int32Array
  | typeof Float32Array
  | typeof Float64Array
  | typeof BigInt64Array
  | typeof BigUint64Array;

type TypedArrayKind =
  | 'Uint8Array'
  | 'Int8Array'
  | 'Uint16Array'
  | 'Int16Array'
  | 'Uint32Array'
  | 'Int32Array'
  | 'Float32Array'
  | 'Float64Array'
  | 'BigInt64Array'
  | 'BigUint64Array';

const TYPED_ARRAY_CTORS: Record<TypedArrayKind, TypedArrayCtor> = {
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTaggedEnvelope = (value: unknown): value is TaggedEnvelope => {
  if (!isRecord(value) || typeof value['__xlnType'] !== 'string') return false;
  switch (value['__xlnType']) {
    case 'BigInt':
      return typeof value['value'] === 'string';
    case 'Map':
      return Array.isArray(value['value']);
    case 'Set':
      return Array.isArray(value['value']);
    case 'TypedArray':
      return typeof value['kind'] === 'string' && typeof value['value'] === 'string';
    case 'Buffer':
      return Array.isArray(value['value']);
    case 'Date':
      return typeof value['value'] === 'string';
    default:
      return false;
  }
};

const isBufferValue = (value: unknown): value is Buffer =>
  typeof Buffer !== 'undefined' && Buffer.isBuffer(value);

const isTypedArrayView = (value: unknown): value is Exclude<ArrayBufferView, DataView> =>
  ArrayBuffer.isView(value) && !(value instanceof DataView);

const toUint8Bytes = (view: ArrayBufferView): Uint8Array =>
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

const bytesToBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(base64, 'base64'));
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const cloneArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
};

const stableString = (value: TaggedJsonValue): string => JSON.stringify(value);

const compareTaggedValues = (left: TaggedJsonValue, right: TaggedJsonValue): number => {
  const leftEncoded = stableString(left);
  const rightEncoded = stableString(right);
  return leftEncoded.localeCompare(rightEncoded);
};

const compareTaggedEntries = (
  left: [TaggedJsonValue, TaggedJsonValue],
  right: [TaggedJsonValue, TaggedJsonValue],
): number => {
  const byKey = compareTaggedValues(left[0], right[0]);
  if (byKey !== 0) return byKey;
  return compareTaggedValues(left[1], right[1]);
};

const normalizeSerializableValue = (
  input: unknown,
  options: SerializeOptions,
  stack: object[],
): TaggedJsonValue | undefined => {
  if (input === undefined) return undefined;
  if (input === null) return null;

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'bigint') {
    return { __xlnType: 'BigInt', value: input.toString() };
  }
  if (typeof input === 'function' || typeof input === 'symbol') {
    return undefined;
  }

  if (input instanceof Date) {
    return { __xlnType: 'Date', value: input.toISOString() };
  }
  if (isBufferValue(input)) {
    return { __xlnType: 'Buffer', value: Array.from(input.values()) };
  }
  if (isTypedArrayView(input)) {
    const kind = input.constructor.name as TypedArrayKind;
    if (kind in TYPED_ARRAY_CTORS) {
      return {
        __xlnType: 'TypedArray',
        kind,
        value: bytesToBase64(toUint8Bytes(input)),
      };
    }
  }

  const objectRef = input as object;
  if (stack.includes(objectRef)) return undefined;
  stack.push(objectRef);
  try {
    if (input instanceof Map) {
      const entries: Array<[TaggedJsonValue, TaggedJsonValue]> = [];
      for (const [rawKey, rawValue] of input.entries()) {
        const key = normalizeSerializableValue(rawKey, options, stack);
        const value = normalizeSerializableValue(rawValue, options, stack);
        if (key !== undefined && value !== undefined) {
          entries.push([key, value]);
        }
      }
      entries.sort(compareTaggedEntries);
      return { __xlnType: 'Map', value: entries };
    }

    if (input instanceof Set) {
      const values = Array.from(input.values())
        .map((value) => normalizeSerializableValue(value, options, stack))
        .filter((value): value is TaggedJsonValue => value !== undefined)
        .sort(compareTaggedValues);
      return { __xlnType: 'Set', value: values };
    }

    if (Array.isArray(input)) {
      return input.map((item) => normalizeSerializableValue(item, options, stack) ?? null);
    }

    const source = input as Record<string, unknown>;
    const result: TaggedJsonRecord = {};
    const keys = Object.keys(source)
      .filter((key) => !ALWAYS_EXCLUDED_KEYS.has(key) && !options.excludeKeys?.has(key))
      .sort((left, right) => left.localeCompare(right));
    for (const key of keys) {
      const value = normalizeSerializableValue(source[key], options, stack);
      if (value !== undefined) result[key] = value;
    }
    return result;
  } finally {
    stack.pop();
  }
};

const stringifyCanonical = (input: unknown, options: SerializeOptions = {}): string => {
  const normalized = normalizeSerializableValue(input, options, []);
  return JSON.stringify(normalized ?? null, null, options.space);
};

const decodeTaggedJson = (value: unknown): unknown => {
  if (!isTaggedEnvelope(value)) {
    return value;
  }

  switch (value.__xlnType) {
    case 'BigInt':
      return BigInt(value.value);
    case 'Map':
      return new Map(value.value);
    case 'Set':
      return new Set(value.value);
    case 'TypedArray': {
      const ctor = TYPED_ARRAY_CTORS[value.kind as TypedArrayKind];
      if (!ctor) return value;
      return new ctor(cloneArrayBuffer(base64ToBytes(value.value)));
    }
    case 'Buffer':
      return Buffer.from(value.value);
    case 'Date':
      return new Date(value.value);
    default:
      return value;
  }
};

export function bigIntReplacer(_key: string, value: unknown): unknown {
  return normalizeSerializableValue(value, {}, []);
}

/**
 * Deterministic JSON.stringify replacement with BigInt/Map/Set/Uint8Array support.
 */
export function safeStringify(obj: unknown, space?: number): string {
  try {
    return stringifyCanonical(obj, space === undefined ? {} : { space });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`SAFE_STRINGIFY_FAILED: ${message}`, err instanceof Error ? { cause: err } : undefined);
  }
}

/**
 * BigInt-safe console logging for debugging.
 */
export function safeLog(message: string, obj?: unknown): void {
  if (obj !== undefined) {
    try {
      console.log(message, safeStringify(obj, 2));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.log(message, `[Unserializable: ${detail}]`);
    }
  } else {
    console.log(message);
  }
}

export function bigIntReviver(_key: string, value: unknown): unknown {
  return decodeTaggedJson(value);
}

/**
 * BigInt-safe JSON.parse replacement.
 */
export function safeParse<T = unknown>(jsonString: string): T {
  try {
    return JSON.parse(jsonString, (_key, value) => decodeTaggedJson(value)) as T;
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${(err as Error).message}`);
  }
}

/**
 * Universal Buffer comparison (works in both Node.js and browser).
 */
export function bufferCompare(buf1: Buffer, buf2: Buffer): number {
  if (typeof Buffer !== 'undefined' && Buffer.compare) {
    return Buffer.compare(buf1, buf2);
  }
  const hex1 = buf1.toString('hex');
  const hex2 = buf2.toString('hex');
  if (hex1 === hex2) return 0;
  return hex1 < hex2 ? -1 : 1;
}

/**
 * Universal Buffer equality check.
 */
export function buffersEqual(buf1: Buffer, buf2: Buffer): boolean {
  return bufferCompare(buf1, buf2) === 0;
}

/**
 * Deterministic JSON snapshot codec for runtime persistence.
 * Preserves BigInt/Map/Set/Uint8Array/Buffer across save/load.
 */
export function serializeTaggedJson(input: unknown, excludeKeys?: ReadonlySet<string>): string {
  return stringifyCanonical(input, excludeKeys === undefined ? {} : { excludeKeys });
}

export function deserializeTaggedJson<T = unknown>(json: string): T {
  return safeParse<T>(json);
}
