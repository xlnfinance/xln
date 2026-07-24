import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  buildQaRestartEnv,
  finishQaRestartAudit,
  insertQaRestartAudit,
  listQaRestartAudit,
  maybeHandleQaRequest,
  type QaRestartAuditRecord,
} from '../qa/api';
import {
  QA_UX_RELEASE_PACK_MIN_SCREENS,
  QA_UX_RELEASE_REQUIRED_GROUPS,
  applyQaRunSeverity,
  assertQaReleaseRunSeverity,
  auditQaUxReleasePack,
  buildQaPhaseWaterfall,
  buildQaRegressionReport,
  buildQaRunLedger,
  buildQaSystemVerdict,
  assertQaRunCandidateBinding,
  classifyQaArtifactSensitivity,
  classifyQaShardFailure,
  compareQaBenchmarkRuns,
  formatQaRunIdUtc,
  QA_HISTORY_DB_PATH,
  QA_RUN_MANIFEST_VERSION,
  listQaStoryScreenshots,
  purgeQaRunsOlderThan,
  readQaRun,
  redactQaSecretText,
  recordQaRunHistory,
  resolveQaArtifactPath,
  resolveQaStoryScreenshotPath,
  summarizeQaRun,
  type QaRunManifest,
} from '../qa/report';
import { buildQaCandidateIdentity } from '../qa/candidate';

const QA_ADMIN_TOKEN = 'qa-admin-test-token';
const JSON_HEADERS = { 'content-type': 'application/json' };

const TEST_RESTART_FINGERPRINT = {
  gitHead: 'test-head',
  gitBranch: 'main',
  gitStatus: '',
  dirty: false,
  codeHash: 'test-code-hash',
  computedAt: Date.UTC(2026, 5, 23),
  trackedFileCount: 1,
  trackedBytes: 1,
};

const qaRequest = (url: string, init: RequestInit = {}, token = ''): Request => {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request(url, { ...init, headers });
};

const withQaAuthEnv = async <T>(work: () => Promise<T>): Promise<T> => {
  const previousAdmin = process.env['XLN_QA_ADMIN_TOKEN'];
  const previousDisabled = process.env['XLN_QA_AUTH_DISABLED'];
  process.env['XLN_QA_ADMIN_TOKEN'] = QA_ADMIN_TOKEN;
  delete process.env['XLN_QA_AUTH_DISABLED'];
  try {
    return await work();
  } finally {
    if (previousAdmin === undefined) delete process.env['XLN_QA_ADMIN_TOKEN'];
    else process.env['XLN_QA_ADMIN_TOKEN'] = previousAdmin;
    if (previousDisabled === undefined) delete process.env['XLN_QA_AUTH_DISABLED'];
    else process.env['XLN_QA_AUTH_DISABLED'] = previousDisabled;
  }
};

const withQaRestartEnv = async <T>(work: () => Promise<T>): Promise<T> => {
  const previousAllowed = process.env['XLN_QA_RESTART_ALLOWED'];
  const previousCooldown = process.env['XLN_QA_RESTART_COOLDOWN_MS'];
  const previousWatchdog = process.env['XLN_QA_RESTART_WATCHDOG_MS'];
  const previousGrace = process.env['XLN_QA_RESTART_KILL_GRACE_MS'];
  process.env['XLN_QA_RESTART_ALLOWED'] = '1';
  process.env['XLN_QA_RESTART_COOLDOWN_MS'] = '0';
  process.env['XLN_QA_RESTART_WATCHDOG_MS'] = '300000';
  process.env['XLN_QA_RESTART_KILL_GRACE_MS'] = '500';
  try {
    return await work();
  } finally {
    if (previousAllowed === undefined) delete process.env['XLN_QA_RESTART_ALLOWED'];
    else process.env['XLN_QA_RESTART_ALLOWED'] = previousAllowed;
    if (previousCooldown === undefined) delete process.env['XLN_QA_RESTART_COOLDOWN_MS'];
    else process.env['XLN_QA_RESTART_COOLDOWN_MS'] = previousCooldown;
    if (previousWatchdog === undefined) delete process.env['XLN_QA_RESTART_WATCHDOG_MS'];
    else process.env['XLN_QA_RESTART_WATCHDOG_MS'] = previousWatchdog;
    if (previousGrace === undefined) delete process.env['XLN_QA_RESTART_KILL_GRACE_MS'];
    else process.env['XLN_QA_RESTART_KILL_GRACE_MS'] = previousGrace;
  }
};

const restartRunBody = (): Record<string, unknown> => ({
  target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
  title: 'QA cockpit fixture records playback transcript',
  operatorId: 'operator-test',
  reason: 'verify restart control plane',
  confirm: 'RUN',
  expectedGitHead: TEST_RESTART_FINGERPRINT.gitHead,
});

const spawnSleeperRestart = (): ChildProcess => spawnChild('bun', [
  '-e',
  'process.on("SIGTERM",()=>process.exit(0)); setTimeout(()=>{}, 60000);',
], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
});

const spawnImmediateRestart = (): ChildProcess => spawnChild('bun', ['-e', 'process.exit(0);'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
});

const waitForRestartInactive = async (): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/restart', {}, QA_ADMIN_TOKEN),
      '/api/qa/restart',
      JSON_HEADERS,
    );
    const payload = await response!.json() as { restart?: { active?: boolean } };
    if (payload.restart?.active === false) return;
    await Bun.sleep(50);
  }
  throw new Error('QA_RESTART_TEST_ACTIVE_TIMEOUT');
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
): QaRunManifest => applyQaRunSeverity({
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
    scenario: null,
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
} as QaRunManifest);

const asCurrentQaRun = (run: QaRunManifest): QaRunManifest => {
  const gitHead = createHash('sha1').update(String(run.code?.gitHead ?? run.runId)).digest('hex');
  const codeHash = createHash('sha256').update(String(run.code?.codeHash ?? run.runId)).digest('hex');
  const gateConfig = { schemaVersion: 1, fixtureRunId: run.runId };
  const candidate = buildQaCandidateIdentity({ gitHead, codeHash, gateConfig });
  return applyQaRunSeverity({
    ...run,
    manifestVersion: QA_RUN_MANIFEST_VERSION,
    candidate,
    gateConfig,
    code: {
      ...run.code!,
      gitHead,
      codeHash,
    },
    shards: run.shards.map(shard => ({
      ...shard,
      candidateId: candidate.candidateId,
      gateConfigHash: candidate.gateConfigHash,
    })),
  });
};

test('qa severity never reports a fail-fast cancelled shard as passed', () => {
  const passed = benchmarkRun('cancelled-shard', 1_000, 800);
  const normalizedShard = passed.shards[0];
  if (!normalizedShard) throw new Error('TEST_QA_SHARD_REQUIRED');
  const {
    severity: _severity,
    reason: _reason,
    since: _since,
    owner: _owner,
    evidence: _evidence,
    ...rawShard
  } = normalizedShard;
  const cancelled = applyQaRunSeverity({
    ...passed,
    status: 'unknown',
    passedShards: 0,
    shards: [{ ...rawShard, status: 'cancelled' }],
  });

  expect(cancelled.shards[0]?.severity).toBe('UNKNOWN');
  expect(cancelled.shards[0]?.reason).toContain('cancelled after another shard failed');
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

test('qa phase waterfall keeps stable phase labels and flags budget breach', () => {
  const waterfall = buildQaPhaseWaterfall({
    preflight: 100,
    anvilBoot: 200,
    apiBoot: 300,
    apiHealthy: 400,
    viteBoot: 500,
    playwright: 5_700,
  });

  expect(waterfall?.totalMs).toBe(7_200);
  expect(waterfall?.segments.map(segment => segment.label)).toEqual([
    'preflight',
    'anvil',
    'api boot',
    'health',
    'vite',
    'playwright',
  ]);
  expect(waterfall?.segments.find(segment => segment.key === 'playwright')).toMatchObject({
    ms: 5_700,
    limitMs: 5_000,
    limitKind: 'budget',
    overLimit: true,
  });
  expect(waterfall?.segments.find(segment => segment.key === 'playwright')?.pct).toBe(79.17);
  expect(waterfall?.overLimitCount).toBe(1);
});

test('qa run summary extracts fatal runtime marker lines per shard', () => {
  const run = benchmarkRun('fatal-marker-run', 1_000, 800);
  const fatalRun = applyQaRunSeverity({
    ...run,
    status: 'failed',
    passedShards: 0,
    failedShards: 1,
    shards: run.shards.map(shard => ({
      ...shard,
      status: 'failed',
      error: null,
      logTail: [
        'normal setup line',
        'E2E_FATAL_RUNTIME_LOG runtime crashed privateKey=0xabc123',
        'ignored trailing line',
      ].join('\n'),
      failureClass: null,
    })),
  });
  const summary = summarizeQaRun(fatalRun);

  expect(summary.failureClasses).toContain('crash');
  expect(summary.fatalMarkers).toHaveLength(1);
  expect(summary.fatalMarkers[0]).toMatchObject({
    shard: 0,
    handle: 'qa cockpit',
    failureClass: 'crash',
    source: 'logTail',
  });
  expect(summary.fatalMarkers[0]?.line).toContain('E2E_FATAL_RUNTIME_LOG runtime crashed');
  expect(summary.fatalMarkers[0]?.line).toContain('privateKey=[REDACTED]');
});

test('qa regression report compares latest run against previous same code head and last green main', () => {
  const at = (minute: number): number => Date.UTC(2026, 5, 23, 0, minute, 0);
  const make = (
    runId: string,
    minute: number,
    totalMs: number,
    playwrightMs: number,
    codeHash: string,
    gitHead: string,
    gitBranch = 'main',
    status: QaRunManifest['status'] = 'passed',
  ): QaRunManifest => {
    const base = benchmarkRun(runId, totalMs, playwrightMs, codeHash, gitHead);
    return applyQaRunSeverity({
      ...base,
      createdAt: at(minute),
      completedAt: at(minute) + totalMs,
      status,
      passedShards: status === 'passed' ? 1 : 0,
      failedShards: status === 'failed' ? 1 : 0,
      code: {
        ...base.code!,
        gitBranch,
      },
      shards: base.shards.map(shard => ({
        ...shard,
        status,
        error: status === 'failed' ? 'Expected regression fixture failure' : null,
        failureClass: status === 'failed' ? 'assertion' : null,
      })),
    });
  };
  const latest = make('latest-regression', 50, 1500, 1200, 'new-code', 'new-head', 'feature', 'failed');
  const previous = make('previous-regression', 40, 1000, 800, 'old-code', 'old-head', 'feature');
  const sameCode = make('same-code-regression', 30, 1100, 820, 'new-code', 'older-head', 'feature');
  const sameHead = make('same-head-regression', 20, 1050, 790, 'other-code', 'new-head', 'feature');
  const greenMain = make('green-main-regression', 10, 900, 720, 'green-code', 'green-head', 'main');
  const report = buildQaRegressionReport([
    latest,
    previous,
    sameCode,
    sameHead,
    greenMain,
  ].map(summarizeQaRun));

  expect(report.status).toBe('failed');
  expect(report.severity).toBe('FAIL');
  expect(report.latestRunId).toBe('latest-regression');
  expect(report.reason).toContain('New failing target');
  expect(report.comparisons.map(item => item.kind)).toEqual([
    'previous',
    'same-code-hash',
    'same-git-head',
    'last-green-main',
  ]);
  const previousComparison = report.comparisons.find(item => item.kind === 'previous');
  expect(previousComparison?.comparedRunId).toBe('previous-regression');
  expect(previousComparison?.status).toBe('failed');
  expect(previousComparison?.metrics.find(metric => metric.metric === 'totalMs')?.deltaPct).toBe(50);
  expect(previousComparison?.newFailingTargets).toEqual(['qa cockpit']);
  expect(report.comparisons.find(item => item.kind === 'same-code-hash')?.comparedRunId).toBe('same-code-regression');
  expect(report.comparisons.find(item => item.kind === 'same-git-head')?.comparedRunId).toBe('same-head-regression');
  expect(report.comparisons.find(item => item.kind === 'last-green-main')?.comparedRunId).toBe('green-main-regression');
});

test('qa severity model normalizes legacy runs and gates release manifests', () => {
  const legacy = benchmarkRun('severity-legacy', 1000, 800);
  expect(legacy.severity).toBe('OK');
  expect(legacy.reason).toBe('QA run is green');
  expect(legacy.shards[0]?.severity).toBe('OK');
  expect(legacy.browserHealth?.severity).toBe('OK');

  const degraded = compareQaBenchmarkRuns(benchmarkRun('severity-slower', 1300, 1100), legacy);
  expect(degraded.severity).toBe('DEGRADED');
  expect(degraded.reason).toContain('% vs severity-legacy');

  const missingSeverity = { ...legacy, manifestVersion: 3 } as Record<string, unknown>;
  delete missingSeverity['severity'];
  expect(() => assertQaReleaseRunSeverity(missingSeverity as QaRunManifest)).toThrow('QA_RUN_SEVERITY_REQUIRED');

  const missingReason = { ...legacy, manifestVersion: 3 } as Record<string, unknown>;
  delete missingReason['reason'];
  expect(() => assertQaReleaseRunSeverity(missingReason as QaRunManifest)).toThrow('QA_RUN_REASON_REQUIRED');

  const current = asCurrentQaRun(benchmarkRun('candidate-bound', 1000, 800));
  expect(() => assertQaRunCandidateBinding(current)).not.toThrow();
  expect(() => assertQaRunCandidateBinding({
    ...current,
    shards: [{ ...current.shards[0]!, candidateId: '0'.repeat(64) }],
  })).toThrow('QA_SHARD_CANDIDATE_MISMATCH');
});

test('qa system verdict is schema-backed by latest run severity', () => {
  const now = Date.UTC(2026, 5, 24);
  const empty = buildQaSystemVerdict([], now);
  expect(empty.status).toBe('UNKNOWN');
  expect(empty.activeCount).toBe(0);
  expect(empty.reason).toBe('No QA runs yet');

  const baseline = benchmarkRun('20260623-215959-999', 1000, 800);
  const failedCurrent = asCurrentQaRun(
    benchmarkRun('20260623-225959-999', 1300, 1100, 'new-code', 'new-head'),
  );
  const failedRun = applyQaRunSeverity({
    ...failedCurrent,
    status: 'failed',
    passedShards: 0,
    failedShards: 1,
    benchmark: compareQaBenchmarkRuns(failedCurrent, baseline),
    browserHealth: {
      severity: 'FAIL',
      reason: '1 browser error(s) captured',
      since: Date.UTC(2026, 5, 23),
      owner: 'browser',
      evidence: [{ label: 'errors', value: 1 }],
      issueCount: 1,
      errorCount: 1,
      warningCount: 0,
      networkFailureCount: 0,
      httpErrorCount: 0,
    },
    shards: [{
      ...failedCurrent.shards[0]!,
      status: 'failed',
      handle: 'qa.system-verdict-fixture',
      error: 'Expected system verdict failure',
      failureClass: 'assertion',
      browserIssues: [{
        type: 'pageerror',
        severity: 'error',
        message: 'Unhandled fixture error',
        url: 'http://127.0.0.1:8080/qa',
        method: null,
        status: null,
        testId: 'system-verdict',
        timestamp: Date.UTC(2026, 5, 23),
      }],
    }],
  });

  const failed = buildQaSystemVerdict([summarizeQaRun(failedRun)], now);
  expect(failed.schemaVersion).toBe(1);
  expect(failed.status).toBe('FAIL');
  expect(failed.reason).toContain('qa.system-verdict-fixture');
  expect(failed.activeCount).toBe(3);
  expect(failed.failingSurfaceCount).toBe(3);
  expect(failed.regressionStatus).toBe('slower');
  expect(failed.browserErrorCount).toBe(1);

  const passedRun = asCurrentQaRun(benchmarkRun('20260623-235959-999', 900, 700));
  const passed = buildQaSystemVerdict([summarizeQaRun(passedRun)], now);
  expect(passed.status).toBe('PASS');
  expect(passed.activeCount).toBe(0);
  expect(passed.failingSurfaceCount).toBe(0);
});

test('qa system verdict excludes future fixture dirty and unknown-schema runs', () => {
  const now = Date.UTC(2026, 5, 24);
  const eligible = asCurrentQaRun(benchmarkRun('20260623-235959-995', 900, 700));
  const future = {
    ...asCurrentQaRun(benchmarkRun('20991231-235959-999', 900, 700)),
    createdAt: Date.UTC(2099, 11, 31, 23, 59, 59, 999),
  };
  const fixture = {
    ...asCurrentQaRun(benchmarkRun('20260623-235959-998', 900, 700)),
    args: { fixture: 'qa-cockpit' },
  };
  const dirty = {
    ...asCurrentQaRun(benchmarkRun('20260623-235959-997', 900, 700)),
    code: { ...eligible.code!, dirty: true },
  };
  const unknownSchema = {
    ...benchmarkRun('20260623-235959-996', 900, 700),
    manifestVersion: 999,
  };

  const verdict = buildQaSystemVerdict([
    summarizeQaRun(future),
    summarizeQaRun(fixture),
    summarizeQaRun(dirty),
    summarizeQaRun(unknownSchema),
    summarizeQaRun(eligible),
  ], now);
  expect(verdict.status).toBe('PASS');
  expect(verdict.latestRunId).toBe(eligible.runId);

  const excluded = buildQaSystemVerdict([
    summarizeQaRun(future),
    summarizeQaRun(fixture),
    summarizeQaRun(dirty),
    summarizeQaRun(unknownSchema),
  ], now);
  expect(excluded.status).toBe('UNKNOWN');
  expect(excluded.reason).toBe('No release-eligible QA runs');
  expect(excluded.evidence.map(item => item.value)).toEqual([
    4,
    'future timestamp',
    'fixture run',
    'dirty worktree',
    'unsupported manifest schema',
  ]);
});

test('qa run ledger exposes canonical operator fields', () => {
  const baseline = benchmarkRun('ledger-baseline', 1000, 800);
  const current = benchmarkRun('ledger-current', 1500, 1200, 'ledger-code', 'ledger-head');
  const run = applyQaRunSeverity({
    ...current,
    status: 'failed',
    passedShards: 0,
    failedShards: 1,
    args: {
      pwFiles: ['tests/e2e-ledger.spec.ts'],
      startedBy: 'regulator-operator',
      auditAction: 'release-gate',
    },
    benchmark: compareQaBenchmarkRuns(current, baseline),
    browserHealth: {
      severity: 'FAIL',
      reason: '1 browser error(s) captured',
      since: Date.UTC(2026, 5, 23),
      owner: 'browser',
      evidence: [{ label: 'errors', value: 1 }],
      issueCount: 1,
      errorCount: 1,
      warningCount: 0,
      networkFailureCount: 0,
      httpErrorCount: 1,
    },
    perf: {
      ...current.perf!,
      maxChildCpuPct: 90,
      samples: [
        {
          ts: Date.UTC(2026, 5, 23, 0, 0, 0),
          load1: 1,
          load5: 1,
          load15: 1,
          freeMemBytes: 100,
          totalMemBytes: 200,
          runnerRssBytes: 300,
          children: [
            { name: 'playwright', pid: 1, cpuPct: 10, memPct: 1, rssKb: 200 },
            { name: 'vite', pid: 2, cpuPct: 90, memPct: 2, rssKb: 300 },
          ],
        },
      ],
    },
    shards: [{
      ...current.shards[0]!,
      status: 'failed',
      handle: 'qa.ledger-fixture',
      failureClass: 'assertion',
      error: 'Expected ledger fixture failure',
      browserIssues: [{
        type: 'http',
        severity: 'error',
        message: 'HTTP 502',
        url: 'http://127.0.0.1:8080/api/qa/run',
        method: 'GET',
        status: 502,
        testId: 'ledger',
        timestamp: Date.UTC(2026, 5, 23),
      }],
      artifacts: [
        {
          name: 'video.webm',
          relativePath: 'video.webm',
          sizeBytes: 1024,
          kind: 'video',
          sensitivity: 'internal',
          contentType: 'video/webm',
        },
        {
          name: 'trace.zip',
          relativePath: 'trace.zip',
          sizeBytes: 2048,
          kind: 'archive',
          sensitivity: 'internal',
          contentType: 'application/zip',
        },
      ],
    }],
  });
  const [row] = buildQaRunLedger([summarizeQaRun(run)]);
  expect(row?.status).toBe('failed');
  expect(row?.category).toBe('e2e');
  expect(row?.suiteLabel).toBe('qa.ledger-fixture');
  expect(row?.startedBy).toBe('regulator-operator');
  expect(row?.auditAction).toBe('release-gate');
  expect(row?.failedShard).toBe('qa.ledger-fixture');
  expect(row?.artifactBytes).toBe(3072);
  expect(row?.cpuP95Pct).toBe(90);
  expect(row?.cpuPeakPct).toBe(90);
  expect(row?.ramPeakKb).toBe(4096);
  expect(row?.browserErrors).toBe(1);
  expect(row?.networkFailures).toBe(1);
  expect(row?.benchmarkStatus).toBe('slower');
  expect(row?.benchmarkDeltaPct).toBe(50);
  expect(row?.gitHead).toBe('ledger-head');
  expect(row?.codeHash).toBe('ledger-code');
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

test('qa failure fixtures classify browser, log, network, and phase failures', () => {
  const at = Date.UTC(2026, 5, 23);
  const browserIssue = (
    type: 'console' | 'pageerror' | 'requestfailed' | 'http',
    message: string,
    extra: { status?: number | null; url?: string | null; method?: string | null } = {},
  ) => ({
    type,
    severity: 'error' as const,
    message,
    url: extra.url ?? 'https://localhost:8080/qa',
    method: extra.method ?? 'GET',
    status: extra.status ?? null,
    testId: `fixture:${type}`,
    timestamp: at,
  });

  expect(classifyQaShardFailure({
    status: 'failed',
    browserIssues: [browserIssue('console', 'Expected: 1 Received: 2')],
  })).toBe('assertion');
  expect(classifyQaShardFailure({
    status: 'failed',
    browserIssues: [browserIssue('pageerror', 'Unhandled app exception')],
  })).toBe('crash');
  expect(classifyQaShardFailure({
    status: 'failed',
    browserIssues: [browserIssue('requestfailed', 'net::ERR_CONNECTION_REFUSED')],
  })).toBe('infra');
  expect(classifyQaShardFailure({
    status: 'failed',
    browserIssues: [browserIssue('http', 'HTTP 502', { status: 502, url: 'https://localhost:8080/api/health' })],
  })).toBe('infra');
  expect(classifyQaShardFailure({
    status: 'failed',
    logTail: 'E2E_FATAL_RUNTIME_LOG runtime crashed',
  })).toBe('crash');

  const phaseBudget = buildQaPhaseWaterfall({
    preflight: 100,
    anvilBoot: 100,
    apiBoot: 100,
    apiHealthy: 100,
    viteBoot: 100,
    playwright: 6_000,
  });
  expect(phaseBudget?.overLimitCount).toBe(1);
  expect(phaseBudget?.segments.find(segment => segment.key === 'playwright')?.overLimit).toBe(true);
});

test('readQaRun surfaces corrupt manifests as failed redacted evidence', async () => {
  const runId = '20000101-000004-128';
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  await rm(runDir, { recursive: true, force: true });
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'manifest.json'),
      '{"authorization":"Bearer corrupt-secret-123456789","shards":',
    );

    const run = await readQaRun(runId);
    const summary = summarizeQaRun(run);
    expect(run.status).toBe('failed');
    expect(run.totalShards).toBe(1);
    expect(run.failedShards).toBe(1);
    expect(run.failureClasses).toContain('infra');
    expect(run.shards[0]?.handle).toBe('qa.corrupt-manifest');
    expect(run.shards[0]?.failureClass).toBe('infra');
    expect(run.shards[0]?.error).toContain('QA_CORRUPT_MANIFEST');
    expect(run.shards[0]?.error).toContain('[REDACTED]');
    expect(run.shards[0]?.error).not.toContain('corrupt-secret-123456789');
    expect(summary.status).toBe('failed');
    expect(summary.failingTargets).toEqual(['qa.corrupt-manifest']);
  } finally {
    deleteQaHistoryRows([runId]);
    await rm(runDir, { recursive: true, force: true });
  }
});

test('readQaRun keeps empty legacy log directories as unknown zero-shard evidence', async () => {
  const runId = '20000101-000005-129';
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  await rm(runDir, { recursive: true, force: true });
  try {
    await mkdir(runDir, { recursive: true });

    const run = await readQaRun(runId);
    const summary = summarizeQaRun(run);
    expect(run.manifestVersion).toBe(1);
    expect(run.status).toBe('unknown');
    expect(run.totalShards).toBe(0);
    expect(run.passedShards).toBe(0);
    expect(run.failedShards).toBe(0);
    expect(run.shards).toEqual([]);
    expect(summary.status).toBe('unknown');
    expect(summary.failingTargets).toEqual([]);
  } finally {
    deleteQaHistoryRows([runId]);
    await rm(runDir, { recursive: true, force: true });
  }
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
  const audit = auditQaUxReleasePack(stories);

  expect(curated.length).toBeGreaterThanOrEqual(QA_UX_RELEASE_PACK_MIN_SCREENS);
  expect(platforms.has('desktop')).toBe(true);
  expect(platforms.has('mobile')).toBe(true);
  for (const group of QA_UX_RELEASE_REQUIRED_GROUPS) {
    expect(groups.has(group), `missing curated UX group ${group}`).toBe(true);
  }
  expect(audit.status).toBe('ready');
  expect(audit.missingReasons).toEqual([]);
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

test('qa artifact sensitivity classifier separates public cues from secret-bearing files', () => {
  expect(classifyQaArtifactSensitivity({
    name: 'video.webm',
    relativePath: 'test-results-shard-1/wallet/video.webm',
    kind: 'video',
    contentType: 'video/webm',
  })).toBe('internal');
  expect(classifyQaArtifactSensitivity({
    name: 'state.png',
    relativePath: 'ux-gallery/desktop/state.png',
    kind: 'image',
    contentType: 'image/png',
  })).toBe('internal');
  expect(classifyQaArtifactSensitivity({
    name: 'cues.vtt',
    relativePath: 'test-results-shard-1/wallet/qa-cues/cues.vtt',
    kind: 'text',
    contentType: 'text/vtt; charset=utf-8',
  })).toBe('public');
  expect(classifyQaArtifactSensitivity({
    name: 'trace.zip',
    relativePath: 'test-results-shard-1/wallet/trace.zip',
    kind: 'trace',
    contentType: 'application/zip',
  })).toBe('secret-bearing');
  expect(classifyQaArtifactSensitivity({
    name: 'manifest.json',
    relativePath: 'manifest.json',
    kind: 'json',
    contentType: 'application/json',
  })).toBe('secret-bearing');
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
      sensitivity: 'secret-bearing' as const,
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
    expect(run.shards[0].artifacts[0]?.sensitivity).toBe('secret-bearing');

    await withQaAuthEnv(async () => {
      const readResponse = await maybeHandleQaRequest(
        qaRequest(`http://127.0.0.1:8080/api/qa/artifact?runId=${runId}&path=secret.log`),
        '/api/qa/artifact',
        JSON_HEADERS,
      );
      expect(readResponse?.status).toBe(200);
      const readArtifactText = await readResponse!.text();
      expect(readArtifactText).toContain('[REDACTED]');
      expect(readArtifactText).not.toContain('bearer-secret-123456789');
      expect(readArtifactText).not.toContain('remote-secret-token');
      expect(readArtifactText).not.toContain('encoded-secret');
      expect(readArtifactText).not.toContain('read-secret');
      expect(readArtifactText).not.toContain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const adminResponse = await maybeHandleQaRequest(
        qaRequest(`http://127.0.0.1:8080/api/qa/artifact?runId=${runId}&path=secret.log`, {}, QA_ADMIN_TOKEN),
        '/api/qa/artifact',
        JSON_HEADERS,
      );
      expect(adminResponse?.status).toBe(200);
      const artifactText = await adminResponse!.text();
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
      releasePack?: { status?: string; curatedCount?: number; missingReasons?: string[] };
      stories?: Array<{ source?: string; url?: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.releasePack?.status).toBe('ready');
    expect(payload.releasePack?.curatedCount ?? 0).toBeGreaterThanOrEqual(QA_UX_RELEASE_PACK_MIN_SCREENS);
    expect(payload.releasePack?.missingReasons).toEqual([]);
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

test('qa api is public read-only and preserves local operator admin access', async () => {
  const previousAdmin = process.env['XLN_QA_ADMIN_TOKEN'];
  const previousDisabled = process.env['XLN_QA_AUTH_DISABLED'];
  delete process.env['XLN_QA_ADMIN_TOKEN'];
  delete process.env['XLN_QA_AUTH_DISABLED'];
  try {
    const localResponse = await maybeHandleQaRequest(
      new Request('http://127.0.0.1:8080/api/qa/catalog'),
      '/api/qa/catalog',
      JSON_HEADERS,
      { operatorAuthorized: true },
    );
    expect(localResponse?.status).toBe(200);
    const payload = await localResponse!.json() as {
      ok?: boolean;
      qaAuth?: { scope?: string; disabled?: boolean; actorKeyId?: string };
      catalog?: unknown[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.qaAuth?.scope).toBe('admin');
    expect(payload.qaAuth?.disabled).toBe(true);
    expect(payload.qaAuth?.actorKeyId).toBe('qa-local-open');
    expect(Array.isArray(payload.catalog)).toBe(true);

    const publicResponse = await maybeHandleQaRequest(
      new Request('https://xln.finance/api/qa/catalog'),
      '/api/qa/catalog',
      JSON_HEADERS,
      { operatorAuthorized: false },
    );
    expect(publicResponse?.status).toBe(200);
    const publicPayload = await publicResponse!.json() as {
      ok?: boolean;
      qaAuth?: { scope?: string; disabled?: boolean; actorKeyId?: string };
      catalog?: unknown[];
    };
    expect(publicPayload.ok).toBe(true);
    expect(publicPayload.qaAuth?.scope).toBe('read');
    expect(publicPayload.qaAuth?.disabled).toBe(false);
    expect(publicPayload.qaAuth?.actorKeyId).toBe('qa-public-read');
    expect(Array.isArray(publicPayload.catalog)).toBe(true);
  } finally {
    if (previousAdmin === undefined) delete process.env['XLN_QA_ADMIN_TOKEN'];
    else process.env['XLN_QA_ADMIN_TOKEN'] = previousAdmin;
    if (previousDisabled === undefined) delete process.env['XLN_QA_AUTH_DISABLED'];
    else process.env['XLN_QA_AUTH_DISABLED'] = previousDisabled;
  }
});

test('qa api allows anonymous reads and requires an admin token for restart operations', async () => {
  await withQaAuthEnv(async () => {
    const publicCatalog = await maybeHandleQaRequest(
      new Request('http://127.0.0.1:8080/api/qa/catalog'),
      '/api/qa/catalog',
      JSON_HEADERS,
    );
    expect(publicCatalog?.status).toBe(200);
    expect((await publicCatalog!.json() as { qaAuth?: { scope?: string } }).qaAuth?.scope).toBe('read');

    const publicPlan = await maybeHandleQaRequest(
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
    expect(publicPlan?.status).toBe(403);
    expect((await publicPlan!.json() as { error?: string }).error).toBe('QA_AUTH_ADMIN_REQUIRED');

    const adminCatalog = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/catalog', {}, QA_ADMIN_TOKEN),
      '/api/qa/catalog',
      JSON_HEADERS,
    );
    expect(adminCatalog?.status).toBe(200);

    const invalidToken = await maybeHandleQaRequest(
      qaRequest('http://127.0.0.1:8080/api/qa/catalog', {}, 'invalid-token'),
      '/api/qa/catalog',
      JSON_HEADERS,
    );
    expect(invalidToken?.status).toBe(401);
    expect((await invalidToken!.json() as { error?: string }).error).toBe('QA_AUTH_INVALID');
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
  const previousAdmin = process.env['XLN_QA_ADMIN_TOKEN'];
  process.env['XLN_QA_AUTH_DISABLED'] = '1';
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
    SECRET_SENTINEL: 'must-not-leak',
    PRIVATE_KEY: 'must-not-leak',
  });
  expect(restartEnv.PATH).toBe('/bin');
  expect(restartEnv.HOME).toBe('/tmp/home');
  expect(restartEnv.PW_TEST_HTML_REPORT_OPEN).toBe('never');
  expect(restartEnv.PLAYWRIGHT_BROWSERS_PATH).toBe('/tmp/pw');
  expect(restartEnv.XLN_QA_ADMIN_TOKEN).toBeUndefined();
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
  const entry: QaRestartAuditRecord = {
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
  expect(row?.severity).toBe('FAIL');
  expect(row?.actorKeyId).toBe('actor-test');
});

test('qa restart audit output hides absolute server paths', () => {
  const auditId = `test-audit-path-${Date.now()}`;
  const absoluteLogPath = resolve(process.cwd(), '.logs', 'qa-restarts', 'absolute-fixture.log');
  insertQaRestartAudit({
    auditId,
    status: 'started',
    actorKeyId: 'actor-test',
    scope: 'admin',
    operatorId: 'operator-test',
    action: 'restart-run',
    target: 'tests/e2e-fixture.spec.ts',
    title: 'fixture',
    reason: 'verify path redaction',
    expectedGitHead: 'expected-head',
    actualGitHead: 'actual-head',
    gitBranch: 'main',
    codeHash: 'code-hash',
    dirty: false,
    startedAt: Date.now(),
    finishedAt: null,
    pid: 123,
    exitCode: null,
    logPath: absoluteLogPath,
    requestIp: '127.0.0.1',
    userAgent: 'bun-test',
  });
  const row = listQaRestartAudit(50).find(candidate => candidate.auditId === auditId);
  expect(row?.logPath).toBe('.logs/qa-restarts/absolute-fixture.log');
  expect(row?.logPath).not.toContain(process.cwd());
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

test('qa restart rejects concurrent run without spawning a second heavy e2e process', async () => {
  await withQaAuthEnv(async () => {
    await withQaRestartEnv(async () => {
      const spawned: ChildProcess[] = [];
      const deps = {
        computeRestartFingerprint: () => TEST_RESTART_FINGERPRINT,
        spawnRestart: () => {
          const proc = spawnSleeperRestart();
          spawned.push(proc);
          return proc;
        },
      };
      try {
        const first = await maybeHandleQaRequest(
          qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=run', {
            method: 'POST',
            body: JSON.stringify(restartRunBody()),
          }, QA_ADMIN_TOKEN),
          '/api/qa/restart',
          JSON_HEADERS,
          deps,
        );
        expect(first?.status).toBe(202);
        const firstPayload = await first!.json() as { restart?: { logPath?: string } };
        expect(firstPayload.restart?.logPath).toContain('.logs/qa-restarts/');
        expect(firstPayload.restart?.logPath).not.toContain(process.cwd());
        expect(spawned.length).toBe(1);

        const second = await maybeHandleQaRequest(
          qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=run', {
            method: 'POST',
            body: JSON.stringify(restartRunBody()),
          }, QA_ADMIN_TOKEN),
          '/api/qa/restart',
          JSON_HEADERS,
          deps,
        );
        expect(second?.status).toBe(409);
        const payload = await second!.json() as { error?: string; restart?: { active?: boolean } };
        expect(payload.error).toBe('QA_RESTART_ALREADY_RUNNING');
        expect(payload.restart?.active).toBe(true);
        expect(spawned.length).toBe(1);

        const abort = await maybeHandleQaRequest(
          qaRequest('http://127.0.0.1:8080/api/qa/restart/abort', {
            method: 'POST',
            body: JSON.stringify({ confirm: 'ABORT_RESTART' }),
          }, QA_ADMIN_TOKEN),
          '/api/qa/restart/abort',
          JSON_HEADERS,
        );
        expect(abort?.status).toBe(202);
        await waitForRestartInactive();
      } finally {
        for (const proc of spawned) {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        }
      }
    });
  });
});

test('qa restart watchdog marks hung child and frees the active slot', async () => {
  await withQaAuthEnv(async () => {
    await withQaRestartEnv(async () => {
      const previousWatchdog = process.env['XLN_QA_RESTART_WATCHDOG_MS'];
      process.env['XLN_QA_RESTART_WATCHDOG_MS'] = '1000';
      const spawned: ChildProcess[] = [];
      const deps = {
        computeRestartFingerprint: () => TEST_RESTART_FINGERPRINT,
        spawnRestart: () => {
          const proc = spawnSleeperRestart();
          spawned.push(proc);
          return proc;
        },
      };
      try {
        const response = await maybeHandleQaRequest(
          qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=run', {
            method: 'POST',
            body: JSON.stringify(restartRunBody()),
          }, QA_ADMIN_TOKEN),
          '/api/qa/restart',
          JSON_HEADERS,
          deps,
        );
        expect(response?.status).toBe(202);
        const started = await response!.json() as { restart?: { auditId?: string; watchdogAt?: number } };
        expect(started.restart?.auditId).toBeDefined();
        expect(typeof started.restart?.watchdogAt).toBe('number');

        await Bun.sleep(1200);
        await waitForRestartInactive();
        const row = listQaRestartAudit(50).find(candidate => candidate.auditId === started.restart?.auditId);
        expect(row?.status).toBe('watchdog_timeout');
        expect(row?.exitCode).not.toBeNull();
      } finally {
        if (previousWatchdog === undefined) delete process.env['XLN_QA_RESTART_WATCHDOG_MS'];
        else process.env['XLN_QA_RESTART_WATCHDOG_MS'] = previousWatchdog;
        for (const proc of spawned) {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        }
      }
    });
  });
});

test('qa restart cooldown rejects rapid sequential runs without spawning', async () => {
  await withQaAuthEnv(async () => {
    await withQaRestartEnv(async () => {
      const previousCooldown = process.env['XLN_QA_RESTART_COOLDOWN_MS'];
      process.env['XLN_QA_RESTART_COOLDOWN_MS'] = '1000';
      const spawned: ChildProcess[] = [];
      const deps = {
        computeRestartFingerprint: () => TEST_RESTART_FINGERPRINT,
        spawnRestart: () => {
          const proc = spawnImmediateRestart();
          spawned.push(proc);
          return proc;
        },
      };
      try {
        const first = await maybeHandleQaRequest(
          qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=run', {
            method: 'POST',
            body: JSON.stringify(restartRunBody()),
          }, QA_ADMIN_TOKEN),
          '/api/qa/restart',
          JSON_HEADERS,
          deps,
        );
        expect(first?.status).toBe(202);
        await waitForRestartInactive();

        const second = await maybeHandleQaRequest(
          qaRequest('http://127.0.0.1:8080/api/qa/restart?mode=run', {
            method: 'POST',
            body: JSON.stringify(restartRunBody()),
          }, QA_ADMIN_TOKEN),
          '/api/qa/restart',
          JSON_HEADERS,
          deps,
        );
        expect(second?.status).toBe(429);
        const payload = await second!.json() as { error?: string; restart?: { cooldownRemainingMs?: number } };
        expect(payload.error).toBe('QA_RESTART_COOLDOWN_ACTIVE');
        expect(Number(payload.restart?.cooldownRemainingMs || 0)).toBeGreaterThan(0);
        expect(spawned.length).toBe(1);
      } finally {
        await Bun.sleep(1000);
        if (previousCooldown === undefined) delete process.env['XLN_QA_RESTART_COOLDOWN_MS'];
        else process.env['XLN_QA_RESTART_COOLDOWN_MS'] = previousCooldown;
        for (const proc of spawned) {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        }
      }
    });
  });
});

test('qa run report preserves timeline order and derives slow steps', async () => {
  const createdAt = Date.now() - 2_000;
  const completedAt = createdAt + 1_000;
  const runId = formatQaRunIdUtc(createdAt);
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  await rm(runDir, { recursive: true, force: true });
  deleteQaHistoryRows([runId]);
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'manifest.json'),
      `${JSON.stringify({
        manifestVersion: 2,
        runId,
        createdAt,
        completedAt,
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
                timestamp: createdAt + 500,
              },
              {
                type: 'http',
                severity: 'warning',
                message: 'HTTP 404',
                url: 'https://localhost:8080/favicon.ico',
                method: 'GET',
                status: 404,
                testId: 'chromium :: qa run report fixture',
                timestamp: createdAt + 600,
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
    expect(run.shards[0]?.browserHealth).toMatchObject({
      severity: 'FAIL',
      reason: '1 browser error(s) captured',
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
    deleteQaHistoryRows([runId]);
    await rm(runDir, { recursive: true, force: true });
  }
});

test('qa run report preserves authored scenario metadata from targets', async () => {
  const runId = '20000101-000003-127';
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  const summary10w = 'Author wrote exact golden summary for regulator playback evidence proof';
  await rm(runDir, { recursive: true, force: true });
  deleteQaHistoryRows([runId]);
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'targets.json'),
      `${JSON.stringify([
        {
          shard: 0,
          target: 'tests/e2e-regulator-golden.spec.ts',
          title: 'prepares cross border payment evidence',
          handle: 'golden.payment-evidence',
          description: 'Full authored description survives report enrichment.',
          scenario: {
            summary10w,
            owner: 'qa',
            severityPolicy: 'release-blocker',
            steps: [
              {
                title: 'Open payment form',
                text: 'Operator opens the payment form with a funded route.',
                startMs: 100,
                endMs: 450,
                ms: 350,
              },
            ],
          },
        },
      ])}\n`,
    );
    await writeFile(
      join(runDir, 'manifest.json'),
      `${JSON.stringify({
        manifestVersion: 2,
        runId,
        createdAt: Date.UTC(2000, 0, 1, 0, 0, 3),
        completedAt: Date.UTC(2000, 0, 1, 0, 0, 4),
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
            target: null,
            title: null,
            requireMarketMaker: false,
            logRelativePath: null,
            logTail: null,
            error: null,
            phaseMs: null,
            timelineSteps: [],
            slowSteps: [],
            artifacts: [],
            hasVideo: false,
            hasTrace: false,
          },
        ],
      })}\n`,
    );

    const run = await readQaRun(runId);
    expect(run.shards[0]?.handle).toBe('golden.payment-evidence');
    expect(run.shards[0]?.description).toBe('Full authored description survives report enrichment.');
    expect(run.shards[0]?.target).toBe('tests/e2e-regulator-golden.spec.ts');
    expect(run.shards[0]?.title).toBe('prepares cross border payment evidence');
    expect(run.shards[0]?.scenario?.summary10w).toBe(summary10w);
    expect(run.shards[0]?.scenario?.owner).toBe('qa');
    expect(run.shards[0]?.scenario?.severityPolicy).toBe('release-blocker');
    expect(run.shards[0]?.scenario?.steps).toEqual([
      {
        title: 'Open payment form',
        text: 'Operator opens the payment form with a funded route.',
        startMs: 100,
        endMs: 450,
        ms: 350,
      },
    ]);
  } finally {
    deleteQaHistoryRows([runId]);
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
    const run = asCurrentQaRun({
      ...base,
      createdAt,
      completedAt: createdAt + 2345,
      status: 'failed',
      testCategory: 'functional',
      passedShards: 0,
      failedShards: 1,
      failureClasses: ['assertion'],
      args: {
        ...base.args,
        startedBy: 'ledger-api-operator',
        auditAction: 'restart-run',
      },
      perf: {
        ...base.perf!,
        maxChildCpuPct: 42,
        samples: [{
          ts: createdAt,
          load1: 1,
          load5: 1,
          load15: 1,
          freeMemBytes: 100,
          totalMemBytes: 200,
          runnerRssBytes: 300,
          children: [{ name: 'playwright', pid: 10, cpuPct: 42, memPct: 1, rssKb: 512 }],
        }],
      },
      shards: [{
        ...base.shards[0]!,
        testCategory: 'functional',
        status: 'failed',
        error: 'Expected canonical ledger failure',
        failureClass: 'assertion',
        logRelativePath: 'e2e-shard-00.log',
        logTail: 'stored summary tail',
        timelineSteps: [{ label: 'stored summary cue', ms: 111 }],
        slowSteps: [{ label: 'stored summary cue', ms: 111 }],
        artifacts: [{
          name: 'video.webm',
          relativePath: 'video.webm',
          sizeBytes: 2048,
          kind: 'video',
          sensitivity: 'internal',
          contentType: 'video/webm',
        }],
      }],
    });
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
        ledger?: Array<{
          runId?: string;
          status?: string;
          suiteLabel?: string;
          category?: string;
          startedBy?: string;
          auditAction?: string | null;
          artifactBytes?: number;
          cpuP95Pct?: number | null;
          cpuPeakPct?: number | null;
          failedShard?: string | null;
        }>;
        regression?: { latestRunId?: string | null; status?: string; comparisons?: unknown[] };
        verdict?: { status?: string; latestRunId?: string | null; reason?: string; activeCount?: number };
      };
      expect(payload.ok).toBe(true);
      const summary = payload.runs?.find(item => item.runId === runId);
      expect(summary?.status).toBe('failed');
      expect(summary?.failingTargets).toEqual(['qa cockpit']);
      expect(summary?.timing?.playwrightMs).toBe(1200);
      expect(payload.verdict?.status).toBe('FAIL');
      expect(payload.verdict?.latestRunId).toBe(runId);
      expect(payload.verdict?.reason).toContain('qa cockpit');
      expect(payload.verdict?.activeCount).toBeGreaterThan(0);
      const ledgerRow = payload.ledger?.find(item => item.runId === runId);
      expect(ledgerRow?.status).toBe('failed');
      expect(ledgerRow?.suiteLabel).toBe('functional · qa cockpit');
      expect(ledgerRow?.category).toBe('e2e');
      expect(ledgerRow?.startedBy).toBe('ledger-api-operator');
      expect(ledgerRow?.auditAction).toBe('restart-run');
      expect(ledgerRow?.artifactBytes).toBe(2048);
      expect(ledgerRow?.cpuP95Pct).toBe(42);
      expect(ledgerRow?.cpuPeakPct).toBe(42);
      expect(ledgerRow?.failedShard).toBe('qa cockpit');
      expect(payload.regression?.latestRunId).toBe(runId);
      expect(payload.regression?.status).toBe('insufficient');
      expect(payload.regression?.comparisons?.length).toBe(4);

      const detailResponse = await maybeHandleQaRequest(
        qaRequest(`http://127.0.0.1:8080/api/qa/run?runId=${runId}`),
        '/api/qa/run',
        JSON_HEADERS,
      );
      expect(detailResponse?.status).toBe(200);
      const detailPayload = await detailResponse!.json() as {
        ok?: boolean;
        run?: QaRunManifest;
      };
      expect(detailPayload.ok).toBe(true);
      expect(detailPayload.run?.runId).toBe(runId);
      expect(detailPayload.run?.shards[0]?.artifacts).toHaveLength(1);
      expect(detailPayload.run?.shards[0]?.artifacts[0]?.url).toBeUndefined();

      const artifactResponse = await maybeHandleQaRequest(
        qaRequest(`http://127.0.0.1:8080/api/qa/artifact?runId=${runId}&path=video.webm`),
        '/api/qa/artifact',
        JSON_HEADERS,
      );
      expect(artifactResponse?.status).toBe(404);
    });
  } finally {
    deleteQaHistoryRows([runId]);
    await rm(runDir, { recursive: true, force: true });
  }
});

test('qa history stores sample-stripped manifest json', () => {
  const runId = '20260623-000126-780';
  deleteQaHistoryRows([runId]);
  try {
    const sample = {
      ts: Date.UTC(2026, 5, 23, 0, 1, 26),
      load1: 1.5,
      load5: 1.25,
      load15: 1.1,
      freeMemBytes: 900_000_000,
      totalMemBytes: 1_800_000_000,
      runnerRssBytes: 123_000_000,
      children: [],
    };
    const base = benchmarkRun(runId, 2345, 1200);
    const perf = { ...base.perf!, samples: [sample] };
    const run: QaRunManifest = {
      ...base,
      perf,
      shards: [{
        ...base.shards[0]!,
        perf,
      }],
    };
    recordQaRunHistory(run, resolve(process.cwd(), '.logs', 'e2e-parallel', runId));

    const db = new Database(QA_HISTORY_DB_PATH);
    try {
      const row = db.query(`SELECT manifest_json FROM qa_runs WHERE run_id = $runId`).get({ $runId: runId }) as {
        manifest_json?: string;
      } | null;
      expect(typeof row?.manifest_json).toBe('string');
      const stored = JSON.parse(row!.manifest_json!) as QaRunManifest;
      expect(stored.perf?.sampleCount).toBe(1);
      expect(stored.perf?.samples).toEqual([]);
      expect(stored.shards[0]?.perf?.sampleCount).toBe(1);
      expect(stored.shards[0]?.perf?.samples).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    deleteQaHistoryRows([runId]);
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
  const createdAt = Date.now() - 3_000;
  const runId = formatQaRunIdUtc(createdAt);
  const runDir = resolve(process.cwd(), '.logs', 'e2e-parallel', runId);
  await rm(runDir, { recursive: true, force: true });
  deleteQaHistoryRows([runId]);
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'manifest.json'),
      `${JSON.stringify({
        ...benchmarkRun(runId, 900, 700, 'history-hot-path-code', 'history-hot-path-head'),
        createdAt,
        completedAt: createdAt + 1_000,
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
