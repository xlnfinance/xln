import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('j-batch success-path logs stay behind structured debug logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/j-batch.ts'), 'utf8');

  expect(source).toContain("const jBatchLog = createStructuredLogger('j.batch');");
  expect(source).not.toContain('console.log');
  expect(source).toContain('jBatchLog.debug');
});

test('r2c handler traces stay behind structured debug logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity-tx/handlers/r2c.ts'), 'utf8');

  expect(source).toContain("const r2cLog = createStructuredLogger('entity.r2c');");
  expect(source).not.toContain('console.log');
  expect(source).toContain('r2cLog.debug');
});
