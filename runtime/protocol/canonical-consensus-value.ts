import { ethers } from 'ethers';

import { compareStableText } from './serialization';

type CanonicalStack = Map<object, string>;

const canonicalBytes = (value: ArrayBufferView): string => {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return ethers.hexlify(bytes);
};

const assertNoOwnExtensions = (
  value: object,
  allowedStringKeys: ReadonlySet<string> = new Set(),
): void => {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error('ENTITY_STATE_ROOT_SYMBOL_KEY');
    if (!allowedStringKeys.has(key)) throw new Error(`ENTITY_STATE_ROOT_EXTRA_PROPERTY:${key}`);
  }
};

const objectChildPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;

const quotedCanonicalText = (value: string): string => JSON.stringify(value);

/**
 * Strict byte encoder shared by every consensus layer.
 *
 * Ordinary JSON silently erases or normalizes several JavaScript values. That
 * is unsafe for hashes, signatures and deterministic comparisons, so this
 * codec rejects them instead. Historical ENTITY_STATE_ROOT_* diagnostics stay
 * stable because changing either bytes or error identities is a protocol
 * migration, not a refactor.
 */
export const encodeCanonicalConsensusValue = (
  value: unknown,
  stack: CanonicalStack = new Map(),
  path = '$',
): string => {
  if (value === null) return '["Null"]';
  if (value === undefined) return '["Undefined"]';
  if (typeof value === 'string') return `["String",${quotedCanonicalText(value)}]`;
  if (typeof value === 'boolean') return `["Boolean",${value ? 'true' : 'false'}]`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`ENTITY_STATE_ROOT_NON_FINITE_NUMBER:${String(value)}`);
    return `["Number",${quotedCanonicalText(Object.is(value, -0) ? '-0' : String(value))}]`;
  }
  if (typeof value === 'bigint') return `["BigInt",${quotedCanonicalText(value.toString())}]`;
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`ENTITY_STATE_ROOT_UNSUPPORTED_VALUE:${typeof value}`);
  }
  if (value instanceof Date) {
    assertNoOwnExtensions(value);
    return `["Date",${quotedCanonicalText(value.toISOString())}]`;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    assertNoOwnExtensions(
      value,
      new Set(Array.from({ length: value.length }, (_, index) => String(index))),
    );
    return `["Buffer",${quotedCanonicalText(canonicalBytes(value))}]`;
  }
  if (ArrayBuffer.isView(value)) {
    const byteView = value as ArrayBufferView & { length?: number };
    const allowed = new Set(Array.from({ length: byteView.length ?? 0 }, (_, index) => String(index)));
    assertNoOwnExtensions(value, allowed);
    return `["TypedArray",${quotedCanonicalText(value.constructor.name)},${quotedCanonicalText(canonicalBytes(value))}]`;
  }

  const object = value as object;
  const ancestorPath = stack.get(object);
  if (ancestorPath) throw new Error(`ENTITY_STATE_ROOT_CYCLE:path=${path}:ancestor=${ancestorPath}`);
  stack.set(object, path);
  try {
    if (value instanceof Map) {
      assertNoOwnExtensions(value);
      const entries = Array.from(value.entries()).map(([key, entry], index) => ({
        key: encodeCanonicalConsensusValue(key, stack, `${path}.<map-key:${index}>`),
        value: encodeCanonicalConsensusValue(entry, stack, `${path}.<map-value:${index}>`),
      }));
      entries.sort((left, right) => {
        const byKey = compareStableText(left.key, right.key);
        return byKey !== 0 ? byKey : compareStableText(left.value, right.value);
      });
      return `["Map",[${entries.map(entry => `[${entry.key},${entry.value}]`).join(',')}]]`;
    }
    if (value instanceof Set) {
      assertNoOwnExtensions(value);
      const entries = Array.from(value.values())
        .map((entry, index) => encodeCanonicalConsensusValue(entry, stack, `${path}.<set:${index}>`))
        .sort(compareStableText);
      return `["Set",[${entries.join(',')}]]`;
    }
    if (Array.isArray(value)) {
      const allowedKeys = new Set<string>(['length']);
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          throw new Error(`ENTITY_STATE_ROOT_SPARSE_ARRAY:index=${index}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error(`ENTITY_STATE_ROOT_ARRAY_DESCRIPTOR_INVALID:index=${index}`);
        }
        entries.push(encodeCanonicalConsensusValue(descriptor.value, stack, `${path}[${index}]`));
      }
      assertNoOwnExtensions(value, allowedKeys);
      return `["Array",[${entries.join(',')}]]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`ENTITY_STATE_ROOT_UNSUPPORTED_OBJECT:${Object.prototype.toString.call(value)}`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key === 'symbol')) throw new Error('ENTITY_STATE_ROOT_SYMBOL_KEY');
    const properties = (keys as string[]).sort(compareStableText).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error(`ENTITY_STATE_ROOT_OBJECT_DESCRIPTOR_INVALID:key=${key}`);
      }
      const encoded = encodeCanonicalConsensusValue(
        descriptor.value,
        stack,
        objectChildPath(path, key),
      );
      return `[${quotedCanonicalText(key)},${encoded}]`;
    });
    return `[${prototype === null ? '"NullObject"' : '"Object"'},[${properties.join(',')}]]`;
  } finally {
    stack.delete(object);
  }
};
