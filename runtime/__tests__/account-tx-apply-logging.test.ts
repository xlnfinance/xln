import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyAccountTx } from '../account/tx/apply';
import type { AccountMachine, AccountTx } from '../types';

const makeAccount = (): AccountMachine => ({
  proofHeader: { fromEntity: 'left', toEntity: 'right', nextProofNonce: 3 },
  leftEntityId: 'left',
  rightEntityId: 'right',
  status: 'active',
  deltas: new Map(),
  collateral: new Map(),
  requestedRebalance: new Map(),
  consensusConfig: { threshold: 1, validators: ['left'] },
  currentHeight: 0,
  mempool: [],
  frameHistory: [],
} as unknown as AccountMachine);

test('applyAccountTx rejects account_frame without direct console output', async () => {
  const originalError = console.error;
  let errored = false;
  console.error = () => {
    errored = true;
  };

  try {
    const result = await applyAccountTx(
      makeAccount(),
      { type: 'account_frame' } as unknown as AccountTx,
      true,
    );

    expect(result).toEqual({
      success: false,
      error: 'account_frame is not a transaction type',
      events: [],
    });
    expect(errored).toBe(false);
  } finally {
    console.error = originalError;
  }
});

test('account tx applicator uses structured logging only for account_frame rejection', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/account/tx/apply.ts'), 'utf8');

  expect(source).toContain("createStructuredLogger('account.tx')");
  expect(source).toContain("accountTxLog.debug('account_frame.rejected'");
  expect(source).not.toContain('console.error');
});
