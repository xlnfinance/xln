import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dbRoot: string | null = null;

afterEach(() => {
  if (dbRoot) rmSync(dbRoot, { recursive: true, force: true });
  dbRoot = null;
});

test('sparse WAL preserves every tx in a merged reliable Entity input', async () => {
  dbRoot = mkdtempSync(join(tmpdir(), 'xln-sparse-wal-'));
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'runtime/scripts/bench-storage-hub.ts',
      '--accounts', '2',
      '--import-batch', '3',
      '--open-batch', '2',
      '--payments', '0',
      '--storage',
      '--persist',
      '--storage-snapshot', '100',
      '--storage-materialize', '100',
      '--storage-canonical', '1',
      '--snapshot-interval', '100',
      '--crash-recover',
    ],
    cwd: join(import.meta.dir, '..', '..'),
    env: { ...process.env, XLN_DB_PATH: dbRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(stdout).toContain('Crash recovery:');
  expect(stdout).toContain('hubAccounts=2');
}, 15_000);
