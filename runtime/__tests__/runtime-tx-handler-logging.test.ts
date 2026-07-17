import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('runtime tx import logs use structured logging and invalid j-height fails closed', () => {
  const txHandlers = readFileSync(join(process.cwd(), 'runtime/machine/tx-handlers.ts'), 'utf8');
  const jurisdictionImport = readFileSync(join(process.cwd(), 'runtime/machine/jurisdiction-import.ts'), 'utf8');
  const runtime = readFileSync(join(process.cwd(), 'runtime/runtime.ts'), 'utf8');

  expect(txHandlers).toContain("const runtimeTxLog = createStructuredLogger('runtime.tx');");
  expect(jurisdictionImport).toContain("const jurisdictionImportLog = createStructuredLogger('runtime.jurisdiction_import');");
  expect(jurisdictionImport).toContain("jurisdictionImportLog.info('jurisdiction.import_start'");
  expect(jurisdictionImport).toContain("jurisdictionImportLog.warn('jurisdiction.import_retry'");
  expect(jurisdictionImport).toContain("jurisdictionImportLog.info('jurisdiction.ready'");
  expect(jurisdictionImport).toContain("jurisdictionImportLog.error('jurisdiction.import_failed'");
  expect(txHandlers).toContain("runtimeTxLog.debug('replica.import_start'");
  expect(runtime).toContain("runtimeLog.debug('browservm.wallet_bind_deferred'");
  expect(txHandlers).not.toContain('console.');
  expect(jurisdictionImport).not.toContain('console.');
  expect(txHandlers).not.toContain('FIXED: Set jBlock');
  expect(txHandlers).toContain('ENTITY_CREATION_INVALID_J_HEIGHT');
});
