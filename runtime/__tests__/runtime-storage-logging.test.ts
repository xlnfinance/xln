import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeDbNamespace, resolveDbNamespace } from '../runtime-storage-dbs';

test('runtime storage DB boundary uses structured logging without direct console output', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/runtime-storage-dbs.ts'), 'utf8');

  expect(source).toContain("const storageLog = createStructuredLogger('runtime.storage');");
  expect(source).toContain("storageLog.warn('storage_db.blocked'");
  expect(source).toContain("storageLog.error('runtime_db.open_failed'");
  expect(source).toContain("storageLog.warn('storage_epoch.recover_complete_interrupted'");
  expect(source).not.toContain('console.');
  expect(source).not.toContain('[storage-epoch]');
  expect(source).not.toContain('IndexedDB blocked (incognito/private mode)');
});

test('runtime DB namespace normalization stays pure for explicit ids', () => {
  expect(normalizeDbNamespace('  0xABCDef  ')).toBe('0xabcdef');
  expect(resolveDbNamespace({ runtimeId: '  Runtime-A  ' })).toBe('runtime-a');
  expect(resolveDbNamespace({ env: { dbNamespace: '  Custom-DB  ' } as never })).toBe('custom-db');
});
