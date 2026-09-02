import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStringify } from '../../../protocol/serialization';
import { executeRebalanceSettlementAccountSemanticVector } from '../../../../rscore/fixtures/account-semantics/rebalance-settlement';

test('rebalance and settlement AccountTx variants match the shared TypeScript semantic vector', async () => {
  const actual = await executeRebalanceSettlementAccountSemanticVector();
  const expected = readFileSync(
    join(import.meta.dir, '../../../../rscore/fixtures/account-semantics/rebalance-settlement-v1.json'),
    'utf8',
  );
  expect(`${safeStringify(actual, 2)}\n`).toBe(expected);
  expect(actual.cases.flatMap(testCase => testCase.steps).map(step => step.txType)).toEqual([
    'request_collateral',
    'rebalance_refund',
    'rebalance_refund',
    'settle_transition',
  ]);
});
