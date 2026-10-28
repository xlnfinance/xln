import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { cleanupTestProcesses, spawnTestProcess } from '../../helpers/test-process';

const helperPath = resolve(import.meta.dir, '../../helpers/test-process.ts');

const expectPidGone = async (pid: number): Promise<void> => {
  const deadline = performance.now() + 5_000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      return;
    }
    if (performance.now() > deadline) throw new Error(`TEST_CHILD_SURVIVED:pid=${pid}`);
    await Bun.sleep(20);
  }
};

test.each(['success', 'failure', 'timeout', 'exit', 'SIGINT', 'SIGTERM'] as const)(
  'owned process groups do not survive test %s', async outcome => {
    const root = mkdtempSync(join(tmpdir(), 'xln-test-process-'));
    const fixturePath = join(root, 'lifecycle.test.ts');
    const pidsPath = join(root, 'pids.json');
    writeFileSync(fixturePath, [
      "import { test } from 'bun:test';",
      "import { writeFileSync } from 'node:fs';",
      `import { spawnTestProcess } from ${JSON.stringify(helperPath)};`,
      "test('lifecycle', async () => {",
      // The group leader exits before cleanup; the surviving descendant must
      // still be killed, including when it ignores graceful termination.
      "const child = spawnTestProcess(process.execPath, ['-e', " + JSON.stringify([
        "import { spawn } from 'node:child_process';",
        "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);\"], { stdio: ['ignore', 'pipe', 'inherit'] });",
        "child.stdout.once('data', data => { console.log(JSON.stringify({ leader: process.pid, descendant: Number(data.toString()) })); child.unref(); process.exit(0); });",
      ].join('\n')) + ']);',
      "const pids = await new Promise(resolve => child.stdout.once('data', chunk => resolve(JSON.parse(chunk.toString()))));",
      `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify(pids));`,
      ...(outcome === 'failure' ? ["throw new Error('EXPECTED_TEST_FAILURE');"] : []),
      ...(outcome === 'timeout' ? ['await new Promise(() => {});'] : []),
      ...(outcome === 'exit' ? ['process.exit(7);'] : []),
      ...(outcome === 'SIGINT' || outcome === 'SIGTERM' ? [`process.kill(process.pid, '${outcome}'); await new Promise(() => {});`] : []),
      '}, 2000);',
    ].join('\n'));
    try {
      const runner = spawnTestProcess(process.execPath, ['test', '--timeout', '180000', fixturePath]);
      const output = Promise.all([text(runner.stdout), text(runner.stderr)]);
      const code = await new Promise<number | null>((done, reject) => {
        runner.once('error', reject);
        runner.once('exit', done);
      });
      const [, stderr] = await output;
      expect(code).toBe(outcome === 'success' ? 0 : outcome === 'exit' ? 7 : outcome === 'SIGINT' ? 130 : outcome === 'SIGTERM' ? 143 : 1);
      if (outcome === 'failure') expect(stderr).toContain('EXPECTED_TEST_FAILURE');
      if (outcome === 'timeout') expect(stderr).toContain('timed out');
      const pids = JSON.parse(readFileSync(pidsPath, 'utf8')) as { leader: number; descendant: number };
      await expectPidGone(pids.leader);
      await expectPidGone(pids.descendant);
    } finally {
      await cleanupTestProcesses();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000,
);

test('a failing test leaves no Anvil child, even before startup returns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-j-watcher-backlog-regression-'));
  const fixturePath = join(root, 'anvil.test.ts');
  const pidPath = join(root, 'pid');
  writeFileSync(fixturePath, [
    "import { test } from 'bun:test';",
    "import { writeFileSync } from 'node:fs';",
    `import { spawnTestProcess } from ${JSON.stringify(helperPath)};`,
    "test('Anvil readiness fails', async () => {",
    `const child = spawnTestProcess('anvil', ['--host', '127.0.0.1', '--port', '0', '--state', ${JSON.stringify(join(root, 'state.json'))}]);`,
    'child.stderr.pipe(process.stderr);',
    // Wait for a real listening Anvil; an early bind error must not pass this regression.
    "await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => reject(new Error(`ANVIL_START_FAILED:${code}`))); child.stdout.on('data', chunk => { if (chunk.toString().includes('Listening on')) resolve(); }); });",
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    "throw new Error('EXPECTED_ANVIL_STARTUP_FAILURE');",
    '}, 5000);',
  ].join('\n'));
  try {
    const runner = spawnTestProcess(process.execPath, ['test', '--timeout', '180000', fixturePath]);
    const output = Promise.all([text(runner.stdout), text(runner.stderr)]);
    const code = await new Promise<number | null>((done, reject) => {
      runner.once('error', reject);
      runner.once('exit', done);
    });
    const [, stderr] = await output;
    expect(code).toBe(1);
    expect(stderr).toContain('EXPECTED_ANVIL_STARTUP_FAILURE');
    await expectPidGone(Number(readFileSync(pidPath, 'utf8')));
  } finally {
    await cleanupTestProcesses();
    rmSync(root, { recursive: true, force: true });
  }
});
