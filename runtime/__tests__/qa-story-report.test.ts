import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  classifyQaShardFailure,
  compareQaBenchmarkRuns,
  formatQaRunIdUtc,
  QA_HISTORY_DB_PATH,
  listQaStoryScreenshots,
  purgeQaRunsOlderThan,
  readQaRun,
  redactQaSecretText,
  recordQaRunHistory,
  resolveQaArtifactPath,
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

const deleteQaHistoryRows = (runIds: string[]): void => {
  if (runIds.length === 0) return;
  if (!existsSync(QA_HISTORY_DB_PATH)) return;
  const db = new Database(QA_HISTORY_DB_PATH);
  try {
    const hasTable = db.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'qa_runs'
      LIMIT 1
    `).get();
    if (!hasTable) return;
    for (const runId of runIds) {
      db.query(`DELETE FROM qa_runs WHERE run_id = $runId`).run({ $runId: runId });
    }
  } finally {
    db.close();
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
    failureClass: null,
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

  const higherHostLoadOnly = compareQaBenchmarkRuns(benchmarkRun('higher-host-load', 1000, 800, 'same-code', 'same-head', 3), baseline);
  expect(higherHostLoadOnly.status).toBe('ok');
  expect(higherHostLoadOnly.metrics.find(metric => metric.metric === 'peakLoad1')?.verdict).toBe('slower');
  expect(higherHostLoadOnly.reason).toContain('host load');
  expect(higherHostLoadOnly.likelyCauses).toContain('host load increased without app timing regression');
});

test('qa run id formatter uses UTC fields', () => {
  expect(formatQaRunIdUtc(Date.UTC(2026, 5, 23, 0, 1, 2, 3))).toBe('20260623-000102-003');
  expect(formatQaRunIdUtc(Date.UTC(2026, 5, 23, 23, 59, 59, 999))).toBe('20260623-235959-999');
});

test('qa shard failure classifier maps operator failure classes', () => {
  expect(classifyQaShardFailure({
    status: 'failed',
    error: 'Timeout 5000ms exceeded',
  })).toBe('timeout');
  expect(classifyQaShardFailure({
    status: 'failed',
    logTail: 'Expected: 1\nReceived: 2',
  })).toBe('assertion');
  expect(classifyQaShardFailure({
    status: 'failed',
    browserIssues: [{
      type: 'http',
      severity: 'error',
      message: 'HTTP 502 from runtime API',
      url: 'http://127.0.0.1:8080/health',
      method: 'GET',
      status: 502,
      testId: 'health',
      timestamp: Date.UTC(2026, 5, 23),
    }],
  })).toBe('infra');
  expect(classifyQaShardFailure({
    status: 'passed',
    logTail: 'Timeout 5000ms exceeded',
  })).toBeNull();
});

test('qa stories catalog indexes real e2e screenshots', async () => {
  const stories = await listQaStoryScreenshots(20);
  const e2eStory = stories.find(story => story.source === 'e2e-screenshots');

  expect(e2eStory).toBeDefined();
  expect(e2eStory?.url.startsWith('/api/qa/story-image?')).toBe(true);
  expect(e2eStory?.relativePath.includes('..')).toBe(false);
  expect(e2eStory?.sizeBytes ?? 0).toBeGreaterThan(0);
});

test('qa curated ux gallery covers core operator surfaces', async () => {
  const stories = await listQaStoryScreenshots(120);
  const curated = stories.filter(story => story.curated);
  const platforms = new Set(curated.map(story => story.platform));
  const groups = new Set(curated.map(story => story.group));

  expect(curated.length).toBeGreaterThanOrEqual(20);
  expect(platforms.has('desktop')).toBe(true);
  expect(platforms.has('mobile')).toBe(true);
  for (const group of ['Payments', 'Swap', 'On-chain Batch', 'Disputes', 'History']) {
    expect(groups.has(group), `missing curated UX group ${group}`).toBe(true);
  }
});

test('qa story image resolver rejects path traversal', async () => {
  await expect(resolveQaStoryScreenshotPath('e2e-screenshots', '../package.json')).rejects.toThrow(
    'INVALID_QA_STORY_IMAGE_PATH',
  );
});

test('qa artifact resolver rejects symlink escape from run directory', async () => {
  const runId = '20000101-000002-125';
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  const outsideDir = resolve(process.cwd(), '.logs', 'qa-artifact-symlink-fixture');
  const outsideFile = join(outsideDir, 'secret.txt');
  const linkPath = join(runDir, 'linked-secret.txt');
  await rm(runDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
  try {
    await expect(resolveQaArtifactPath(runId, '../package.json')).rejects.toThrow(
      'INVALID_QA_ARTIFACT_PATH',
    );
    await mkdir(runDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(outsideFile, 'secret-bearing artifact must not escape run root\n');
    await symlink(outsideFile, linkPath);

    await expect(resolveQaArtifactPath(runId, 'linked-secret.txt')).rejects.toThrow(
      'INVALID_QA_ARTIFACT_PATH',
    );
  } finally {
    await rm(runDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('qa secret redactor masks runtime tokens and labeled secrets', () => {
  const raw = [
    'Authorization: Bearer bearer-secret-123456789',
    'x-xln-qa-token: qa-secret-token-123456',
    'remote=xlnra1.remote-secret-token',
    'link=/wallet?runtime-import=encoded-secret&readToken=read-secret',
    'rpc=https://user:password@example.invalid/rpc',
    'PRIVATE_KEY=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'mnemonic="abandon abandon abandon secret"',
    '{"adminToken":"json-admin-token-123456"}',
  ].join('\n');
  const redacted = redactQaSecretText(raw);

  for (const secret of [
    'bearer-secret-123456789',
    'qa-secret-token-123456',
    'remote-secret-token',
    'encoded-secret',
    'read-secret',
    'user:password',
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'abandon abandon abandon secret',
    'json-admin-token-123456',
  ]) {
    expect(redacted).not.toContain(secret);
  }
  expect(redacted).toContain('[REDACTED]');
});

test('qa run and text artifact surfaces redact stored secrets', async () => {
  const runId = '20000101-000002-126';
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  const secretLog = [
    'Expected wallet import to fail',
    'Authorization: Bearer bearer-secret-123456789',
    'remote=xlnra1.remote-secret-token',
    'link=/wallet?runtime-import=encoded-secret&readToken=read-secret',
    'PRIVATE_KEY=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ].join('\n');
  const manifest = benchmarkRun(runId, 1000, 800);
  const shard = {
    ...manifest.shards[0],
    shard: 1,
    status: 'failed' as const,
    logRelativePath: 'e2e-shard-01.log',
    logTail: secretLog,
    error: secretLog,
    artifacts: [{
      name: 'secret.log',
      relativePath: 'secret.log',
      sizeBytes: secretLog.length,
      kind: 'text' as const,
      contentType: 'text/plain; charset=utf-8',
    }],
  };

  await rm(runDir, { recursive: true, force: true });
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'e2e-shard-01.log'), secretLog);
    await writeFile(join(runDir, 'secret.log'), secretLog);
    await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify({
      ...manifest,
      status: 'failed',
      totalShards: 1,
      passedShards: 0,
      failedShards: 1,
      shards: [shard],
    })}\n`);

    const run = await readQaRun(runId);
    const runSurface = `${run.shards[0].logTail}\n${run.shards[0].error}`;
    expect(runSurface).toContain('[REDACTED]');
    expect(runSurface).not.toContain('bearer-secret-123456789');
    expect(runSurface).not.toContain('remote-secret-token');
    expect(runSurface).not.toContain('encoded-secret');
    expect(runSurface).not.toContain('read-secret');
    expect(runSurface).not.toContain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    await withQaAuthEnv(async () => {
      const response = await maybeHandleQaRequest(
        qaRequest(`http://127.0.0.1:8080/api/qa/artifact?runId=${runId}&path=secret.log`),
        '/api/qa/artifact',
        JSON_HEADERS,
      );
      expect(response?.status).toBe(200);
      const artifactText = await response!.text();
      expect(artifactText).toContain('[REDACTED]');
      expect(artifactText).not.toContain('bearer-secret-123456789');
      expect(artifactText).not.toContain('remote-secret-token');
      expect(artifactText).not.toContain('encoded-secret');
      expect(artifactText).not.toContain('read-secret');
      expect(artifactText).not.toContain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
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

test('qa restart plan rejects invalid mode and unsafe targets', async () => {
  await withQaAuthEnv(async () => {
    const invalidMode = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=bogus', {
        method: 'POST',
        body: JSON.stringify({
          target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
          title: 'QA cockpit fixture records playback transcript',
        }),
      }, QA_ADMIN_TOKEN),
      '/api/qa/restart',
      JSON_HEADERS,
    );
    expect(invalidMode?.status).toBe(400);
    expect((await invalidMode!.json() as { error?: string }).error).toBe('QA_RESTART_MODE_INVALID');

    const unsafeTargets = [
      ['traversal', 'tests/../runtime/secret.spec.ts', 'INVALID_QA_RESTART_TARGET'],
      ['null-byte', 'tests/e2e-safe.spec.ts\0', 'INVALID_QA_RESTART_TARGET'],
      ['self-target', 'tests/e2e-qa-cockpit.spec.ts', 'QA_RESTART_SELF_TARGET_DENIED'],
    ] as const;

    for (const [, target, expectedError] of unsafeTargets) {
      const response = await maybeHandleQaRequest(
        qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=plan', {
          method: 'POST',
          body: JSON.stringify({
            target,
            title: 'Unsafe restart target fixture',
          }),
        }, QA_ADMIN_TOKEN),
        '/api/qa/restart',
        JSON_HEADERS,
      );
      expect(response?.status).toBe(400);
      expect((await response!.json() as { error?: string }).error).toBe(expectedError);
    }
  });
});

test('qa read endpoints support ETag revalidation', async () => {
  await withQaAuthEnv(async () => {
    const first = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/catalog'),
      '/api/qa/catalog',
      JSON_HEADERS,
    );
    expect(first?.status).toBe(200);
    const etag = first?.headers.get('etag');
    expect(etag).toMatch(/^"qa-[a-f0-9]+"/);
    expect(first?.headers.get('cache-control')).toBe('private, no-cache');
    const firstPayload = await first!.json() as { ok?: boolean; catalog?: unknown[] };
    expect(firstPayload.ok).toBe(true);

    const second = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/catalog', {
        headers: { 'if-none-match': etag || '' },
      }),
      '/api/qa/catalog',
      JSON_HEADERS,
    );
    expect(second?.status).toBe(304);
    expect(second?.headers.get('etag')).toBe(etag);
    expect(await second!.text()).toBe('');
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
        '[E2E-CUE] subtitle synchronized start=1200ms end=1600ms duration=400ms',
      ].join('\n'),
    );

    const run = await readQaRun(runId);
    expect(run.shards[0]?.timelineSteps).toEqual([
      { label: 'E2E-TIMING:first visible cockpit cue', ms: 200 },
      { label: 'MESH-TIMING:hub mesh hydrated', ms: 800 },
      { label: 'E2E-TIMING:subtitle synchronized', ms: 400, startMs: 1200, endMs: 1600 },
    ]);
    expect(run.shards[0]?.slowSteps).toEqual([
      { label: 'MESH-TIMING:hub mesh hydrated', ms: 800 },
      { label: 'E2E-TIMING:subtitle synchronized', ms: 400, startMs: 1200, endMs: 1600 },
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
    recordQaRunHistory(run, runDir);

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

test('readQaRun trusts complete manifest without opening shard logs', async () => {
  const runId = '20260623-000125-779';
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  await rm(runDir, { recursive: true, force: true });
  try {
    await mkdir(runDir, { recursive: true });
    await mkdir(join(runDir, 'e2e-shard-00.log'));
    const storedStep = { label: 'stored manifest cue', ms: 321 };
    const base = benchmarkRun(runId, 1234, 900);
    const manifest: QaRunManifest = {
      ...base,
      shards: [{
        ...base.shards[0]!,
        logRelativePath: 'e2e-shard-00.log',
        logTail: 'stored manifest tail',
        timelineSteps: [storedStep],
        slowSteps: [storedStep],
      }],
    };
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const run = await readQaRun(runId);
    expect(run.shards[0]?.logTail).toBe('stored manifest tail');
    expect(run.shards[0]?.timelineSteps).toEqual([storedStep]);
    expect(run.shards[0]?.slowSteps).toEqual([storedStep]);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('qa runs endpoint reads SQLite summaries without requiring run logs', async () => {
  const createdAt = Date.now() - 2_000;
  const runId = formatQaRunIdUtc(createdAt);
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  await rm(runDir, { recursive: true, force: true });
  deleteQaHistoryRows([runId]);
  try {
    const base = benchmarkRun(runId, 2345, 1200);
    const run: QaRunManifest = {
      ...base,
      createdAt,
      completedAt: createdAt + 2345,
      status: 'failed',
      passedShards: 0,
      failedShards: 1,
      failureClasses: ['assertion'],
      shards: [{
        ...base.shards[0]!,
        status: 'failed',
        error: 'Expected canonical ledger failure',
        failureClass: 'assertion',
        logRelativePath: 'e2e-shard-00.log',
        logTail: 'stored summary tail',
        timelineSteps: [{ label: 'stored summary cue', ms: 111 }],
        slowSteps: [{ label: 'stored summary cue', ms: 111 }],
      }],
    };
    recordQaRunHistory(run, runDir);
    await rm(runDir, { recursive: true, force: true });

    await withQaAuthEnv(async () => {
      const response = await maybeHandleQaRequest(
        qaRequest('http://127.0.0.1:8080/api/qa/runs?limit=50'),
        '/api/qa/runs',
        JSON_HEADERS,
      );
      expect(response?.status).toBe(200);
      const payload = await response!.json() as {
        ok?: boolean;
        runs?: Array<{ runId?: string; status?: string; failingTargets?: string[]; timing?: { playwrightMs?: number | null } }>;
      };
      expect(payload.ok).toBe(true);
      const summary = payload.runs?.find(item => item.runId === runId);
      expect(summary?.status).toBe('failed');
      expect(summary?.failingTargets).toEqual(['qa cockpit']);
      expect(summary?.timing?.playwrightMs).toBe(1200);
    });
  } finally {
    deleteQaHistoryRows([runId]);
    await rm(runDir, { recursive: true, force: true });
  }
});

test('qa run endpoint strips perf samples and exposes raw timeseries separately', async () => {
  const runId = '20260623-000124-778';
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  const sample = {
    ts: Date.UTC(2026, 5, 23, 0, 1, 24),
    load1: 1.5,
    load5: 1.25,
    load15: 1.1,
    freeMemBytes: 900_000_000,
    totalMemBytes: 2_000_000_000,
    runnerRssBytes: 240_000_000,
    children: [{
      name: 'playwright',
      pid: 4242,
      cpuPct: 37,
      memPct: 3,
      rssKb: 512_000,
    }],
  };
  const run: QaRunManifest = benchmarkRun(runId, 900, 700, 'perf-samples-code', 'perf-samples-head');
  run.perf = {
    ...run.perf!,
    sampleCount: 1,
    samples: [sample],
  };
  run.shards[0] = {
    ...run.shards[0]!,
    perf: {
      ...run.perf,
      samples: [sample],
    },
  };

  await rm(runDir, { recursive: true, force: true });
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(run)}\n`);

    await withQaAuthEnv(async () => {
      const runResponse = await maybeHandleQaRequest(
        qaRequest(`http://127.0.0.1:8080/api/qa/run?runId=${runId}`),
        '/api/qa/run',
        JSON_HEADERS,
      );
      expect(runResponse?.status).toBe(200);
      const runPayload = await runResponse!.json() as {
        ok?: boolean;
        run?: {
          perf?: { sampleCount?: number; samples?: unknown[] };
          shards?: Array<{ perf?: { sampleCount?: number; samples?: unknown[] } }>;
        };
      };
      expect(runPayload.ok).toBe(true);
      expect(runPayload.run?.perf?.sampleCount).toBe(1);
      expect(runPayload.run?.perf?.samples).toBeUndefined();
      expect(runPayload.run?.shards?.[0]?.perf?.sampleCount).toBe(1);
      expect(runPayload.run?.shards?.[0]?.perf?.samples).toBeUndefined();

      const perfResponse = await maybeHandleQaRequest(
        qaRequest(`http://127.0.0.1:8080/api/qa/run/perf?runId=${runId}`),
        '/api/qa/run/perf',
        JSON_HEADERS,
      );
      expect(perfResponse?.status).toBe(200);
      const perfPayload = await perfResponse!.json() as {
        ok?: boolean;
        perf?: { sampleCount?: number; samples?: unknown[] };
        samples?: unknown[];
        shards?: Array<{ perf?: { sampleCount?: number; samples?: unknown[] }; samples?: unknown[] }>;
      };
      expect(perfPayload.ok).toBe(true);
      expect(perfPayload.perf?.sampleCount).toBe(1);
      expect(perfPayload.perf?.samples).toBeUndefined();
      expect(perfPayload.samples).toHaveLength(1);
      expect(perfPayload.shards?.[0]?.perf?.sampleCount).toBe(1);
      expect(perfPayload.shards?.[0]?.perf?.samples).toBeUndefined();
      expect(perfPayload.shards?.[0]?.samples).toHaveLength(1);
    });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('qa history endpoint reads only sqlite and does not backfill manifests on poll', async () => {
  const runId = '20260623-000123-777';
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  await rm(runDir, { recursive: true, force: true });
  deleteQaHistoryRows([runId]);
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'manifest.json'),
      `${JSON.stringify({
        ...benchmarkRun(runId, 900, 700, 'history-hot-path-code', 'history-hot-path-head'),
        createdAt: Date.UTC(2026, 5, 23, 0, 1, 23),
        completedAt: Date.UTC(2026, 5, 23, 0, 1, 24),
      })}\n`,
    );

    await withQaAuthEnv(async () => {
      const historyResponse = await maybeHandleQaRequest(
        qaRequest('http://127.0.0.1:8080/api/qa/history?limit=500'),
        '/api/qa/history',
        JSON_HEADERS,
      );
      expect(historyResponse?.status).toBe(200);
      const historyPayload = await historyResponse!.json() as {
        ok?: boolean;
        history?: Array<{ runId?: string }>;
      };
      expect(historyPayload.ok).toBe(true);
      expect(historyPayload.history?.some((item) => item.runId === runId)).toBe(false);

      const backfillResponse = await maybeHandleQaRequest(
        qaRequest('http://127.0.0.1:8080/api/qa/history/backfill', {
          method: 'POST',
          body: JSON.stringify({ confirm: 'BACKFILL_QA_HISTORY', limit: 500 }),
        }, QA_ADMIN_TOKEN),
        '/api/qa/history/backfill',
        JSON_HEADERS,
      );
      expect(backfillResponse?.status).toBe(200);
      const backfillPayload = await backfillResponse!.json() as {
        ok?: boolean;
        result?: { recordedRuns?: number; failedRuns?: unknown[] };
      };
      expect(backfillPayload.ok).toBe(true);
      expect(backfillPayload.result?.recordedRuns).toBeGreaterThan(0);
      expect(backfillPayload.result?.failedRuns).toEqual([]);

      const refreshedResponse = await maybeHandleQaRequest(
        qaRequest('http://127.0.0.1:8080/api/qa/history?limit=500'),
        '/api/qa/history',
        JSON_HEADERS,
      );
      expect(refreshedResponse?.status).toBe(200);
      const refreshedPayload = await refreshedResponse!.json() as {
        ok?: boolean;
        history?: Array<{ runId?: string }>;
      };
      expect(refreshedPayload.ok).toBe(true);
      expect(refreshedPayload.history?.some((item) => item.runId === runId)).toBe(true);
    });
  } finally {
    deleteQaHistoryRows([runId]);
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
