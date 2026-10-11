import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('signed loan and queued withdrawal survive SIGKILL, restored liquidity and outbox redelivery', async () => {
  const dbRoot = mkdtempSync(join(tmpdir(), 'xln-lending-crash-'));
  try {
    for (const mode of ['originate', 'partial', 'mature', 'withdraw', 'repay', 'interleave', 'recover']) {
      const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, '../../fixtures/storage/lending-crash-child.ts'), mode],
        env: { ...process.env, XLN_DB_PATH: dbRoot }, stdout: 'pipe', stderr: 'pipe',
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timeout));
      expect(exitCode, `${mode}\n${stdout}\n${stderr}`).toBe(mode === 'recover' ? 0 : 137);
      if (mode !== 'recover') expect(child.signalCode).toBe('SIGKILL');
    }
    for (const phase of ['active', 'partial', 'queued', 'defaulted', 'repayment-committed', 'interleaved', 'recovered', 'redelivered']) {
      expect(readFileSync(join(dbRoot, `${phase}.json`), 'utf8').length).toBeGreaterThan(0);
    }
  } finally { rmSync(dbRoot, { recursive: true, force: true }); }
}, 60_000);
