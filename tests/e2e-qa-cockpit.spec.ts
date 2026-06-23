import { expect, test } from './global-setup';

const QA_FIXTURE_RUN_ID = '20260623-235959-999';
const QA_FAST_RUN_ID = '20260623-225959-888';
const QA_FIXTURE_ARTIFACT = 'test-results-shard-1/qa-cockpit-fixture/video.webm';
const QA_AUTH = { scope: 'admin', disabled: true, actorKeyId: 'fixture-auth-disabled' };
const QA_FIXTURE_TIMING = {
  avgShardMs: 7_200,
  maxShardMs: 7_200,
  bootstrapMs: 1_500,
  apiHealthyMs: 400,
  playwrightMs: 5_700,
};
const QA_FAST_TIMING = {
  avgShardMs: 4_000,
  maxShardMs: 4_000,
  bootstrapMs: 900,
  apiHealthyMs: 250,
  playwrightMs: 3_100,
};
const QA_CLEAN_BROWSER_HEALTH = {
  issueCount: 0,
  errorCount: 0,
  warningCount: 0,
  networkFailureCount: 0,
  httpErrorCount: 0,
};
const QA_FIXTURE_BROWSER_HEALTH = {
  issueCount: 3,
  errorCount: 1,
  warningCount: 2,
  networkFailureCount: 0,
  httpErrorCount: 1,
};
const QA_FIXTURE_WEBM = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAITEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggH97AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDBEiYhAXgAAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIrVSOo5G6X2+cgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QCYloA4JCwgRC6gRCagQJVsIRVuYEBElTDZ0B/c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2Mi4zLjEwMHNz2mPAi2PFiK1UjqORul9vZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4xMS4xMDAgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMTIwMDAwMDAwAB9DtnXQ54EAo6GBAACAgkmDQgAA8AD2ADgkHBhCAAAwYAAAEL///YsqAACjk4EAKACGAECSnABJQAADIAAAQkCjk4EAUACGAECSnABKwAADIAAAQkAcU7trkbuPs4EAt4r3gQHxggGo8IED',
  'base64',
);
const QA_FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNk+M+ABzAwMDAwMgAAHncCPYhSw6AAAAAASUVORK5CYII=',
  'base64',
);

const QA_FIXTURE_RUN = {
  manifestVersion: 2,
  runId: QA_FIXTURE_RUN_ID,
  createdAt: Date.UTC(2026, 5, 23, 23, 59, 59, 999),
  completedAt: Date.UTC(2026, 5, 24, 0, 0, 7, 199),
  status: 'passed',
  totalMs: 7_200,
  timing: QA_FIXTURE_TIMING,
  code: {
    gitHead: '95174ad2c2d9d8db1d7f07b6f4a4e9ec0c000001',
    gitBranch: 'codex/qa-cockpit',
    gitStatus: '',
    dirty: false,
    codeHash: 'b4e0f2401f81e9c82268f0e217f514e2d7bc1ecf6f6a9d911c9da7e9d6400001',
    computedAt: Date.UTC(2026, 5, 23, 23, 59, 58),
    trackedFileCount: 512,
    trackedBytes: 4_200_000,
  },
  perf: {
    sampleCount: 8,
    avgLoad1: 2.1,
    peakLoad1: 3.4,
    minFreeMemBytes: 1_000_000_000,
    maxRunnerRssBytes: 240_000_000,
    maxChildCpuPct: 44.2,
    maxChildRssKb: 812_000,
    samples: [],
  },
  browserHealth: QA_FIXTURE_BROWSER_HEALTH,
  benchmark: {
    status: 'slower',
    suiteKey: 'fixture-suite',
    suiteLabel: 'qa.cockpit-fixture',
    comparedRunId: '20260623-225959-888',
    comparedGitHead: '95174ad2c2d9d8db1d7f07b6f4a4e9ec0c000000',
    comparedCodeHash: 'a3d0f1401f81e9c82268f0e217f514e2d7bc1ecf6f6a9d911c9da7e9d6400000',
    sameGitHead: false,
    sameCodeHash: false,
    reason: 'wall time +25% vs 20260623-225959-888',
    metrics: [
      {
        metric: 'totalMs',
        label: 'wall time',
        unit: 'ms',
        current: 7_200,
        baseline: 5_760,
        delta: 1_440,
        deltaPct: 25,
        thresholdPct: 20,
        verdict: 'slower',
      },
    ],
    likelyCauses: ['code hash changed', 'git HEAD changed', 'largest delta: wall time +25%'],
  },
  totalShards: 1,
  passedShards: 1,
  failedShards: 0,
  args: { fixture: 'qa-cockpit-scenario-player' },
  shards: [
    {
      shard: 1,
      status: 'passed',
      durationMs: 7_200,
      handle: 'qa.cockpit-fixture',
      description: 'Fixture run records a wallet scenario with synced transcript and video playback.',
      target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
      title: 'QA cockpit fixture records playback transcript',
      requireMarketMaker: false,
      logRelativePath: 'e2e-shard-01.log',
      logTail: null,
      error: null,
      phaseMs: {
        preflight: 100,
        anvilBoot: 200,
        apiBoot: 300,
        apiHealthy: 400,
        viteBoot: 500,
        playwright: 5_700,
      },
      browserIssues: [
        {
          type: 'pageerror',
          severity: 'error',
          message: 'Unhandled promise rejection while opening scenario playback',
          url: 'https://localhost:8080/qa',
          method: null,
          status: null,
          testId: 'chromium :: tests/e2e-qa-cockpit-fixture.spec.ts :: QA cockpit fixture',
          timestamp: Date.UTC(2026, 5, 24, 0, 0, 2),
        },
        {
          type: 'console',
          severity: 'warning',
          message: 'Slow scenario subtitle hydration',
          url: 'https://localhost:8080/qa',
          method: null,
          status: null,
          testId: 'chromium :: tests/e2e-qa-cockpit-fixture.spec.ts :: QA cockpit fixture',
          timestamp: Date.UTC(2026, 5, 24, 0, 0, 3),
        },
        {
          type: 'http',
          severity: 'warning',
          message: 'HTTP 404',
          url: 'https://localhost:8080/favicon.ico',
          method: 'GET',
          status: 404,
          testId: 'chromium :: tests/e2e-qa-cockpit-fixture.spec.ts :: QA cockpit fixture',
          timestamp: Date.UTC(2026, 5, 24, 0, 0, 4),
        },
      ],
      browserHealth: QA_FIXTURE_BROWSER_HEALTH,
      timelineSteps: [
        { label: 'E2E-TIMING:open wallet cockpit', ms: 900 },
        { label: 'E2E-TIMING:select recorded shard', ms: 1_100 },
        { label: 'E2E-TIMING:sync video subtitle transcript', ms: 1_300 },
        { label: 'E2E-TIMING:enter theater playback', ms: 1_500 },
      ],
      slowSteps: [
        { label: 'E2E-TIMING:enter theater playback', ms: 1_500 },
        { label: 'E2E-TIMING:sync video subtitle transcript', ms: 1_300 },
        { label: 'E2E-TIMING:select recorded shard', ms: 1_100 },
      ],
      artifacts: [
        {
          name: 'video.webm',
          relativePath: QA_FIXTURE_ARTIFACT,
          sizeBytes: 1024,
          kind: 'video',
          contentType: 'video/webm',
          url: `/api/qa/artifact?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}&path=${encodeURIComponent(QA_FIXTURE_ARTIFACT)}`,
        },
      ],
      hasVideo: true,
      hasTrace: false,
    },
  ],
};

const QA_FIXTURE_SUMMARY = {
  ...QA_FIXTURE_RUN,
  shards: undefined,
  failingTargets: [],
};

const QA_FAST_SUMMARY = {
  ...QA_FIXTURE_SUMMARY,
  runId: QA_FAST_RUN_ID,
  createdAt: Date.UTC(2026, 5, 23, 22, 59, 59, 888),
  completedAt: Date.UTC(2026, 5, 23, 23, 0, 3, 888),
  status: 'passed',
  totalMs: 4_000,
  timing: QA_FAST_TIMING,
  browserHealth: QA_CLEAN_BROWSER_HEALTH,
  code: {
    ...QA_FIXTURE_RUN.code,
    gitHead: '95174ad2c2d9d8db1d7f07b6f4a4e9ec0c000000',
    codeHash: 'a3d0f1401f81e9c82268f0e217f514e2d7bc1ecf6f6a9d911c9da7e9d6400000',
  },
  benchmark: {
    ...QA_FIXTURE_RUN.benchmark,
    status: 'ok',
    reason: 'Within thresholds vs baseline',
    metrics: [],
  },
  failingTargets: [],
};

const QA_CATALOG = [
  {
    id: 'e2e-isolated',
    group: 'E2E',
    label: 'Isolated Browser E2E',
    command: 'bun runtime/scripts/run-e2e-parallel-isolated.ts --all --video=on',
    description: 'Full browser mesh with isolated chains, API, wallet, videos, traces.',
  },
  {
    id: 'runtime-units',
    group: 'Unit',
    label: 'Runtime Unit Tests',
    command: 'bun test runtime/__tests__',
    description: 'Pure runtime, consensus, adapter, and protocol regression tests.',
  },
  {
    id: 'contracts',
    group: 'Contracts',
    label: 'Contract Tests',
    command: 'cd jurisdictions && bun run test',
    description: 'Jurisdiction contracts, deployment fixtures, and on-chain invariants.',
  },
  {
    id: 'swap-runtime-bench',
    group: 'Benchmark',
    label: 'Swap Runtime TPS',
    command: 'bun run bench:swap:runtime',
    description: 'Measures deterministic swap runtime throughput against release threshold.',
  },
];

const QA_HISTORY = [
  {
    runId: QA_FIXTURE_RUN_ID,
    createdAt: QA_FIXTURE_RUN.createdAt,
    completedAt: QA_FIXTURE_RUN.completedAt,
    status: 'passed',
    totalMs: QA_FIXTURE_RUN.totalMs,
    totalShards: QA_FIXTURE_RUN.totalShards,
    passedShards: QA_FIXTURE_RUN.passedShards,
    failedShards: QA_FIXTURE_RUN.failedShards,
    gitHead: QA_FIXTURE_RUN.code.gitHead,
    gitBranch: QA_FIXTURE_RUN.code.gitBranch,
    dirty: false,
    codeHash: QA_FIXTURE_RUN.code.codeHash,
    avgLoad1: QA_FIXTURE_RUN.perf.avgLoad1,
    peakLoad1: QA_FIXTURE_RUN.perf.peakLoad1,
    maxChildCpuPct: QA_FIXTURE_RUN.perf.maxChildCpuPct,
    maxChildRssKb: QA_FIXTURE_RUN.perf.maxChildRssKb,
    avgShardMs: QA_FIXTURE_TIMING.avgShardMs,
    maxShardMs: QA_FIXTURE_TIMING.maxShardMs,
    bootstrapMs: QA_FIXTURE_TIMING.bootstrapMs,
    apiHealthyMs: QA_FIXTURE_TIMING.apiHealthyMs,
    playwrightMs: QA_FIXTURE_TIMING.playwrightMs,
    benchmarkStatus: QA_FIXTURE_RUN.benchmark.status,
    benchmarkDeltaPct: 25,
    benchmarkComparedRunId: QA_FIXTURE_RUN.benchmark.comparedRunId,
    browserIssueCount: QA_FIXTURE_BROWSER_HEALTH.issueCount,
    browserErrorCount: QA_FIXTURE_BROWSER_HEALTH.errorCount,
    browserWarningCount: QA_FIXTURE_BROWSER_HEALTH.warningCount,
    networkFailureCount: QA_FIXTURE_BROWSER_HEALTH.networkFailureCount,
    httpErrorCount: QA_FIXTURE_BROWSER_HEALTH.httpErrorCount,
  },
  {
    runId: QA_FAST_RUN_ID,
    createdAt: QA_FAST_SUMMARY.createdAt,
    completedAt: QA_FAST_SUMMARY.completedAt,
    status: 'passed',
    totalMs: QA_FAST_SUMMARY.totalMs,
    totalShards: 1,
    passedShards: 1,
    failedShards: 0,
    gitHead: '95174ad2c2d9d8db1d7f07b6f4a4e9ec0c000000',
    gitBranch: 'codex/qa-cockpit',
    dirty: true,
    codeHash: 'a3d0f1401f81e9c82268f0e217f514e2d7bc1ecf6f6a9d911c9da7e9d6400000',
    avgLoad1: 2.7,
    peakLoad1: 4.1,
    maxChildCpuPct: 64.1,
    maxChildRssKb: 920_000,
    avgShardMs: QA_FAST_TIMING.avgShardMs,
    maxShardMs: QA_FAST_TIMING.maxShardMs,
    bootstrapMs: QA_FAST_TIMING.bootstrapMs,
    apiHealthyMs: QA_FAST_TIMING.apiHealthyMs,
    playwrightMs: QA_FAST_TIMING.playwrightMs,
    benchmarkStatus: 'ok',
    benchmarkDeltaPct: 0,
    benchmarkComparedRunId: null,
    browserIssueCount: 0,
    browserErrorCount: 0,
    browserWarningCount: 0,
    networkFailureCount: 0,
    httpErrorCount: 0,
  },
];

const QA_STORIES = [
  {
    id: `qa-run:${QA_FIXTURE_RUN_ID}:ux-gallery/desktop/desktop-accounts-pay.png`,
    source: 'qa-run',
    title: 'desktop payment composer',
    group: 'Payments',
    description: 'User prepares a payment from an open hub account.',
    platform: 'desktop',
    tags: ['payment', 'account'],
    curated: true,
    name: 'desktop-accounts-pay.png',
    relativePath: 'ux-gallery/desktop/desktop-accounts-pay.png',
    sizeBytes: QA_FIXTURE_PNG.length,
    updatedAt: QA_FIXTURE_RUN.completedAt,
    url: '/api/qa/artifact?runId=20260623-235959-999&path=ux-gallery%2Fdesktop%2Fdesktop-accounts-pay.png',
    runId: QA_FIXTURE_RUN_ID,
    shard: 1,
    status: 'passed',
  },
  {
    id: `qa-run:${QA_FIXTURE_RUN_ID}:ux-gallery/mobile/mobile-iphone15pro-swap-base.png`,
    source: 'qa-run',
    title: 'mobile swap ticket',
    group: 'Swap',
    description: 'Prepared cross-chain swap ticket with live orderbook depth.',
    platform: 'mobile',
    tags: ['swap', 'orderbook'],
    curated: true,
    name: 'mobile-iphone15pro-swap-base.png',
    relativePath: 'ux-gallery/mobile/mobile-iphone15pro-swap-base.png',
    sizeBytes: QA_FIXTURE_PNG.length,
    updatedAt: QA_FIXTURE_RUN.completedAt,
    url: '/api/qa/artifact?runId=20260623-235959-999&path=ux-gallery%2Fmobile%2Fmobile-iphone15pro-swap-base.png',
    runId: QA_FIXTURE_RUN_ID,
    shard: 1,
    status: 'passed',
  },
];

const QA_RESTART_AUDIT = [
  {
    auditId: 'fixture-restart-audit-1',
    status: 'finished',
    actorKeyId: 'fixture-auth-disabled',
    scope: 'admin',
    operatorId: 'regulator-auditor',
    action: 'restart-run',
    target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
    title: 'QA cockpit fixture records playback transcript',
    reason: 'verify evidence playback after code hash change',
    expectedGitHead: QA_FIXTURE_RUN.code.gitHead,
    actualGitHead: QA_FIXTURE_RUN.code.gitHead,
    gitBranch: QA_FIXTURE_RUN.code.gitBranch,
    codeHash: QA_FIXTURE_RUN.code.codeHash,
    dirty: false,
    startedAt: Date.UTC(2026, 5, 24, 0, 0, 8, 0),
    finishedAt: Date.UTC(2026, 5, 24, 0, 0, 17, 0),
    pid: 4242,
    exitCode: 0,
    logPath: '.logs/qa-restarts/fixture.log',
    requestIp: '127.0.0.1',
    userAgent: 'fixture',
  },
];

test.describe('QA cockpit scenario player', () => {
  test('plays recorded scenario videos with short copy and synced transcript', async ({ page }) => {
    test.setTimeout(90_000);
    await page.route('**/api/qa/runs?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, qaAuth: QA_AUTH, runs: [QA_FIXTURE_SUMMARY, QA_FAST_SUMMARY] }),
      });
    });
    await page.route('**/api/qa/run?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, qaAuth: QA_AUTH, run: QA_FIXTURE_RUN }),
      });
    });
    await page.route('**/api/qa/catalog', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          catalog: QA_CATALOG,
          restart: { active: false },
          restartAllowed: false,
        }),
      });
    });
    await page.route('**/api/qa/history?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          history: QA_HISTORY,
          restart: { active: false },
          restartAllowed: false,
        }),
      });
    });
    await page.route('**/api/qa/restart-audit?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          audit: QA_RESTART_AUDIT,
        }),
      });
    });
    await page.route('**/api/qa/stories?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          total: QA_STORIES.length,
          stories: QA_STORIES,
        }),
      });
    });
    await page.route('**/api/qa/restart?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          mode: 'plan',
          target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
          title: 'QA cockpit fixture records playback transcript',
          command: [
            'bun',
            'runtime/scripts/run-e2e-parallel-isolated.ts',
            '--pw-project=chromium',
            '--pw-files=["tests/e2e-qa-cockpit-fixture.spec.ts::QA cockpit fixture records playback transcript"]',
            '--video=on',
          ],
          expectedGitHead: QA_FIXTURE_RUN.code.gitHead,
          gitBranch: QA_FIXTURE_RUN.code.gitBranch,
          codeHash: QA_FIXTURE_RUN.code.codeHash,
          dirty: false,
        }),
      });
    });
    await page.route('**/api/qa/retention', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          result: {
            retentionDays: 30,
            cutoff: Date.UTC(2026, 4, 25),
            deletedRunIds: ['20260401-000000-000'],
            deletedLogDirs: 1,
            deletedHistoryRows: 1,
          },
        }),
      });
    });
    await page.route('**/api/qa/artifact?**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const artifactPath = requestUrl.searchParams.get('path') || '';
      const isPng = artifactPath.endsWith('.png');
      await route.fulfill({
        status: 200,
        contentType: isPng ? 'image/png' : 'video/webm',
        body: isPng ? QA_FIXTURE_PNG : QA_FIXTURE_WEBM,
      });
    });
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });

    await page.goto('/qa');
    await expect(page.getByRole('heading', { name: 'Test Cockpit' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('qa-test-tabs')).toBeVisible();
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('FAIL');
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('1 browser errors');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('browser');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('Browser health failed');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('performance');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('SLOWER');
    await expect(page.getByTestId('qa-ux-gallery-preview')).toContainText('UX Screenshot Gallery');
    await expect(page.getByTestId('qa-ux-gallery-preview')).toContainText('desktop payment composer');
    await expect(page.getByTestId('qa-run-row').first()).toHaveAttribute('data-run-id', QA_FIXTURE_RUN_ID);
    await page.getByTestId('qa-run-sort').selectOption('stack-fast');
    await expect(page.getByTestId('qa-run-row').first()).toHaveAttribute('data-run-id', QA_FAST_RUN_ID);
    await page.getByTestId('qa-run-sort').selectOption('date-desc');
    await expect(page.getByTestId('qa-run-row').first()).toHaveAttribute('data-run-id', QA_FIXTURE_RUN_ID);
    await page.getByTestId('qa-failure-item').first().click();
    await expect(page.locator(`[data-testid="qa-run-row"][data-run-id="${QA_FIXTURE_RUN_ID}"]`)).toHaveClass(/selected/);

    await page.goto(`/qa?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}`);
    await expect(page.locator(`[data-testid="qa-run-row"][data-run-id="${QA_FIXTURE_RUN_ID}"]`)).toHaveClass(/selected/, { timeout: 30_000 });

    await page.getByRole('button', { name: 'Scenario Player' }).click();
    await expect(page.getByTestId('qa-scenario-player-frame')).toBeVisible();
    await page.getByRole('button', { name: 'UX Gallery' }).click();
    await expect(page.getByTestId('qa-ux-gallery')).toContainText('Payments');
    await expect(page.getByTestId('qa-ux-gallery')).toContainText('mobile swap ticket');
    await expect(page.getByTestId('qa-ux-gallery-card').filter({ hasText: 'desktop' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Suites' }).click();
    await expect(page.getByTestId('qa-system-suites')).toContainText('Runtime Unit Tests');
    await expect(page.getByTestId('qa-system-suites')).toContainText('Contract Tests');
    await page.getByRole('button', { name: 'Benchmarks' }).click();
    await expect(page.getByTestId('qa-benchmarks')).toContainText('Swap Runtime TPS');
    await expect(page.getByTestId('qa-benchmarks')).toContainText('cpu 44.2%');
    await expect(page.getByTestId('qa-benchmarks')).toContainText('browser 1 err / 2 warn');
    await expect(page.getByTestId('qa-benchmarks')).toContainText('SLOWER +25.0%');
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByTestId('qa-history')).toContainText('head 95174ad2c2d');
    await expect(page.getByTestId('qa-history')).toContainText('code b4e0f2401f81');
    await expect(page.getByTestId('qa-history')).toContainText('browser 1 err / 2 warn');
    await expect(page.getByTestId('qa-history')).toContainText('SLOWER +25.0%');
    await expect(page.getByTestId('qa-history')).toContainText('regulator-auditor');
    await expect(page.getByTestId('qa-history')).toContainText('verify evidence playback');
    await expect(page.getByTestId('qa-retention-card')).toContainText('Delete Runs Older Than 30 Days');
    await expect(page.getByTestId('qa-retention-purge')).toBeDisabled();
    await page.getByPlaceholder('DELETE_OLDER_THAN_30_DAYS').fill('DELETE_OLDER_THAN_30_DAYS');
    await expect(page.getByTestId('qa-retention-purge')).toBeEnabled();
    await page.getByTestId('qa-retention-purge').click();
    await expect(page.getByTestId('qa-retention-result')).toContainText('deleted 1 log dirs / 1 history rows');
    await page.getByTestId('qa-history-sort').selectOption('stack-fast');
    await expect(page.getByTestId('qa-history-row').first()).toHaveAttribute('data-run-id', QA_FAST_RUN_ID);
    await page.getByTestId('qa-history-sort').selectOption('date-desc');
    await expect(page.getByTestId('qa-history-row').first()).toHaveAttribute('data-run-id', QA_FIXTURE_RUN_ID);
    await page.getByRole('button', { name: 'E2E Runs' }).click();
    await expect(page.locator('.run-summary')).toContainText('Benchmark');
    await expect(page.locator('.run-summary')).toContainText('wall time +25%');
    await expect(page.locator('.run-summary')).toContainText('Browser Health');
    await expect(page.locator('.run-summary')).toContainText('1 err / 2 warn');

    const previewCards = page.getByTestId('scenario-preview-card');
    await expect(previewCards.first()).toBeVisible({ timeout: 30_000 });

    const videoShard = page.getByTestId('qa-suite-row').first();
    await expect(videoShard).toHaveAttribute('data-has-video', 'true');
    await videoShard.click();

    const watchPanel = page.getByTestId('qa-watch-panel');
    await expect(page.getByTestId('qa-browser-health')).toContainText('Unhandled promise rejection');
    await expect(page.getByTestId('qa-browser-health')).toContainText('HTTP 404');
    await expect(watchPanel).toBeVisible();
    await expect(page.getByTestId('qa-video-player')).toBeVisible();
    await expect(page.getByTestId('qa-video-player')).toHaveAttribute('src', /^blob:/);

    const shortDescription = (await page.getByTestId('qa-short-description').textContent())?.trim() ?? '';
    expect(shortDescription.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(10);

    await page.getByRole('button', { name: 'Restart plan' }).click();
    await expect(page.getByTestId('qa-restart-plan')).toContainText('run-e2e-parallel-isolated');
    await expect(page.getByTestId('qa-restart-plan')).toContainText('Code hash changed');
    await expect(page.getByRole('button', { name: 'Restart run' })).toBeDisabled();

    await expect(page.getByTestId('qa-scenario-transcript')).toBeVisible();
    await expect
      .poll(async () => page.getByTestId('qa-subtitle-cue').count(), {
        timeout: 10_000,
        message: 'scenario transcript should expose multiple cues',
      })
      .toBeGreaterThan(2);

    await expect(page.getByTestId('qa-live-subtitle')).toBeVisible();
    await page.getByTestId('qa-subtitle-cue').nth(1).click();
    await expect(page.locator('[data-testid="qa-subtitle-cue"][aria-current="step"]')).toBeVisible();

    await page.getByTestId('qa-theater-toggle').click();
    await expect(watchPanel).toHaveClass(/theater/);
    await page.getByTestId('qa-fullscreen-button').click();
    await expect(watchPanel).toHaveClass(/theater/);

    expect(runtimeErrors).toEqual([]);
  });
});
