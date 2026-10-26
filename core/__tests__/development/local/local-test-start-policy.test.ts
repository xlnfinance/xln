import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  acquireLocalTestPortLease,
  acquireLocalHltLaneLease,
  buildInheritedLocalTestLeaseEnv,
  LOCAL_TEST_STACK_BASES,
  stripLocalTestLeaseEnv,
} from '../../../scripts/e2e/harness/local-test-port-lease';
import { resetOwnedLocalRunRoot } from '../../../scripts/e2e/harness/local-run-root';

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

// The shell start policy keeps its own lane list; a pool lane it does not know
// fails every stack started there with LOCAL_TEST_LEASE_BASE_INVALID.
test('the shell start policy accepts every machine-wide stack lane', async () => {
  for (const base of LOCAL_TEST_STACK_BASES) {
    const lease = await acquireLocalTestPortLease({ slotBases: [base], timeoutMs: 1_000 });
    try {
      const env = { ...stripLocalTestLeaseEnv(process.env), ...buildInheritedLocalTestLeaseEnv(lease, repoRoot) };
      const accepted = await run('bash', [
        '-c',
        'source scripts/lib/start-common.sh; xln_configure_start_policy "$1"; printf "%s" "$XLN_PORT_BASE"',
        'lease-lane-policy',
        repoRoot,
      ], env);
      expect(accepted.stderr, String(base)).toBe('');
      expect(accepted.stdout).toBe(String(base));
    } finally {
      lease.release();
    }
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
    const result = await run('bash', ['scripts/operations/start-server.sh'], {
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

test('HLT lane leases allocate disjoint fixed-size port batches', async () => {
  const first = await acquireLocalHltLaneLease(4_096, 1_000);
  const second = await acquireLocalHltLaneLease(4_096, 1_000);
  try {
    expect(second.basePort).not.toBe(first.basePort);
    expect(Math.abs(second.basePort - first.basePort)).toBeGreaterThanOrEqual(4_096);
  } finally {
    second.release();
    first.release();
  }
});

test('owned local run roots reject dev and foreign data before reset', () => {
  const owned = mkdtempSync(join(tmpdir(), 'xln-owned-root-test-'));
  const foreign = mkdtempSync(join(tmpdir(), 'xln-foreign-root-test-'));
  tempRoots.push(owned, foreign);
  resetOwnedLocalRunRoot(owned, repoRoot, 'test');
  writeFileSync(join(owned, 'stale.txt'), 'stale');
  resetOwnedLocalRunRoot(owned, repoRoot, 'test');
  expect(existsSync(join(owned, 'stale.txt'))).toBeFalse();

  writeFileSync(join(foreign, 'owner-data.txt'), 'keep');
  expect(() => resetOwnedLocalRunRoot(foreign, repoRoot, 'test'))
    .toThrow('LOCAL_RUN_ROOT_NOT_OWNED');
  expect(() => resetOwnedLocalRunRoot(join(repoRoot, 'db', 'dev'), repoRoot, 'test'))
    .toThrow('LOCAL_RUN_ROOT_OVERLAPS_DEV');
});

test('startup selects the actual PATH Bun only when it matches the repository pin', async () => {
  const result = await run(
    'bash',
    [
      '-ec',
      'source scripts/lib/start-common.sh; xln_require_pinned_bun "$1"; "$XLN_START_BUN" --version',
      'pinned-bun',
      repoRoot,
    ],
    process.env,
  );
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe(Bun.version);
});

test('startup rejects a different Bun pin before any following service action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-start-bun-pin-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'package.json'), '{"packageManager":"bun@0.0.0"}');
  const marker = join(root, 'service-started');
  const result = await run(
    'bash',
    [
      '-ec',
      'source scripts/lib/start-common.sh; xln_require_pinned_bun "$1"; touch "$2"',
      'pinned-bun-reject',
      root,
      marker,
    ],
    process.env,
  );
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(`XLN_BUN_VERSION_MISMATCH:expected=bun@0.0.0:actual=bun@${Bun.version}`);
  expect(existsSync(marker)).toBeFalse();
});

test('actual fresh deployment rejects an unsupported Bun before deleting data or logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-deploy-bun-pin-'));
  tempRoots.push(root);
  for (const directory of ['core', 'db', 'logs', 'scripts/deployment', 'scripts/lib']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const file of ['scripts/deployment/deploy-platform.sh', 'scripts/lib/start-common.sh']) {
    writeFileSync(join(root, file), readFileSync(join(repoRoot, file)));
  }
  writeFileSync(join(root, 'package.json'), '{"packageManager":"bun@0.0.0"}');
  writeFileSync(join(root, 'db', 'owner-data'), 'preserve data');
  writeFileSync(join(root, 'logs', 'owner.log'), 'preserve evidence');
  const result = await run(
    'bash',
    [join(root, 'scripts/deployment/deploy-platform.sh'), '--fresh', '--runtime-only'],
    process.env,
  );
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('XLN_BUN_VERSION_MISMATCH');
  expect(readFileSync(join(root, 'db', 'owner-data'), 'utf8')).toBe('preserve data');
  expect(readFileSync(join(root, 'logs', 'owner.log'), 'utf8')).toBe('preserve evidence');
});
