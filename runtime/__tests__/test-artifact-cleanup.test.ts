import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cleanupTestArtifactsBeforeRun,
  DEFAULT_TEST_WORKSPACE_MAX_BYTES,
  KEEP_TEST_ARTIFACTS_ENV,
  TEST_ARTIFACT_RUN_LOCK_PATH,
  TEST_ARTIFACT_RUN_TOKEN_ENV,
  TEST_ARTIFACT_CLEANUP_DONE_ENV,
  TEST_WORKSPACE_MAX_BYTES_ENV,
  withoutTestArtifactCleanupDoneEnv,
} from '../scripts/test-artifact-cleanup';
import { parseRunWithTestCleanupArgs } from '../scripts/run-with-test-cleanup';
import { sanitizeChildProcessEnv } from '../server/child-process-env';

const makeTempWorkspace = (): string => mkdtempSync(join(tmpdir(), 'xln-test-artifacts-'));

const writeFile = (root: string, relativePath: string, body = 'x'): void => {
  const path = join(root, relativePath);
  mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(path, body, 'utf8');
};

const waitForFile = async (path: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`TEST_FILE_WAIT_TIMEOUT:path=${path}`);
    await Bun.sleep(20);
  }
};

const waitForProcessExit = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
};

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

const waitForPidExit = async (pid: number, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (pidIsAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`TEST_PID_WAIT_TIMEOUT:pid=${pid}`);
    await Bun.sleep(20);
  }
};

const killProcessIfAlive = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

const independentTestRunEnv = (
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv => {
  const env = sanitizeChildProcessEnv({ ...process.env, ...overrides });
  // These probes deliberately start a new top-level run in a different
  // workspace. A lease is scoped to its cleanup cwd, so inheriting the unit
  // runner's repo-root token here would correctly fail closed on a missing
  // lock instead of acquiring an independent fixture lease.
  delete env[TEST_ARTIFACT_CLEANUP_DONE_ENV];
  delete env[TEST_ARTIFACT_RUN_TOKEN_ENV];
  return env;
};

describe('test artifact cleanup', () => {
  test('removes generated test artifacts by default', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/e2e-parallel/old-run/log.txt');
      writeFile(root, '.logs/scenarios-parallel/old-run/log.txt');
      writeFile(root, 'frontend/.svelte-kit-e2e/old-run/output.txt');
      writeFile(root, 'frontend/.svelte-kit/output/client/app.js');
      writeFile(root, '.logs/bootstrap-soundcheck/probe.log');
      writeFile(root, 'frontend/build/index.html');
      writeFile(root, 'frontend/playwright-report/index.html');
      writeFile(root, 'native/dist/xln.dmg');
      writeFile(root, 'tests/test-results/old.png');
      writeFile(root, '.logs/soak/old.json');
      writeFile(root, '.logs/system-tests/old/log.txt');
      writeFile(root, '.logs/gates/report.json');
      writeFile(root, '.logs/bench-radapter/result.json');

      const summary = cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: {},
        argv: [],
        reason: 'unit',
        log: () => undefined,
      });

      expect(summary.skipped).toBe(false);
      expect(summary.maxBytes).toBe(DEFAULT_TEST_WORKSPACE_MAX_BYTES);
      expect(summary.estimatedWorkspaceBytes).toBeGreaterThanOrEqual(0);
      expect(summary.estimatedBudgetedBytes).toBeLessThan(1024 * 1024);
      expect(summary.removed).toContain('.logs/e2e-parallel');
      expect(summary.removed).toContain('.logs/scenarios-parallel');
      expect(summary.removed).toContain('frontend/.svelte-kit-e2e');
      expect(summary.removed).toContain('frontend/.svelte-kit/output');
      expect(summary.removed).toContain('frontend/build');
      expect(summary.removed).toContain('frontend/playwright-report');
      expect(summary.removed).toContain('native/dist');
      expect(summary.removed).toContain('tests/test-results');
      expect(summary.removed).toContain('.logs/soak');
      expect(summary.removed).toContain('.logs/system-tests');
      expect(summary.removed).toContain('.logs/gates');
      expect(summary.removed).toContain('.logs/bench-radapter');
      expect(existsSync(join(root, '.logs/e2e-parallel'))).toBe(false);
      expect(existsSync(join(root, '.logs/scenarios-parallel'))).toBe(false);
      expect(existsSync(join(root, 'frontend/.svelte-kit-e2e'))).toBe(false);
      expect(existsSync(join(root, 'frontend/.svelte-kit/output'))).toBe(false);
      expect(existsSync(join(root, 'frontend/build'))).toBe(false);
      expect(existsSync(join(root, 'frontend/playwright-report'))).toBe(false);
      expect(existsSync(join(root, 'native/dist'))).toBe(false);
      expect(existsSync(join(root, 'tests/test-results'))).toBe(false);
      expect(existsSync(join(root, '.logs/soak'))).toBe(false);
      expect(existsSync(join(root, '.logs/system-tests'))).toBe(false);
      expect(existsSync(join(root, '.logs/gates'))).toBe(false);
      expect(existsSync(join(root, '.logs/bench-radapter'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves artifacts when caller asks to keep them', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/e2e-parallel/old-run/log.txt');

      const summary = cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: { [KEEP_TEST_ARTIFACTS_ENV]: '1' },
        argv: [],
        reason: 'unit',
        log: () => undefined,
      });

      expect(summary.skipped).toBe(true);
      expect(summary.estimatedWorkspaceBytes).toBeGreaterThan(0);
      expect(existsSync(join(root, '.logs/e2e-parallel/old-run/log.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserve mode still enforces the workspace budget', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/e2e-parallel/old-run/log.txt', 'too-large-for-budget');

      expect(() => cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: {
          [KEEP_TEST_ARTIFACTS_ENV]: '1',
          [TEST_WORKSPACE_MAX_BYTES_ENV]: '1',
        },
        argv: [],
        reason: 'unit-keep-budget',
        log: () => undefined,
      })).toThrow('TEST_WORKSPACE_BUDGET_EXCEEDED');
      expect(existsSync(join(root, '.logs/e2e-parallel/old-run/log.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('child runners skip cleanup after the parent runner did it', () => {
    const root = makeTempWorkspace();
    try {
      const env: Record<string, string | undefined> = {};
      cleanupTestArtifactsBeforeRun({
        cwd: root,
        env,
        argv: [],
        reason: 'unit-parent',
        log: () => undefined,
      });
      writeFile(root, '.logs/e2e-parallel/current-parent-run/log.txt');
      env[TEST_ARTIFACT_CLEANUP_DONE_ENV] = '1';

      const summary = cleanupTestArtifactsBeforeRun({
        cwd: root,
        env,
        argv: [],
        reason: 'unit-child',
        log: () => undefined,
      });

      expect(summary.skipped).toBe(true);
      expect(summary.estimatedWorkspaceBytes).toBeGreaterThan(0);
      expect(existsSync(join(root, '.logs/e2e-parallel/current-parent-run/log.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cleanup marker without the matching inherited lease fails loud', () => {
    const root = makeTempWorkspace();
    try {
      expect(() => cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: { [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1' },
        argv: [],
        reason: 'orphan-child-marker',
        log: () => undefined,
      })).toThrow('TEST_ARTIFACT_RUN_LEASE_REQUIRED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('child-runner skip still enforces the workspace budget', () => {
    const root = makeTempWorkspace();
    try {
      const env: Record<string, string | undefined> = {};
      cleanupTestArtifactsBeforeRun({
        cwd: root,
        env,
        argv: [],
        reason: 'unit-parent-budget',
        log: () => undefined,
      });
      writeFile(root, '.logs/e2e-parallel/current-parent-run/log.txt', 'too-large-for-budget');
      env[TEST_ARTIFACT_CLEANUP_DONE_ENV] = '1';
      env[TEST_WORKSPACE_MAX_BYTES_ENV] = '1';

      expect(() => cleanupTestArtifactsBeforeRun({
        cwd: root,
        env,
        argv: [],
        reason: 'unit-child-budget',
        log: () => undefined,
      })).toThrow('TEST_WORKSPACE_BUDGET_EXCEEDED');
      expect(existsSync(join(root, '.logs/e2e-parallel/current-parent-run/log.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses to delete artifacts owned by another live top-level test run', () => {
    const root = makeTempWorkspace();
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      if (!owner.pid) throw new Error('TEST_ARTIFACT_LOCK_OWNER_PID_MISSING');
      writeFile(root, TEST_ARTIFACT_RUN_LOCK_PATH, `${JSON.stringify({
        pid: owner.pid,
        reason: 'parallel-owner',
        startedAt: new Date().toISOString(),
        token: 'parallel-owner-token',
      })}\n`);
      writeFile(root, 'db-tmp/runtime/active.ldb', 'live-runtime-data');

      expect(() => cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: {},
        argv: [],
        reason: 'parallel-contender',
        log: () => undefined,
      })).toThrow(`TEST_ARTIFACT_CLEANUP_ACTIVE_RUN:pid=${owner.pid}:reason=parallel-owner`);
      expect(existsSync(join(root, 'db-tmp/runtime/active.ldb'))).toBe(true);
    } finally {
      owner.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reclaims a run lock only after proving its owner is dead', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, TEST_ARTIFACT_RUN_LOCK_PATH, `${JSON.stringify({
        pid: 2_147_483_647,
        reason: 'dead-owner',
        startedAt: '2000-01-01T00:00:00.000Z',
        token: 'dead-owner-token',
      })}\n`);
      writeFile(root, 'db-tmp/runtime/stale.ldb', 'stale-runtime-data');

      const summary = cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: {},
        argv: [],
        reason: 'dead-owner-recovery',
        log: () => undefined,
      });

      expect(summary.removed).toContain('db-tmp');
      expect(existsSync(join(root, 'db-tmp/runtime/stale.ldb'))).toBe(false);
      expect(existsSync(join(root, TEST_ARTIFACT_RUN_LOCK_PATH))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('nested runner can refresh e2e artifacts only through its inherited run lease', () => {
    const root = makeTempWorkspace();
    const repoRoot = process.cwd();
    const wrapperPath = join(repoRoot, 'runtime/scripts/run-with-test-cleanup.ts');
    const cleanupModulePath = join(repoRoot, 'runtime/scripts/test-artifact-cleanup.ts');
    const nestedProbe = [
      "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
      `import { cleanupTestArtifactsBeforeRun } from ${JSON.stringify(cleanupModulePath)};`,
      "const root = String(process.env.XLN_TEST_LEASE_PROBE_ROOT || '');",
      "const artifact = `${root}/.logs/e2e-parallel/nested/active.txt`;",
      "mkdirSync(`${root}/.logs/e2e-parallel/nested`, { recursive: true });",
      "writeFileSync(artifact, 'nested-run');",
      "cleanupTestArtifactsBeforeRun({ cwd: root, reason: 'nested-e2e', scope: 'e2e', skipIfAlreadyDone: false });",
      "if (existsSync(artifact)) throw new Error('NESTED_E2E_ARTIFACT_NOT_REMOVED');",
    ].join('\n');

    try {
      const result = spawnSync(process.execPath, [
        wrapperPath,
        `--cwd=${root}`,
        '--reason=outer-run',
        '--',
        process.execPath,
        '-e',
        nestedProbe,
      ], {
        cwd: repoRoot,
        env: independentTestRunEnv({
          XLN_TEST_LEASE_PROBE_ROOT: root,
        }),
        encoding: 'utf8',
      });

      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(existsSync(join(root, TEST_ARTIFACT_RUN_LOCK_PATH))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sequential nested runners preserve the root lease between sibling gate steps', () => {
    const root = makeTempWorkspace();
    const repoRoot = process.cwd();
    const wrapperPath = join(repoRoot, 'runtime/scripts/run-with-test-cleanup.ts');
    const cleanupModulePath = join(repoRoot, 'runtime/scripts/test-artifact-cleanup.ts');
    const probe = [
      "import { spawnSync } from 'node:child_process';",
      "import { existsSync } from 'node:fs';",
      `import { cleanupTestArtifactsBeforeRun, TEST_ARTIFACT_RUN_LOCK_PATH } from ${JSON.stringify(cleanupModulePath)};`,
      `const root = ${JSON.stringify(root)};`,
      `const repoRoot = ${JSON.stringify(repoRoot)};`,
      `const wrapperPath = ${JSON.stringify(wrapperPath)};`,
      "cleanupTestArtifactsBeforeRun({ cwd: root, env: process.env, reason: 'root-gate', log: () => undefined });",
      "for (const reason of ['first-step', 'second-step']) {",
      "  const result = spawnSync(process.execPath, [wrapperPath, `--cwd=${root}`, `--reason=${reason}`, '--', process.execPath, '-e', ''], { cwd: repoRoot, env: process.env, encoding: 'utf8' });",
      "  if (result.status !== 0) throw new Error(`NESTED_STEP_FAILED:${reason}:${result.stderr}`);",
      "  if (!existsSync(`${root}/${TEST_ARTIFACT_RUN_LOCK_PATH}`)) throw new Error(`ROOT_LEASE_REMOVED:${reason}`);",
      "}",
    ].join('\n');

    try {
      const result = spawnSync(process.execPath, ['-e', probe], {
        cwd: repoRoot,
        env: independentTestRunEnv({
          XLN_FOUNDRY_HOME: join(root, '.foundry'),
          XLN_MIN_DISK_FREE_BYTES: '1',
        }),
        encoding: 'utf8',
      });

      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(existsSync(join(root, TEST_ARTIFACT_RUN_LOCK_PATH))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('SIGKILL of the wrapper cannot expose artifacts while its leased child is alive', async () => {
    const root = makeTempWorkspace();
    const repoRoot = process.cwd();
    const wrapperPath = join(repoRoot, 'runtime/scripts/run-with-test-cleanup.ts');
    const cleanupPath = join(repoRoot, 'runtime/scripts/test-artifact-cleanup.ts');
    const readyPath = join(root, 'child-ready.json');
    const activeArtifact = join(root, 'db-tmp/runtime/active.ldb');
    const childProbe = [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "const root = String(process.env.XLN_TEST_LEASE_PROBE_ROOT || '');",
      "mkdirSync(`${root}/db-tmp/runtime`, { recursive: true });",
      "writeFileSync(`${root}/db-tmp/runtime/active.ldb`, 'live-runtime-data');",
      "writeFileSync(`${root}/child-ready.json`, JSON.stringify({ pid: process.pid }));",
      'setInterval(() => undefined, 1_000);',
    ].join('\n');
    const wrapper = spawn(process.execPath, [
      wrapperPath,
      `--cwd=${root}`,
      '--reason=sigkill-owner',
      '--',
      process.execPath,
      '-e',
      childProbe,
    ], {
      cwd: repoRoot,
      env: independentTestRunEnv({
        XLN_TEST_LEASE_PROBE_ROOT: root,
      }),
      stdio: 'ignore',
    });
    let childPid = 0;

    try {
      await waitForFile(readyPath);
      childPid = Number(JSON.parse(readFileSync(readyPath, 'utf8')).pid);
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      wrapper.kill('SIGKILL');
      await waitForProcessExit(wrapper);

      const liveContender = spawnSync(process.execPath, [
        cleanupPath,
        `--cwd=${root}`,
        '--reason=live-contender',
      ], { cwd: repoRoot, env: independentTestRunEnv({}), encoding: 'utf8' });
      expect(liveContender.status).toBe(1);
      expect(liveContender.stderr).toContain(`TEST_ARTIFACT_CLEANUP_ACTIVE_RUN:pid=${childPid}`);
      expect(existsSync(activeArtifact)).toBe(true);

      process.kill(childPid, 'SIGKILL');
      await waitForPidExit(childPid);
      childPid = 0;
      const deadOwnerRecovery = spawnSync(process.execPath, [
        cleanupPath,
        `--cwd=${root}`,
        '--reason=dead-child-recovery',
      ], { cwd: repoRoot, env: independentTestRunEnv({}), encoding: 'utf8' });
      expect({ status: deadOwnerRecovery.status, stderr: deadOwnerRecovery.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      expect(existsSync(activeArtifact)).toBe(false);
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
      if (childPid > 0) killProcessIfAlive(childPid);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test('SIGINT and SIGTERM stop the wrapper child and its complete process group', async () => {
    for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      const root = makeTempWorkspace();
      const repoRoot = process.cwd();
      const wrapperPath = join(repoRoot, 'runtime/scripts/run-with-test-cleanup.ts');
      const readyPath = join(root, 'process-group-ready.json');
      const childProbe = [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const root = String(process.env.XLN_TEST_LEASE_PROBE_ROOT || '');",
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], { stdio: 'ignore' });",
        "writeFileSync(`${root}/process-group-ready.json`, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }));",
        'setInterval(() => undefined, 1_000);',
      ].join('\n');
      const wrapper = spawn(process.execPath, [
        wrapperPath,
        `--cwd=${root}`,
        `--reason=${signal.toLowerCase()}-process-group`,
        '--',
        process.execPath,
        '-e',
        childProbe,
      ], {
        cwd: repoRoot,
        env: independentTestRunEnv({ XLN_TEST_LEASE_PROBE_ROOT: root }),
        stdio: 'ignore',
      });
      let childPid = 0;
      let grandchildPid = 0;

      try {
        await waitForFile(readyPath);
        ({ childPid, grandchildPid } = JSON.parse(readFileSync(readyPath, 'utf8')));
        wrapper.kill(signal);
        await waitForProcessExit(wrapper);
        expect(wrapper.exitCode).toBe(exitCode);
        await waitForPidExit(childPid);
        await waitForPidExit(grandchildPid);
      } finally {
        if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
        if (childPid > 0) killProcessIfAlive(childPid);
        if (grandchildPid > 0) killProcessIfAlive(grandchildPid);
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 15_000);

  test('e2e scope refreshes isolated artifacts without deleting the live dev build', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/e2e-parallel/old-run/log.txt');
      writeFile(root, 'frontend/.svelte-kit-e2e/old-run/output.txt');
      writeFile(root, 'frontend/build/index.html');
      writeFile(root, 'native/dist/xln.dmg');
      writeFile(root, '.logs/bootstrap-soundcheck/current/probe.log');

      const summary = cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: { [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1' },
        argv: [],
        reason: 'unit-e2e',
        scope: 'e2e',
        skipIfAlreadyDone: false,
        log: () => undefined,
      });

      expect(summary.skipped).toBe(false);
      expect(summary.removed).toContain('.logs/e2e-parallel');
      expect(summary.removed).toContain('frontend/.svelte-kit-e2e');
      expect(summary.removed).not.toContain('frontend/build');
      expect(summary.removed).not.toContain('.logs/bootstrap-soundcheck');
      expect(summary.removed).not.toContain('native/dist');
      expect(existsSync(join(root, '.logs/e2e-parallel'))).toBe(false);
      expect(existsSync(join(root, 'frontend/.svelte-kit-e2e'))).toBe(false);
      expect(existsSync(join(root, 'frontend/build/index.html'))).toBe(true);
      expect(existsSync(join(root, 'native/dist/xln.dmg'))).toBe(true);
      expect(existsSync(join(root, '.logs/bootstrap-soundcheck/current/probe.log'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('child runtime env can drop the cleanup marker before browser builds', () => {
    const env = withoutTestArtifactCleanupDoneEnv({
      [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1',
      [TEST_ARTIFACT_RUN_TOKEN_ENV]: 'parent-run-token',
      NO_COLOR: '1',
      KEEP_ME: 'yes',
    });

    expect(env[TEST_ARTIFACT_CLEANUP_DONE_ENV]).toBeUndefined();
    expect(env[TEST_ARTIFACT_RUN_TOKEN_ENV]).toBe('parent-run-token');
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');
  });

  test('fails when generated workspace artifacts exceed the configured budget', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/qa-history.sqlite', 'too-large-for-budget');

      expect(() => cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: { [TEST_WORKSPACE_MAX_BYTES_ENV]: '1' },
        argv: [],
        reason: 'unit-budget',
        log: () => undefined,
      })).toThrow('TEST_WORKSPACE_BUDGET_EXCEEDED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails when the whole workspace exceeds the configured budget', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, 'node_modules/.cache/large.bin', 'too-large-for-budget');

      expect(() => cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: { [TEST_WORKSPACE_MAX_BYTES_ENV]: '1' },
        argv: [],
        reason: 'unit-workspace-budget',
        log: () => undefined,
      })).toThrow('TEST_WORKSPACE_BUDGET_EXCEEDED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('default workspace budget is the agreed 50 GiB repo cap', () => {
    expect(DEFAULT_TEST_WORKSPACE_MAX_BYTES).toBe(50 * 1024 * 1024 * 1024);
  });

  test('run-with-test-cleanup keeps cleanup flags out of the child command', () => {
    const parsed = parseRunWithTestCleanupArgs([
      '--reason=frontend-playwright',
      '--scope=e2e',
      '--cwd=..',
      '--child-cwd=frontend',
      '--',
      'playwright',
      'test',
      '--keep-test-artifacts',
      'tests/landing.spec.ts',
    ]);

    expect(parsed.reason).toBe('frontend-playwright');
    expect(parsed.scope).toBe('e2e');
    expect(parsed.cleanupCwd).toBe('..');
    expect(parsed.childCwd).toBe('frontend');
    expect(parsed.command).toBe('playwright');
    expect(parsed.commandArgs).toEqual(['test', 'tests/landing.spec.ts']);
    expect(parsed.cleanupArgv).toContain('--keep-test-artifacts');
  });

  test('child process env sanitizer removes NO_COLOR before child tools can set FORCE_COLOR', () => {
    const env = sanitizeChildProcessEnv({
      FORCE_COLOR: '1',
      NO_COLOR: '1',
      KEEP_ME: 'yes',
    });

    expect(env).toEqual({ FORCE_COLOR: '1', KEEP_ME: 'yes' });
  });

  test('package test shortcuts run through cleanup before direct browser or hardhat tests', () => {
    const repoRoot = process.cwd();
    const rootPackage = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    const rootScripts = JSON.parse(rootPackage).scripts as Record<string, string>;
    const frontendPackage = readFileSync(join(repoRoot, 'frontend/package.json'), 'utf8');
    const contractsPackage = readFileSync(join(repoRoot, 'jurisdictions/package.json'), 'utf8');
    const scenarioRunner = readFileSync(join(repoRoot, 'runtime/scenarios/run.ts'), 'utf8');

    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=e2e-prod-payment --scope=e2e');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=contracts --child-cwd=jurisdictions');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=governance --child-cwd=jurisdictions');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=entity --child-cwd=jurisdictions');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=persistence-cli -- bun runtime/scripts/persistence-wal-smoke.ts');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=watchtower-smoke -- bun runtime/scripts/watchtower-smoke.ts');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=rpc-settlement -- bun runtime/scripts/rpc-settlement-parity.ts');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=p2p-relay -- bun runtime/scenarios/p2p-relay.ts');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=bootstrap-soundcheck -- bun runtime/scripts/bootstrap-soundcheck.ts --mode=all');
    expect(rootPackage).toContain('"check": "bun run check:src && bun run check:frontend-file-size && bun run check:frontend"');
    expect(rootPackage).not.toContain('run-with-test-cleanup.ts --reason=check');
    expect(rootPackage).not.toContain('test-artifact-cleanup.ts --reason=check &&');
    for (const scriptName of [
      'test:persistence:cli',
      'test:watchtower:smoke',
      'test:rpc-settlement',
      'test:p2p:relay',
      'prod:bootstrap:bench',
      'prod:bootstrap:fresh',
      'prod:bootstrap:template',
      'prod:bootstrap:clone',
      'prod:bootstrap:hydrate',
      'prod:bootstrap:soundcheck',
    ]) {
      expect(rootScripts[scriptName]).toStartWith('bun runtime/scripts/run-with-test-cleanup.ts ');
      expect(rootScripts[scriptName]).not.toContain('test-artifact-cleanup.ts');
    }
    expect(rootPackage).toContain('"test:scenarios:parallel:isolated": "bun runtime/scenarios/run.ts"');
    expect(rootPackage).toContain('"test:feedback:20": "bun runtime/scenarios/run.ts --set=smoke --workers=2"');
    expect(scenarioRunner).toContain("cleanupTestArtifactsBeforeRun({ reason: 'scenarios', argv: process.argv.slice(2) })");
    expect(scenarioRunner).toContain("cleanupTestArtifactsBeforeRun({ reason: 'scenario', argv: process.argv.slice(2) })");
    expect(scenarioRunner).toContain("[TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1'");
    expect(scenarioRunner).not.toContain('runtime/relay/standalone-server.ts');
    expect(frontendPackage).toContain('../runtime/scripts/run-with-test-cleanup.ts --cwd=.. --reason=frontend-playwright --scope=e2e');
    expect(frontendPackage).toContain('../runtime/scripts/run-with-test-cleanup.ts --cwd=.. --reason=frontend-ui --scope=e2e');
    expect(contractsPackage).toContain('../runtime/scripts/run-with-test-cleanup.ts --cwd=.. --reason=contracts');
    expect(contractsPackage).toContain('../runtime/scripts/run-with-test-cleanup.ts --cwd=.. --reason=contracts-default');
  });
});
