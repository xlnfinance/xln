/**
 * Deterministic, BigInt-safe JSON stringification for frontend rendering.
 * Mirrors runtime serialization rules for the common built-in data structures
 * we surface in the UI.
 */

type JsonPrimitive = string | number | boolean | null;

type TaggedBigInt = { __xlnType: 'BigInt'; value: string };
type TaggedMap = { __xlnType: 'Map'; value: Array<[TaggedJsonValue, TaggedJsonValue]> };
type TaggedSet = { __xlnType: 'Set'; value: TaggedJsonValue[] };
type TaggedUint8Array = { __xlnType: 'Uint8Array'; value: number[] };
type TaggedDate = { __xlnType: 'Date'; value: string };
type TaggedJsonRecord = { [key: string]: TaggedJsonValue };

type TaggedJsonValue =
  | JsonPrimitive
  | TaggedBigInt
  | TaggedMap
  | TaggedSet
  | TaggedUint8Array
  | TaggedDate
  | TaggedJsonValue[]
  | TaggedJsonRecord;

const stableString = (value: TaggedJsonValue): string => JSON.stringify(value);

const compareTaggedValues = (left: TaggedJsonValue, right: TaggedJsonValue): number =>
  stableString(left).localeCompare(stableString(right));

const normalizeSerializableValue = (input: unknown, stack: object[]): TaggedJsonValue | undefined => {
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
  if (input instanceof Uint8Array) {
    return { __xlnType: 'Uint8Array', value: Array.from(input) };
  }

  const objectRef = input as object;
  if (stack.includes(objectRef)) return undefined;
  stack.push(objectRef);
  try {
    if (input instanceof Map) {
      const entries: Array<[TaggedJsonValue, TaggedJsonValue]> = [];
      for (const [rawKey, rawValue] of input.entries()) {
        const key = normalizeSerializableValue(rawKey, stack);
        const value = normalizeSerializableValue(rawValue, stack);
        if (key !== undefined && value !== undefined) {
          entries.push([key, value]);
        }
      }
      entries.sort((left, right) => {
        const keyCmp = compareTaggedValues(left[0], right[0]);
        if (keyCmp !== 0) return keyCmp;
        return compareTaggedValues(left[1], right[1]);
      });
      return { __xlnType: 'Map', value: entries };
    }

    if (input instanceof Set) {
      const values = Array.from(input.values())
        .map((value) => normalizeSerializableValue(value, stack))
        .filter((value): value is TaggedJsonValue => value !== undefined)
        .sort(compareTaggedValues);
      return { __xlnType: 'Set', value: values };
    }

    if (Array.isArray(input)) {
      return input.map((item) => normalizeSerializableValue(item, stack) ?? null);
    }

    const source = input as Record<string, unknown>;
    const result: TaggedJsonRecord = {};
    for (const key of Object.keys(source).sort((left, right) => left.localeCompare(right))) {
      const value = normalizeSerializableValue(source[key], stack);
      if (value !== undefined) result[key] = value;
    }
    return result;
  } finally {
    stack.pop();
  }
};

export function safeStringify(obj: unknown, space?: number): string {
  return JSON.stringify(normalizeSerializableValue(obj, []) ?? null, null, space);
}
