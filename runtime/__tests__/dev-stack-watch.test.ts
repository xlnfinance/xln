import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = readFileSync(resolve(import.meta.dir, '../../scripts/dev/run-dev-child.sh'), 'utf8');
const cleanSlate = readFileSync(resolve(import.meta.dir, '../../scripts/dev/clean-slate.sh'), 'utf8');

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`DEV_WATCH_TEST_TIMEOUT:${timeoutMs}`);
};

const readPids = (path: string): number[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(pid => Number.isSafeInteger(pid) && pid > 0);
};

const readListenerPid = async (port: number): Promise<number | null> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`);
    const pid = Number(await response.text());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('dev stack restarts backend services when source changes', () => {
  expect(script).toContain('bun --no-orphans runtime/scripts/watch-process-tree.ts');
  expect(script).toContain('--watch-root "$REPO_ROOT/runtime"');
  expect(script).toContain('--ignore-prefix scripts');
  expect(script).toContain('--ignore-prefix __tests__');
  expect(script).toContain('--ignore-prefix scenarios');
  expect(script).toContain('bun --no-orphans runtime/orchestrator/orchestrator.ts');
  expect(script).toContain('bun --no-orphans --watch runtime/watchtower/standalone-server.ts');
});

test('configured MESH supervisor reaps its exact process group before restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-watch-'));
  const sourceRoot = join(root, 'source');
  const dependencyPath = join(sourceRoot, 'dependency.ts');
  const childPath = join(sourceRoot, 'child.ts');
  const mainPath = join(sourceRoot, 'main.ts');
  const pidLogPath = join(root, 'children.pid');
  mkdirSync(sourceRoot, { recursive: true });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = reservation.port;
  reservation.stop(true);
  writeFileSync(dependencyPath, 'export const generation = 1;\n', 'utf8');
  writeFileSync(childPath, [
    'const port = Number(process.argv[2]);',
    "process.on('SIGTERM', () => {});",
    "Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response(String(process.pid)) });",
  ].join('\n'), 'utf8');
  writeFileSync(mainPath, [
    "import { appendFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { generation } from './dependency';",
    'void generation;',
    "process.on('SIGTERM', () => {});",
    'const child = spawn(process.execPath, [process.argv[2]!, process.argv[3]!], { stdio: \'ignore\' });',
    "if (!child.pid) throw new Error('DEV_WATCH_CHILD_PID_MISSING');",
    "appendFileSync(process.argv[4]!, `${child.pid}\\n`, 'utf8');",
    'await new Promise<void>(() => {});',
  ].join('\n'), 'utf8');

  const watcher = spawn('bun', [
    'runtime/scripts/watch-process-tree.ts',
    '--label', 'MESH_TEST',
    '--watch-root', sourceRoot,
    '--debounce-ms', '20',
    '--term-timeout-ms', '100',
    '--kill-timeout-ms', '1000',
    '--', 'bun', mainPath, childPath, String(port), pidLogPath,
  ], {
    cwd: resolve(import.meta.dir, '../..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let watcherStderr = '';
  watcher.stderr.on('data', chunk => { watcherStderr += String(chunk); });
  const watcherExit = new Promise<void>(resolveExit => watcher.once('exit', () => resolveExit()));
  try {
    await waitFor(() => {
      if (watcher.exitCode !== null) throw new Error(`DEV_WATCH_SUPERVISOR_EARLY_EXIT:${watcherStderr}`);
      return readPids(pidLogPath).length === 1;
    });
    const firstPid = readPids(pidLogPath)[0]!;
    await waitFor(async () => await readListenerPid(port) === firstPid);

    writeFileSync(dependencyPath, 'export const generation = 2;\n', 'utf8');
    await waitFor(() => readPids(pidLogPath).length >= 2);
    const secondPid = readPids(pidLogPath)[1]!;
    expect(secondPid).not.toBe(firstPid);
    await waitFor(async () => await readListenerPid(port) === secondPid);
    expect(pidAlive(firstPid)).toBe(false);
  } finally {
    watcher.kill('SIGTERM');
    await Promise.race([watcherExit, Bun.sleep(1_000)]);
    if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill('SIGKILL');
    for (const pid of readPids(pidLogPath)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 12_000);

test('MESH supervisor ignores tests, scenarios, and operational scripts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-watch-ignore-'));
  const sourceRoot = join(root, 'source');
  const ignoredRoot = join(sourceRoot, 'scripts');
  const ignoredPath = join(ignoredRoot, 'smoke.ts');
  const mainPath = join(root, 'main.ts');
  const pidLogPath = join(root, 'children.pid');
  mkdirSync(ignoredRoot, { recursive: true });
  writeFileSync(ignoredPath, 'export const smoke = 1;\n', 'utf8');
  writeFileSync(mainPath, [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.argv[2]!, `${process.pid}\\n`, 'utf8');",
    'await new Promise<void>(() => {});',
  ].join('\n'), 'utf8');

  const watcher = spawn('bun', [
    'runtime/scripts/watch-process-tree.ts',
    '--label', 'MESH_IGNORE_TEST',
    '--watch-root', sourceRoot,
    '--ignore-prefix', 'scripts',
    '--debounce-ms', '20',
    '--term-timeout-ms', '100',
    '--kill-timeout-ms', '1000',
    '--', 'bun', mainPath, pidLogPath,
  ], {
    cwd: resolve(import.meta.dir, '../..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let watcherStderr = '';
  watcher.stderr.on('data', chunk => { watcherStderr += String(chunk); });
  const watcherExit = new Promise<void>(resolveExit => watcher.once('exit', () => resolveExit()));
  try {
    await waitFor(() => {
      if (watcher.exitCode !== null) throw new Error(`DEV_WATCH_IGNORE_EARLY_EXIT:${watcherStderr}`);
      return readPids(pidLogPath).length === 1;
    });
    writeFileSync(ignoredPath, 'export const smoke = 2;\n', 'utf8');
    await Bun.sleep(250);
    expect(readPids(pidLogPath)).toHaveLength(1);
  } finally {
    watcher.kill('SIGTERM');
    await Promise.race([watcherExit, Bun.sleep(1_000)]);
    if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill('SIGKILL');
    for (const pid of readPids(pidLogPath)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 5_000);

test('dev cleanup only reaps canonical dev ports and db paths', () => {
  expect(cleanSlate).toContain('RPC2_PORT="$(xln_rpc2_port)"');
  expect(cleanSlate).toContain('stop_owned_dev_processes "$DEV_OWNER_FILE" "$DEV_PID_DIR" "$ROOT_DIR"');
  expect(cleanSlate).toContain('assert_port_clear "$RPC2_PORT"');
  expect(cleanSlate).toContain('rm -rf "$DEV_DATA_ROOT"');
  expect(cleanSlate).not.toContain('kill_by_port');
  expect(cleanSlate).not.toContain('pkill');
  expect(cleanSlate).not.toMatch(/rm -rf db(?:\s|$)/);
});
