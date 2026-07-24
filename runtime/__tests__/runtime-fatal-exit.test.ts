import { expect, test } from 'bun:test';
import { join } from 'path';

const fixture = join(import.meta.dir, 'fixtures/runtime-fatal-exit-child.ts');

test('an unhandled Node Runtime error always terminates the child process', async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, fixture],
    cwd: join(import.meta.dir, '..', '..'),
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = `${stdout}\n${stderr}`;

  expect(exitCode, output).toBe(1);
  expect(output).toContain('RUNTIME_TX_UNKNOWN: fatal-exit-fixture');
  expect(output).not.toContain('RUNTIME_FATAL_EXIT_FIXTURE_TIMEOUT');
}, 10_000);
