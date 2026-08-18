import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('runtime infra restore diagnostics use structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'core/runtime/recovery/j-adapter-restore.ts'), 'utf8');

  expect(source).toContain("const infraLog = createStructuredLogger('runtime.restore');");
  expect(source).toContain("infraLog.info('jadapter.restore_retry'");
  expect(source).toContain("infraLog.debug('jadapter.derived'");
  expect(source).toContain("infraLog.warn('gossip.restore_skipped'");
  expect(source).toContain("infraLog.debug('browservm.restored'");
  expect(source).toContain("infraLog.error('jadapter.restore_failed'");
  expect(source).not.toContain('console.');
});
