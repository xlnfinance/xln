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
  expect(actual.cases[0]?.steps[0]?.outputs).toEqual([{
    kind: 'runtimeEvent',
    eventName: 'request_collateral_committed',
    data: {
      entityId: `0x${'11'.repeat(32)}`,
      accountId: `0x${'22'.repeat(32)}`,
      tokenId: 1,
      requestedAmount: '90',
      prepaidFee: '10',
      requestedAt: 1_000,
    },
  }]);
});
