import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStringify } from '../../../protocol/serialization';
import { executeSameJFinancialEntitySemanticVector } from '../../../../rscore/fixtures/entity-kernel/same-j-financial';

test('same-j financial EntityTx kinds match the shared TypeScript semantic vector', async () => {
  const actual = await executeSameJFinancialEntitySemanticVector();
  const expected = readFileSync(
    join(import.meta.dir, '../../../../rscore/fixtures/entity-kernel/same-j-financial-v1.json'),
    'utf8',
  );
  expect(`${safeStringify(actual, 2)}\n`).toBe(expected);
  expect(actual.cases.map(testCase => testCase.name)).toEqual([
    'lendingOffer',
    'lendingBorrow',
    'lendingRepay',
    'lendingClosePosition',
    'placeSwapOffer',
    'proposeCancelSwap',
    'requestCollateral',
    'setRebalancePolicy',
    'htlcPayment',
    'resolveHtlcLock',
    'openAccount',
  ]);
});
