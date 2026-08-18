import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  assertE2ECodeFingerprintStable,
  assertE2EShardPortsIsolated,
  acquireAvailableE2EWorkerPortLeases,
  acquireLocalTestPortLease,
  awaitE2EWorkersBeforeLeaseRelease,
  batchPlaywrightTargetsByFile,
  computeE2EBuildInputHash,
  computeE2EBuildArtifactHash,
  computeE2ESourceDriftProbe,
  decideE2EBuildCache,
  deriveE2EBuildArtifacts,
  deriveE2EShardPaths,
  deriveE2EShardPorts,
  isE2ECodeInputPath,
  LOCAL_TEST_STACK_BASES,
  parsePlaywrightFilesFlag,
} from '../../../scripts/e2e/runners/run-e2e-parallel-isolated';

const createE2EBuildCacheFixture = (root: string, codeHash: string) => {
  const artifacts = deriveE2EBuildArtifacts(root);
  mkdirSync(join(artifacts.publicDir), { recursive: true });
  mkdirSync(join(artifacts.svelteKitOutDir, 'output/server'), { recursive: true });
  mkdirSync(artifacts.frontendBuildDir, { recursive: true });
  writeFileSync(artifacts.runtimeBundlePath, 'runtime-v1', 'utf8');
  writeFileSync(join(artifacts.svelteKitOutDir, 'output/server/manifest.js'), 'manifest-v1', 'utf8');
  writeFileSync(join(artifacts.frontendBuildDir, 'index.html'), '<main>v1</main>', 'utf8');
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    version: 1,
    buildInputHash: codeHash,
    artifactHash: computeE2EBuildArtifactHash(artifacts),
    createdAt: '2026-07-17T00:00:00.000Z',
  }));
  return artifacts;
};

describe('isolated E2E runner resources', () => {
  test('canonical package E2E commands never exceed the machine-wide lease pool', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    const canonicalCommands = Object.entries(scripts)
      .filter(([name, command]) => name.startsWith('test:e2e:') && command.includes('run-e2e-parallel-isolated.ts'));
    expect(canonicalCommands.length).toBeGreaterThan(0);
    for (const [name, command] of canonicalCommands) {
      const match = command.match(/--shards=(\d+)/);
      if (!match) continue;
      expect(Number(match[1]), name).toBeLessThanOrEqual(LOCAL_TEST_STACK_BASES.length);
    }
  });

  test('--help prints usage without acquiring a lease or starting a stack', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-e2e-help-'));
    try {
      const script = resolve('core/scripts/e2e/runners/run-e2e-parallel-isolated.ts');
      const result = spawnSync('bun', [script, '--help'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Usage: bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts');
      expect(existsSync(join(root, '.logs'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps every shard port away from the canonical dev stack', () => {
    assertE2EShardPortsIsolated(20_000, 64);
    const ports = deriveE2EShardPorts(20_000, 0);

    expect(ports).toEqual({
      rpc: 20_000,
      rpc2: 20_001,
      api: 20_002,
      web: 20_004,
      custody: 20_007,
      custodyDaemon: 20_008,
      runtimeChildren: [20_012, 20_013, 20_014, 20_015],
    });
    expect(() => assertE2EShardPortsIsolated(8_545, 1)).toThrow('E2E_DEV_PORT_OVERLAP');
    expect(() => assertE2EShardPortsIsolated(8_060, 2)).toThrow('E2E_DEV_PORT_OVERLAP');
    expect(() => assertE2EShardPortsIsolated(8_090, 1)).toThrow('E2E_DEV_PORT_OVERLAP');
  });

  test('leases machine-wide stack lanes without colliding across worktrees', async () => {
    const slotBases = [50_000, 50_020];
    const first = await acquireLocalTestPortLease({ slotBases, timeoutMs: 0 });
    const second = await acquireLocalTestPortLease({ slotBases, timeoutMs: 0 });
    try {
      expect(first.basePort).toBe(50_000);
      expect(second.basePort).toBe(50_020);
      await expect(acquireLocalTestPortLease({ slotBases, timeoutMs: 0 }))
        .rejects.toThrow('LOCAL_TEST_PORT_SLOTS_EXHAUSTED');
      expect(LOCAL_TEST_STACK_BASES).toHaveLength(7);
    } finally {
      first.release();
      second.release();
    }
    const reused = await acquireLocalTestPortLease({ slotBases, timeoutMs: 0 });
    expect(reused.basePort).toBe(50_000);
    reused.release();
  });

  test('reserves only available worker lanes and reuses them without lease starvation', async () => {
    const slotBases = [50_100, 50_120, 50_140];
    const occupied = await acquireLocalTestPortLease({ slotBases: [slotBases[0]!], timeoutMs: 0 });
    try {
      const workerLeases = await acquireAvailableE2EWorkerPortLeases(3, { slotBases });
      try {
        expect(workerLeases.map(lease => lease.basePort)).toEqual([50_120, 50_140]);
        await expect(acquireLocalTestPortLease({ slotBases, timeoutMs: 0 }))
          .rejects.toThrow('LOCAL_TEST_PORT_SLOTS_EXHAUSTED');
      } finally {
        for (const lease of workerLeases) lease.release();
      }
    } finally {
      occupied.release();
    }
  });

  test('keeps sibling worker guards held until abort cleanup settles', async () => {
    let finishSibling!: () => void;
    const sibling = new Promise<void>(resolveSibling => { finishSibling = resolveSibling; });
    let observedError: unknown;
    let settled = false;
    const waiting = awaitE2EWorkersBeforeLeaseRelease(
      [Promise.reject(new Error('primary-worker-failed')), sibling],
      error => { observedError = error; },
    ).finally(() => { settled = true; });

    await Bun.sleep(0);
    expect((observedError as Error)?.message).toBe('primary-worker-failed');
    expect(settled).toBe(false);
    finishSibling();
    await expect(waiting).rejects.toThrow('primary-worker-failed');
    expect(settled).toBe(true);
  });

  test('places runtime, jurisdiction, logs, and artifacts below one shard root', () => {
    const runRoot = resolve('/tmp/xln-e2e-run');
    const paths = deriveE2EShardPaths(runRoot, 3);

    expect(paths.root).toBe(resolve(runRoot, 'shard-3'));
    for (const path of Object.values(paths)) {
      expect(path.startsWith(`${paths.root}/`) || path === paths.root).toBe(true);
      expect(path).not.toContain('/db/dev/');
      expect(path).not.toContain('/.logs/dev/');
    }
    expect(paths.rdbRoot.endsWith('/shard-3/rdb')).toBe(true);
    expect(paths.jdbRoot.endsWith('/shard-3/jdb')).toBe(true);
    expect(paths.resultsDir.endsWith('/shard-3/artifacts/playwright')).toBe(true);
  });

  test('runner never reaps processes by command-line substring', () => {
    const runner = readFileSync('core/scripts/e2e/runners/run-e2e-parallel-isolated.ts', 'utf8');
    expect(runner).not.toContain('reapStaleIsolatedE2EProcesses');
    expect(runner).not.toContain('isIsolatedE2EProcessCommand');
    expect(runner).not.toContain('process.kill(pid');
    expect(runner).not.toContain("'  --base-port");
    expect(runner).toContain('E2E_BASE_PORT_OVERRIDE_FORBIDDEN');
    expect(runner).toContain('acquireLocalTestPortLease({');
    expect(runner).toContain('deriveE2EShardPorts(portBase, 0)');
  });

  test('runner build and browser helpers cannot substitute shared dev resources', () => {
    const runner = readFileSync('core/scripts/e2e/runners/run-e2e-parallel-isolated.ts', 'utf8');
    const runtimeImport = readFileSync('tests/utils/runtime/e2e-runtime-import.ts', 'utf8');
    const viteConfig = readFileSync('frontend/vite.config.ts', 'utf8');

    expect(runner).toContain('XLN_RUNTIME_BUNDLE_OUT: artifacts.runtimeBundlePath');
    expect(runner).toContain('XLN_SVELTE_BUILD_DIR: relative(frontendRoot, artifacts.frontendBuildDir)');
    expect(runner).toContain('XLN_RDB_ROOT: shardPaths.rdbRoot');
    expect(runner).toContain('XLN_JDB_ROOT: shardPaths.jdbRoot');
    expect(runner).toContain('codeFingerprint.buildInputHash,');
    expect(runner).not.toContain('prepareIsolatedE2EBuild(logsDir, codeFingerprint.codeHash');
    expect(runner).not.toContain("runE2ECommand('bun', ['run', 'build']");
    expect(runner).toContain("const webUrl = `http://localhost:${webPort}`");
    expect(runner).toContain("XLN_VITE_FORCE_HTTP: '1'");
    expect(runner).toContain("PW_PROFILE: args.pwProject === 'brainvault' ? 'brainvault' : ''");
    expect(runner).toContain('Math.min(args.stackTimeoutMs, 30_000)');
    expect(viteConfig).toContain("const FORCE_HTTP = process.env['XLN_VITE_FORCE_HTTP'] === '1'");
    expect(runtimeImport).not.toContain("return 'http://127.0.0.1:8082'");
  });

  test('artifact retention preserves evidence without skipping the parent run lease', () => {
    const runner = readFileSync('core/scripts/e2e/runners/run-e2e-parallel-isolated.ts', 'utf8');

    expect(runner).toContain("argv: args.preserveArtifacts ? ['--keep-test-artifacts'] : []");
    expect(runner).not.toContain('if (!args.preserveArtifacts) {\n    cleanupTestArtifactsBeforeRun');

    const root = mkdtempSync(join(tmpdir(), 'xln-e2e-preserve-lease-'));
    const artifact = join(root, '.logs/e2e-parallel/prior-run/evidence.txt');
    const repoRoot = resolve(import.meta.dir, '../../../..');
    const cleanupModule = join(repoRoot, 'core/scripts/e2e/harness/test-artifact-cleanup.ts');
    const globalSetupModule = join(repoRoot, 'tests/playwright-global-setup.ts');
    mkdirSync(join(root, '.logs/e2e-parallel/prior-run'), { recursive: true });
    writeFileSync(artifact, 'preserve-me', 'utf8');

    const probe = [
      "import { existsSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `import { cleanupTestArtifactsBeforeRun, TEST_ARTIFACT_CLEANUP_DONE_ENV, TEST_ARTIFACT_RUN_LOCK_PATH, TEST_ARTIFACT_RUN_TOKEN_ENV } from ${JSON.stringify(cleanupModule)};`,
      `import { runPlaywrightArtifactCleanup } from ${JSON.stringify(globalSetupModule)};`,
      `const root = ${JSON.stringify(root)};`,
      `const artifact = ${JSON.stringify(artifact)};`,
      "cleanupTestArtifactsBeforeRun({ cwd: root, env: process.env, argv: ['--keep-test-artifacts'], reason: 'e2e-preserve-parent', scope: 'e2e', skipIfAlreadyDone: false });",
      "if (!String(process.env[TEST_ARTIFACT_RUN_TOKEN_ENV] || '')) throw new Error('PARENT_LEASE_TOKEN_MISSING');",
      "if (!existsSync(join(root, TEST_ARTIFACT_RUN_LOCK_PATH))) throw new Error('PARENT_LEASE_LOCK_MISSING');",
      "process.env[TEST_ARTIFACT_CLEANUP_DONE_ENV] = '1';",
      'runPlaywrightArtifactCleanup(root);',
      "if (!existsSync(artifact)) throw new Error('PRESERVED_ARTIFACT_REMOVED_BY_CHILD');",
    ].join('\n');

    try {
      const result = spawnSync('bun', ['-e', probe], {
        cwd: repoRoot,
        env: {
          ...process.env,
          XLN_FOUNDRY_HOME: join(root, '.foundry'),
          XLN_MIN_DISK_FREE_BYTES: '1',
          XLN_TEST_ARTIFACT_CLEANUP_DONE: undefined,
          XLN_TEST_ARTIFACT_RUN_TOKEN: undefined,
        },
        encoding: 'utf8',
      });

      expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
        status: 0,
        signal: null,
        stderr: '',
      });
      expect(result.stdout).toContain('test artifact cleanup (e2e-preserve-parent): preserving existing artifacts');
      expect(result.stdout).toContain('test artifact cleanup (playwright): inherited parent lease validated');
      expect(result.stdout).not.toContain('test artifact budget (playwright):');
      expect(readFileSync(artifact, 'utf8')).toBe('preserve-me');
      expect(existsSync(join(root, '.logs/.test-artifact-run-lock.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resumed runs resolve manifest metadata by stable shard id', () => {
    const report = readFileSync('core/scripts/e2e/harness/e2e-run-report.ts', 'utf8');

    expect(report).toContain('const taskByShard = new Map(tasks.map(task => [task.shard, task] as const));');
    expect(report).toContain('const task = taskByShard.get(result.shard);');
    expect(report).not.toContain('const task = tasks[result.shard];');
  });

  test('passes the provisioned shard jurisdiction registry into Playwright-owned child runtimes', () => {
    const runner = readFileSync('core/scripts/e2e/runners/run-e2e-parallel-isolated.ts', 'utf8');
    const playwrightEnv = runner.slice(
      runner.indexOf("const playwrightResult = await runE2ECommand('bunx'"),
      runner.indexOf("markPhase('playwright'"),
    );

    expect(playwrightEnv).toContain("XLN_JURISDICTIONS_PATH: join(dbPath, 'jurisdictions.json')");
    expect(runner).toContain("XLN_EPHEMERAL_TESTNET: '1'");
  });

  test('payment smoke shortcut runs through one isolated shard', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const command = packageJson.scripts['test:e2e:payment:smoke'];

    expect(command).toStartWith('bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts ');
    expect(command).toContain('--shards=1');
    expect(command).toContain('--workers-per-shard=1');
    expect(command).toContain('--pw-project=chromium');
    expect(command).toContain('--pw-files=tests/e2e/payments/e2e-payment-smoke.spec.ts');
    expect(command).not.toContain('localhost:8080');
    expect(command).not.toContain('127.0.0.1:8082');
    expect(command).not.toContain('run-with-test-cleanup.ts');
    expect(command).not.toContain('playwright test');
  });

  test('preserves commas inside an exact Playwright title selector', () => {
    const target =
      'tests/e2e/payments/e2e-payment-smoke.spec.ts::fresh runtimes can open accounts, faucet, pay, and reload persisted state';

    expect(parsePlaywrightFilesFlag(target)).toEqual([target]);
    expect(parsePlaywrightFilesFlag('tests/one.spec.ts,tests/two.spec.ts')).toEqual([
      'tests/one.spec.ts',
      'tests/two.spec.ts',
    ]);
  });

  test('batches one spec by infrastructure requirements and QA category', () => {
    const batches = batchPlaywrightTargetsByFile([
      {
        target: 'tests/e2e/swap/e2e-swap.spec.ts',
        requireMarketMaker: true,
        requireCustody: false,
        scenario: null,
        title: 'functional one',
        tags: ['@functional'],
        testCategory: 'functional',
      },
      {
        target: 'tests/e2e/swap/e2e-swap.spec.ts',
        requireMarketMaker: true,
        requireCustody: false,
        scenario: null,
        title: 'functional two',
        tags: ['@functional'],
        testCategory: 'functional',
      },
      {
        target: 'tests/e2e/swap/e2e-swap.spec.ts',
        requireMarketMaker: true,
        requireCustody: false,
        scenario: null,
        title: 'resilience one',
        tags: ['@resilience'],
        testCategory: 'resilience',
      },
    ]);

    expect(batches).toHaveLength(2);
    expect(batches.map(batch => ({
      title: batch.title,
      grep: batch.grep,
      category: batch.testCategory,
      requireMarketMaker: batch.requireMarketMaker,
    }))).toEqual([
      {
        title: 'tests/e2e/swap/e2e-swap.spec.ts [functional batch]',
        grep: undefined,
        category: 'functional',
        requireMarketMaker: true,
      },
      {
        title: 'tests/e2e/swap/e2e-swap.spec.ts [resilience batch]',
        grep: undefined,
        category: 'resilience',
        requireMarketMaker: true,
      },
    ]);
  });

  test('fails loud when source bytes drift during an E2E run', () => {
    const start = 'a'.repeat(64);
    const end = 'b'.repeat(64);

    expect(() => assertE2ECodeFingerprintStable(start, start)).not.toThrow();
    expect(() => assertE2ECodeFingerprintStable(start, end)).toThrow(
      `E2E_CODE_DRIFT:start=${start}:end=${end}`,
    );
  });

  test('reuses only an exact build cache and fails strict reuse on byte corruption', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-e2e-build-cache-'));
    const codeHash = 'a'.repeat(64);
    try {
      const artifacts = createE2EBuildCacheFixture(root, codeHash);
      expect(decideE2EBuildCache(artifacts, codeHash, false)).toEqual({ action: 'reuse' });

      writeFileSync(artifacts.runtimeBundlePath, 'runtime-corrupt', 'utf8');
      const decision = decideE2EBuildCache(artifacts, codeHash, false);
      expect(decision.action).toBe('rebuild');
      if (decision.action !== 'rebuild') throw new Error('EXPECTED_BUILD_CACHE_REBUILD');
      expect(decision.reason).toStartWith('E2E_BUILD_CACHE_CORRUPT:');
      expect(() => decideE2EBuildCache(artifacts, codeHash, true)).toThrow(
        'E2E_BUILD_CACHE_CORRUPT:',
      );

      const freshArtifacts = createE2EBuildCacheFixture(root, codeHash);
      expect(decideE2EBuildCache(freshArtifacts, 'b'.repeat(64), false)).toEqual({
        action: 'rebuild',
        reason: `E2E_BUILD_CACHE_STALE:expected=${'b'.repeat(64)}:actual=${codeHash}`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('build cache ignores runner-only drift but invalidates runtime and frontend inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-e2e-build-inputs-'));
    const files = [
      'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts',
      'core/__tests__/runner.test.ts',
      'core/runtime.ts',
      'frontend/src/app.ts',
    ];
    try {
      for (const file of files) {
        mkdirSync(dirname(resolve(root, file)), { recursive: true });
        writeFileSync(resolve(root, file), `${file}:v1`);
      }
      const original = computeE2EBuildInputHash(files, root);
      writeFileSync(resolve(root, files[0]!), 'runner:changed');
      writeFileSync(resolve(root, files[1]!), 'test:changed');
      expect(computeE2EBuildInputHash(files, root)).toBe(original);

      writeFileSync(resolve(root, files[2]!), 'runtime:changed');
      const runtimeChanged = computeE2EBuildInputHash(files, root);
      expect(runtimeChanged).not.toBe(original);

      writeFileSync(resolve(root, files[3]!), 'frontend:changed');
      expect(computeE2EBuildInputHash(files, root)).not.toBe(runtimeChanged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('source drift probe uses metadata and detects changed bytes without content hashing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-e2e-drift-probe-'));
    const file = 'core/runtime.ts';
    try {
      mkdirSync(dirname(resolve(root, file)), { recursive: true });
      writeFileSync(resolve(root, file), 'v1');
      const runner = readFileSync('core/scripts/e2e/runners/run-e2e-parallel-isolated.ts', 'utf8');
      const probeImplementation = runner.slice(
        runner.indexOf('export const computeE2ESourceDriftProbe'),
        runner.indexOf('const computeRepositorySourceDriftProbe'),
      );
      expect(probeImplementation).not.toContain('readFileSync');
      const original = computeE2ESourceDriftProbe([file], root);
      expect(computeE2ESourceDriftProbe([file], root)).toBe(original);
      await Bun.sleep(2);
      writeFileSync(resolve(root, file), 'version-two');
      expect(computeE2ESourceDriftProbe([file], root)).not.toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('generated runtime bundles cannot invalidate an isolated source candidate', () => {
    expect(isE2ECodeInputPath('core/runtime.ts')).toBe(true);
    expect(isE2ECodeInputPath('frontend/src/app.ts')).toBe(true);
    expect(isE2ECodeInputPath('frontend/static/runtime.js')).toBe(false);
    expect(isE2ECodeInputPath('ui/public/runtime.js')).toBe(false);
  });
});
