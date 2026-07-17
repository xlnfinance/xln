import { ethers } from 'ethers';

import { compareStableText, safeParse, safeStringify } from '../protocol/serialization';

const DEFAULT_MAX_VALUE_CHARS = 320;
const MIN_MAX_VALUE_CHARS = 32;
const MAX_MAX_VALUE_CHARS = 4_096;

export type RuntimeStateDiffValue = {
  type: string;
  value: string;
  totalChars: number;
};

export type RuntimeStateFirstDifference = {
  path: string;
  reason:
    | 'missing-left'
    | 'missing-right'
    | 'type-mismatch'
    | 'value-mismatch';
  left: RuntimeStateDiffValue;
  right: RuntimeStateDiffValue;
};

export type RuntimeStateDiffReport = {
  equal: boolean;
  leftHash: string;
  rightHash: string;
  leftCanonicalBytes: number;
  rightCanonicalBytes: number;
  firstDifference: RuntimeStateFirstDifference | null;
};

export type RuntimeStateDiffOptions = {
  maxValueChars?: number;
};

type MapEntry = {
  key: unknown;
  value: unknown;
  keyText: string;
  valueText: string;
};

const missingValue = (): RuntimeStateDiffValue => ({
  type: 'missing',
  value: '<missing>',
  totalChars: 0,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const canonicalHash = (canonical: string): string =>
  ethers.keccak256(ethers.toUtf8Bytes(canonical));

const canonicalBytes = (canonical: string): number =>
  new TextEncoder().encode(canonical).byteLength;

const valueType = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return 'Buffer';
  if (ArrayBuffer.isView(value)) return value.constructor.name;
  if (value instanceof Date) return 'Date';
  if (value instanceof Map) return 'Map';
  if (value instanceof Set) return 'Set';
  if (Array.isArray(value)) return 'Array';
  return typeof value === 'object' ? 'Object' : typeof value;
};

const boundedText = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const marker = '…<truncated>…';
  const available = maxChars - marker.length;
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
};

const describeValue = (value: unknown, maxChars: number): RuntimeStateDiffValue => {
  const canonical = safeStringify(value);
  return {
    type: valueType(value),
    value: boundedText(canonical, maxChars),
    totalChars: canonical.length,
  };
};

const difference = (
  path: string,
  reason: RuntimeStateFirstDifference['reason'],
  left: unknown,
  right: unknown,
  maxChars: number,
): RuntimeStateFirstDifference => ({
  path,
  reason,
  left: reason === 'missing-left' ? missingValue() : describeValue(left, maxChars),
  right: reason === 'missing-right' ? missingValue() : describeValue(right, maxChars),
});

const objectPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;

const mapPath = (path: string, key: unknown): string =>
  `${path}{${boundedText(safeStringify(key), 96)}}`;

const sortedMapEntries = (value: Map<unknown, unknown>): MapEntry[] =>
  Array.from(value.entries(), ([key, entryValue]) => ({
    key,
    value: entryValue,
    keyText: safeStringify(key),
    valueText: safeStringify(entryValue),
  })).sort((left, right) =>
    compareStableText(left.keyText, right.keyText) || compareStableText(left.valueText, right.valueText));

const sortedSetValues = (value: Set<unknown>): Array<{ value: unknown; text: string }> =>
  Array.from(value, (entry) => ({ value: entry, text: safeStringify(entry) }))
    .sort((left, right) => compareStableText(left.text, right.text));

const findMapDifference = (
  left: Map<unknown, unknown>,
  right: Map<unknown, unknown>,
  path: string,
  maxChars: number,
): RuntimeStateFirstDifference | null => {
  const leftEntries = sortedMapEntries(left);
  const rightEntries = sortedMapEntries(right);
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftEntries.length || rightIndex < rightEntries.length) {
    const leftEntry = leftEntries[leftIndex];
    const rightEntry = rightEntries[rightIndex];
    if (!leftEntry) return difference(mapPath(path, rightEntry!.key), 'missing-left', undefined, rightEntry!.value, maxChars);
    if (!rightEntry) return difference(mapPath(path, leftEntry.key), 'missing-right', leftEntry.value, undefined, maxChars);
    if (leftEntry.keyText < rightEntry.keyText) {
      return difference(mapPath(path, leftEntry.key), 'missing-right', leftEntry.value, undefined, maxChars);
    }
    if (leftEntry.keyText > rightEntry.keyText) {
      return difference(mapPath(path, rightEntry.key), 'missing-left', undefined, rightEntry.value, maxChars);
    }
    const nested = findFirstDifference(leftEntry.value, rightEntry.value, mapPath(path, leftEntry.key), maxChars);
    if (nested) return nested;
    leftIndex += 1;
    rightIndex += 1;
  }
  return null;
};

const findSetDifference = (
  left: Set<unknown>,
  right: Set<unknown>,
  path: string,
  maxChars: number,
): RuntimeStateFirstDifference | null => {
  const leftValues = sortedSetValues(left);
  const rightValues = sortedSetValues(right);
  const limit = Math.max(leftValues.length, rightValues.length);
  for (let index = 0; index < limit; index += 1) {
    const leftEntry = leftValues[index];
    const rightEntry = rightValues[index];
    if (!leftEntry) return difference(`${path}<${index}>`, 'missing-left', undefined, rightEntry!.value, maxChars);
    if (!rightEntry) return difference(`${path}<${index}>`, 'missing-right', leftEntry.value, undefined, maxChars);
    if (leftEntry.text !== rightEntry.text) {
      return difference(`${path}<${index}>`, 'value-mismatch', leftEntry.value, rightEntry.value, maxChars);
    }
  }
  return null;
};

const findArrayDifference = (
  left: unknown[],
  right: unknown[],
  path: string,
  maxChars: number,
): RuntimeStateFirstDifference | null => {
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const itemPath = `${path}[${index}]`;
    if (index >= left.length) return difference(itemPath, 'missing-left', undefined, right[index], maxChars);
    if (index >= right.length) return difference(itemPath, 'missing-right', left[index], undefined, maxChars);
    const nested = findFirstDifference(left[index], right[index], itemPath, maxChars);
    if (nested) return nested;
  }
  return null;
};

const findObjectDifference = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  path: string,
  maxChars: number,
): RuntimeStateFirstDifference | null => {
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort(compareStableText);
  for (const key of keys) {
    const itemPath = objectPath(path, key);
    if (!Object.prototype.hasOwnProperty.call(left, key)) {
      return difference(itemPath, 'missing-left', undefined, right[key], maxChars);
    }
    if (!Object.prototype.hasOwnProperty.call(right, key)) {
      return difference(itemPath, 'missing-right', left[key], undefined, maxChars);
    }
    const nested = findFirstDifference(left[key], right[key], itemPath, maxChars);
    if (nested) return nested;
  }
  return null;
};

const findFirstDifference = (
  left: unknown,
  right: unknown,
  path: string,
  maxChars: number,
): RuntimeStateFirstDifference | null => {
  const leftType = valueType(left);
  const rightType = valueType(right);
  if (leftType !== rightType) return difference(path, 'type-mismatch', left, right, maxChars);
  if (left instanceof Map && right instanceof Map) return findMapDifference(left, right, path, maxChars);
  if (left instanceof Set && right instanceof Set) return findSetDifference(left, right, path, maxChars);
  if (Array.isArray(left) && Array.isArray(right)) return findArrayDifference(left, right, path, maxChars);
  if (leftType === 'Object') {
    return findObjectDifference(left as Record<string, unknown>, right as Record<string, unknown>, path, maxChars);
  }
  if (safeStringify(left) === safeStringify(right)) return null;
  return difference(path, 'value-mismatch', left, right, maxChars);
};

const resolveMaxValueChars = (options: RuntimeStateDiffOptions): number => {
  const value = options.maxValueChars ?? DEFAULT_MAX_VALUE_CHARS;
  if (!Number.isSafeInteger(value) || value < MIN_MAX_VALUE_CHARS || value > MAX_MAX_VALUE_CHARS) {
    throw new Error(
      `RUNTIME_STATE_DIFF_MAX_VALUE_CHARS_INVALID: expected integer ${MIN_MAX_VALUE_CHARS}..${MAX_MAX_VALUE_CHARS}, got ${String(value)}`,
    );
  }
  return value;
};

export const buildRuntimeStateDiffReport = (
  left: unknown,
  right: unknown,
  options: RuntimeStateDiffOptions = {},
): RuntimeStateDiffReport => {
  const maxChars = resolveMaxValueChars(options);
  const leftCanonical = safeStringify(left);
  const rightCanonical = safeStringify(right);
  const equal = leftCanonical === rightCanonical;
  const firstDifference = equal ? null : findFirstDifference(left, right, '$', maxChars);
  if (!equal && !firstDifference) {
    throw new Error('RUNTIME_STATE_DIFF_INTERNAL_MISMATCH: canonical bytes differ without a structural difference');
  }
  return {
    equal,
    leftHash: canonicalHash(leftCanonical),
    rightHash: canonicalHash(rightCanonical),
    leftCanonicalBytes: canonicalBytes(leftCanonical),
    rightCanonicalBytes: canonicalBytes(rightCanonical),
    firstDifference,
  };
};

const parseRuntimeStateJson = (json: string, side: 'LEFT' | 'RIGHT'): unknown => {
  try {
    const value = safeParse(json);
    safeStringify(value);
    return value;
  } catch (error) {
    throw new Error(`RUNTIME_STATE_DIFF_${side}_JSON_INVALID: ${errorMessage(error)}`, { cause: error });
  }
};

export const buildRuntimeStateDiffReportFromJson = (
  leftJson: string,
  rightJson: string,
  options: RuntimeStateDiffOptions = {},
): RuntimeStateDiffReport => buildRuntimeStateDiffReport(
  parseRuntimeStateJson(leftJson, 'LEFT'),
  parseRuntimeStateJson(rightJson, 'RIGHT'),
  options,
);
