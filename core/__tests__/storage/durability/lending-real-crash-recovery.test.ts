import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cases = [
  {
    name: 'demand savings rate, fractional earnings and queued actual-time payout survive three SIGKILL restarts',
    modes: ['demand-originate', 'demand-rate', 'demand-close', 'demand-recover'],
    phases: ['active', 'demand-rate', 'demand-queued', 'demand-paid'],
  },
  {
    name: 'signed loan and queued withdrawal survive SIGKILL, restored liquidity and outbox redelivery',
    modes: ['originate', 'partial', 'mature', 'withdraw', 'repay', 'interleave', 'recover'],
    phases: [
      'active',
      'partial',
      'queued',
      'defaulted',
      'repayment-committed',
      'interleaved',
      'recovered',
      'redelivered',
    ],
  },
  {
    name: 'signed early withdrawal delivered after maturity survives SIGKILL without earning the term coupon',
    modes: ['originate', 'early-close', 'early-recover'],
    phases: ['active', 'early-queued', 'early-paid'],
  },
];

for (const scenario of cases)
  for (const reverse of scenario.name.startsWith('signed ') ? [false, true] : [false])
    test(`${scenario.name}, reverse=${reverse}`, async () => {
      const dbRoot = mkdtempSync(join(tmpdir(), 'xln-lending-crash-'));
      try {
        for (const mode of scenario.modes) {
          const child = Bun.spawn({
            cmd: [
              process.execPath,
              join(import.meta.dir, '../../fixtures/storage/lending-crash-child.ts'),
              mode,
              ...(reverse ? ['--reverse-lending-parties'] : []),
            ],
            env: { ...process.env, XLN_DB_PATH: dbRoot },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]).finally(() => clearTimeout(timeout));
          const recovered = mode.endsWith('recover');
          expect(exitCode, `${mode}\n${stdout}\n${stderr}`).toBe(recovered ? 0 : 137);
          if (!recovered) expect(child.signalCode).toBe('SIGKILL');
        }
        for (const phase of scenario.phases) {
          expect(readFileSync(join(dbRoot, `${phase}.json`), 'utf8').length).toBeGreaterThan(0);
        }
      } finally {
        rmSync(dbRoot, { recursive: true, force: true });
      }
    }, 60_000);
