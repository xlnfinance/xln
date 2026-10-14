import { decodeRuntimeManifestEntries } from '../../hlt/boundary/worker-boundary';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
import { requireBoundaryInteger, requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import { safeStringify } from '../../../../protocol/serialization';

type WalletGate = {
  tests: string;
  repoRoot: string;
  workDir: string;
  rpcPort: number;
  apiPort: number;
  start(name: string, command: string, args: string[], env: Record<string, string>): ChildProcess;
};

const waitForService = async (child: ChildProcess, url: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  let last = 'wallet server has not answered';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`WALLET_GATE_SERVICE_EXITED:${url}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`WALLET_GATE_SERVICE_NOT_READY:${url}:${last}`);
};

/** The controller publishes this file only after canonical import readiness passes.
 * General system health can become ready before its scheduled refresh publishes it. */
export const waitForRuntimeImportManifest = async (path: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const value: unknown = JSON.parse(content);
    if (decodeRuntimeManifestEntries(value).length === 0) throw new Error('WALLET_IMPORT_MANIFEST_EMPTY');
    const root = requireBoundaryRecord(value, 'WALLET_IMPORT_MANIFEST_INVALID');
    const manifest = requireBoundaryRecord(root['manifest'], 'WALLET_IMPORT_MANIFEST_BODY_INVALID');
    if (requireBoundaryInteger(manifest['expiresAt'], 'WALLET_IMPORT_MANIFEST_EXPIRY_INVALID') <= Date.now())
      throw new Error('WALLET_IMPORT_MANIFEST_EXPIRED');
    return;
  }
  throw new Error(`WALLET_IMPORT_MANIFEST_NOT_READY:${path}`);
};

const waitForGateProcess = (child: ChildProcess, stage: string): Promise<void> =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`WALLET_GATE_PROCESS_FAILED:${stage}:${code}:${signal}`)),
    );
  });

const recordWalletGateQaRun = (repoRoot: string, tests: readonly string[], startedAt: number): void => {
  const headRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const statusRes = spawnSync(
    'git',
    ['status', '--short', '--untracked-files=all', '--', 'core', 'ui', 'jurisdictions'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const gitHead = String(headRes.stdout || '').trim() || null;
  const gitBranch = String(branchRes.stdout || '').trim() || null;
  const dirty = String(statusRes.stdout || '').trim().length > 0 ? 1 : 0;
  const completedAt = Date.now();
  const totalMs = Math.max(1, completedAt - startedAt);
  const pwFiles = tests.map(test => (test.startsWith('ui/tests/') ? test : `ui/tests/${test}`));
  const runId = `wallet-gate-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${(gitHead ?? 'local').slice(0, 9)}`;
  const logsDir = join(repoRoot, '.logs');
  mkdirSync(logsDir, { recursive: true });
  const dbPath = join(logsDir, 'qa-history.sqlite');
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath);
  try {
    const manifestJson = JSON.stringify({
      gateConfig: { args: { pwFiles }, tasks: [{ pwTargets: pwFiles }] },
    });
    db.query(
      `INSERT OR REPLACE INTO qa_runs (
        run_id, created_at, completed_at, status, total_ms, total_shards, passed_shards, failed_shards,
        git_head, git_branch, dirty, code_hash, logs_dir, manifest_json, forensic_json
      ) VALUES ($runId, $createdAt, $completedAt, 'passed', $totalMs, 1, 1, 0, $gitHead, $gitBranch, $dirty, $gitHead, $logsDir, $manifestJson, '{}')`,
    ).run({
      $runId: runId,
      $createdAt: startedAt,
      $completedAt: completedAt,
      $totalMs: totalMs,
      $gitHead: gitHead,
      $gitBranch: gitBranch,
      $dirty: dirty,
      $logsDir: logsDir,
      $manifestJson: manifestJson,
    });
  } finally {
    db.close();
  }
};

const assertBrowserReport = (path: string, repoRoot: string, tests: readonly string[], startedAt: number): void => {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const report = requireBoundaryRecord(raw, 'WALLET_REPORT_INVALID');
  const stats = requireBoundaryRecord(report['stats'], 'WALLET_REPORT_STATS_MISSING');
  const passed = requireBoundaryInteger(stats['expected'], 'WALLET_REPORT_NO_PASSES', 1);
  for (const key of ['unexpected', 'flaky', 'skipped']) {
    if (requireBoundaryInteger(stats[key], `WALLET_REPORT_${key}`) !== 0)
      throw new Error(`WALLET_REPORT_NOT_GREEN:${key}`);
  }
  recordWalletGateQaRun(repoRoot, tests, startedAt);
  console.log(`WALLET_BROWSER_GATE_OK passed=${passed} skipped=0 report=${path}`);
};

/** Reuse the production stand and its leased ports; all children share its cleanup owner. */
export const runWalletBrowserGate = async (input: WalletGate): Promise<void> => {
  const tests = input.tests.split(',');
  const ui = process.env['XLN_LOCAL_PROD_SMOKE_WALLET_UI'] ?? 'react';
  if (ui !== 'react' && ui !== 'svelte') throw new Error('WALLET_UI_INVALID');
  const grep = process.env['XLN_LOCAL_PROD_SMOKE_WALLET_GREP'];
  if (grep !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,255}$/.test(grep)) {
    throw new Error('WALLET_TEST_GREP_INVALID');
  }
  if (tests.some(test => !/^(?:[a-z0-9-]+\/)*e2e-[a-z0-9-]+\.spec\.ts$/.test(test)))
    throw new Error('WALLET_TEST_ARGUMENT_INVALID');
  if (ui === 'react' && tests.some(test => /(?:^|\/)e2e-svelte-/.test(test)))
    throw new Error('WALLET_TEST_UI_MISMATCH:svelte');
  const artifactDir = process.env['XLN_LOCAL_PROD_SMOKE_WALLET_ARTIFACT_DIR'];
  if (
    artifactDir !== undefined &&
    (!isAbsolute(artifactDir) || ui !== 'react' || tests.length !== 1 || tests[0] !== 'e2e-production-wallet.spec.ts')
  )
    throw new Error('WALLET_ARTIFACT_ARGUMENT_INVALID');
  // Source runs rebuild this candidate; artifact runs preserve the supplied release bytes.
  if (artifactDir === undefined)
    await waitForGateProcess(
      input.start('wallet-runtime-build', process.execPath, ['run', 'build'], {}),
      'runtime-build',
    );
  const port = input.rpcPort + 2;
  const origin = `http://127.0.0.1:${port}`;
  const report = join(input.workDir, 'wallet-results.json');
  const towerPort = input.rpcPort + 3;
  const towerOrigin = `http://127.0.0.1:${towerPort}`;
  const rpcUrl = `http://127.0.0.1:${input.rpcPort}`;
  const provider = new JsonRpcProvider(rpcUrl);
  const towerSigner = Wallet.createRandom();
  try {
    if ((await provider.getNetwork()).chainId !== 31337n) throw new Error('WALLET_TOWER_PRIVATE_CHAIN_REQUIRED');
    const funder = await provider.getSigner(0);
    await (await funder.sendTransaction({ to: towerSigner.address, value: parseEther('1') })).wait();
  } finally {
    provider.destroy();
  }
  const tower = input.start(
    'wallet-tower',
    process.execPath,
    [
      join(input.repoRoot, 'core/watchtower/standalone-server.ts'),
      '--host',
      '127.0.0.1',
      '--port',
      String(towerPort),
      '--db',
      join(input.workDir, 'watchtower'),
      '--quota-bytes',
      '4194304',
      '--max-bundles',
      '3',
      '--enable-last-resort-agent',
      '--sweep-interval-ms',
      '1000',
    ],
    {
      XLN_WATCHTOWER_PRIVATE_KEY: towerSigner.privateKey,
      XLN_WATCHTOWER_ALLOWED_RPC_URLS: [rpcUrl, `${origin}/rpc`, `http://127.0.0.1:${input.apiPort}/rpc`].join(','),
    },
  );
  await waitForService(tower, `${towerOrigin}/api/tower/healthz`);
  const env = {
    NODE_ENV: artifactDir === undefined ? 'development' : 'production',
    VITE_DEV_PORT: String(port),
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${input.apiPort}`,
    XLN_VITE_FORCE_HTTP: '1',
    SVELTE_E2E_BASE_URL: `${origin}/app`,
    VITE_XLN_WATCHTOWER_URL: towerOrigin,
    UI_E2E_TOWER_URL: towerOrigin,
    XLN_UI_STACK_ORIGIN: `http://127.0.0.1:${input.apiPort}`,
    XLN_UI_RUNTIME_BUNDLE_DIR: artifactDir === undefined ? join(input.repoRoot, 'frontend/static') : '',
    UI_E2E_BASE_URL: origin,
    UI_E2E_PORT: String(port),
    XLN_RDB_ROOT: input.workDir,
    XLN_UI_DISPUTE_PRIVATE_RPC: `http://127.0.0.1:${input.rpcPort}`,
    XLN_UI_DISPUTE_PRIVATE_ORIGIN: origin,
    PLAYWRIGHT_JSON_OUTPUT_NAME: report,
  };
  const server = input.start(
    'wallet-server',
    process.execPath,
    ui === 'svelte'
      ? [
          '--cwd',
          join(input.repoRoot, 'frontend'),
          './node_modules/vite/bin/vite.js',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
        ]
      : [
          join(input.repoRoot, 'ui/node_modules/vite/bin/vite.js'),
          ...(artifactDir === undefined ? [] : ['preview']),
          'ui',
          ...(artifactDir === undefined ? [] : ['--outDir', artifactDir, '--base', '/']),
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
        ],
    env,
  );
  await waitForService(server, `${origin}/api/jurisdictions`);
  if (artifactDir !== undefined) {
    const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
    const files = await Promise.all(
      ['index.html', 'runtime.js', 'account-worker.js'].map(async path => {
        const artifact = readFileSync(join(artifactDir, path));
        const response = await fetch(`${origin}/${path}`, { signal: AbortSignal.timeout(10_000) });
        const servedHash = hash(new Uint8Array(await response.arrayBuffer()));
        const sha256 = hash(artifact);
        if (!response.ok || servedHash !== sha256)
          throw new Error(`WALLET_ARTIFACT_MISMATCH:${path}:${response.status}:${sha256}:${servedHash}`);
        return { path, bytes: artifact.length, sha256 };
      }),
    );
    writeFileSync(join(input.workDir, 'wallet-artifact.json'), safeStringify({ artifactDir, origin, files }, 2));
  }
  const gateStartedAt = Date.now();
  await waitForRuntimeImportManifest(join(input.workDir, 'prod-mesh', 'runtime-import-manifest.json'));
  await waitForGateProcess(
    input.start(
      'wallet-browser',
      process.execPath,
      [
        join(input.repoRoot, 'ui/node_modules/playwright/cli.js'),
        'test',
        '--config',
        'ui/playwright.config.ts',
        '--project=chromium',
        '--max-failures=1',
        '--reporter=list,json',
        ...(grep === undefined ? [] : ['--grep', grep.replaceAll('.', '[.]')]),
        '--output',
        join(input.workDir, 'wallet-artifacts'),
        ...tests.map(test => `ui/tests/${test}`),
      ],
      env,
    ),
    'browser',
  );
  assertBrowserReport(report, input.repoRoot, tests, gateStartedAt);
};
