import { expect, test } from 'bun:test';

import {
  isWalletFinancialCommandPending,
  runWalletIntentOnce,
  submitWalletFinancialCommandSequence,
} from '../../frontend/apps/wallet/src/features/accounts/wallet-financial-actions';

test('one confirmed wallet intent cannot execute concurrently twice and releases after completion', async () => {
  let release!: () => void;
  let executions = 0;
  const pending = runWalletIntentOnce('same-intent', async () => {
    executions += 1;
    await new Promise<void>(resolve => { release = resolve; });
  });
  await Promise.resolve();
  expect(isWalletFinancialCommandPending('same-intent')).toBe(true);
  await expect(runWalletIntentOnce('same-intent', async () => { executions += 1; })).rejects.toThrow(
    'WALLET_COMMAND_ALREADY_PENDING:same-intent',
  );
  expect(executions).toBe(1);
  release();
  await pending;
  expect(isWalletFinancialCommandPending('same-intent')).toBe(false);
  await runWalletIntentOnce('same-intent', async () => { executions += 1; });
  expect(executions).toBe(2);
});

test('failed wallet intent releases its guard without swallowing the error', async () => {
  await expect(runWalletIntentOnce('failed-intent', async () => {
    throw new Error('runtime-rejected');
  })).rejects.toThrow('runtime-rejected');
  expect(isWalletFinancialCommandPending('failed-intent')).toBe(false);
});

test('financial command sequences reject an empty logical intent before mutation', async () => {
  await expect(submitWalletFinancialCommandSequence('empty-sequence', [])).rejects.toThrow(
    'WALLET_COMMAND_SEQUENCE_EMPTY',
  );
});
