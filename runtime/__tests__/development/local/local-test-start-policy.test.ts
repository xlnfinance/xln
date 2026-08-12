import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  acquireLocalTestPortLease,
  buildInheritedLocalTestLeaseEnv,
  stripLocalTestLeaseEnv,
} from '../../../scripts/e2e/harness/local-test-port-lease';

const repoRoot = resolve(import.meta.dir, '../../../..');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const run = async (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn([command, ...args], {
    cwd: repoRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

test('local test lease capability enables assert-only startup and forbids process killing', async () => {
  const lease = await acquireLocalTestPortLease({ timeoutMs: 1_000 });
  const env = {
    ...stripLocalTestLeaseEnv(process.env),
    ...buildInheritedLocalTestLeaseEnv(lease, repoRoot),
  };
  try {
    const accepted = await run('bash', [
      '-c',
      'source scripts/lib/start-common.sh; xln_configure_start_policy "$1"; printf "%s:%s" "$XLN_START_ASSERT_ONLY_ACTIVE" "$XLN_PORT_BASE"',
      'lease-policy',
      repoRoot,
    ], env);
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toBe(`1:${lease.basePort}`);

    const killAttempt = await run('bash', [
      '-c',
      'source scripts/lib/start-common.sh; xln_configure_start_policy "$1"; xln_kill_by_port 1 test',
      'lease-kill-policy',
      repoRoot,
    ], env);
    expect(killAttempt.code).not.toBe(0);
    expect(killAttempt.stderr).toContain('LOCAL_TEST_PROCESS_KILL_FORBIDDEN:port');

    const rejected = await run('bash', [
      '-c',
      'source scripts/lib/start-common.sh; xln_configure_start_policy "$1"',
      'lease-reject-policy',
      repoRoot,
    ], { ...env, XLN_LOCAL_TEST_LEASE_OWNER_PID: '1' });
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain('LOCAL_TEST_LEASE_OWNER_INVALID');
  } finally {
    lease.release();
  }
});

test('local prod startup reports a post-lease port race without killing the owner', async () => {
  const lease = await acquireLocalTestPortLease({
    requiredOffsets: [0, 1, 4, 7, 8, 10, 11, 12, 13],
    timeoutMs: 1_000,
  });
  const root = mkdtempSync(join(tmpdir(), 'xln-local-prod-policy-'));
  tempRoots.push(root);
  const foreign = Bun.serve({
    hostname: '127.0.0.1',
    port: lease.basePort + 4,
    fetch: () => new Response('foreign-alive'),
  });
  try {
    const result = await run('bash', ['scripts/start-server.sh'], {
      ...stripLocalTestLeaseEnv(process.env),
      ...buildInheritedLocalTestLeaseEnv(lease, repoRoot),
      XLN_RDB_ROOT: join(root, 'rdb'),
      XLN_DB_PATH: join(root, 'rdb', 'prod-main'),
      XLN_MESH_DB_ROOT: join(root, 'rdb', 'prod-mesh'),
      XLN_SERVER_PORT: String(lease.basePort + 4),
      XLN_MESH_API_PORT_BASE: String(lease.basePort + 10),
      XLN_MESH_PUBLIC_PORT_BASE: String(lease.basePort + 10),
      XLN_MESH_CUSTODY_PORT: String(lease.basePort + 7),
      XLN_MESH_CUSTODY_DAEMON_PORT: String(lease.basePort + 8),
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`XLN_START_PORT_BUSY:port=${lease.basePort + 4}`);
    expect(await (await fetch(`http://127.0.0.1:${lease.basePort + 4}`)).text()).toBe('foreign-alive');
    expect(existsSync(join(root, 'rdb'))).toBeFalse();
  } finally {
    foreign.stop(true);
    lease.release();
  }
});
