import { expect, test } from 'bun:test';

import { assertAccountFrameDeltaIntegrity, deriveAccountFrameOffdeltas, deriveAccountFrameTokenIds } from '../account-frame';
import type { AccountFrame, Delta } from '../types';
import { validateAccountFrame } from '../validation-utils';

const delta = (tokenId: number, offdelta: bigint): Delta => ({
  tokenId,
  collateral: 0n,
  ondelta: 0n,
  offdelta,
  leftCreditLimit: 0n,
  rightCreditLimit: 0n,
  leftAllowance: 0n,
  rightAllowance: 0n,
});

const frame = (deltas: Delta[]): AccountFrame => ({
  height: 1,
  timestamp: 1,
  jHeight: 0,
  accountTxs: [],
  prevFrameHash: 'genesis',
  stateHash: '0xabc',
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
  expect(() => validateAccountFrame(broken)).toThrow('Delta validation failed');
});
