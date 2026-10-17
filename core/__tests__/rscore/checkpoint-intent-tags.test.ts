import { expect, test } from 'bun:test';
import { decodeRscoreAccountStateTrees } from '../../rscore/checkpoint/checkpoint-restore-state';
import { assertStorageSchemaVersion } from '../../storage/keys';

const trees = (rows: unknown[]) => decodeRscoreAccountStateTrees([[], [], rows, [], [], [], [], []]);

test('current checkpoint tags preserve disburse=7 and assign credit-request=8 without collision', () => {
  const decoded = trees([['disburse:loan-0000000000000001', 7], ['credit:credit-0000000000000001', 8]]);
  expect([...decoded.lendingIntents]).toEqual([
    ['credit:credit-0000000000000001', 'credit-request'],
    ['disburse:loan-0000000000000001', 'disburse'],
  ]);
});

test('retired revolving-credit and unknown intent tags are rejected', () => {
  for (const tag of [3, 4, 9]) expect(() => trees([['obsolete', tag]])).toThrow('LENDING_0_KIND');
});

test('both pre-integration tag-7 histories are rejected at the canonical storage boundary', () => {
  expect(() => assertStorageSchemaVersion(5, 'storage-head'))
    .toThrow('STORAGE_SCHEMA_MISMATCH:stored=5:current=6:boundary=storage-head');
  expect(assertStorageSchemaVersion(6, 'storage-head')).toBe(6);
});
