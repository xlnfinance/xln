import { expect, test } from 'bun:test';

import {
  pruneHankoWitnessToReachableState,
  type HankoWitnessEntry,
} from '../entity/consensus/hanko-witness';
import type { EntityState } from '../types';

const hash = (byte: string): string => `0x${byte.repeat(64)}`;
const entry = (
  type: HankoWitnessEntry['type'],
  entityHeight: number,
): HankoWitnessEntry => ({
  hanko: `0x${'11'.repeat(65)}` as HankoWitnessEntry['hanko'],
  type,
  entityHeight,
  createdAt: entityHeight,
});

const stateWithPendingExternalWrites = (batchHash: string, actionHash: string): EntityState => ({
  jBatchState: { sentBatch: { batchHash } },
  entityProviderActionState: {
    version: 1,
    confirmedNonce: 0n,
    generation: 1,
    pending: { actionHash },
  },
} as EntityState);

test('Hanko witness retention keeps only current external writes and newest profile', () => {
  const batchHash = hash('a');
  const actionHash = hash('b');
  const oldProfileHash = hash('c');
  const currentProfileHash = hash('d');
  const witnesses = new Map<string, HankoWitnessEntry>([
    [batchHash, entry('jBatch', 7)],
    [actionHash, entry('entityProviderAction', 8)],
    [oldProfileHash, entry('profile', 4)],
    [currentProfileHash, entry('profile', 9)],
  ]);
  for (let index = 0; index < 10_000; index += 1) {
    witnesses.set(`0x${index.toString(16).padStart(64, '0')}`, entry('accountFrame', index + 1));
  }

  expect(pruneHankoWitnessToReachableState(
    stateWithPendingExternalWrites(batchHash, actionHash),
    witnesses,
  )).toBe(10_001);
  expect([...witnesses.keys()].sort()).toEqual([
    actionHash,
    batchHash,
    currentProfileHash,
  ].sort());
});

test('Hanko witness retention fails loud when a pending external write lost its quorum witness', () => {
  const batchHash = hash('a');
  const actionHash = hash('b');
  const witnesses = new Map<string, HankoWitnessEntry>([
    [batchHash, entry('jBatch', 7)],
  ]);

  expect(() => pruneHankoWitnessToReachableState(
    stateWithPendingExternalWrites(batchHash, actionHash),
    witnesses,
  )).toThrow(`HANKO_WITNESS_REACHABLE_MISSING:entityProviderAction:${actionHash}`);
});
