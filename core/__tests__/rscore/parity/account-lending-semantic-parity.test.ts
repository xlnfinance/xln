import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStringify } from '../../../protocol/serialization';
import { executeLendingAccountSemanticVector } from '../../../../rscore/fixtures/account-semantics/lending';

test('all six lending AccountTx variants match the shared TypeScript semantic vector', async () => {
  const actual = await executeLendingAccountSemanticVector();
  const expected = readFileSync(
    join(import.meta.dir, '../../../../rscore/fixtures/account-semantics/lending-v1.json'),
    'utf8',
  );
  expect(`${safeStringify(actual, 2)}\n`).toBe(expected);
  expect(actual.cases.flatMap(testCase => testCase.steps).map(step => step.txType)).toEqual([
    'lending_borrow_request',
    'lending_credit',
    'lending_repay',
    'lending_fund',
    'lending_close_request',
    'lending_close_payout',
  ]);
});
