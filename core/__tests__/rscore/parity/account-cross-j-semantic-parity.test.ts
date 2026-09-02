import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStringify } from '../../../protocol/serialization';
import { executeCrossJAccountSemanticVector } from '../../../../rscore/fixtures/account-semantics/cross-j';

test('cross-j AccountTx variants match the shared TypeScript semantic vector', async () => {
  const actual = await executeCrossJAccountSemanticVector();
  const expected = readFileSync(
    join(import.meta.dir, '../../../../rscore/fixtures/account-semantics/cross-j-v1.json'),
    'utf8',
  );
  expect(`${safeStringify(actual, 2)}\n`).toBe(expected);
  expect(actual.cases.flatMap(testCase => testCase.steps).map(step => step.txType)).toEqual([
    'cross_pull_lock',
    'swap_offer',
    'cross_swap_fill_ack',
    'cross_pull_lock',
    'cross_pull_close',
    'cross_pull_lock',
    'cross_pull_progress',
  ]);
});
