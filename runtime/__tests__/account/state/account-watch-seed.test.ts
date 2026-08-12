import { describe, expect, test } from 'bun:test';
import { deriveAccountWatchSeed } from '../../../protocol/identity/account-watch-seed';

const ENTITY_A = `0x${'11'.repeat(32)}`;
const ENTITY_B = `0x${'22'.repeat(32)}`;
const ENTITY_C = `0x${'33'.repeat(32)}`;

describe('account watch seed derivation', () => {
  // The type now carries this: with no time-varying input in the signature, a
  // re-derivation after retry, restart or recovery cannot differ. The test
  // remains as the executable statement of why that matters.
  test('is reproducible from identity alone, so recovery re-derives the same seed', () => {
    const first = deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-a',
      runtimeId: '0xruntime',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_B,
    });
    const retriedAfterRestore = deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-a',
      runtimeId: '0xruntime',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_B,
    });

    expect(retriedAfterRestore).toBe(first);
  });

  test('still separates runtime secret, runtime id, and account pair', () => {
    const base = deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-a',
      runtimeId: '0xruntime-a',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_B,
    });

    expect(deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-b',
      runtimeId: '0xruntime-a',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_B,
    })).not.toBe(base);
    expect(deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-a',
      runtimeId: '0xruntime-b',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_B,
    })).not.toBe(base);
    expect(deriveAccountWatchSeed({
      runtimeSeed: 'runtime-seed-a',
      runtimeId: '0xruntime-a',
      entityId: ENTITY_A,
      counterpartyId: ENTITY_C,
    })).not.toBe(base);
  });
});
