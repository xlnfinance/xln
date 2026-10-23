import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('malformed bank policy evicts only its transaction and preserves current WAL recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-policy-admission-'));
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, '../../../fixtures/storage/lending/policy-admission.ts')],
      env: { ...process.env, XLN_DB_PATH: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timeout));
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain('LENDING_POLICY_REJECTION_WAL_GREEN:rejected=8:healthy=8:recovery=exact');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
