import { expect, test } from 'bun:test';

test('canonical root module has no wallet, worker, filesystem, or network imports', async () => {
  const source = await Bun.file(`${import.meta.dir}/canonical.ts`).text();
  for (const forbidden of ['ethers', 'worker_threads', 'node:fs', 'node:net', 'node:http', 'node:https']) {
    expect(source).not.toContain(forbidden);
  }
});

test('derivation succeeds with operating-system network access denied', () => {
  if (process.platform !== 'darwin') return;
  const run = Bun.spawnSync({
    cmd: [
      '/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)',
      process.execPath, 'cli.ts', '--bench', '--shards', '1', '--workers', '1', '--engine', 'native',
    ],
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toContain('Frozen root check: PASS');
});
