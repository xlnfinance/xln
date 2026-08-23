import { ethers } from 'ethers';
import { countOpWithSite, OP_COUNTERS_ENABLED } from '../../support/performance/op-counters';
import { getPerfMs } from '../../support/time';
import { RecencyMemo } from '../../support/recency-memo';

import { compareStableText } from './';

/**
 * Cycle guard plus the ancestry needed to name a path in a diagnostic.
 * Segments are pushed as encoding descends and only joined on error, so the
 * hot path never builds path strings.
 */
type CanonicalStack = {
  readonly ancestors: Map<object, number>;
  readonly segments: string[];
};

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

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Segments are stored raw: object property keys as the key itself, every
 * other segment (array index, map/set position) pre-formatted behind a
 * marker byte. Formatting happens only when a diagnostic is built.
 */
const FORMATTED_SEGMENT = '\u0000';

/** Path text of the current position: `$` followed by every pushed segment. */
const describePath = (segments: readonly string[], upTo = segments.length): string => {
  let path = '$';
  for (let index = 0; index < upTo; index += 1) {
    const segment = segments[index]!;
    path += segment.charCodeAt(0) === 0 ? segment.slice(1) : objectChildSegment(segment);
  }
  return path;
};

const objectChildSegment = (key: string): string =>
  IDENTIFIER_KEY.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;

const quotedCanonicalText = (value: string): string => JSON.stringify(value);

// Property names repeat across every encoded value; quoting is pure.
const QUOTED_KEY_MEMO_MAX = 4096;
const quotedKeys = new Map<string, string>();
const quotedKey = (key: string): string => {
  let quoted = quotedKeys.get(key);
  if (quoted === undefined) {
    quoted = JSON.stringify(key);
    if (quotedKeys.size >= QUOTED_KEY_MEMO_MAX) quotedKeys.clear();
    quotedKeys.set(key, quoted);
  }
  return quoted;
};

const newStack = (): CanonicalStack => ({ ancestors: new Map(), segments: [] });

/**
 * Strict byte encoder shared by every consensus layer.
 *
 * Ordinary JSON silently erases or normalizes several JavaScript values. That
 * is unsafe for hashes, signatures and deterministic comparisons, so this
 * codec rejects them instead. Historical ENTITY_STATE_ROOT_* diagnostics stay
 * stable because changing either bytes or error identities is a protocol
 * migration, not a refactor.
 */
/**
 * Immutable arrays whose canonical encoding is already known. A sealed Entity
 * frame's tx array is encoded by wire fitting, the frame hash, the wire
 * estimate and the storage validators: the same multi-megabyte walk several
 * times per frame. Registration is explicit and identity-keyed; the stored
 * length guards the one cheap mutation we can detect. Callers only register
 * arrays that are immutable by protocol (sealed frame txs).
 */
const preEncodedArrays = new RecencyMemo<readonly unknown[], { length: number; encoded: string }>(64);

export const rememberCanonicalArrayEncoding = (array: readonly unknown[], encoded: string): void => {
  // The registered array is frozen so its element set cannot drift behind the
  // cached bytes; element objects are sealed frame txs, immutable by protocol.
  Object.freeze(array);
  preEncodedArrays.set(array, { length: array.length, encoded });
};

export const encodeCanonicalArrayOnce = (array: readonly unknown[]): string => {
  const hit = preEncodedArrays.get(array);
  if (hit && hit.length === array.length) return hit.encoded;
  const encoded = encodeCanonicalConsensusValue(array);
  rememberCanonicalArrayEncoding(array, encoded);
  return encoded;
};

export const encodeCanonicalConsensusValue = (value: unknown): string => {
  const startedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  const encoded = encodeUncached(value, newStack());
  countOpWithSite(
    'canonical.encode',
    encoded.length,
    1,
    OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - startedAt) * 1_000) : 0,
  );
  return encoded;
};

const encodeChild = (value: unknown, stack: CanonicalStack, segment: string): string => {
  stack.segments.push(segment);
  const encoded = encodeUncached(value, stack);
  stack.segments.pop();
  return encoded;
};

const encodeUncached = (value: unknown, stack: CanonicalStack): string => {
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
  const ancestorDepth = stack.ancestors.get(object);
  if (ancestorDepth !== undefined) {
    throw new Error(
      `ENTITY_STATE_ROOT_CYCLE:path=${describePath(stack.segments)}:ancestor=${describePath(stack.segments, ancestorDepth)}`,
    );
  }
  stack.ancestors.set(object, stack.segments.length);
  try {
    if (value instanceof Map) {
      assertNoOwnExtensions(value);
      const entries: Array<{ key: string; value: string }> = [];
      let index = 0;
      for (const [key, entry] of value.entries()) {
        entries.push({
          key: encodeChild(key, stack, `${FORMATTED_SEGMENT}.<map-key:${index}>`),
          value: encodeChild(entry, stack, `${FORMATTED_SEGMENT}.<map-value:${index}>`),
        });
        index += 1;
      }
      entries.sort((left, right) => {
        const byKey = compareStableText(left.key, right.key);
        return byKey !== 0 ? byKey : compareStableText(left.value, right.value);
      });
      let body = '';
      for (let position = 0; position < entries.length; position += 1) {
        const entry = entries[position]!;
        body += position === 0 ? `[${entry.key},${entry.value}]` : `,[${entry.key},${entry.value}]`;
      }
      return `["Map",[${body}]]`;
    }
    if (value instanceof Set) {
      assertNoOwnExtensions(value);
      const entries: string[] = [];
      let index = 0;
      for (const entry of value.values()) {
        entries.push(encodeChild(entry, stack, `${FORMATTED_SEGMENT}.<set:${index}>`));
        index += 1;
      }
      // Default sort compares UTF-16 code units, exactly compareStableText.
      entries.sort();
      return `["Set",[${entries.join(',')}]]`;
    }
    if (Array.isArray(value)) {
      const length = value.length;
      const preEncoded = preEncodedArrays.get(value);
      if (preEncoded && preEncoded.length === length) {
        countOpWithSite('canonical.encode.arrayHit', preEncoded.encoded.length, 2);
        return preEncoded.encoded;
      }
      // Own keys of a well-formed array: every index plus `length`.
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== length + 1 || Object.getOwnPropertySymbols(value).length !== 0) {
        return encodeArrayStrict(value, stack);
      }
      let body = '';
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          throw new Error(`ENTITY_STATE_ROOT_SPARSE_ARRAY:index=${index}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error(`ENTITY_STATE_ROOT_ARRAY_DESCRIPTOR_INVALID:index=${index}`);
        }
        const encoded = encodeChild(descriptor.value, stack, `${FORMATTED_SEGMENT}[${index}]`);
        body += index === 0 ? encoded : `,${encoded}`;
      }
      return `["Array",[${body}]]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`ENTITY_STATE_ROOT_UNSUPPORTED_OBJECT:${Object.prototype.toString.call(value)}`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('ENTITY_STATE_ROOT_SYMBOL_KEY');
    // Own enumerable string keys; a hidden (non-enumerable) key shows up as a
    // longer own-name list and is reported under its sorted position below.
    const keys = Object.keys(value);
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== keys.length) {
      names.sort();
      for (const key of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error(`ENTITY_STATE_ROOT_OBJECT_DESCRIPTOR_INVALID:key=${key}`);
        }
      }
    }
    keys.sort();
    let body = '';
    for (let position = 0; position < keys.length; position += 1) {
      const key = keys[position]!;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error(`ENTITY_STATE_ROOT_OBJECT_DESCRIPTOR_INVALID:key=${key}`);
      }
      const encoded = encodeChild(descriptor.value, stack, key.charCodeAt(0) === 0 ? FORMATTED_SEGMENT + objectChildSegment(key) : key);
      const property = `[${quotedKey(key)},${encoded}]`;
      body += position === 0 ? property : `,${property}`;
    }
    return `[${prototype === null ? '"NullObject"' : '"Object"'},[${body}]]`;
  } finally {
    stack.ancestors.delete(object);
  }
};

/** Arrays with extra own keys or symbols: reproduce the exact historical diagnostics. */
const encodeArrayStrict = (value: unknown[], stack: CanonicalStack): string => {
  const allowedKeys = new Set<string>(['length']);
  let body = '';
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
    const encoded = encodeChild(descriptor.value, stack, `${FORMATTED_SEGMENT}[${index}]`);
    body += index === 0 ? encoded : `,${encoded}`;
  }
  assertNoOwnExtensions(value, allowedKeys);
  return `["Array",[${body}]]`;
};
