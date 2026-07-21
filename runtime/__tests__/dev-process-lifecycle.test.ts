import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../..');
const concurrentlyJs = join(repoRoot, 'node_modules/concurrently/dist/bin/concurrently.js');
const tempRoots: string[] = [];
const cleanupPids = new Set<number>();

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> => {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt >= timeoutMs) throw new Error(`WAIT_TIMEOUT:${label}`);
    await Bun.sleep(20);
  }
};

const waitForExit = async (
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    }),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`PROCESS_EXIT_TIMEOUT:pid=${child.pid ?? 'unknown'}`);
    }),
  ]);
};

const waitForFile = async (path: string): Promise<void> => {
  await waitUntil(() => existsSync(path), `file=${path}`);
};

afterEach(async () => {
  for (const pid of cleanupPids) {
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
  cleanupPids.clear();
  await Bun.sleep(20);
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dev process lifecycle', () => {
  test('Bun supervisor kills every concurrently descendant on SIGINT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-dev-supervisor-'));
    tempRoots.push(root);
    const firstPidPath = join(root, 'first.pid');
    const secondPidPath = join(root, 'second.pid');
    const command = (pidPath: string): string =>
      `bash -c 'echo $$$$ > "${pidPath}"; trap "exit 0" INT TERM; while :; do sleep 1; done'`;
    const supervisor = spawn('bun', [
      '--no-orphans', concurrentlyJs,
      '--kill-others', '--kill-timeout', '1000',
      command(firstPidPath), command(secondPidPath),
    ], { cwd: repoRoot, stdio: 'ignore' });
    if (!supervisor.pid) throw new Error('SUPERVISOR_PID_MISSING');
    cleanupPids.add(supervisor.pid);
    await Promise.all([waitForFile(firstPidPath), waitForFile(secondPidPath)]);
    const descendants = [firstPidPath, secondPidPath].map(path => Number(readFileSync(path, 'utf8').trim()));
    descendants.forEach(pid => cleanupPids.add(pid));

    process.kill(supervisor.pid, 'SIGINT');
    await waitForExit(supervisor);
    await waitUntil(() => descendants.every(pid => !isAlive(pid)), `descendants=${descendants.join(',')}`);
  });

  test('watchtower cannot survive a SIGKILLed role wrapper', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-dev-watchtower-'));
    tempRoots.push(root);
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
    const port = reservation.port;
    reservation.stop(true);
    const pidDir = join(root, 'pids');
    const wrapper = spawn(join(repoRoot, 'scripts/dev/run-dev-child.sh'), ['watchtower'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        RPC_PORT: '19545', RPC2_PORT: '19546', API_PORT: '19082', WEB_PORT: '19080', WEB_HTTP_PORT: '19081',
        CUSTODY_PORT: '19087', CUSTODY_DAEMON_PORT: '19088', WATCHTOWER_PORT: String(port),
        DEV_LOG_DIR: join(root, 'logs'), MESH_LOG_LEVEL: 'warn', XLN_RDB_ROOT: join(root, 'rdb'),
        XLN_JDB_ROOT: join(root, 'jdb'), XLN_DEV_PID_DIR: pidDir, XLN_DEV_OWNER_ID: 'a'.repeat(32),
      },
      stdio: 'ignore',
    });
    if (!wrapper.pid) throw new Error('WATCHTOWER_WRAPPER_PID_MISSING');
    cleanupPids.add(wrapper.pid);
    await waitUntil(() => {
      try { return Bun.spawnSync(['lsof', '-ti', `TCP:${port}`, '-sTCP:LISTEN']).stdout.toString().trim().length > 0; }
      catch { return false; }
    }, `watchtower-port=${port}`, 10_000);
    const listenerPid = Number(Bun.spawnSync(['lsof', '-ti', `TCP:${port}`, '-sTCP:LISTEN']).stdout.toString().trim());
    expect(listenerPid).toBeGreaterThan(0);
    expect(listenerPid).not.toBe(wrapper.pid);
    cleanupPids.add(listenerPid);

    process.kill(wrapper.pid, 'SIGKILL');
    await waitForExit(wrapper);
    await waitUntil(() => !isAlive(listenerPid), `watchtower-listener=${listenerPid}`);
  });

  test('cleanup accepts a recorded process that exits during identity inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-dev-owner-race-'));
    tempRoots.push(root);
    const pidDir = join(root, 'pids');
    const ownerFile = join(root, 'owner');
    const counterFile = join(root, 'kill-count');
    const owner = 'b'.repeat(32);
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(ownerFile, `${owner}\n`, 'utf8');
    writeFileSync(counterFile, '0', 'utf8');
    writeFileSync(join(pidDir, 'anvil.pid'), `${owner}\t4242\tTue Jul 21 18:00:00 2026\t${repoRoot}\tanvil\n`, 'utf8');
    const script = [
      'source scripts/dev/process-owner.sh',
      'kill() {',
      '  if [[ "$1" == "-0" ]]; then',
      '    local count="$(cat "$MOCK_COUNTER")"',
      '    echo "$((count + 1))" > "$MOCK_COUNTER"',
      '    [[ "$count" -eq 0 ]]',
      '    return',
      '  fi',
      '  echo "UNEXPECTED_SIGNAL:$*" >&2',
      '  return 1',
      '}',
      'ps() { return 1; }',
      'stop_owned_dev_processes "$1" "$2" "$3"',
    ].join('\n');
    const result = Bun.spawnSync(['bash', '-c', script, 'owner-race', ownerFile, pidDir, repoRoot], {
      cwd: repoRoot,
      env: { ...process.env, MOCK_COUNTER: counterFile },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).not.toContain('DEV_PROCESS_START_IDENTITY_UNAVAILABLE');
    expect(result.stderr.toString()).not.toContain('UNEXPECTED_SIGNAL');
    expect(existsSync(join(pidDir, 'anvil.pid'))).toBeFalse();
  });

  test('busy-port diagnostic identifies the exact listener and ownership record', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-dev-port-diagnostic-'));
    tempRoots.push(root);
    const pidDir = join(root, 'pids');
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(
      join(pidDir, 'watchtower.pid'),
      `${'d'.repeat(32)}\t${process.pid}\tunused\t${repoRoot}\twatchtower\n`,
      'utf8',
    );
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
    try {
      const script = 'source scripts/dev/process-owner.sh; describe_dev_port_listener "$1" "$2" "$3"';
      const result = Bun.spawnSync(['bash', '-c', script, 'port-diagnostic', String(server.port), String(process.pid), pidDir], {
        cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
      });
      const diagnostic = result.stderr.toString();
      expect(result.exitCode).toBe(0);
      expect(diagnostic).toContain(`DEV_PORT_BUSY_PROCESS:port=${server.port} pid=${process.pid}`);
      expect(diagnostic).toContain('ppid=');
      expect(diagnostic).toContain('pgid=');
      expect(diagnostic).toContain('start=');
      expect(diagnostic).toContain(`cwd=${repoRoot}`);
      expect(diagnostic).toContain('ownership=role=watchtower,record=watchtower.pid');
      expect(diagnostic).toContain('command=');
    } finally {
      server.stop(true);
    }
  });

  test('SIGINTed role wrapper removes its record and can restart immediately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-dev-role-restart-'));
    tempRoots.push(root);
    const binDir = join(root, 'bin');
    const pidDir = join(root, 'pids');
    mkdirSync(binDir, { recursive: true });
    const fakeAnvil = join(binDir, 'anvil');
    writeFileSync(fakeAnvil, '#!/bin/bash\nexec sleep 30\n', 'utf8');
    chmodSync(fakeAnvil, 0o755);
    const env = {
      ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
      RPC_PORT: '19545', RPC2_PORT: '19546', API_PORT: '19082', WEB_PORT: '19080', WEB_HTTP_PORT: '19081',
      CUSTODY_PORT: '19087', CUSTODY_DAEMON_PORT: '19088', WATCHTOWER_PORT: '19110',
      DEV_LOG_DIR: join(root, 'logs'), MESH_LOG_LEVEL: 'warn', XLN_RDB_ROOT: join(root, 'rdb'),
      XLN_JDB_ROOT: join(root, 'jdb'), XLN_DEV_PID_DIR: pidDir, XLN_DEV_OWNER_ID: 'c'.repeat(32), DEV_VERBOSE: '1',
      XLN_DEV_CHILD_TERM_TIMEOUT_MS: '500',
    };
    const startAndStop = async (): Promise<void> => {
      const wrapper = spawn(join(repoRoot, 'scripts/dev/run-dev-child.sh'), ['anvil'], { cwd: repoRoot, env, stdio: 'ignore' });
      if (!wrapper.pid) throw new Error('ANVIL_WRAPPER_PID_MISSING');
      cleanupPids.add(wrapper.pid);
      const recordPath = join(pidDir, 'anvil.pid');
      await waitForFile(recordPath);
      let childPid = 0;
      await waitUntil(() => {
        childPid = Number(Bun.spawnSync(['pgrep', '-P', String(wrapper.pid)]).stdout.toString().trim());
        return childPid > 0;
      }, `anvil-child-for-wrapper=${wrapper.pid}`);
      cleanupPids.add(childPid);
      process.kill(wrapper.pid, 'SIGINT');
      await waitForExit(wrapper);
      await waitUntil(() => !isAlive(childPid), `anvil-child=${childPid}`);
      await waitUntil(() => !existsSync(recordPath), `removed-record=${recordPath}`);
    };
    await startAndStop();
    await startAndStop();
  }, 10_000);
});
