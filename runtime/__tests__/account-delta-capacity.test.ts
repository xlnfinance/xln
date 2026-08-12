import { expect, test } from 'bun:test';

import { validateAccountDeltas } from '../account/validation/delta-validation';
import { createDefaultDelta } from '../account/state/delta';
import { ensureDelta } from '../account/tx/delta-utils';
import { LIMITS } from '../config/constants';
import type { AccountState } from '../types/account';

test('Account accepts exactly the on-chain enforceable Delta row limit', () => {
  const account = { deltas: new Map() } as AccountState;
  for (let tokenId = 1; tokenId <= LIMITS.MAX_ACCOUNT_TOKEN_ROWS; tokenId += 1) {
    ensureDelta(account, tokenId);
  }
  expect(account.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
  expect(() => ensureDelta(account, LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1))
    .toThrow(
      `ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:` +
      `${LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1}:${LIMITS.MAX_ACCOUNT_TOKEN_ROWS}`,
    );
  expect(account.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
});

test('Account restore rejects an oversized Delta map before accepting partial state', () => {
  const oversized = new Map(
    Array.from(
      { length: LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1 },
      (_, index) => [index + 1, createDefaultDelta(index + 1)],
    ),
  );
  expect(() => validateAccountDeltas(oversized, 'restore'))
    .toThrow(
      `ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:restore:` +
      `${LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1}:${LIMITS.MAX_ACCOUNT_TOKEN_ROWS}`,
    );
});
