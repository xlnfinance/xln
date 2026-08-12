import { expect, test } from 'bun:test';

import { assertAccountFrameDeltaIntegrity, deriveAccountFrameOffdeltas, deriveAccountFrameTokenIds } from '../../../account/state/frame';
import { canonicalAccountTxForFrameHash } from '../../../account/consensus/frame/hash';
import type { AccountFrame, Delta } from '../../../types/account';
import { decodeAccountFrame } from '../../../account/validation/frame-validation';
import { INT256_MAX, INT256_MIN, UINT256_MAX } from '../../../protocol/boundary/integer-ranges';
import { TOKENS } from '../../../config/constants';

const delta = (tokenId: number, offdelta: bigint): Delta => ({
  tokenId,
  collateral: 0n,
  ondelta: 0n,
  offdelta,
  leftCreditLimit: 0n,
  rightCreditLimit: 0n,
  leftAllowance: 0n,
  rightAllowance: 0n,
  leftHold: 0n,
  rightHold: 0n,
});

const frame = (deltas: Delta[]): AccountFrame => ({
  height: 1,
  timestamp: 1,
  jHeight: 0,
  accountTxs: [],
  prevFrameHash: 'genesis',
  stateHash: `0x${'22'.repeat(32)}`,
  accountStateRoot: `0x${'11'.repeat(32)}`,
  byLeft: true,
  deltas,
});

test('AccountFrame.deltas is the only frame-level delta source', () => {
  assertAccountFrameDeltaIntegrity(frame([delta(1, 5n), delta(2, -3n)]));
  expect(deriveAccountFrameOffdeltas(frame([delta(1, 5n), delta(2, -3n)]))).toEqual([5n, -3n]);
  expect(deriveAccountFrameTokenIds(frame([delta(1, 5n), delta(2, -3n)]))).toEqual([1, 2]);
});

test('AccountFrame rejects unsorted or duplicate token ids', () => {
  expect(() => assertAccountFrameDeltaIntegrity(frame([delta(2, 5n), delta(1, -1n)]))).toThrow('sorted');
  expect(() => assertAccountFrameDeltaIntegrity(frame([delta(1, 5n), delta(1, -1n)]))).toThrow('sorted');
});

test('AccountFrame rejects malformed delta entries', () => {
  const broken = frame([delta(1, 5n)]);
  (broken.deltas[0] as unknown as { offdelta: string }).offdelta = '5';
  expect(() => assertAccountFrameDeltaIntegrity(broken)).toThrow('offdelta');
});

test('AccountFrame validation rejects malformed delta entries', () => {
  const broken = frame([delta(1, 5n)]);
  (broken.deltas[0] as unknown as { tokenId: string }).tokenId = '1';
  expect(() => decodeAccountFrame(broken)).toThrow('Delta validation failed');
});

test('AccountFrame validation rejects every out-of-domain financial delta', () => {
  const invalid = [
    { field: 'tokenId', value: TOKENS.MAX_TOKEN_ID + 1 },
    { field: 'collateral', value: -1n },
    { field: 'collateral', value: UINT256_MAX + 1n },
    { field: 'leftAllowance', value: -1n },
    { field: 'rightHold', value: -1n },
    { field: 'ondelta', value: INT256_MIN - 1n },
    { field: 'offdelta', value: INT256_MAX + 1n },
  ] as const;
  for (const { field, value } of invalid) {
    const broken = frame([delta(1, 5n)]);
    (broken.deltas[0] as unknown as Record<string, unknown>)[field] = value;
    expect(() => decodeAccountFrame(broken, `invalid-${field}`)).toThrow();
  }
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
