import { expect, test } from 'bun:test';

import {
  assertAccountFrameHash,
  canonicalAccountTxForFrameHash,
  computeFrameHash,
} from '../../../account/consensus/frame/hash';
import { decodeAccountFrame } from '../../../account/validation/frame-validation';
import type { AccountFrame } from '../../../types/account';

const frame = (): AccountFrame => {
  const value: AccountFrame = {
    height: 1,
    timestamp: 1,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: `0x${'11'.repeat(32)}`,
    stateHash: '',
  };
  value.stateHash = computeFrameHash(value);
  return value;
};

test('AccountFrame carries one AccountState root and no duplicate financial snapshot', () => {
  const value = frame();
  expect(decodeAccountFrame(value)).toEqual(value);
  expect(() => decodeAccountFrame({ ...value, deltas: [] })).toThrow('AccountFrame.fields');
  expect(() => decodeAccountFrame({ ...value, byLeft: true })).toThrow('AccountFrame.fields');
  expect(() => assertAccountFrameHash(value, 'ACCOUNT_FRAME_HASH_INVALID')).not.toThrow();
});

test('AccountFrame hash binds the canonical state root', () => {
  const value = frame();
  const changed = { ...value, accountStateRoot: `0x${'22'.repeat(32)}` };
  expect(computeFrameHash(changed)).not.toBe(value.stateHash);
});

test('Account frame hashing rejects a malformed J-claim height', () => {
  expect(() => canonicalAccountTxForFrameHash({
    type: 'j_event_claim',
    data: {
      jHeight: Number.NaN,
      jBlockHash: `0x${'22'.repeat(32)}`,
      events: [],
      leftProof: {},
      rightProof: {},
    },
  })).toThrow('ACCOUNT_FRAME_J_EVENT_CLAIM_HEIGHT_INVALID');
});
