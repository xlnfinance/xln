import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('settlement entity handler keeps progress and warning logs behind structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'core/entity/tx/handlers/payments/settle.ts'), 'utf8');

  expect(source).toContain("const settleLog = createStructuredLogger('entity.settle');");
  expect(source).not.toContain('console.');
  expect(source).toContain('settleLog.debug');
  expect(source).toContain('settleLog.warn');
});
