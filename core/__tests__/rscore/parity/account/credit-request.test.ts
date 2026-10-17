import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStringify } from '../../../../protocol/serialization';
import { executeCreditRequestAccountSemanticVector } from '../../../../../rscore/fixtures/account-semantics/credit-request';

// Rust replays the same file in rscore/crates/engine/tests/monetary/credit_request.rs.
test('credit_request and the hub answer match the shared TypeScript semantic vector', async () => {
  const actual = await executeCreditRequestAccountSemanticVector();
  const expected = readFileSync(
    join(import.meta.dir, '../../../../../rscore/fixtures/account-semantics/credit-request-v1.json'),
    'utf8',
  );
  expect(`${safeStringify(actual, 2)}\n`).toBe(expected);
  expect(actual.cases.flatMap(testCase => testCase.steps).map(step => step.txType)).toEqual([
    'credit_request',
    'set_credit_limit',
    'credit_request',
    'set_credit_limit',
  ]);
});
