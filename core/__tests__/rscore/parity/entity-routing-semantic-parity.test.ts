import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { executeEntityRoutingSemanticVectors } from '../../../../rscore/fixtures/entity-routing-semantics/cases';

test('runtime and J routing EntityTx kinds match the shared TypeScript semantic vector', async () => {
  const actual = await executeEntityRoutingSemanticVectors();
  const expected = JSON.parse(readFileSync(
    join(import.meta.dir, '../../../../rscore/fixtures/entity-routing-semantics/parity-v1.json'),
    'utf8',
  ));
  expect(actual).toEqual(expected);
  expect(actual.cases.map(row => row.txType)).toEqual([
    'e2r',
    'r2e',
    'r2r',
    'r2c',
    'j_rebroadcast',
    'j_abort_sent_batch',
    'j_clear_batch',
    'runtimeOutput',
    'processHtlcTimeouts',
    'j_event',
  ]);
});
