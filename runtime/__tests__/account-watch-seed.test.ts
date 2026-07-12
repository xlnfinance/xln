import { describe, expect, test } from 'bun:test';
import { deriveAccountWatchSeed } from '../account/watch-seed';

const ENTITY_A = `0x${'11'.repeat(32)}`;
const ENTITY_B = `0x${'22'.repeat(32)}`;
const ENTITY_C = `0x${'33'.repeat(32)}`;

describe('account watch seed derivation', () => {
  test('is stable across retry and recovery timestamps for the same runtime pair', () => {
    const first = deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-a',
      runtimeId: '0xruntime',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_B,
      timestamp: 1,
    });
    const retriedAfterRestore = deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-a',
      runtimeId: '0xruntime',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_B,
      timestamp: 999_999,
    });

    expect(retriedAfterRestore).toBe(first);
  });

  test('still separates runtime secret, runtime id, and account pair', () => {
    const base = deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-a',
      runtimeId: '0xruntime-a',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_B,
      timestamp: 0,
    });

    expect(deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-b',
      runtimeId: '0xruntime-a',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_B,
      timestamp: 0,
    })).not.toBe(base);
    expect(deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-a',
      runtimeId: '0xruntime-b',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_B,
      timestamp: 0,
    })).not.toBe(base);
    expect(deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-a',
      runtimeId: '0xruntime-a',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_C,
      timestamp: 0,
    })).not.toBe(base);
  });
});
