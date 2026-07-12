import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('runtime tx import logs use structured logging and invalid j-height fails closed', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/machine/tx-handlers.ts'), 'utf8');

  expect(source).toContain("const runtimeTxLog = createStructuredLogger('runtime.tx');");
  expect(source).toContain("runtimeTxLog.info('jurisdiction.import_start'");
  expect(source).toContain("runtimeTxLog.warn('jurisdiction.import_retry'");
  expect(source).toContain("runtimeTxLog.info('jurisdiction.ready'");
  expect(source).toContain("runtimeTxLog.error('jurisdiction.import_failed'");
  expect(source).toContain("runtimeTxLog.debug('replica.import_start'");
  expect(source).toContain("runtimeTxLog.warn('replica.wallet_registration_skipped'");
  expect(source).not.toContain('console.');
  expect(source).not.toContain('console.log(`[Runtime] Importing J-machine');
  expect(source).not.toContain('console.log(`[Runtime] JReplica');
  expect(source).not.toContain('FIXED: Set jBlock');
  expect(source).toContain('ENTITY_CREATION_INVALID_J_HEIGHT');
});
