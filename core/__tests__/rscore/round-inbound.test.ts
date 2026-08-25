import { describe, expect, test } from 'bun:test';

import { inboundSlice, indexInboundWave } from '../../rscore/round/inbound';
import type { Wave } from '../../rscore/wave-decode';

const ACCOUNT_A = `0x${'aa'.repeat(32)}`;
const ACCOUNT_B = `0x${'bb'.repeat(32)}`;

const waveWithApplied = (...rows: Wave['applied']): Wave => ({
  revision: 1,
  accountsRoot: `0x${'11'.repeat(32)}`,
  applied: rows,
  admissions: [],
  proposals: [],
  touched: [],
  postAccounts: [],
  parityDigest: `0x${'22'.repeat(32)}`,
  engineMicros: 0,
});

describe('rscore inbound wave index', () => {
  test('binds an operation in O(1) without changing its verdict', () => {
    const first = { operationIndex: 3, accountId: ACCOUNT_A, verdict: { kind: 'duplicate' } };
    const second = { operationIndex: 9, accountId: ACCOUNT_B, verdict: { kind: 'duplicate' } };
    const wave = waveWithApplied(
      first as unknown as Wave['applied'][number],
      second as unknown as Wave['applied'][number],
    );

    expect(inboundSlice(wave, ACCOUNT_B, 9, indexInboundWave(wave)).applied).toEqual([second]);
  });

  test('rejects a duplicate operation index before it can overwrite a verdict', () => {
    const row = { operationIndex: 3, accountId: ACCOUNT_A, verdict: { kind: 'duplicate' } };
    const wave = waveWithApplied(
      row as unknown as Wave['applied'][number],
      { ...row, accountId: ACCOUNT_B } as unknown as Wave['applied'][number],
    );

    expect(() => indexInboundWave(wave)).toThrow('RSCORE_ROUND_INDEX_DUPLICATE');
  });
});
