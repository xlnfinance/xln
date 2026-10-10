import { expect, test } from 'bun:test';

import { validateAccountDeltas } from '../../../account/validation/delta-validation';
import { createDefaultDelta } from '../../../account/state/delta';
import { commitDeltaDraft, createDeltaDraft } from '../../../account/tx/delta-utils';
import { beginAccountStateDraft } from '../../../account/state/account-state-draft';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { makeAccount } from '../../helpers/cross-j';
import { applyAccountTx } from '../../../account/tx/apply';
import { decodeAccountFrame } from '../../../account/validation/frame-validation';
import { decodeAccountTx } from '../../../account/tx-validation';
import { LIMITS, TOKENS } from '../../../config/constants';

const emptyReplicaDraft = () => {
  const base = makeAccount('alice', 'hub');
  base.state.deltas = PersistentAccountStateMap.empty('deltas');
  return beginAccountStateDraft(base).draft;
};
const emptyDraft = () => emptyReplicaDraft().state;

test('Account accepts exactly the on-chain enforceable Delta row limit', () => {
  const account = emptyDraft();
  for (let tokenId = 1; tokenId <= LIMITS.MAX_ACCOUNT_TOKEN_ROWS; tokenId += 1) {
    commitDeltaDraft(account, createDeltaDraft(account, tokenId));
  }
  expect(account.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
  expect(() => createDeltaDraft(account, LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1))
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

test('add_delta rejects a 129th row at the Account tx boundary without throwing or mutation', async () => {
  const draft = emptyReplicaDraft();
  const account = draft.state;
  for (let tokenId = 1; tokenId <= LIMITS.MAX_ACCOUNT_TOKEN_ROWS; tokenId += 1) {
    commitDeltaDraft(account, createDeltaDraft(account, tokenId));
  }
  const result = await applyAccountTx(
    draft,
    { type: 'add_delta', data: { tokenId: LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1 } },
    true,
  );
  expect(result).toEqual({
    ok: false,
    events: [
      `ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:` +
      `${LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1}:${LIMITS.MAX_ACCOUNT_TOKEN_ROWS}`,
    ],
    rejection: {
      kind: 'delta_row_limit_exceeded',
      code: 'ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED',
      message:
        `ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:` +
        `${LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1}:${LIMITS.MAX_ACCOUNT_TOKEN_ROWS}`,
    },
  });
  expect(account.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
});

test('add_delta boundary and Account tx boundary reject token ids outside the canonical domain', async () => {
  const draft = emptyReplicaDraft();
  const account = draft.state;
  expect(() => decodeAccountTx(
    { type: 'add_delta', data: { tokenId: TOKENS.MAX_TOKEN_ID + 1 } },
    'peer-add-delta',
  )).toThrow('peer-add-delta_DATA_TOKENID_DOMAIN');
  const result = await applyAccountTx(
    draft,
    { type: 'add_delta', data: { tokenId: TOKENS.MAX_TOKEN_ID + 1 } },
    true,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected add_delta rejection');
  expect(result.rejection.message).toBe(`ACCOUNT_DELTA_TOKEN_INVALID:${TOKENS.MAX_TOKEN_ID + 1}`);
  expect(account.deltas.size).toBe(0);
});

test('Account frame decoder rejects retired inline financial rows before replay', () => {
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
  // Frames commit accountStateRoot; obsolete inline state must never bypass
  // the canonical state decoder (whose row-limit rejection is tested above).
  expect(() => decodeAccountFrame(frame, 'peer-frame'))
    .toThrow('peer-frame.fields:missing=none:extra=byLeft,deltas');
});
