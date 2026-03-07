import { describe, expect, test } from 'bun:test';
import { deserializeTaggedJson, safeParse, safeStringify, serializeTaggedJson } from '../serialization-utils';
import { decode, encode } from '../snapshot-coder';

type RoundTripDiff = {
  path: string;
  reason: string;
  before?: string;
  after?: string;
};

const stringifyValue = (value: unknown): string => {
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return JSON.stringify(Array.from(value));
  try {
    return safeStringify(value);
  } catch {
    return String(value);
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set);

const collectRoundTripDiffs = (
  before: unknown,
  after: unknown,
  path = 'root',
  ignorePaths: ReadonlySet<string> = new Set(),
  diffs: RoundTripDiff[] = [],
): RoundTripDiff[] => {
  if (ignorePaths.has(path)) return diffs;

  if (before === after) return diffs;
  if (typeof before !== typeof after) {
    diffs.push({ path, reason: 'type-mismatch', before: typeof before, after: typeof after });
    return diffs;
  }
  if (before === null || after === null) {
    diffs.push({ path, reason: 'null-mismatch', before: stringifyValue(before), after: stringifyValue(after) });
    return diffs;
  }
  if (typeof before === 'bigint' || typeof before === 'string' || typeof before === 'number' || typeof before === 'boolean') {
    diffs.push({ path, reason: 'value-mismatch', before: stringifyValue(before), after: stringifyValue(after) });
    return diffs;
  }
  if (typeof before === 'function') {
    diffs.push({ path, reason: 'function-stripped', before: '[Function]', after: stringifyValue(after) });
    return diffs;
  }
  if (before instanceof Date && after instanceof Date) {
    if (before.toISOString() !== after.toISOString()) {
      diffs.push({ path, reason: 'date-mismatch', before: before.toISOString(), after: after.toISOString() });
    }
    return diffs;
  }
  if (before instanceof Uint8Array && after instanceof Uint8Array) {
    const left = Array.from(before);
    const right = Array.from(after);
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
      diffs.push({ path, reason: 'bytes-mismatch', before: stringifyValue(left), after: stringifyValue(right) });
    }
    return diffs;
  }
  if (Buffer.isBuffer(before) && Buffer.isBuffer(after)) {
    if (!before.equals(after)) {
      diffs.push({ path, reason: 'buffer-mismatch', before: stringifyValue(before), after: stringifyValue(after) });
    }
    return diffs;
  }
  if (before instanceof Map && after instanceof Map) {
    const beforeEntries = Array.from(before.entries()).sort((left, right) =>
      stringifyValue(left[0]).localeCompare(stringifyValue(right[0])),
    );
    const afterEntries = Array.from(after.entries()).sort((left, right) =>
      stringifyValue(left[0]).localeCompare(stringifyValue(right[0])),
    );
    if (beforeEntries.length !== afterEntries.length) {
      diffs.push({
        path,
        reason: 'map-size-mismatch',
        before: String(beforeEntries.length),
        after: String(afterEntries.length),
      });
    }
    const max = Math.max(beforeEntries.length, afterEntries.length);
    for (let index = 0; index < max; index += 1) {
      const left = beforeEntries[index];
      const right = afterEntries[index];
      if (!left || !right) continue;
      const keyPath = `${path}[${stringifyValue(left[0])}]`;
      collectRoundTripDiffs(left[0], right[0], `${keyPath}::key`, ignorePaths, diffs);
      collectRoundTripDiffs(left[1], right[1], keyPath, ignorePaths, diffs);
    }
    return diffs;
  }
  if (before instanceof Set && after instanceof Set) {
    const left = Array.from(before.values()).map(stringifyValue).sort();
    const right = Array.from(after.values()).map(stringifyValue).sort();
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
      diffs.push({ path, reason: 'set-mismatch', before: JSON.stringify(left), after: JSON.stringify(right) });
    }
    return diffs;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      diffs.push({ path, reason: 'array-size-mismatch', before: String(before.length), after: String(after.length) });
    }
    const max = Math.max(before.length, after.length);
    for (let index = 0; index < max; index += 1) {
      collectRoundTripDiffs(before[index], after[index], `${path}[${index}]`, ignorePaths, diffs);
    }
    return diffs;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      if (ignorePaths.has(childPath)) continue;
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      if (!hasBefore || !hasAfter) {
        diffs.push({
          path: childPath,
          reason: hasBefore ? 'missing-after' : 'missing-before',
          before: hasBefore ? stringifyValue(before[key]) : undefined,
          after: hasAfter ? stringifyValue(after[key]) : undefined,
        });
        continue;
      }
      collectRoundTripDiffs(before[key], after[key], childPath, ignorePaths, diffs);
    }
    return diffs;
  }

  diffs.push({ path, reason: 'unhandled-mismatch', before: stringifyValue(before), after: stringifyValue(after) });
  return diffs;
};

describe('serialization-utils', () => {
  test('serializes deterministically regardless of insertion order', () => {
    const left = {
      z: 1,
      a: new Map([
        ['b', 2n],
        ['a', 1n],
      ]),
      s: new Set(['b', 'a']),
    };
    const right = {
      s: new Set(['a', 'b']),
      a: new Map([
        ['a', 1n],
        ['b', 2n],
      ]),
      z: 1,
    };

    expect(safeStringify(left)).toBe(safeStringify(right));
    expect(serializeTaggedJson(left)).toBe(serializeTaggedJson(right));
  });

  test('round-trips typed values through tagged json and snapshot coder', () => {
    const payload = {
      amount: 12345678901234567890n,
      tags: new Set(['alpha', 'beta']),
      index: new Map<unknown, unknown>([
        ['count', 3n],
        [7, new Uint8Array([1, 2, 3])],
      ]),
      buffer: Buffer.from([9, 8, 7]),
      bytes: new Uint8Array([4, 5, 6]),
    };

    const json = serializeTaggedJson(payload);
    const restored = deserializeTaggedJson<typeof payload>(json);
    expect(restored.amount).toBe(payload.amount);
    expect(restored.tags).toEqual(payload.tags);
    expect(restored.index).toEqual(payload.index);
    expect(Buffer.from(restored.buffer)).toEqual(payload.buffer);
    expect(Array.from(restored.bytes)).toEqual(Array.from(payload.bytes));

    const snapshotRestored = decode<typeof payload>(encode(payload));
    expect(snapshotRestored).toEqual(restored);
  });

  test('rejects old legacy bigint string encoding', () => {
    const parsed = safeParse<{ amount: string }>('{"amount":"BigInt(5)"}');
    expect(parsed.amount).toBe('BigInt(5)');
  });

  test('reports stripped fields with deep round-trip diffs', () => {
    const payload = {
      keep: 1,
      drop: () => 'nope',
    };

    const restored = deserializeTaggedJson<{ keep: number }>(serializeTaggedJson(payload));
    const diffs = collectRoundTripDiffs(payload, restored);

    expect(diffs).toEqual([
      {
        path: 'root.drop',
        reason: 'missing-after',
        before: '[Function]',
        after: undefined,
      },
    ]);
  });

  test('round-trips persisted jReplica payloads without leaking dead jadapter objects', () => {
    const payload = {
      jReplicas: new Map([
        [
          'arrakis',
          {
            name: 'arrakis',
            blockNumber: 17n,
            stateRoot: new Uint8Array([1, 2, 3, 4]),
            mempool: [],
            blockDelayMs: 300,
            lastBlockTimestamp: 1234567890,
            position: { x: 1, y: 2, z: 3 },
            chainId: 31337,
            rpcs: ['http://127.0.0.1:8545'],
            depositoryAddress: '0x00000000000000000000000000000000000000aa',
            entityProviderAddress: '0x00000000000000000000000000000000000000bb',
            contracts: {
              depository: '0x00000000000000000000000000000000000000aa',
              entityProvider: '0x00000000000000000000000000000000000000bb',
            },
            jadapter: {
              mode: 'rpc',
              chainId: 31337,
              startWatching: () => {},
              stopWatching: () => {},
              submitTx: async () => ({ ok: true }),
            },
          },
        ],
      ]),
    };

    const restored = deserializeTaggedJson<typeof payload>(
      serializeTaggedJson(payload, new Set(['jadapter'])),
    );
    const diffs = collectRoundTripDiffs(
      payload,
      restored,
      'root',
      new Set(['root.jReplicas["arrakis"].jadapter']),
    );

    expect(diffs).toEqual([]);
    expect((restored.jReplicas.get('arrakis') as Record<string, unknown>)?.jadapter).toBeUndefined();
  });
});
