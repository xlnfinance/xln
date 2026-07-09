import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('j-batch success-path logs stay behind structured debug logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/j-batch.ts'), 'utf8');

  expect(source).toContain("const jBatchLog = createStructuredLogger('j.batch');");
  expect(source).not.toContain('console.log');
  expect(source).toContain('jBatchLog.debug');
});
