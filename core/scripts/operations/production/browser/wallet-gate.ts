import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireBoundaryInteger, requireBoundaryRecord } from '../../../../protocol/boundary-validation';

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

const waitForBrowser = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`WALLET_E2E_FAILED:${code}:${signal}`)),
    );
  });

const assertBrowserReport = (path: string): void => {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const report = requireBoundaryRecord(raw, 'WALLET_REPORT_INVALID');
  const stats = requireBoundaryRecord(report['stats'], 'WALLET_REPORT_STATS_MISSING');
  const passed = requireBoundaryInteger(stats['expected'], 'WALLET_REPORT_NO_PASSES', 1);
  for (const key of ['unexpected', 'flaky', 'skipped']) {
    if (requireBoundaryInteger(stats[key], `WALLET_REPORT_${key}`) !== 0)
      throw new Error(`WALLET_REPORT_NOT_GREEN:${key}`);
  }
  console.log(`WALLET_BROWSER_GATE_OK passed=${passed} skipped=0 report=${path}`);
};

/** Reuse the production stand and its leased ports; all children share its cleanup owner. */
export const runWalletBrowserGate = async (input: WalletGate): Promise<void> => {
  const tests = input.tests.split(',');
  if (tests.some(test => !/^e2e-[a-z0-9-]+\.spec\.ts$/.test(test))) throw new Error('WALLET_TEST_ARGUMENT_INVALID');
  const port = input.rpcPort + 2;
  const origin = `http://127.0.0.1:${port}`;
  const report = join(input.workDir, 'wallet-results.json');
  const towerPort = input.rpcPort + 3;
  const towerOrigin = `http://127.0.0.1:${towerPort}`;
  const tower = input.start('wallet-tower', process.execPath, [
    join(input.repoRoot, 'core/watchtower/standalone-server.ts'),
    '--host', '127.0.0.1', '--port', String(towerPort),
    '--db', join(input.workDir, 'watchtower'), '--quota-bytes', '4194304', '--max-bundles', '3',
  ], {});
  await waitForService(tower, `${towerOrigin}/api/tower/healthz`);
  const env = {
    NODE_ENV: 'development',
    VITE_XLN_WATCHTOWER_URL: towerOrigin,
    UI_E2E_TOWER_URL: towerOrigin,
    XLN_UI_STACK_ORIGIN: `http://127.0.0.1:${input.apiPort}`,
    XLN_UI_RUNTIME_BUNDLE_DIR: join(input.repoRoot, 'frontend/static'),
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
    [
      join(input.repoRoot, 'ui/node_modules/vite/bin/vite.js'),
      'ui',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    env,
  );
  await waitForService(server, `${origin}/api/jurisdictions`);
  await waitForBrowser(
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
        '--output',
        join(input.workDir, 'wallet-artifacts'),
        ...tests.map(test => `ui/tests/${test}`),
      ],
      env,
    ),
  );
  assertBrowserReport(report);
};
