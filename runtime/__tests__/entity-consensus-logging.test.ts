import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('entity consensus core uses structured logging only', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity/consensus/index.ts'), 'utf8');

  expect(source).toContain("createStructuredLogger('entity')");
  expect(source).toContain("entityLog.info('frame.profile'");
  expect(source).toContain("entityLog.debug('frame.apply'");
  expect(source).not.toContain('console.');
});
