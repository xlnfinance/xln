import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('runtime entity input j-output collection logs stay behind structured debug logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/machine/entity-inputs.ts'), 'utf8');

  expect(source).toContain("const entityInputLog = createStructuredLogger('runtime.entity_inputs');");
  expect(source).not.toContain('[2/6] Collecting');
  expect(source).toContain("entityInputLog.debug('j_outputs.collected'");
  expect(source).toContain("entityInputLog.debug('replay.merged_input'");
  expect(source).toContain("entityInputLog.warn('inputs.profile'");
  expect(source).toContain("entityInputLog.debug('input.processing'");
  expect(source).not.toContain('console.');
});
