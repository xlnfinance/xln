import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  buildQaRestartEnv,
  finishQaRestartAudit,
  insertQaRestartAudit,
  listQaRestartAudit,
  maybeHandleQaRequest,
  type QaRestartAuditEntry,
} from '../qa/api';
import {
  compareQaBenchmarkRuns,
  listQaStoryScreenshots,
  purgeQaRunsOlderThan,
  readQaRun,
  recordQaRunHistory,
  resolveQaStoryScreenshotPath,
  type QaRunManifest,
} from '../qa/report';

const QA_READ_TOKEN = 'qa-read-test-token';
const QA_ADMIN_TOKEN = 'qa-admin-test-token';
const JSON_HEADERS = { 'content-type': 'application/json' };

const qaRequest = (url: string, init: RequestInit = {}, token = QA_READ_TOKEN): Request => {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request(url, { ...init, headers });
};

const withQaAuthEnv = async <T>(work: () => Promise<T>): Promise<T> => {
  const previousRead = process.env['XLN_QA_READ_TOKEN'];
  const previousAdmin = process.env['XLN_QA_ADMIN_TOKEN'];
  const previousDisabled = process.env['XLN_QA_AUTH_DISABLED'];
  process.env['XLN_QA_READ_TOKEN'] = QA_READ_TOKEN;
  process.env['XLN_QA_ADMIN_TOKEN'] = QA_ADMIN_TOKEN;
  delete process.env['XLN_QA_AUTH_DISABLED'];
  try {
    return await work();
  } finally {
    if (previousRead === undefined) delete process.env['XLN_QA_READ_TOKEN'];
    else process.env['XLN_QA_READ_TOKEN'] = previousRead;
    if (previousAdmin === undefined) delete process.env['XLN_QA_ADMIN_TOKEN'];
    else process.env['XLN_QA_ADMIN_TOKEN'] = previousAdmin;
    if (previousDisabled === undefined) delete process.env['XLN_QA_AUTH_DISABLED'];
    else process.env['XLN_QA_AUTH_DISABLED'] = previousDisabled;
  }
};

const benchmarkRun = (
  runId: string,
  totalMs: number,
  playwrightMs: number,
  codeHash = 'same-code',
  gitHead = 'same-head',
  peakLoad1 = 1,
): QaRunManifest => ({
  manifestVersion: 2,
  runId,
  createdAt: Date.UTC(2026, 5, 23),
  completedAt: Date.UTC(2026, 5, 23, 0, 0, 1),
  status: 'passed',
  totalMs,
  code: {
    gitHead,
    gitBranch: 'codex/qa',
    gitStatus: '',
    dirty: false,
    codeHash,
    computedAt: Date.UTC(2026, 5, 23),
    trackedFileCount: 1,
    trackedBytes: 1,
  },
  perf: {
    sampleCount: 1,
    avgLoad1: 1,
    peakLoad1,
    minFreeMemBytes: 1024,
    maxRunnerRssBytes: 2048,
    maxChildCpuPct: 20,
    maxChildRssKb: 4096,
    samples: [],
  },
  totalShards: 1,
  passedShards: 1,
  failedShards: 0,
  args: {
    pwProject: 'chromium',
    pwFiles: ['tests/e2e-qa-cockpit.spec.ts'],
  },
  shards: [{
    shard: 0,
    status: 'passed',
    durationMs: totalMs,
    handle: 'qa cockpit',
    description: null,
    target: 'tests/e2e-qa-cockpit.spec.ts',
    title: 'plays recorded scenario videos',
    requireMarketMaker: false,
    logRelativePath: null,
    logTail: null,
    error: null,
    phaseMs: {
      preflight: 0,
      anvilBoot: 0,
      apiBoot: 100,
      apiHealthy: 100,
      viteBoot: 100,
      playwright: playwrightMs,
    },
    timelineSteps: [],
    slowSteps: [],
    artifacts: [],
    hasVideo: false,
    hasTrace: false,
  }],
});

test('qa benchmark comparison flags sharp runtime deltas', () => {
  const baseline = benchmarkRun('baseline', 1000, 800);
  const slower = compareQaBenchmarkRuns(benchmarkRun('slower', 1300, 1100, 'new-code', 'new-head'), baseline);
  expect(slower.status).toBe('slower');
  expect(slower.sameCodeHash).toBe(false);
  expect(slower.sameGitHead).toBe(false);
  expect(slower.metrics.find(metric => metric.metric === 'totalMs')?.deltaPct).toBe(30);
  expect(slower.likelyCauses).toContain('code hash changed');

  const faster = compareQaBenchmarkRuns(benchmarkRun('faster', 700, 550), baseline);
  expect(faster.status).toBe('faster');
  expect(faster.metrics.find(metric => metric.metric === 'totalMs')?.deltaPct).toBe(-30);

  const lowerLoadOnly = compareQaBenchmarkRuns(benchmarkRun('lower-load', 1010, 805, 'same-code', 'same-head', 0.4), baseline);
  expect(lowerLoadOnly.status).toBe('ok');
  expect(lowerLoadOnly.metrics.find(metric => metric.metric === 'peakLoad1')?.verdict).toBe('faster');
  expect(lowerLoadOnly.reason).toContain('Timing within thresholds');
});

test('qa stories catalog indexes real e2e screenshots', async () => {
  const stories = await listQaStoryScreenshots(20);
  const e2eStory = stories.find(story => story.source === 'e2e-screenshots');

  expect(e2eStory).toBeDefined();
  expect(e2eStory?.url.startsWith('/api/qa/story-image?')).toBe(true);
  expect(e2eStory?.relativePath.includes('..')).toBe(false);
  expect(e2eStory?.sizeBytes ?? 0).toBeGreaterThan(0);
});

test('qa story image resolver rejects path traversal', async () => {
  await expect(resolveQaStoryScreenshotPath('e2e-screenshots', '../package.json')).rejects.toThrow(
    'INVALID_QA_STORY_IMAGE_PATH',
  );
});

test('qa stories api returns screenshot catalog', async () => {
  await withQaAuthEnv(async () => {
    const response = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/stories?limit=3'),
      '/api/qa/stories',
      JSON_HEADERS,
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);

    const payload = await response?.json() as {
      ok?: boolean;
      stories?: Array<{ source?: string; url?: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.stories?.length).toBeGreaterThan(0);
    expect(payload.stories?.[0]?.url?.startsWith('/api/qa/')).toBe(true);
  });
});

test('qa catalog and restart plan expose real runner commands', async () => {
  await withQaAuthEnv(async () => {
    const catalogResponse = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/catalog'),
      '/api/qa/catalog',
      JSON_HEADERS,
    );
    expect(catalogResponse?.status).toBe(200);
    const catalogPayload = await catalogResponse!.json() as {
      ok?: boolean;
      catalog?: Array<{ label?: string; group?: string; command?: string }>;
      restartAllowed?: boolean;
    };
    expect(catalogPayload.ok).toBe(true);
    expect(catalogPayload.catalog?.some((item) => item.label === 'Runtime Unit Tests')).toBe(true);
    expect(catalogPayload.catalog?.some((item) => item.group === 'Contracts')).toBe(true);
    expect(typeof catalogPayload.restartAllowed).toBe('boolean');

    const planResponse = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=plan', {
        method: 'POST',
        body: JSON.stringify({
          target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
          title: 'QA cockpit fixture records playback transcript',
        }),
      }, QA_ADMIN_TOKEN),
      '/api/qa/restart',
      JSON_HEADERS,
    );
    expect(planResponse?.status).toBe(200);
    const planPayload = await planResponse!.json() as {
      ok?: boolean;
      command?: string[];
      expectedGitHead?: string | null;
      codeHash?: string;
      dirty?: boolean;
    };
    expect(planPayload.ok).toBe(true);
    expect(planPayload.command?.join(' ')).toContain('run-e2e-parallel-isolated.ts');
    expect(planPayload.command?.join(' ')).toContain('--video=on');
    expect(typeof planPayload.expectedGitHead === 'string' || planPayload.expectedGitHead === null).toBe(true);
    expect(typeof planPayload.codeHash).toBe('string');
    expect(typeof planPayload.dirty).toBe('boolean');
  });
});

test('qa api is open by default when qa tokens are not configured', async () => {
  const previousRead = process.env['XLN_QA_READ_TOKEN'];
  const previousAdmin = process.env['XLN_QA_ADMIN_TOKEN'];
  const previousDisabled = process.env['XLN_QA_AUTH_DISABLED'];
  delete process.env['XLN_QA_READ_TOKEN'];
  delete process.env['XLN_QA_ADMIN_TOKEN'];
  delete process.env['XLN_QA_AUTH_DISABLED'];
  try {
    const response = await maybeHandleQaRequest(
      new Request('http://127.0.0.1:8080/api/qa/catalog'),
      '/api/qa/catalog',
      JSON_HEADERS,
    );
    expect(response?.status).toBe(200);
    const payload = await response!.json() as {
      ok?: boolean;
      qaAuth?: { scope?: string; disabled?: boolean; actorKeyId?: string };
      catalog?: unknown[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.qaAuth?.scope).toBe('admin');
    expect(payload.qaAuth?.disabled).toBe(true);
    expect(payload.qaAuth?.actorKeyId).toBe('qa-open');
    expect(Array.isArray(payload.catalog)).toBe(true);
  } finally {
    if (previousRead === undefined) delete process.env['XLN_QA_READ_TOKEN'];
    else process.env['XLN_QA_READ_TOKEN'] = previousRead;
    if (previousAdmin === undefined) delete process.env['XLN_QA_ADMIN_TOKEN'];
    else process.env['XLN_QA_ADMIN_TOKEN'] = previousAdmin;
    if (previousDisabled === undefined) delete process.env['XLN_QA_AUTH_DISABLED'];
    else process.env['XLN_QA_AUTH_DISABLED'] = previousDisabled;
  }
});

test('qa api requires read token and admin token for restart operations', async () => {
  await withQaAuthEnv(async () => {
    const missingToken = await maybeHandleQaRequest(
      new Request('http://127.0.0.1:8080/api/qa/catalog'),
      '/api/qa/catalog',
      JSON_HEADERS,
    );
    expect(missingToken?.status).toBe(401);
    expect((await missingToken!.json() as { error?: string }).error).toBe('QA_AUTH_REQUIRED');

    const readPlan = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=plan', {
        method: 'POST',
        body: JSON.stringify({
          target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
          title: 'QA cockpit fixture records playback transcript',
        }),
      }),
      '/api/qa/restart',
      JSON_HEADERS,
    );
    expect(readPlan?.status).toBe(403);
    expect((await readPlan!.json() as { error?: string }).error).toBe('QA_AUTH_ADMIN_REQUIRED');

    const adminCatalog = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/catalog', {}, QA_ADMIN_TOKEN),
      '/api/qa/catalog',
      JSON_HEADERS,
    );
    expect(adminCatalog?.status).toBe(200);
  });
});

test('qa auth disabled escape hatch is explicit and media responses stay same-origin', async () => {
  const previousDisabled = process.env['XLN_QA_AUTH_DISABLED'];
  const previousRead = process.env['XLN_QA_READ_TOKEN'];
  const previousAdmin = process.env['XLN_QA_ADMIN_TOKEN'];
  process.env['XLN_QA_AUTH_DISABLED'] = '1';
  delete process.env['XLN_QA_READ_TOKEN'];
  delete process.env['XLN_QA_ADMIN_TOKEN'];
  try {
    const storiesResponse = await maybeHandleQaRequest(
      new Request('http://127.0.0.1:8080/api/qa/stories?limit=1'),
      '/api/qa/stories',
      JSON_HEADERS,
    );
    expect(storiesResponse?.status).toBe(200);
    const storiesPayload = await storiesResponse!.json() as {
      stories?: Array<{ source?: string; relativePath?: string }>;
    };
    const story = storiesPayload.stories?.[0];
    expect(story?.source).toBeDefined();
    expect(story?.relativePath).toBeDefined();

    const mediaResponse = await maybeHandleQaRequest(
      new Request(`http://127.0.0.1:8080/api/qa/story-image?source=${story!.source}&path=${encodeURIComponent(story!.relativePath!)}`),
      '/api/qa/story-image',
      JSON_HEADERS,
    );
    expect(mediaResponse?.status).toBe(200);
    expect(mediaResponse?.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(mediaResponse?.headers.get('X-Content-Type-Options')).toBe('nosniff');
  } finally {
    if (previousDisabled === undefined) delete process.env['XLN_QA_AUTH_DISABLED'];
    else process.env['XLN_QA_AUTH_DISABLED'] = previousDisabled;
    if (previousRead === undefined) delete process.env['XLN_QA_READ_TOKEN'];
    else process.env['XLN_QA_READ_TOKEN'] = previousRead;
    if (previousAdmin === undefined) delete process.env['XLN_QA_ADMIN_TOKEN'];
    else process.env['XLN_QA_ADMIN_TOKEN'] = previousAdmin;
  }
});

test('qa restart env allowlist strips server secrets', () => {
  const restartEnv = buildQaRestartEnv({
    PATH: '/bin',
    HOME: '/tmp/home',
    PW_TEST_HTML_REPORT_OPEN: 'never',
    PLAYWRIGHT_BROWSERS_PATH: '/tmp/pw',
    XLN_QA_ADMIN_TOKEN: 'admin-secret',
    XLN_QA_READ_TOKEN: 'read-secret',
    SECRET_SENTINEL: 'must-not-leak',
    PRIVATE_KEY: 'must-not-leak',
  });
  expect(restartEnv.PATH).toBe('/bin');
  expect(restartEnv.HOME).toBe('/tmp/home');
  expect(restartEnv.PW_TEST_HTML_REPORT_OPEN).toBe('never');
  expect(restartEnv.PLAYWRIGHT_BROWSERS_PATH).toBe('/tmp/pw');
  expect(restartEnv.XLN_QA_ADMIN_TOKEN).toBeUndefined();
  expect(restartEnv.XLN_QA_READ_TOKEN).toBeUndefined();
  expect(restartEnv.SECRET_SENTINEL).toBeUndefined();
  expect(restartEnv.PRIVATE_KEY).toBeUndefined();
});

test('qa restart run requires reason confirm and expected head before spawn', async () => {
  await withQaAuthEnv(async () => {
    const previous = process.env['XLN_QA_RESTART_ALLOWED'];
    process.env['XLN_QA_RESTART_ALLOWED'] = '1';
    try {
      const response = await maybeHandleQaRequest(
        qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=run', {
          method: 'POST',
          body: JSON.stringify({
            target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
            title: 'QA cockpit fixture records playback transcript',
            operatorId: 'operator-test',
            confirm: 'RUN',
            expectedGitHead: 'not-current-head',
          }),
        }, QA_ADMIN_TOKEN),
        '/api/qa/restart',
        JSON_HEADERS,
      );
      expect(response?.status).toBe(400);
      const payload = await response!.json() as { ok?: boolean; error?: string };
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe('QA_RESTART_REASON_REQUIRED');
    } finally {
      if (previous === undefined) delete process.env['XLN_QA_RESTART_ALLOWED'];
      else process.env['XLN_QA_RESTART_ALLOWED'] = previous;
    }
  });
});

test('qa restart audit ledger writes start and finish evidence', () => {
  const auditId = `test-audit-${Date.now()}`;
  const entry: QaRestartAuditEntry = {
    auditId,
    status: 'started',
    actorKeyId: 'actor-test',
    scope: 'admin',
    operatorId: 'operator-test',
    action: 'restart-run',
    target: 'tests/e2e-fixture.spec.ts',
    title: 'fixture',
    reason: 'verify audit trail',
    expectedGitHead: 'expected-head',
    actualGitHead: 'actual-head',
    gitBranch: 'codex/test',
    codeHash: 'code-hash',
    dirty: true,
    startedAt: Date.now(),
    finishedAt: null,
    pid: 123,
    exitCode: null,
    logPath: '.logs/qa-restarts/test.log',
    requestIp: '127.0.0.1',
    userAgent: 'bun-test',
  };
  insertQaRestartAudit(entry);
  finishQaRestartAudit(auditId, 'finished', 17, entry.startedAt + 5);
  const row = listQaRestartAudit(50).find(candidate => candidate.auditId === auditId);
  expect(row).toBeDefined();
  expect(row?.status).toBe('finished');
  expect(row?.exitCode).toBe(17);
  expect(row?.reason).toBe('verify audit trail');
  expect(row?.actorKeyId).toBe('actor-test');
});

test('qa restart run is explicitly disabled without operator flag', async () => {
  await withQaAuthEnv(async () => {
    const previous = process.env['XLN_QA_RESTART_ALLOWED'];
    process.env['XLN_QA_RESTART_ALLOWED'] = '0';
    try {
      const response = await maybeHandleQaRequest(
        qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=run', {
          method: 'POST',
          body: JSON.stringify({
            target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
            title: 'QA cockpit fixture records playback transcript',
          }),
        }, QA_ADMIN_TOKEN),
        '/api/qa/restart',
        JSON_HEADERS,
      );
      expect(response?.status).toBe(403);
      const payload = await response!.json() as { ok?: boolean; error?: string };
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe('QA_RESTART_DISABLED');
    } finally {
      if (previous === undefined) {
        delete process.env['XLN_QA_RESTART_ALLOWED'];
      } else {
        process.env['XLN_QA_RESTART_ALLOWED'] = previous;
      }
    }
  });
});

test('qa run report preserves timeline order and derives slow steps', async () => {
  const runId = '20000101-000000-123';
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  await rm(runDir, { recursive: true, force: true });
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'manifest.json'),
      `${JSON.stringify({
        manifestVersion: 2,
        runId,
        createdAt: Date.UTC(2000, 0, 1),
        completedAt: Date.UTC(2000, 0, 1, 0, 0, 1),
        status: 'passed',
        totalMs: 1000,
        totalShards: 1,
        passedShards: 1,
        failedShards: 0,
        args: null,
        shards: [
          {
            shard: 0,
            status: 'passed',
            durationMs: 1000,
            handle: null,
            description: null,
            target: 'tests/e2e-qa-cockpit.spec.ts',
            title: 'QA cockpit fixture',
            requireMarketMaker: false,
            logRelativePath: 'e2e-shard-00.log',
            logTail: null,
            error: null,
            phaseMs: null,
            browserIssues: [
              {
                type: 'pageerror',
                severity: 'error',
                message: 'fixture browser error',
                url: 'https://localhost:8080/qa',
                method: null,
                status: null,
                testId: 'chromium :: qa run report fixture',
                timestamp: Date.UTC(2000, 0, 1, 0, 0, 0, 500),
              },
              {
                type: 'http',
                severity: 'warning',
                message: 'HTTP 404',
                url: 'https://localhost:8080/favicon.ico',
                method: 'GET',
                status: 404,
                testId: 'chromium :: qa run report fixture',
                timestamp: Date.UTC(2000, 0, 1, 0, 0, 0, 600),
              },
            ],
            slowSteps: [],
            artifacts: [],
            hasVideo: false,
            hasTrace: false,
          },
        ],
      })}\n`,
    );
    await writeFile(
      join(runDir, 'e2e-shard-00.log'),
      [
        '[E2E-TIMING] first visible cockpit cue 200ms',
        '[MESH-TIMING] hub mesh hydrated 800ms',
        '[E2E-TIMING] subtitle synchronized 400ms',
      ].join('\n'),
    );

    const run = await readQaRun(runId);
    expect(run.shards[0]?.timelineSteps).toEqual([
      { label: 'E2E-TIMING:first visible cockpit cue', ms: 200 },
      { label: 'MESH-TIMING:hub mesh hydrated', ms: 800 },
      { label: 'E2E-TIMING:subtitle synchronized', ms: 400 },
    ]);
    expect(run.shards[0]?.slowSteps).toEqual([
      { label: 'MESH-TIMING:hub mesh hydrated', ms: 800 },
      { label: 'E2E-TIMING:subtitle synchronized', ms: 400 },
      { label: 'E2E-TIMING:first visible cockpit cue', ms: 200 },
    ]);
    expect(run.shards[0]?.browserHealth).toEqual({
      issueCount: 2,
      errorCount: 1,
      warningCount: 1,
      networkFailureCount: 0,
      httpErrorCount: 1,
    });
    expect(run.browserHealth?.errorCount).toBe(1);

    await withQaAuthEnv(async () => {
      const historyResponse = await maybeHandleQaRequest(
        qaRequest('http://127.0.0.1:8080/api/qa/history?limit=500'),
        '/api/qa/history',
        JSON_HEADERS,
      );
      expect(historyResponse?.status).toBe(200);
      const historyPayload = await historyResponse!.json() as {
        ok?: boolean;
        history?: Array<{ runId?: string; browserErrorCount?: number; httpErrorCount?: number }>;
      };
      expect(historyPayload.ok).toBe(true);
      const row = historyPayload.history?.find((item) => item.runId === runId);
      expect(row?.browserErrorCount).toBe(1);
      expect(row?.httpErrorCount).toBe(1);
    });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('qa retention purge deletes only runs older than the cutoff', async () => {
  const oldRunId = '19990101-000000-777';
  const recentRunId = '19990201-000000-888';
  const oldRunDir = resolve(process.cwd(), '.logs', 'e2e-parallel', oldRunId);
  const recentRunDir = resolve(process.cwd(), '.logs', 'e2e-parallel', recentRunId);
  await rm(oldRunDir, { recursive: true, force: true });
  await rm(recentRunDir, { recursive: true, force: true });
  try {
    await mkdir(oldRunDir, { recursive: true });
    await mkdir(recentRunDir, { recursive: true });
    const oldRun: QaRunManifest = {
      ...benchmarkRun(oldRunId, 1000, 800),
      runId: oldRunId,
      createdAt: Date.UTC(1999, 0, 1),
      completedAt: Date.UTC(1999, 0, 1, 0, 0, 1),
    };
    const recentRun: QaRunManifest = {
      ...benchmarkRun(recentRunId, 1000, 800),
      runId: recentRunId,
      createdAt: Date.UTC(1999, 1, 1),
      completedAt: Date.UTC(1999, 1, 1, 0, 0, 1),
    };
    recordQaRunHistory(oldRun, oldRunDir);
    recordQaRunHistory(recentRun, recentRunDir);

    const result = purgeQaRunsOlderThan(30, Date.UTC(1999, 1, 15));
    expect(result.retentionDays).toBe(30);
    expect(result.deletedRunIds).toContain(oldRunId);
    expect(result.deletedRunIds).not.toContain(recentRunId);
    expect(result.deletedHistoryRows).toBeGreaterThanOrEqual(1);
    expect(existsSync(oldRunDir)).toBe(false);
    expect(existsSync(recentRunDir)).toBe(true);
  } finally {
    purgeQaRunsOlderThan(30, Date.UTC(1999, 3, 15));
    await rm(oldRunDir, { recursive: true, force: true });
    await rm(recentRunDir, { recursive: true, force: true });
  }
});
