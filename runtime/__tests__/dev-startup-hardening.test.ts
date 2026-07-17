import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../..');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const run = async (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }> => {
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const timeoutMs = options.timeoutMs ?? 5_000;
  const code = await Promise.race([
    new Promise<number | null>(resolveExit => child.once('exit', resolveExit)),
    Bun.sleep(timeoutMs).then(() => {
      child.kill('SIGKILL');
      throw new Error(`COMMAND_TIMEOUT:${command} ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`);
    }),
  ]);
  return { code, stdout, stderr, elapsedMs: performance.now() - startedAt };
};

const startChainRpc = (chainId: number): ReturnType<typeof Bun.serve> => Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: async request => {
    const body = await request.json() as { id?: unknown; method?: unknown };
    if (body.method !== 'eth_chainId') {
      return Response.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'method not found' } });
    }
    return Response.json({ jsonrpc: '2.0', id: body.id ?? null, result: `0x${chainId.toString(16)}` });
  },
});

const waitForPath = async (path: string, timeoutMs = 1_000): Promise<void> => {
  const startedAt = performance.now();
  while (!existsSync(path)) {
    if (performance.now() - startedAt >= timeoutMs) throw new Error(`PATH_WAIT_TIMEOUT:${path}`);
    await Bun.sleep(10);
  }
};

describe('dev RPC readiness', () => {
  test('accepts only the expected chain id', async () => {
    const server = startChainRpc(31_337);
    try {
      const result = await run('bun', [
        'runtime/scripts/wait-rpc-chain.ts',
        '--url', `http://127.0.0.1:${server.port}`,
        '--chain-id', '31337',
        '--timeout-ms', '1000',
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('DEV_RPC_READY');
    } finally {
      server.stop(true);
    }
  });

  test('fails immediately when a listener exposes the wrong chain', async () => {
    const server = startChainRpc(31_338);
    try {
      const result = await run('bun', [
        'runtime/scripts/wait-rpc-chain.ts',
        '--url', `http://127.0.0.1:${server.port}`,
        '--chain-id', '31337',
        '--timeout-ms', '1000',
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('DEV_RPC_CHAIN_ID_MISMATCH');
      expect(result.elapsedMs).toBeLessThan(900);
    } finally {
      server.stop(true);
    }
  });

  test('bounds readiness wait when no RPC is listening', async () => {
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
    const port = reservation.port;
    reservation.stop(true);
    const result = await run('bun', [
      'runtime/scripts/wait-rpc-chain.ts',
      '--url', `http://127.0.0.1:${port}`,
      '--chain-id', '31337',
      '--timeout-ms', '200',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('DEV_RPC_READY_TIMEOUT');
    expect(result.elapsedMs).toBeLessThan(1_500);
  });
});

test('dev starts application services only after both exact Anvil chains are ready', () => {
  const runner = readFileSync(join(repoRoot, 'scripts/dev/run-dev.sh'), 'utf8');
  const child = readFileSync(join(repoRoot, 'scripts/dev/run-dev-child.sh'), 'utf8');
  expect(runner).toContain("--names 'ANVIL,ANVIL2,STACK'");
  expect(runner).toContain('${DEV_CHILD_COMMAND} stack');
  const firstReady = child.indexOf("--chain-id 31337");
  const secondReady = child.indexOf("--chain-id 31338");
  const meshStart = child.indexOf('${DEV_CHILD_COMMAND} mesh');
  expect(firstReady).toBeGreaterThan(0);
  expect(secondReady).toBeGreaterThan(firstReady);
  expect(meshStart).toBeGreaterThan(secondReady);
});

test('dev cleanup reaps only owner-recorded processes and only deletes the dev shard', () => {
  const clean = readFileSync(join(repoRoot, 'scripts/dev/clean-slate.sh'), 'utf8');
  const child = readFileSync(join(repoRoot, 'scripts/dev/run-dev-child.sh'), 'utf8');
  const ownership = readFileSync(join(repoRoot, 'scripts/dev/process-owner.sh'), 'utf8');
  expect(clean).toContain('stop_owned_dev_processes');
  expect(ownership).toContain('DEV_PROCESS_OWNER_MISMATCH');
  expect(clean).toContain('rm -rf "$DEV_DATA_ROOT"');
  expect(clean).not.toContain('kill_by_port');
  expect(clean).not.toContain('pkill');
  expect(clean).not.toMatch(/rm -rf db(?:\s|$)/);
  expect(clean).not.toContain('rm -rf db-tmp');
  expect(clean).not.toContain('rm -rf db-relay');
  expect(child).toContain('register_owned_dev_process');
});

test('dev ownership rejects a stale PID file that points at a foreign process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-owner-'));
  tempRoots.push(root);
  const pidDir = join(root, 'pids');
  const ownerFile = join(root, 'owner');
  const owner = 'a'.repeat(32);
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(ownerFile, `${owner}\n`, 'utf8');
  writeFileSync(join(pidDir, 'anvil.pid'), `${owner}\t${process.pid}\tanvil\n`, 'utf8');
  const result = await run('bash', [
    '-c',
    'source scripts/dev/process-owner.sh; stop_owned_dev_processes "$1" "$2" "$3"',
    'owner-test',
    ownerFile,
    pidDir,
    repoRoot,
  ]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('DEV_PROCESS_OWNER_MISMATCH');
  expect(() => process.kill(process.pid, 0)).not.toThrow();
});

test('dev ownership records bind PID start identity to the absolute repo and role', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-owner-record-'));
  tempRoots.push(root);
  const pidDir = join(root, 'pids');
  const owner = 'b'.repeat(32);
  const result = await run('bash', [
    '-c',
    'source scripts/dev/process-owner.sh; export XLN_DEV_OWNER_ID="$1" XLN_DEV_PID_DIR="$2"; register_owned_dev_process anvil "$3"; cat "$2/anvil.pid"',
    'owner-record-test',
    owner,
    pidDir,
    repoRoot,
  ]);
  expect(result.code).toBe(0);
  const fields = result.stdout.trim().split('\t');
  expect(fields).toHaveLength(5);
  expect(fields[0]).toBe(owner);
  expect(fields[2]?.length).toBeGreaterThan(0);
  expect(fields[3]).toBe(repoRoot);
  expect(fields[4]).toBe('anvil');
});

const runOwnedStopWithMockProcess = async (params: {
  storedStart: string;
  liveStart: string;
  liveCommand: string;
}): Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }> => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-owner-reuse-'));
  tempRoots.push(root);
  const pidDir = join(root, 'pids');
  const ownerFile = join(root, 'owner');
  const owner = 'c'.repeat(32);
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(ownerFile, `${owner}\n`, 'utf8');
  writeFileSync(join(pidDir, 'anvil.pid'), `${owner}\t4242\t${params.storedStart}\t${repoRoot}\tanvil\n`, 'utf8');
  return run('bash', [
    '-c',
    'source scripts/dev/process-owner.sh; kill() { [[ "$1" == "-0" ]] && return 0; echo "UNEXPECTED_KILL:$*" >&2; }; ps() { [[ "$*" == *"lstart="* ]] && printf "%s\\n" "$MOCK_START" || printf "%s\\n" "$MOCK_COMMAND"; }; stop_owned_dev_processes "$1" "$2" "$3"',
    'owner-reuse-test',
    ownerFile,
    pidDir,
    repoRoot,
  ], { env: { MOCK_START: params.liveStart, MOCK_COMMAND: params.liveCommand } });
};

test('dev ownership rejects a reused PID even when argv still matches the role', async () => {
  const result = await runOwnedStopWithMockProcess({
    storedStart: 'Thu Jul 16 10:00:00 2026',
    liveStart: 'Thu Jul 16 10:00:01 2026',
    liveCommand: `/bin/bash ${repoRoot}/scripts/dev/run-dev-child.sh anvil`,
  });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('DEV_PROCESS_START_IDENTITY_MISMATCH');
  expect(result.stderr).not.toContain('UNEXPECTED_KILL');
});

test('dev ownership rejects the same role running from another checkout', async () => {
  const start = 'Thu Jul 16 10:00:00 2026';
  const result = await runOwnedStopWithMockProcess({
    storedStart: start,
    liveStart: start,
    liveCommand: '/bin/bash /tmp/other-xln/scripts/dev/run-dev-child.sh anvil',
  });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('DEV_PROCESS_REPO_ROLE_MISMATCH');
  expect(result.stderr).not.toContain('UNEXPECTED_KILL');
});

test('dev cleanup stops a live wrapper whose full process identity matches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-owner-live-'));
  tempRoots.push(root);
  const binDir = join(root, 'bin');
  const pidDir = join(root, 'pids');
  const ownerFile = join(root, 'owner');
  const owner = 'e'.repeat(32);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(ownerFile, `${owner}\n`, 'utf8');
  const fakeAnvil = join(binDir, 'anvil');
  writeFileSync(fakeAnvil, '#!/bin/bash\nexec sleep 30\n', 'utf8');
  chmodSync(fakeAnvil, 0o755);
  const child = spawn(join(repoRoot, 'scripts/dev/run-dev-child.sh'), ['anvil'], {
    cwd: repoRoot,
    env: {
      ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
      RPC_PORT: '19545', RPC2_PORT: '19546', API_PORT: '19082', WEB_PORT: '19080', WEB_HTTP_PORT: '19081',
      CUSTODY_PORT: '19087', CUSTODY_DAEMON_PORT: '19088', WATCHTOWER_PORT: '19110', DEV_LOG_DIR: join(root, 'logs'),
      MESH_LOG_LEVEL: 'warn', XLN_RDB_ROOT: join(root, 'rdb'), XLN_JDB_ROOT: join(root, 'jdb'),
      ANVIL_TMPDIR: join(root, 'jdb', 'tmp', 'anvil'), XLN_DEV_PID_DIR: pidDir, XLN_DEV_OWNER_ID: owner, DEV_VERBOSE: '1',
    },
    stdio: 'ignore',
  });
  const exited = new Promise<number | null>(resolveExit => child.once('exit', resolveExit));
  try {
    await waitForPath(join(pidDir, 'anvil.pid'));
    const result = await run('bash', ['-c', 'source scripts/dev/process-owner.sh; stop_owned_dev_processes "$1" "$2" "$3"', 'owner-live-test', ownerFile, pidDir, repoRoot], { timeoutMs: 7_000 });
    expect(result.code).toBe(0);
    expect(await Promise.race([exited, Bun.sleep(1_000).then(() => 'timeout')])).not.toBe('timeout');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('HTTPS and HTTP dev servers use separate SvelteKit outputs', () => {
  const child = readFileSync(join(repoRoot, 'scripts/dev/run-dev-child.sh'), 'utf8');
  expect(child).toContain('run_vite "$WEB_PORT" ".svelte-kit-dev-https"');
  expect(child).toContain('run_vite "$WEB_HTTP_PORT" ".svelte-kit-dev-http"');
  expect(child).toContain('XLN_SVELTE_KIT_OUT_DIR="$svelte_out_dir"');
});

test('storage health measures the configured RDB and JDB shard roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-storage-health-'));
  tempRoots.push(root);
  const rdbRoot = join(root, 'rdb');
  const jdbRoot = join(root, 'jdb');
  const historyPath = join(root, 'health.json');
  const probe = await run('bun', ['-e', [
    "const { getStorageHealth } = await import('./runtime/orchestrator/storage-monitor.ts');",
    'const health = await getStorageHealth();',
    'console.log(JSON.stringify({ historyPath: health.historyPath, tracked: health.tracked.map(x => ({ name: x.name, path: x.path })) }));',
  ].join(' ')], {
    env: {
      XLN_RDB_ROOT: rdbRoot,
      XLN_JDB_ROOT: jdbRoot,
      XLN_STORAGE_HISTORY_PATH: historyPath,
      XLN_MIN_DISK_FREE_BYTES: '1',
    },
  });
  expect(probe.code).toBe(0);
  const payload = JSON.parse(probe.stdout.trim()) as {
    historyPath: string;
    tracked: Array<{ name: string; path: string }>;
  };
  expect(payload.historyPath).toBe(historyPath);
  expect(payload.tracked).toContainEqual({ name: 'runtimeDb', path: rdbRoot });
  expect(payload.tracked).toContainEqual({ name: 'jurisdictionDb', path: jdbRoot });
});

test('each dev Anvil writes state and temp files inside its configured JDB root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-anvil-storage-'));
  tempRoots.push(root);
  const binDir = join(root, 'bin');
  const jdbRoot = join(root, 'jdb');
  mkdirSync(binDir, { recursive: true });
  const fakeAnvil = join(binDir, 'anvil');
  writeFileSync(fakeAnvil, '#!/bin/bash\nprintf "TMPDIR=%s\\nANVIL_TMPDIR=%s\\nARGS=%s\\n" "$TMPDIR" "$ANVIL_TMPDIR" "$*"\n', 'utf8');
  chmodSync(fakeAnvil, 0o755);
  const baseEnv = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    RPC_PORT: '18545', RPC2_PORT: '18546', API_PORT: '18082', WEB_PORT: '18080', WEB_HTTP_PORT: '18081',
    CUSTODY_PORT: '18087', CUSTODY_DAEMON_PORT: '18088', WATCHTOWER_PORT: '19100',
    DEV_LOG_DIR: join(root, 'logs'), MESH_LOG_LEVEL: 'warn', XLN_RDB_ROOT: join(root, 'rdb'), XLN_JDB_ROOT: jdbRoot,
    ANVIL_TMPDIR: join(jdbRoot, 'tmp', 'anvil'), XLN_DEV_PID_DIR: join(root, 'pids'), XLN_DEV_OWNER_ID: 'd'.repeat(32), DEV_VERBOSE: '1',
  };
  for (const [role, chainId] of [['anvil', '31337'], ['anvil2', '31338']] as const) {
    const result = await run('./scripts/dev/run-dev-child.sh', [role], { env: baseEnv });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`TMPDIR=${jdbRoot}/tmp/anvil/chain-${chainId}`);
    expect(result.stdout).toContain(`ANVIL_TMPDIR=${jdbRoot}/tmp/anvil/chain-${chainId}`);
    expect(result.stdout).toContain(`--state ${jdbRoot}/anvil-${chainId}-state.json`);
    expect(result.stdout).toContain('--state-interval 60');
  }
});

test('dev exports the storage roots consumed by mesh, watcher and health monitoring', () => {
  const runner = readFileSync(join(repoRoot, 'scripts/dev/run-dev.sh'), 'utf8');
  const child = readFileSync(join(repoRoot, 'scripts/dev/run-dev-child.sh'), 'utf8');
  expect(runner).toContain('XLN_RDB_ROOT="${XLN_RDB_ROOT:-$DEV_DATA_ROOT/rdb}"');
  expect(runner).toContain('XLN_JDB_ROOT="${XLN_JDB_ROOT:-$DEV_DATA_ROOT/jdb}"');
  expect(runner).toContain('XLN_STORAGE_HISTORY_PATH="${XLN_STORAGE_HISTORY_PATH:-$XLN_RDB_ROOT/storage-health-history.json}"');
  expect(child).toContain('--db-root "$XLN_RDB_ROOT/mesh"');
  expect(child).toContain('--db "$XLN_RDB_ROOT/watchtower"');
});
