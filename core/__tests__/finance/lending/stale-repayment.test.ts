import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a signed stale repayment preserves Account roots and bank book without stopping the Runtime', async () => {
  const dbRoot = mkdtempSync(join(tmpdir(), 'xln-stale-repayment-'));
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, '../../fixtures/storage/lending/stale-repay.ts')],
      env: { ...process.env, XLN_DB_PATH: dbRoot },
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
    expect(stdout).toContain('LENDING_STALE_REPAY_PRECONDITION');
    expect(stdout).toContain('LENDING_STALE_REPAY_GREEN');
  } finally {
    rmSync(dbRoot, { recursive: true, force: true });
  }
}, 40_000);
