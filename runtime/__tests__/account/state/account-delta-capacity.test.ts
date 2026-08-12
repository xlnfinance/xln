import { expect, test } from 'bun:test';

import { validateAccountDeltas } from '../../../account/validation/delta-validation';
import { createDefaultDelta } from '../../../account/state/delta';
import { ensureDelta } from '../../../account/tx/delta-utils';
import { handleAddDelta } from '../../../account/tx/handlers/balance/add-delta';
import { decodeAccountFrame } from '../../../account/validation/frame-validation';
import { decodeAccountTx } from '../../../account/tx-validation';
import { LIMITS, TOKENS } from '../../../config/constants';
import type { AccountState } from '../../../types/account';

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

test('add_delta rejects a 129th row at the mutation sink without throwing or mutation', () => {
  const account = {
    deltas: new Map(
      Array.from(
        { length: LIMITS.MAX_ACCOUNT_TOKEN_ROWS },
        (_, index) => [index + 1, createDefaultDelta(index + 1)],
      ),
    ),
  } as AccountState;
  const result = handleAddDelta(
    account,
    { type: 'add_delta', data: { tokenId: LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1 } },
  );
  expect(result).toEqual({
    success: false,
    events: [
      `ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:` +
      `${LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1}:${LIMITS.MAX_ACCOUNT_TOKEN_ROWS}`,
    ],
    error:
      `ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:` +
      `${LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1}:${LIMITS.MAX_ACCOUNT_TOKEN_ROWS}`,
  });
  expect(account.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
});

test('add_delta boundary and mutation sink reject token ids outside the canonical domain', () => {
  const account = { deltas: new Map() } as AccountState;
  expect(() => decodeAccountTx(
    { type: 'add_delta', data: { tokenId: TOKENS.MAX_TOKEN_ID + 1 } },
    'peer-add-delta',
  )).toThrow('peer-add-delta_DATA_TOKENID_DOMAIN');
  const result = handleAddDelta(
    account,
    { type: 'add_delta', data: { tokenId: TOKENS.MAX_TOKEN_ID + 1 } },
  );
  expect(result.success).toBe(false);
  expect(result.error).toBe(`ACCOUNT_DELTA_TOKEN_INVALID:${TOKENS.MAX_TOKEN_ID + 1}`);
  expect(account.deltas.size).toBe(0);
});

test('Account frame decoder rejects 129 financial rows before replay', () => {
  const frame = {
    height: 1,
    timestamp: 1,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    stateHash: `0x${'11'.repeat(32)}`,
    accountStateRoot: `0x${'22'.repeat(32)}`,
    byLeft: true,
    deltas: Array.from(
      { length: LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1 },
      (_, index) => createDefaultDelta(index + 1),
    ),
  };
  expect(() => decodeAccountFrame(frame, 'peer-frame')).toThrow(
    `ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:peer-frame.deltas:` +
    `${LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1}:${LIMITS.MAX_ACCOUNT_TOKEN_ROWS}`,
  );
});
