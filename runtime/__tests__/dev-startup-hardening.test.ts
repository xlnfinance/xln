import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireDevSingleton, runDevCommands, type DevSingletonLease } from '../../scripts/dev/run-dev';
import {
  DEV_ROLES,
  isExpectedDevTerminationNotice,
  shouldEchoDevLine,
  superviseDev,
} from '../../scripts/dev/supervise-dev';

const repoRoot = resolve(import.meta.dir, '../..');
const tempRoots: string[] = [];

const capabilityEnv = (lease: DevSingletonLease): NodeJS.ProcessEnv => ({
  XLN_DEV_LAUNCHER_PORT: String(lease.port),
  XLN_DEV_LAUNCHER_TOKEN: lease.capability,
});

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
        'runtime/scripts/operations/development/wait-rpc-chain.ts',
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
        'runtime/scripts/operations/development/wait-rpc-chain.ts',
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
      'runtime/scripts/operations/development/wait-rpc-chain.ts',
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
  const supervisor = readFileSync(join(repoRoot, 'scripts/dev/supervise-dev.ts'), 'utf8');
  expect(DEV_ROLES).toEqual(['anvil', 'anvil2', 'mesh', 'watchtower', 'runtime', 'vite', 'vite-http', 'ready']);
  expect(runner).toContain('bun scripts/dev/supervise-dev.ts');
  expect(runner).not.toContain('concurrently');
  const firstReady = child.indexOf("--chain-id 31337");
  const secondReady = child.indexOf("--chain-id 31338");
  const barrier = supervisor.indexOf('const barrier = spawnRole(DEV_CHAIN_BARRIER_ROLE)');
  const applicationStart = supervisor.indexOf('for (const role of DEV_APPLICATION_ROLES) spawnRole(role)');
  expect(firstReady).toBeGreaterThan(0);
  expect(secondReady).toBeGreaterThan(firstReady);
  expect(child).toContain('rpc-ready)\n    wait_for_dev_chains');
  expect(child).toContain('DEV_CHAINS_NOT_READY:role=${role}');
  expect(barrier).toBeGreaterThan(0);
  expect(applicationStart).toBeGreaterThan(barrier);
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

test('ordinary dev startup atomically resets ephemeral Anvil and Runtime state', () => {
  const setup = readFileSync(join(repoRoot, 'scripts/dev/prepare-start.sh'), 'utf8');
  const launcher = readFileSync(join(repoRoot, 'scripts/dev/run-dev.ts'), 'utf8');
  const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts as Record<string, string>;
  expect(scripts['dev']).toBe('bun scripts/dev/run-dev.ts');
  expect(scripts['dev:debug']).toBe('bun scripts/dev/run-dev.ts --mode=debug');
  expect(scripts['dev:trace']).toBe('bun scripts/dev/run-dev.ts --mode=trace');
  expect(scripts['dev:verbose']).toBe('bun scripts/dev/run-dev.ts --mode=verbose');
  expect(scripts['dev:setup']).toBeUndefined();
  expect(scripts['dev:no-relay']).toBeUndefined();
  expect(scripts['dev:anvil2']).toBeUndefined();
  expect(scripts['start']).toBeUndefined();
  expect(scripts['serve']).toBeUndefined();
  expect(scripts['serve:dev']).toBeUndefined();
  expect(launcher.indexOf('const lease = acquireDevSingleton()')).toBeLessThan(launcher.indexOf('runDevCommands(commands'));
  expect(launcher).toContain('DEV_LAUNCHER_SHUTDOWN_TIMEOUT_MS = 90_000');
  expect(launcher).toContain('stopProcessGroup({');
  expect(scripts['clean-slate']).toBe('bun scripts/dev/run-dev.ts --clean');
  expect(setup).toContain('stop_owned_dev_processes');
  expect(setup).toContain('resetting ephemeral local JDB/RDB');
  expect(setup).toContain('rm -rf -- "$DEV_RDB_ROOT" "$DEV_JDB_ROOT"');
  expect(setup).not.toContain('rm -rf -- "$DEV_DATA_ROOT"');
  expect(setup).not.toContain('db-tmp');
  const dependencyCheck = setup.indexOf('DEV_DEPENDENCIES_MISSING:frontend');
  const ownedStop = setup.indexOf('stop_owned_dev_processes');
  const portPreflight = setup.indexOf('assert_dev_ports_clear');
  const contractSync = setup.indexOf('sync-contract-artifacts.sh');
  const stateReset = setup.indexOf('rm -rf -- "$DEV_RDB_ROOT" "$DEV_JDB_ROOT"');
  expect(dependencyCheck).toBeGreaterThanOrEqual(0);
  expect(portPreflight).toBeGreaterThanOrEqual(0);
  expect(dependencyCheck).toBeLessThan(ownedStop);
  expect(portPreflight).toBeGreaterThan(ownedStop);
  expect(portPreflight).toBeLessThan(contractSync);
  expect(portPreflight).toBeLessThan(stateReset);
});

test('ordinary dev uses a kernel-held machine-wide singleton', () => {
  const first = acquireDevSingleton(0);
  try {
    expect(() => acquireDevSingleton(first.port)).toThrow(`DEV_ALREADY_RUNNING:127.0.0.1:${first.port}`);
  } finally {
    first.release();
  }
  const replacement = acquireDevSingleton(first.port);
  replacement.release();
});

test('dev shell capability is exact and direct shell entrypoints fail before mutation', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'xln-dev-capability-')), 'not-created');
  tempRoots.push(resolve(root, '..'));
  const direct = await run('bash', ['scripts/dev/prepare-start.sh'], {
    env: { XLN_DEV_DATA_ROOT: root },
  });
  expect(direct.code).not.toBe(0);
  expect(direct.stderr).toContain('DEV_LAUNCHER_CAPABILITY_MISSING');
  expect(existsSync(root)).toBeFalse();

  const lease = acquireDevSingleton(0);
  try {
    const accepted = await run('bun', ['scripts/dev/verify-launcher-capability.ts'], {
      env: capabilityEnv(lease),
    });
    expect(accepted.code).toBe(0);
    const rejected = await run('bun', ['scripts/dev/verify-launcher-capability.ts'], {
      env: {
        XLN_DEV_LAUNCHER_PORT: String(lease.port),
        XLN_DEV_LAUNCHER_TOKEN: '0'.repeat(64),
      },
    });
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain('DEV_LAUNCHER_CAPABILITY_REJECTED');
  } finally {
    lease.release();
  }
});

test('dev launcher reaps a TERM-ignoring grandchild after its shell exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-process-group-'));
  tempRoots.push(root);
  const fixture = join(root, 'listener.ts');
  const ready = join(root, 'ready');
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = probe.port;
  probe.stop(true);
  writeFileSync(fixture, [
    "import { writeFileSync } from 'node:fs';",
    "process.on('SIGTERM', () => {});",
    "Bun.serve({ hostname: '127.0.0.1', port: Number(process.argv[2]), fetch: () => new Response('orphan') });",
    "writeFileSync(process.argv[3]!, String(process.pid));",
    "await new Promise(() => {});",
  ].join('\n'));
  const command = `bun ${JSON.stringify(fixture)} ${port} ${JSON.stringify(ready)} & while [ ! -f ${JSON.stringify(ready)} ]; do sleep 0.01; done`;
  const startedAt = performance.now();
  expect(await runDevCommands([['bash', '-c', command]], process.env, {
    cwd: repoRoot,
    termTimeoutMs: 100,
    killTimeoutMs: 2_000,
  })).toBe(0);
  expect(performance.now() - startedAt).toBeLessThan(3_000);
  expect(existsSync(ready)).toBeTrue();
  await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(200) })).rejects.toThrow();
});

test('ordinary dev forbids test-style port overrides before preparation', async () => {
  const result = await run('bun', ['scripts/dev/run-dev.ts'], {
    env: { XLN_PORT_BASE: '28000' },
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('DEV_PORT_OVERRIDE_FORBIDDEN:XLN_PORT_BASE');
  expect(result.stdout).not.toContain('resetting ephemeral local JDB/RDB');
});

test('canonical dev data root supports a clean checkout without a db parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-clean-checkout-'));
  tempRoots.push(root);
  const requested = join(root, 'db', 'dev');
  const result = await run('bash', [
    '-c',
    'source scripts/dev/process-owner.sh; canonical_dev_data_root "$1"',
    'canonical-root-test',
    requested,
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(join(realpathSync(root), 'db', 'dev'));
  expect(existsSync(join(root, 'db'))).toBeFalse();
});

test('dev startup reports a foreign listener and never kills it', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('foreign-listener-alive'),
  });
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-port-preflight-'));
  tempRoots.push(root);
  const pidDir = join(root, 'pids');
  const ownerFile = join(root, 'owner');
  mkdirSync(pidDir, { recursive: true });
  try {
    const result = await run('bash', [
      '-c',
      'source scripts/dev/process-owner.sh; assert_dev_ports_clear "$1" "$2" "$3"',
      'port-preflight-test',
      pidDir,
      ownerFile,
      String(server.port),
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`DEV_PORT_BUSY_UNOWNED:port=${server.port}`);
    expect(result.stderr).toContain(`DEV_PORT_BUSY_PROCESS:port=${server.port}`);
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text())
      .toBe('foreign-listener-alive');
  } finally {
    server.stop(true);
  }
});

test('full dev preparation preserves state when a required port belongs to another process', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('foreign-listener-alive'),
  });
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-prepare-preflight-'));
  tempRoots.push(root);
  const rdbSentinel = join(root, 'rdb', 'sentinel');
  const jdbSentinel = join(root, 'jdb', 'sentinel');
  mkdirSync(join(root, 'rdb'), { recursive: true });
  mkdirSync(join(root, 'jdb'), { recursive: true });
  writeFileSync(rdbSentinel, 'keep-rdb', 'utf8');
  writeFileSync(jdbSentinel, 'keep-jdb', 'utf8');
  const lease = acquireDevSingleton(0);
  try {
    const result = await run('bash', ['scripts/dev/prepare-start.sh'], {
      env: {
        ...capabilityEnv(lease),
        XLN_DEV_DATA_ROOT: root,
        XLN_PORT_BASE: String(server.port),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`DEV_PORT_BUSY_UNOWNED:port=${server.port}`);
    expect(readFileSync(rdbSentinel, 'utf8')).toBe('keep-rdb');
    expect(readFileSync(jdbSentinel, 'utf8')).toBe('keep-jdb');
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text())
      .toBe('foreign-listener-alive');
  } finally {
    lease.release();
    server.stop(true);
  }
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

test('HTTPS and HTTP dev servers share canonical SvelteKit output with isolated Vite caches', () => {
  const child = readFileSync(join(repoRoot, 'scripts/dev/run-dev-child.sh'), 'utf8');
  expect(child).toContain('run_vite "$WEB_PORT" --logLevel warn');
  expect(child).toContain('run_vite "$WEB_HTTP_PORT" --config vite.config.http.ts --logLevel warn');
  expect(child).not.toContain('XLN_SVELTE_KIT_OUT_DIR');
  expect(readFileSync(join(repoRoot, 'frontend/vite.config.ts'), 'utf8'))
    .toContain("process.env['VITE_CACHE_DIR'] || 'node_modules/.vite'");
  expect(readFileSync(join(repoRoot, 'frontend/vite.config.http.ts'), 'utf8'))
    .toContain("process.env['VITE_HTTP_CACHE_DIR'] || 'node_modules/.vite-http'");
});

test('storage health measures the configured RDB and JDB shard roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-storage-health-'));
  tempRoots.push(root);
  const rdbRoot = join(root, 'rdb');
  const jdbRoot = join(root, 'jdb');
  const historyPath = join(root, 'health.json');
  const probe = await run('bun', ['-e', [
    "const { getStorageHealth } = await import('./runtime/infra/storage-monitor.ts');",
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
  expect(runner).toContain('assert_no_dev_storage_path_overrides');
  expect(runner).toContain('canonical_dev_data_root');
  expect(runner).toContain('XLN_RDB_ROOT="$DEV_DATA_ROOT/rdb"');
  expect(runner).toContain('XLN_JDB_ROOT="$DEV_DATA_ROOT/jdb"');
  expect(runner).toContain('XLN_STORAGE_HISTORY_PATH="$XLN_RDB_ROOT/storage-health-history.json"');
  expect(runner).toContain('ANVIL_TMPDIR="$XLN_JDB_ROOT/tmp/anvil"');
  expect(runner).toContain('XLN_JURISDICTIONS_PATH="$XLN_RDB_ROOT/jurisdictions.json"');
  expect(child).toContain('--db-root "$XLN_RDB_ROOT/mesh"');
  expect(child).toContain('--db "$XLN_RDB_ROOT/watchtower"');
  expect(runner).toContain('export DEV_RUNTIME_BUNDLE_PATH DEV_STARTED_AT_MS DEV_READY_TIMEOUT_MS DEV_SHUTDOWN_TIMEOUT_MS');
  expect(child).not.toContain('DEV_INNER_KILL_TIMEOUT_MS');
  expect(child).not.toContain('CONCURRENTLY_JS');
  expect(child).not.toContain('dist/bin/concurrently.js');
});

test('dev supervisor owns all roles, preserves their logs and stops siblings after one role fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-supervisor-'));
  tempRoots.push(root);
  const childScript = join(root, 'child.sh');
  const descendantPidPath = join(root, 'descendant.pid');
  const logDir = join(root, 'logs');
  writeFileSync(childScript, `#!/bin/bash
set -euo pipefail
role="$1"
echo "started role=$role"
if [[ "$role" == "ready" || "$role" == "rpc-ready" ]]; then exit 0; fi
if [[ "$role" == "mesh" ]]; then sleep 0.1; exit 7; fi
if [[ "$role" == "anvil" ]]; then
  sleep 30 &
  echo $! > "${descendantPidPath}"
fi
trap 'exit 0' TERM INT
while true; do sleep 0.05; done
`);
  chmodSync(childScript, 0o700);
  const exitCode = await superviseDev({
    childScript,
    cwd: root,
    logDir,
    shutdownTimeoutMs: 2_000,
  });
  expect(exitCode).toBe(7);
  const log = readFileSync(join(logDir, 'dev.log'), 'utf8');
  for (const role of DEV_ROLES) expect(log).toContain(`started role=${role}`);
  expect(log).toContain('[MESH] DEV_ROLE_EXIT code=7 signal=none');
  expect(log).toContain('DEV_STOPPED exitCode=7');
  const descendantPid = Number(readFileSync(descendantPidPath, 'utf8').trim());
  expect(() => process.kill(descendantPid, 0)).toThrow();
});

test('dev console keeps lifecycle/status/error lines while full detail stays in dev.log', () => {
  expect(shouldEchoDevLine('ready', 'DEV_HEARTBEAT phase=mesh', false)).toBe(true);
  expect(shouldEchoDevLine('mesh', 'RUNTIME_IMPORT_READY count=5', false)).toBe(true);
  expect(shouldEchoDevLine('mesh', '[WARN][network] retrying', false)).toBe(true);
  expect(shouldEchoDevLine('vite', 'verbose transform detail', false)).toBe(false);
  expect(shouldEchoDevLine('vite', 'real socket failure', true)).toBe(true);
  expect(isExpectedDevTerminationNotice(
    '/repo/scripts/dev/run-dev-child.sh: line 63: 98394 Terminated: 15          "$@"',
  )).toBe(true);
  expect(isExpectedDevTerminationNotice('worker failed: Terminated: 15 while flushing state')).toBe(false);
});

test('dev rejects independent storage roots before stopping or resetting anything', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-storage-override-'));
  tempRoots.push(root);
  const lease = acquireDevSingleton(0);
  try {
    const result = await run('bash', ['scripts/dev/prepare-start.sh'], {
      env: {
        ...capabilityEnv(lease),
        XLN_DEV_DATA_ROOT: root,
        XLN_RDB_ROOT: join(root, 'other-rdb'),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('DEV_STORAGE_OVERRIDE_FORBIDDEN:XLN_RDB_ROOT');
    expect(existsSync(join(root, 'rdb'))).toBeFalse();
  } finally {
    lease.release();
  }
});
