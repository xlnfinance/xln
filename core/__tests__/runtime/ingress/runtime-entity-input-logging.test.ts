import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('runtime entity input j-output collection logs stay behind structured debug logging', () => {
  const source = [
    'admit/entity-input-contract.ts',
    'admit/entity-input-output.ts',
    'admit/entity-input-replica.ts',
    'admit/entity-input-staging.ts',
    'mempool/entity-inputs.ts',
  ].map(file => readFileSync(join(process.cwd(), 'core/runtime', file), 'utf8')).join('\n');

  expect(source).toContain("entityInputLog = createStructuredLogger('runtime.entity_inputs');");
  expect(source).not.toContain('[2/6] Collecting');
  expect(source).toContain("entityInputLog.debug('j_outputs.collected'");
  expect(source).toContain("entityInputLog.debug('replay.merged_input'");
  expect(source).toContain("entityInputLog.info('inputs.profile'");
  expect(source).toContain("entityInputLog.debug('input.processing'");
  expect(source).not.toContain('console.');
});
