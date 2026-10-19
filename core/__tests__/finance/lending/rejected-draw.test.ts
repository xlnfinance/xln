import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a rejected unsigned draw releases its facility across real SIGKILL and current WAL recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-rejected-draw-'));
  try {
    for (const mode of ['originate', 'recover']) {
      const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, '../../fixtures/storage/lending/rejected-draw.ts'), mode],
        env: { ...process.env, XLN_DB_PATH: root },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timeout));
      expect(stdout, `${stdout}\n${stderr}`).toContain(
        mode === 'originate' ? 'LENDING_REJECTED_DRAW_DURABLE' : 'LENDING_REJECTED_DRAW_RECOVERY_GREEN',
      );
      if (mode === 'originate') expect(child.signalCode).toBe('SIGKILL');
      else expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 55_000);
