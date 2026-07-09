import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('settlement entity handler keeps progress logs behind structured debug logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity-tx/handlers/settle.ts'), 'utf8');

  expect(source).toContain("const settleLog = createStructuredLogger('entity.settle');");
  expect(source).not.toContain('console.log');
  expect(source).toContain('settleLog.debug');
});
