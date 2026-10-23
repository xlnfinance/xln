import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['missing-request', 'mature-underpayment'])
  for (const reverse of [false, true]) {
    test(`signed savings payout rejection keeps the Runtime alive: ${mode}, reverse=${reverse}`, async () => {
      const dbRoot = mkdtempSync(join(tmpdir(), 'xln-savings-close-admission-'));
      try {
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            join(import.meta.dir, '../../fixtures/storage/lending/savings-close.ts'),
            mode,
            ...(reverse ? ['--reverse-lending-parties'] : []),
          ],
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
        expect(stdout).toContain('SAVINGS_SIGNED_REJECTION_GREEN');
        console.log(stdout.slice(stdout.indexOf('SAVINGS_SIGNED_REJECTION_GREEN')));
      } finally {
        rmSync(dbRoot, { recursive: true, force: true });
      }
    }, 40_000);
  }
