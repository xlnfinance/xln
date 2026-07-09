import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('runtime j-submit side-effect logs use structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/runtime-j-submit.ts'), 'utf8');

  expect(source).toContain("const jSubmitLog = createStructuredLogger('runtime.jsubmit');");
  expect(source).toContain("jSubmitLog.debug('outbox.submit_start'");
  expect(source).toContain("jSubmitLog.debug('tx.submit_start'");
  expect(source).toContain("jSubmitLog.debug('tx.submit_ok'");
  expect(source).toContain("jSubmitLog.error('tx.submit_failed'");
  expect(source).toContain("jSubmitLog.warn('sealed_batch.non_local_skipped'");
  expect(source).not.toContain('console.');
  expect(source).not.toContain('[J-SUBMIT]');
  expect(source).not.toContain('[SIDE-EFFECT]');
});
