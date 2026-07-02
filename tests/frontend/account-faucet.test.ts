import { describe, expect, test } from 'bun:test';

import {
  OFFCHAIN_FAUCET_REQUEST_TIMEOUT_MS,
  attachOffchainFaucetReceipt,
  reconcilePendingOffchainFaucets,
  type PendingOffchainFaucet,
} from '../../frontend/src/lib/components/Entity/account-faucet';

const pendingRequest = (): PendingOffchainFaucet => ({
  hubEntityId: '0xhub',
  tokenId: 1,
  amount: 100n,
  baselineOut: 0n,
  expectedOut: 100n,
  startedAt: 1_000,
  symbol: 'USDC',
});

describe('account faucet UI state', () => {
  test('keeps queue receipt metadata visible after faucet admission', () => {
    const pending = [pendingRequest()];

    const next = attachOffchainFaucetReceipt(pending, '0xhub:1', {
      requestId: 'offchain_1',
      status: 'queued',
      statusUrl: '/api/control/runtime-input/offchain_1/status',
      accountReady: false,
    });

    expect(next).toEqual([
      {
        ...pending[0],
        requestId: 'offchain_1',
        status: 'queued',
        statusUrl: '/api/control/runtime-input/offchain_1/status',
        accountReady: false,
      },
    ]);
  });

  test('faucet request timeout is short because server only queues input', () => {
    expect(OFFCHAIN_FAUCET_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  });

  test('pending faucet remains pending until capacity changes or timeout elapses', () => {
    const pending = [pendingRequest()];
    const reconciled = reconcilePendingOffchainFaucets(pending, 2_000, () => 0n);

    expect(reconciled.remaining).toEqual(pending);
    expect(reconciled.received).toEqual([]);
    expect(reconciled.timedOut).toEqual([]);
  });
});
