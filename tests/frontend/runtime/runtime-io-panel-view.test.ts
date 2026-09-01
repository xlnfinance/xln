import { describe, expect, test } from 'bun:test';

import type { EnvSnapshot } from '../../../core/api/public/runtime-module';
import {
  RUNTIME_IO_ALL_CATEGORIES,
  RUNTIME_IO_ALL_LEVELS,
  countEntries,
  filterRuntimeIoLogs,
  formatBigInt,
  mapToArray,
  selectRuntimeIoFrame,
  sumRuntimeIoCollateral,
  sumRuntimeIoReserves,
  toBigIntValue,
  valuesOf,
} from '../../../frontend/packages/runtime-client/src/runtime-io-panel-view';

const log = (level: 'trace' | 'debug' | 'info' | 'warn' | 'error', category: 'consensus' | 'account' | 'evm', message: string) =>
  ({ level, category, message }) as never;

const frame = (overrides: Record<string, unknown>): EnvSnapshot => ({ gossip: undefined, ...overrides } as never);

describe('runtime io panel view model', () => {
  test('normalizes Map and Record shapes identically', () => {
    const asMap = new Map([['e1', { v: 1 }], ['e2', { v: 2 }]]);
    const asRecord = { e1: { v: 1 }, e2: { v: 2 } };
    expect(mapToArray(asMap)).toEqual([['e1', { v: 1 }], ['e2', { v: 2 }]]);
    expect(mapToArray(asRecord)).toEqual([['e1', { v: 1 }], ['e2', { v: 2 }]]);
    expect(valuesOf(asMap)).toEqual([{ v: 1 }, { v: 2 }]);
    expect(valuesOf(asRecord)).toEqual([{ v: 1 }, { v: 2 }]);
    expect(mapToArray(undefined)).toEqual([]);
    expect(valuesOf(undefined)).toEqual([]);
    expect(countEntries(new Map([['a', 1]]))).toBe(1);
    expect(countEntries([1, 2])).toBe(2);
    expect(countEntries({ a: 1, b: 2 })).toBe(2);
    expect(countEntries(null)).toBe(0);
  });

  test('coerces bigint values tolerantly and formats them for display', () => {
    expect(toBigIntValue(5n)).toBe(5n);
    expect(toBigIntValue(7.9)).toBe(7n);
    expect(toBigIntValue('-12')).toBe(-12n);
    expect(toBigIntValue('not-a-number')).toBe(0n);
    expect(toBigIntValue(undefined)).toBe(0n);
    expect(formatBigInt(5n)).toBe('5n');
    expect(formatBigInt(5)).toBe('5');
    expect(formatBigInt(null)).toBe('null');
  });

  test('selects the external frame for the time index exactly like the canonical panel', () => {
    const history = [frame({ id: 0 }), frame({ id: 1 }), frame({ id: 2 })];
    expect(selectRuntimeIoFrame(history, 1)?.['id']).toBe(1);
    // Out-of-range indices clamp to the newest frame; live view selects nothing.
    expect(selectRuntimeIoFrame(history, 99)?.['id']).toBe(2);
    expect(selectRuntimeIoFrame(history, -1)).toBe(null);
    expect(selectRuntimeIoFrame(history, null)).toBe(null);
    expect(selectRuntimeIoFrame(undefined, 0)).toBe(null);
    expect(selectRuntimeIoFrame([], 0)).toBe(null);
  });

  test('filters frame logs by level, category, and case-insensitive search', () => {
    const logs = [
      log('info', 'consensus', 'Frame committed'),
      log('debug', 'account', 'DEBUG detail'),
      log('warn', 'evm', 'Reorg depth exceeded'),
    ];
    const levels = new Set(['info', 'warn'] as const);
    const categories = new Set(['consensus', 'account', 'evm'] as const);
    expect(filterRuntimeIoLogs(logs, levels, categories, '')).toHaveLength(2);
    expect(filterRuntimeIoLogs(logs, levels, categories, 'reorg')).toEqual([logs[2]]);
    expect(filterRuntimeIoLogs(logs, new Set(['debug']), categories, 'debug')).toEqual([logs[1]]);
    expect(filterRuntimeIoLogs(logs, levels, new Set(['account']), '')).toEqual([]);
    expect(RUNTIME_IO_ALL_LEVELS).toHaveLength(5);
    expect(RUNTIME_IO_ALL_CATEGORIES).toHaveLength(7);
  });

  test('projects reserves and collateral conservation across Map and Record shapes', () => {
    const mapFrame = frame({
      state: {
        eReplicas: new Map([
          ['e1', { state: { reserves: new Map([[1, 100n]]), accounts: new Map([['a', { state: { deltas: new Map([[0, { collateral: 40n }]]) } }]]) } }],
          ['e2', { state: { reserves: { 2: '60' }, accounts: { b: { state: { deltas: { 0: { collateral: 15 } } } } } } }],
        ]),
      },
    });
    expect(sumRuntimeIoReserves(mapFrame)).toBe(160n);
    expect(sumRuntimeIoCollateral(mapFrame)).toBe(55n);
    expect(sumRuntimeIoReserves(null)).toBe(0n);
    expect(sumRuntimeIoCollateral(null)).toBe(0n);
  });
});
