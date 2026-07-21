import { describe, expect, test } from 'bun:test';

import {
  OFFCHAIN_FAUCET_REQUEST_TIMEOUT_MS,
  faucetPendingKey,
} from '../../frontend/src/lib/components/Entity/account-faucet';

describe('account faucet UI state', () => {
  test('uses one canonical key only while the POST is in flight', () => {
    expect(faucetPendingKey('0xABCD', 1)).toBe('0xabcd:1');
  });

  test('faucet request timeout is short because server only queues input', () => {
    expect(OFFCHAIN_FAUCET_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  });

});
