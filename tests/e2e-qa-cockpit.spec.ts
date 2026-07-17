import { expect, test } from './global-setup';

const QA_FIXTURE_RUN_ID = '20260623-235959-999';
const QA_FAST_RUN_ID = '20260623-225959-888';
const QA_FIXTURE_ARTIFACT = 'test-results-shard-1/qa-cockpit-fixture/video.webm';
const QA_AUTH = { scope: 'admin', disabled: true, actorKeyId: 'fixture-auth-disabled' };
const QA_READ_AUTH = { scope: 'read', disabled: false, actorKeyId: 'fixture-read' };
const qaSignal = (
  severity: 'OK' | 'WARN' | 'DEGRADED' | 'FAIL' | 'BLOCKED' | 'UNKNOWN',
  reason: string,
  owner: string,
  since = Date.UTC(2026, 5, 23, 23, 59, 59, 999),
  evidence: Array<{ label: string; value?: string | number | boolean | null; unit?: string | null }> = [],
) => ({ severity, reason, owner, since, evidence });
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
  ...qaSignal('OK', 'Browser event stream is clean', 'browser'),
  issueCount: 0,
  errorCount: 0,
  warningCount: 0,
  networkFailureCount: 0,
  httpErrorCount: 0,
};
const QA_FIXTURE_BROWSER_HEALTH = {
  ...qaSignal('FAIL', '1 browser error(s) captured', 'browser', Date.UTC(2026, 5, 24, 0, 0, 2), [
    { label: 'errors', value: 1 },
    { label: 'warnings', value: 2 },
  ]),
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
const QA_FIXTURE_VTT = [
  'WEBVTT',
  '',
  'cue-01',
  '00:00:00.000 --> 00:00:00.030',
  'open wallet cockpit',
  '',
  'cue-02',
  '00:00:00.030 --> 00:00:00.060',
  'select recorded shard',
  '',
].join('\n');

function qaStoryVideoShard(
  shard: number,
  slug: string,
  title: string,
  description: string,
  summary10w: string,
) {
  const relativeRoot = `test-results-shard-${shard}/qa-story-${slug}`;
  return {
    ...qaSignal('OK', `${slug} story video passed`, 'qa-shard'),
    shard,
    status: 'passed',
    durationMs: 1_600,
    handle: `qa.story.${slug}`,
    description,
    scenario: {
      summary10w,
      owner: 'qa',
      severityPolicy: 'release-evidence',
      steps: [
        { title: title, text: description, startMs: 0, endMs: 40, ms: 40 },
        { title: 'Verify evidence', text: 'Operator confirms the visible wallet state and the recorded video.', startMs: 40, endMs: 80, ms: 40 },
      ],
    },
    target: `tests/e2e-user-story-${slug}.spec.ts`,
    title,
    requireMarketMaker: slug.includes('swap'),
    logRelativePath: `e2e-shard-${String(shard).padStart(2, '0')}.log`,
    logTail: `${title} passed with recorded video evidence`,
    error: null,
    failureClass: null,
    phaseMs: {
      preflight: 45,
      anvilBoot: 90,
      apiBoot: 120,
      apiHealthy: 180,
      viteBoot: 220,
      playwright: 945,
    },
    browserIssues: [],
    browserHealth: QA_CLEAN_BROWSER_HEALTH,
    timelineSteps: [
      { label: `E2E-TIMING:${title}`, ms: 40, startMs: 0, endMs: 40 },
      { label: 'E2E-TIMING:verify evidence', ms: 40, startMs: 40, endMs: 80 },
    ],
    slowSteps: [
      { label: 'E2E-TIMING:verify evidence', ms: 40, startMs: 40, endMs: 80 },
    ],
    artifacts: [
      {
        name: `${slug}.webm`,
        relativePath: `${relativeRoot}/video.webm`,
        sizeBytes: 1024,
        kind: 'video',
        sensitivity: 'internal',
        contentType: 'video/webm',
        url: `/api/qa/artifact?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}&path=${encodeURIComponent(`${relativeRoot}/video.webm`)}`,
      },
      {
        name: 'cues.vtt',
        relativePath: `${relativeRoot}/qa-cues/cues.vtt`,
        sizeBytes: QA_FIXTURE_VTT.length,
        kind: 'text',
        sensitivity: 'public',
        contentType: 'text/vtt; charset=utf-8',
        url: `/api/qa/artifact?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}&path=${encodeURIComponent(`${relativeRoot}/qa-cues/cues.vtt`)}`,
      },
    ],
    hasVideo: true,
    hasTrace: false,
  };
}

const QA_FIXTURE_RUN = {
  ...qaSignal('FAIL', '1/3 shard(s) failed', 'qa', Date.UTC(2026, 5, 23, 23, 59, 59, 999), [
    { label: 'failed shards', value: 1 },
    { label: 'total shards', value: 3 },
  ]),
  manifestVersion: 2,
  runId: QA_FIXTURE_RUN_ID,
  createdAt: Date.UTC(2026, 5, 23, 23, 59, 59, 999),
  completedAt: Date.UTC(2026, 5, 24, 0, 0, 7, 199),
  status: 'failed',
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
  },
  browserHealth: QA_FIXTURE_BROWSER_HEALTH,
  benchmark: {
    ...qaSignal('DEGRADED', 'wall time +25% vs 20260623-225959-888', 'benchmark'),
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
  totalShards: 7,
  passedShards: 6,
  failedShards: 1,
  failureClasses: ['assertion'],
  fatalMarkers: [{
    shard: 1,
    handle: 'qa.cockpit-fixture',
    title: 'QA cockpit fixture records playback transcript',
    target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
    failureClass: 'crash',
    source: 'logTail',
    line: 'E2E_FATAL_RUNTIME_LOG scenario playback runtime crashed',
  }],
  args: { fixture: 'qa-cockpit-scenario-player' },
  shards: [
    {
      ...qaSignal('FAIL', 'qa.cockpit-fixture failed (assertion)', 'qa-shard'),
      shard: 1,
      status: 'failed',
      durationMs: 7_200,
      handle: 'qa.cockpit-fixture',
      description: 'Fixture run records a wallet scenario with synced transcript and video playback.',
      scenario: {
        summary10w: 'Authored cockpit evidence summary stays exact for central bank',
        owner: 'qa',
        severityPolicy: 'release-blocker',
        steps: [
          {
            title: 'Open wallet cockpit',
            text: 'Operator opens the QA cockpit and selects the failing run.',
            startMs: 0,
            endMs: 30,
            ms: 30,
          },
          {
            title: 'Select recorded shard',
            text: 'Operator selects the failed shard with recorded video evidence.',
            startMs: 30,
            endMs: 60,
            ms: 30,
          },
          {
            title: 'Sync transcript cue',
            text: 'Transcript cue follows the video clock at the real marker.',
            startMs: 60,
            endMs: 90,
            ms: 30,
          },
          {
            title: 'Enter theater playback',
            text: 'Operator opens full playback without losing failure context.',
            startMs: 90,
            endMs: 120,
            ms: 30,
          },
        ],
      },
      target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
      title: 'QA cockpit fixture records playback transcript',
      requireMarketMaker: false,
      logRelativePath: 'e2e-shard-01.log',
      logTail: 'Expected: scenario playback to render active cue\nReceived: no active cue',
      error: 'Expected: scenario playback to render active cue',
      failureClass: 'assertion',
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
        { label: 'E2E-TIMING:open wallet cockpit', ms: 30, startMs: 0, endMs: 30 },
        { label: 'E2E-TIMING:select recorded shard', ms: 30, startMs: 30, endMs: 60 },
        { label: 'E2E-TIMING:sync video subtitle transcript', ms: 30, startMs: 60, endMs: 90 },
        { label: 'E2E-TIMING:enter theater playback', ms: 30, startMs: 90, endMs: 120 },
      ],
      slowSteps: [
        { label: 'E2E-TIMING:enter theater playback', ms: 30, startMs: 90, endMs: 120 },
        { label: 'E2E-TIMING:sync video subtitle transcript', ms: 30, startMs: 60, endMs: 90 },
        { label: 'E2E-TIMING:select recorded shard', ms: 30, startMs: 30, endMs: 60 },
      ],
      artifacts: [
        {
          name: 'video.webm',
          relativePath: QA_FIXTURE_ARTIFACT,
          sizeBytes: 1024,
          kind: 'video',
          sensitivity: 'internal',
          contentType: 'video/webm',
          url: `/api/qa/artifact?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}&path=${encodeURIComponent(QA_FIXTURE_ARTIFACT)}`,
        },
        {
          name: 'cues.vtt',
          relativePath: 'test-results-shard-1/qa-cockpit-fixture/qa-cues/cues.vtt',
          sizeBytes: QA_FIXTURE_VTT.length,
          kind: 'text',
          sensitivity: 'public',
          contentType: 'text/vtt; charset=utf-8',
          url: `/api/qa/artifact?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}&path=${encodeURIComponent('test-results-shard-1/qa-cockpit-fixture/qa-cues/cues.vtt')}`,
        },
      ],
      hasVideo: true,
      hasTrace: false,
    },
    qaStoryVideoShard(
      2,
      'payment',
      'Payment flow prepares hub transfer',
      'Payment user story records a prepared hub payment with visible counterparty capacity.',
      'Payment evidence shows transfer capacity before signing',
    ),
    qaStoryVideoShard(
      3,
      'swap',
      'Swap flow quotes market-maker orderbook',
      'Swap user story records source token selection, quote side, and visible orderbook depth.',
      'Swap evidence shows quote and resting orderbook depth',
    ),
    qaStoryVideoShard(
      4,
      'cross-chain-swap',
      'Cross-chain swap route selects target hub',
      'Cross-chain swap user story records jurisdiction routing and target hub liquidity path.',
      'Cross-chain route evidence shows target hub selection',
    ),
    qaStoryVideoShard(
      5,
      'dispute',
      'Dispute flow opens challenge controls',
      'Dispute user story records account challenge controls and lifecycle evidence.',
      'Dispute evidence shows challenge controls and history',
    ),
    {
      ...qaSignal('OK', 'qa.deep-link-video passed', 'qa-shard'),
      shard: 7,
      status: 'passed',
      durationMs: 1_800,
      handle: 'qa.deep-link-video',
      description: 'Deep link opens the exact recorded video shard without falling back to the failed shard.',
      target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
      title: 'QA cockpit deep link opens exact video shard',
      requireMarketMaker: false,
      logRelativePath: 'e2e-shard-07.log',
      logTail: 'Deep link video shard passed',
      error: null,
      failureClass: null,
      phaseMs: {
        preflight: 50,
        anvilBoot: 100,
        apiBoot: 120,
        apiHealthy: 180,
        viteBoot: 200,
        playwright: 1_150,
      },
      browserIssues: [],
      browserHealth: QA_CLEAN_BROWSER_HEALTH,
      timelineSteps: [
        { label: 'E2E-TIMING:open deep link video shard', ms: 40, startMs: 0, endMs: 40 },
        { label: 'E2E-TIMING:verify selected shard playback', ms: 50, startMs: 40, endMs: 90 },
      ],
      slowSteps: [
        { label: 'E2E-TIMING:verify selected shard playback', ms: 50, startMs: 40, endMs: 90 },
      ],
      artifacts: [
        {
          name: 'video.webm',
          relativePath: 'test-results-shard-7/qa-cockpit-deep-link/video.webm',
          sizeBytes: 1024,
          kind: 'video',
          sensitivity: 'internal',
          contentType: 'video/webm',
          url: `/api/qa/artifact?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}&path=${encodeURIComponent('test-results-shard-7/qa-cockpit-deep-link/video.webm')}`,
        },
        {
          name: 'cues.vtt',
          relativePath: 'test-results-shard-7/qa-cockpit-deep-link/qa-cues/cues.vtt',
          sizeBytes: QA_FIXTURE_VTT.length,
          kind: 'text',
          sensitivity: 'public',
          contentType: 'text/vtt; charset=utf-8',
          url: `/api/qa/artifact?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}&path=${encodeURIComponent('test-results-shard-7/qa-cockpit-deep-link/qa-cues/cues.vtt')}`,
        },
      ],
      hasVideo: true,
      hasTrace: false,
    },
    {
      ...qaSignal('OK', 'qa.missing-video-empty-state passed', 'qa-shard'),
      shard: 9,
      status: 'passed',
      durationMs: 1_200,
      handle: 'qa.missing-video-empty-state',
      description: 'Shard has timing evidence and transcript but no recorded video artifact.',
      target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
      title: 'QA cockpit missing video empty state',
      requireMarketMaker: false,
      logRelativePath: 'e2e-shard-09.log',
      logTail: 'Missing video fixture passed with transcript only',
      error: null,
      failureClass: null,
      phaseMs: {
        preflight: 40,
        anvilBoot: 80,
        apiBoot: 120,
        apiHealthy: 160,
        viteBoot: 180,
        playwright: 620,
      },
      browserIssues: [],
      browserHealth: QA_CLEAN_BROWSER_HEALTH,
      timelineSteps: [
        { label: 'E2E-TIMING:render missing video empty state', ms: 60, startMs: 0, endMs: 60 },
        { label: 'E2E-TIMING:keep transcript available without video', ms: 70, startMs: 60, endMs: 130 },
      ],
      slowSteps: [
        { label: 'E2E-TIMING:keep transcript available without video', ms: 70, startMs: 60, endMs: 130 },
      ],
      artifacts: [],
      hasVideo: false,
      hasTrace: false,
    },
  ],
};

const QA_FIXTURE_SUMMARY = {
  ...QA_FIXTURE_RUN,
  shards: undefined,
  failingTargets: ['qa.cockpit-fixture'],
};

const QA_FAST_SUMMARY = {
  ...QA_FIXTURE_SUMMARY,
  ...qaSignal('OK', 'QA run is green', 'qa', Date.UTC(2026, 5, 23, 22, 59, 59, 888)),
  runId: QA_FAST_RUN_ID,
  createdAt: Date.UTC(2026, 5, 23, 22, 59, 59, 888),
  completedAt: Date.UTC(2026, 5, 23, 23, 0, 3, 888),
  status: 'passed',
  totalShards: 1,
  totalMs: 4_000,
  timing: QA_FAST_TIMING,
  browserHealth: QA_CLEAN_BROWSER_HEALTH,
  passedShards: 1,
  failedShards: 0,
  failureClasses: [],
  fatalMarkers: [],
  code: {
    ...QA_FIXTURE_RUN.code,
    gitHead: '95174ad2c2d9d8db1d7f07b6f4a4e9ec0c000000',
    codeHash: 'a3d0f1401f81e9c82268f0e217f514e2d7bc1ecf6f6a9d911c9da7e9d6400000',
  },
  benchmark: {
    ...QA_FIXTURE_RUN.benchmark,
    ...qaSignal('OK', 'Within thresholds vs baseline', 'benchmark', Date.UTC(2026, 5, 23, 22, 59, 59, 888)),
    status: 'ok',
    reason: 'Within thresholds vs baseline',
    metrics: [],
  },
  failingTargets: [],
};

const QA_FAIL_VERDICT = {
  ...qaSignal('FAIL', 'backend verdict: qa.cockpit-fixture', 'qa-system', QA_FIXTURE_RUN.createdAt, [
    { label: 'run', value: QA_FIXTURE_RUN_ID },
    { label: 'failed shards', value: 1 },
    { label: 'browser errors', value: 1 },
    { label: 'benchmark', value: 'slower' },
  ]),
  schemaVersion: 1,
  status: 'FAIL',
  activeCount: 3,
  failingSurfaceCount: 3,
  latestRunId: QA_FIXTURE_RUN_ID,
  latestAt: QA_FIXTURE_RUN.createdAt,
  gitHead: QA_FIXTURE_RUN.code.gitHead,
  codeHash: QA_FIXTURE_RUN.code.codeHash,
  dirty: false,
  regressionStatus: 'slower',
  browserErrorCount: 1,
  browserWarningCount: 2,
};

const QA_PASS_VERDICT = {
  ...qaSignal('OK', 'backend verdict: all green', 'qa-system', QA_FAST_SUMMARY.createdAt, [
    { label: 'run', value: QA_FAST_RUN_ID },
    { label: 'failed shards', value: 0 },
  ]),
  schemaVersion: 1,
  status: 'PASS',
  activeCount: 0,
  failingSurfaceCount: 0,
  latestRunId: QA_FAST_RUN_ID,
  latestAt: QA_FAST_SUMMARY.createdAt,
  gitHead: QA_FAST_SUMMARY.code.gitHead,
  codeHash: QA_FAST_SUMMARY.code.codeHash,
  dirty: false,
  regressionStatus: 'ok',
  browserErrorCount: 0,
  browserWarningCount: 0,
};

const QA_FAIL_LEDGER = {
  ...qaSignal('FAIL', '1/7 shard(s) failed', 'qa', QA_FIXTURE_RUN.createdAt),
  runId: QA_FIXTURE_RUN_ID,
  createdAt: QA_FIXTURE_RUN.createdAt,
  completedAt: QA_FIXTURE_RUN.completedAt,
  status: 'failed',
  category: 'e2e',
  suiteKey: 'fixture-suite',
  suiteLabel: 'qa.cockpit-fixture',
  gitHead: QA_FIXTURE_RUN.code.gitHead,
  gitBranch: QA_FIXTURE_RUN.code.gitBranch,
  codeHash: QA_FIXTURE_RUN.code.codeHash,
  dirty: false,
  startedBy: 'regulator-auditor',
  durationMs: QA_FIXTURE_RUN.totalMs,
  timing: QA_FIXTURE_TIMING,
  failedShard: 'qa.cockpit-fixture',
  failedTargets: ['qa.cockpit-fixture'],
  artifactBytes: 2048 + QA_FIXTURE_VTT.length,
  cpuP95Pct: 41.5,
  cpuPeakPct: QA_FIXTURE_RUN.perf.maxChildCpuPct,
  ramPeakKb: QA_FIXTURE_RUN.perf.maxChildRssKb,
  browserErrors: QA_FIXTURE_BROWSER_HEALTH.errorCount,
  browserWarnings: QA_FIXTURE_BROWSER_HEALTH.warningCount,
  networkFailures: QA_FIXTURE_BROWSER_HEALTH.networkFailureCount + QA_FIXTURE_BROWSER_HEALTH.httpErrorCount,
  benchmarkStatus: QA_FIXTURE_RUN.benchmark.status,
  benchmarkDeltaPct: 25,
  benchmarkComparedRunId: QA_FIXTURE_RUN.benchmark.comparedRunId,
  auditAction: 'release-gate',
};

const QA_FAST_LEDGER = {
  ...qaSignal('OK', 'QA run is green', 'qa', QA_FAST_SUMMARY.createdAt),
  runId: QA_FAST_RUN_ID,
  createdAt: QA_FAST_SUMMARY.createdAt,
  completedAt: QA_FAST_SUMMARY.completedAt,
  status: 'passed',
  category: 'e2e',
  suiteKey: 'fixture-fast-suite',
  suiteLabel: 'qa.cockpit-green',
  gitHead: QA_FAST_SUMMARY.code.gitHead,
  gitBranch: QA_FAST_SUMMARY.code.gitBranch,
  codeHash: QA_FAST_SUMMARY.code.codeHash,
  dirty: false,
  startedBy: 'runner',
  durationMs: QA_FAST_SUMMARY.totalMs,
  timing: QA_FAST_TIMING,
  failedShard: null,
  failedTargets: [],
  artifactBytes: 0,
  cpuP95Pct: null,
  cpuPeakPct: QA_FAST_SUMMARY.perf.maxChildCpuPct,
  ramPeakKb: QA_FAST_SUMMARY.perf.maxChildRssKb,
  browserErrors: 0,
  browserWarnings: 0,
  networkFailures: 0,
  benchmarkStatus: 'ok',
  benchmarkDeltaPct: 0,
  benchmarkComparedRunId: null,
  auditAction: null,
};

const QA_REGRESSION_REPORT = {
  ...qaSignal('FAIL', 'New failing target vs 20260623-225959-888: qa.cockpit-fixture', 'qa-regression', QA_FIXTURE_RUN.createdAt),
  status: 'failed',
  latestRunId: QA_FIXTURE_RUN_ID,
  suiteKey: 'fixture-suite',
  suiteLabel: 'qa.cockpit-fixture',
  comparisons: [
    {
      kind: 'previous',
      label: 'previous comparable',
      status: 'failed',
      comparedRunId: QA_FAST_RUN_ID,
      comparedGitHead: QA_FAST_SUMMARY.code.gitHead,
      comparedCodeHash: QA_FAST_SUMMARY.code.codeHash,
      reason: `New failing target vs ${QA_FAST_RUN_ID}: qa.cockpit-fixture`,
      metrics: [
        {
          metric: 'totalMs',
          label: 'wall time',
          unit: 'ms',
          current: QA_FIXTURE_RUN.totalMs,
          baseline: QA_FAST_SUMMARY.totalMs,
          delta: QA_FIXTURE_RUN.totalMs - QA_FAST_SUMMARY.totalMs,
          deltaPct: 80,
          thresholdPct: 20,
          verdict: 'slower',
        },
      ],
      newFailingTargets: ['qa.cockpit-fixture'],
      likelyCauses: ['new failing target: qa.cockpit-fixture', 'largest delta: wall time +80%'],
    },
    {
      kind: 'same-code-hash',
      label: 'previous same code hash',
      status: 'insufficient',
      comparedRunId: null,
      comparedGitHead: null,
      comparedCodeHash: null,
      reason: 'No previous same code hash baseline found',
      metrics: [],
      newFailingTargets: [],
      likelyCauses: [],
    },
    {
      kind: 'same-git-head',
      label: 'previous same HEAD',
      status: 'insufficient',
      comparedRunId: null,
      comparedGitHead: null,
      comparedCodeHash: null,
      reason: 'No previous same HEAD baseline found',
      metrics: [],
      newFailingTargets: [],
      likelyCauses: [],
    },
    {
      kind: 'last-green-main',
      label: 'last green on main',
      status: 'slower',
      comparedRunId: QA_FAST_RUN_ID,
      comparedGitHead: QA_FAST_SUMMARY.code.gitHead,
      comparedCodeHash: QA_FAST_SUMMARY.code.codeHash,
      reason: `wall time +80% vs ${QA_FAST_RUN_ID}`,
      metrics: [
        {
          metric: 'totalMs',
          label: 'wall time',
          unit: 'ms',
          current: QA_FIXTURE_RUN.totalMs,
          baseline: QA_FAST_SUMMARY.totalMs,
          delta: QA_FIXTURE_RUN.totalMs - QA_FAST_SUMMARY.totalMs,
          deltaPct: 80,
          thresholdPct: 20,
          verdict: 'slower',
        },
      ],
      newFailingTargets: [],
      likelyCauses: ['code hash changed', 'largest delta: wall time +80%'],
    },
  ],
};

const QA_TEST_LEDGER = [
  {
    testId: 'tests/e2e-wallet.spec.ts::creates a wallet',
    category: 'functional',
    target: 'tests/e2e-wallet.spec.ts',
    title: 'creates a wallet',
    description: 'Creates and unlocks a browser wallet.',
    status: 'passed',
    durationMs: 1_200,
    lastRunId: QA_FAST_RUN_ID,
    lastRunAt: Date.UTC(2026, 5, 23, 22, 59, 59),
  },
  {
    testId: 'tests/e2e-account.spec.ts::opens a hub account',
    category: 'functional',
    target: 'tests/e2e-account.spec.ts',
    title: 'opens a hub account',
    description: 'Connects the wallet to a live hub.',
    status: 'unknown',
    durationMs: null,
    lastRunId: QA_FAST_RUN_ID,
    lastRunAt: Date.UTC(2026, 5, 23, 23, 29, 59),
  },
  {
    testId: 'tests/e2e-recovery.spec.ts::restores after crash',
    category: 'resilience',
    target: 'tests/e2e-recovery.spec.ts',
    title: 'restores after crash',
    description: 'Kills and restores the persisted runtime.',
    status: 'failed',
    durationMs: 3_400,
    lastRunId: QA_FIXTURE_RUN_ID,
    lastRunAt: Date.UTC(2026, 5, 23, 23, 59, 59),
  },
] as const;

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
    status: QA_FIXTURE_RUN.status,
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

function qaFixtureStory(
  name: string,
  title: string,
  group: string,
  description: string,
  platform: 'desktop' | 'mobile',
  tags: string[],
) {
  const relativePath = `ux-gallery/${platform}/${name}`;
  return {
    id: `qa-run:${QA_FIXTURE_RUN_ID}:${relativePath}`,
    source: 'qa-run' as const,
    title,
    group,
    description,
    platform,
    tags,
    curated: true,
    name,
    relativePath,
    sizeBytes: QA_FIXTURE_PNG.length,
    updatedAt: QA_FIXTURE_RUN.completedAt,
    url: `/api/qa/artifact?runId=${QA_FIXTURE_RUN_ID}&path=${encodeURIComponent(relativePath)}`,
    runId: QA_FIXTURE_RUN_ID,
    shard: 1,
    status: 'passed' as const,
  };
}

const QA_STORIES = [
  qaFixtureStory(
    'desktop-accounts-pay.png',
    'desktop payment composer',
    'Payments',
    'User prepares a payment from an open hub account.',
    'desktop',
    ['payment', 'account'],
  ),
  qaFixtureStory(
    'mobile-iphone15pro-swap-base.png',
    'mobile swap ticket',
    'Swap',
    'Prepared cross-chain swap ticket with live orderbook depth.',
    'mobile',
    ['swap', 'orderbook'],
  ),
  qaFixtureStory(
    'desktop-accounts-move.png',
    'desktop on-chain batch composer',
    'On-chain Batch',
    'User prepares a reserve move before adding it to a batch.',
    'desktop',
    ['move', 'batch'],
  ),
  qaFixtureStory(
    'desktop-accounts-dispute-controls.png',
    'desktop dispute controls',
    'Disputes',
    'Account management panel for preparing and starting a dispute.',
    'desktop',
    ['dispute', 'account'],
  ),
  qaFixtureStory(
    'mobile-iphone15pro-accounts-history.png',
    'mobile on-chain batch history',
    'History',
    'Mobile history view for finalized and pending account batches.',
    'mobile',
    ['history', 'batch'],
  ),
  qaFixtureStory(
    'desktop-onboarding-seed.png',
    'desktop onboarding seed',
    'Onboarding',
    'New operator creates a browser runtime wallet.',
    'desktop',
    ['onboarding', 'wallet'],
  ),
  qaFixtureStory(
    'mobile-onboarding-seed.png',
    'mobile onboarding seed',
    'Onboarding',
    'Mobile operator creates a browser runtime wallet.',
    'mobile',
    ['onboarding', 'wallet'],
  ),
  qaFixtureStory(
    'desktop-assets-ledger.png',
    'desktop assets ledger',
    'Portfolio',
    'Portfolio ledger with external, reserve, and account balances.',
    'desktop',
    ['assets', 'balances'],
  ),
  qaFixtureStory(
    'mobile-assets-ledger.png',
    'mobile assets ledger',
    'Portfolio',
    'Mobile portfolio ledger with external, reserve, and account balances.',
    'mobile',
    ['assets', 'balances'],
  ),
  qaFixtureStory(
    'desktop-accounts-overview.png',
    'desktop accounts overview',
    'Accounts',
    'Hub account list with balances and counterparty capacity.',
    'desktop',
    ['accounts', 'credit'],
  ),
  qaFixtureStory(
    'mobile-accounts-overview.png',
    'mobile accounts overview',
    'Accounts',
    'Mobile hub account list with balances and counterparty capacity.',
    'mobile',
    ['accounts', 'credit'],
  ),
  qaFixtureStory(
    'desktop-accounts-receive.png',
    'desktop receive request',
    'Payments',
    'User prepares a receive invoice for inbound liquidity.',
    'desktop',
    ['payment', 'invoice'],
  ),
  qaFixtureStory(
    'mobile-accounts-pay.png',
    'mobile payment composer',
    'Payments',
    'Mobile user prepares a payment from an open hub account.',
    'mobile',
    ['payment', 'account'],
  ),
  qaFixtureStory(
    'desktop-swap-route-menu.png',
    'desktop swap route menu',
    'Swap',
    'Route selector for cross-chain liquidity paths.',
    'desktop',
    ['swap', 'route'],
  ),
  qaFixtureStory(
    'mobile-swap-route-menu.png',
    'mobile swap route menu',
    'Swap',
    'Mobile route selector for cross-chain liquidity paths.',
    'mobile',
    ['swap', 'route'],
  ),
  qaFixtureStory(
    'mobile-accounts-move.png',
    'mobile asset move ticket',
    'On-chain Batch',
    'Mobile move ticket for reserve, collateral, and external token flows.',
    'mobile',
    ['move', 'batch'],
  ),
  qaFixtureStory(
    'desktop-batch-queued.png',
    'desktop on-chain batch queued',
    'On-chain Batch',
    'Queued batch ready for on-chain submission.',
    'desktop',
    ['move', 'batch', 'queue'],
  ),
  qaFixtureStory(
    'mobile-dispute-controls.png',
    'mobile dispute controls',
    'Disputes',
    'Mobile account management panel for preparing and starting a dispute.',
    'mobile',
    ['dispute', 'account'],
  ),
  qaFixtureStory(
    'desktop-dispute-history.png',
    'desktop dispute history',
    'Disputes',
    'Dispute lifecycle history after finalization.',
    'desktop',
    ['dispute', 'history'],
  ),
  qaFixtureStory(
    'desktop-settings.png',
    'desktop wallet settings',
    'Settings',
    'Wallet settings and display controls for the runtime.',
    'desktop',
    ['settings'],
  ),
  qaFixtureStory(
    'mobile-settings.png',
    'mobile wallet settings',
    'Settings',
    'Mobile settings and display controls for the runtime.',
    'mobile',
    ['settings'],
  ),
  qaFixtureStory(
    'desktop-qa-cockpit.png',
    'desktop QA cockpit',
    'QA Cockpit',
    'Operator QA cockpit with run ledger, gallery, failures, and benchmarks.',
    'desktop',
    ['qa', 'cockpit', 'evidence'],
  ),
  qaFixtureStory(
    'mobile-qa-cockpit.png',
    'mobile QA cockpit',
    'QA Cockpit',
    'Mobile QA cockpit evidence view.',
    'mobile',
    ['qa', 'cockpit', 'evidence'],
  ),
  qaFixtureStory(
    'desktop-health-admin.png',
    'desktop health admin',
    'Health',
    'Health admin summary for runtime, relay, hubs, custody, and QA links.',
    'desktop',
    ['health', 'admin'],
  ),
  qaFixtureStory(
    'mobile-health-admin.png',
    'mobile health admin',
    'Health',
    'Mobile health admin summary for runtime and relay status.',
    'mobile',
    ['health', 'admin'],
  ),
  qaFixtureStory(
    'desktop-remote-runtime-import.png',
    'desktop remote runtime import',
    'Remote Runtime Import',
    'Dedicated remote runtime manager for bulk URL and token imports.',
    'desktop',
    ['remote-runtime', 'radapter', 'bulk-import'],
  ),
  qaFixtureStory(
    'mobile-remote-runtime-import.png',
    'mobile remote runtime import',
    'Remote Runtime Import',
    'Mobile remote runtime manager for bulk URL and token imports.',
    'mobile',
    ['remote-runtime', 'radapter', 'bulk-import'],
  ),
  qaFixtureStory(
    'desktop-time-machine.png',
    'desktop time machine',
    'Time Machine',
    'Workspace time machine enabled for historical frame scrubbing and replay.',
    'desktop',
    ['time-machine', 'debug', 'history'],
  ),
  qaFixtureStory(
    'mobile-time-machine.png',
    'mobile time machine',
    'Time Machine',
    'Mobile time machine enabled for historical frame scrubbing and replay.',
    'mobile',
    ['time-machine', 'debug', 'history'],
  ),
  qaFixtureStory(
    'desktop-history-ledger.png',
    'desktop history ledger',
    'History',
    'Desktop history ledger for finalized and pending account batches.',
    'desktop',
    ['history', 'batch'],
  ),
  qaFixtureStory(
    'desktop-swap-token-menu.png',
    'desktop swap token picker',
    'Swap',
    'Token selector with balances during swap preparation.',
    'desktop',
    ['swap', 'token-picker'],
  ),
  qaFixtureStory(
    'mobile-swap-token-menu.png',
    'mobile swap token picker',
    'Swap',
    'Mobile token selector with balances during swap preparation.',
    'mobile',
    ['swap', 'token-picker'],
  ),
  qaFixtureStory(
    'desktop-account-capacity.png',
    'desktop account capacity detail',
    'Accounts',
    'Expanded account row showing directional credit capacity.',
    'desktop',
    ['accounts', 'capacity'],
  ),
  qaFixtureStory(
    'mobile-account-capacity.png',
    'mobile account capacity detail',
    'Accounts',
    'Mobile expanded account row showing directional credit capacity.',
    'mobile',
    ['accounts', 'capacity'],
  ),
  qaFixtureStory(
    'mobile-receive-request.png',
    'mobile receive request',
    'Payments',
    'Mobile receive invoice for inbound liquidity.',
    'mobile',
    ['payment', 'invoice'],
  ),
];

const QA_RELEASE_PACK = {
  status: 'ready',
  minScreens: 30,
  curatedCount: QA_STORIES.length,
  desktopCount: QA_STORIES.filter(story => story.platform === 'desktop').length,
  mobileCount: QA_STORIES.filter(story => story.platform === 'mobile').length,
  requiredGroups: [
    'Onboarding',
    'Portfolio',
    'Accounts',
    'Payments',
    'Swap',
    'On-chain Batch',
    'Disputes',
    'History',
    'Settings',
    'QA Cockpit',
    'Health',
    'Remote Runtime Import',
    'Time Machine',
  ],
  presentGroups: Array.from(new Set(QA_STORIES.map(story => story.group))).sort(),
  missingGroups: [],
  missingReasons: [],
} as const;

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

const QA_ADMIN_HEALTH = {
  timestamp: Date.UTC(2026, 5, 24, 0, 1, 0),
  coreOk: true,
  systemOk: true,
  degraded: [],
  disk: {
    ok: true,
    minFreeBytes: 5 * 1024 ** 3,
    shortfallBytes: 0,
    freeBytes: 24 * 1024 ** 3,
    usedBytes: 76 * 1024 ** 3,
    totalBytes: 100 * 1024 ** 3,
    shortfallGiB: 0,
    freeGiB: 24,
    usedGiB: 76,
    totalGiB: 100,
    usedPct: 76,
  },
  storage: {
    ok: true,
    minFreeBytes: 5 * 1024 ** 3,
    shortfallBytes: 0,
    disk: {
      totalBytes: 100 * 1024 ** 3,
      usedBytes: 76 * 1024 ** 3,
      freeBytes: 24 * 1024 ** 3,
    },
    sampledAt: Date.UTC(2026, 5, 24, 0, 1, 0),
    historyPath: 'data/storage-health-history.json',
    tracked: [
      {
        name: 'runtimeDb',
        kind: 'db',
        path: '/Users/zigota/xln/db/runtime',
        currentBytes: 87_000_000,
        deltaBytes1h: 1_500_000,
        bytesPerHour: 1_500_000,
        sampleWindowMs: 3_600_000,
        scanEntries: 12,
        scanMs: 8,
        scanTruncated: false,
        scanMode: 'shallow',
      },
      {
        name: 'runtimeArtifacts',
        kind: 'log',
        path: '/Users/zigota/xln/.logs',
        currentBytes: 23_000_000,
        deltaBytes1h: 3_000_000,
        bytesPerHour: 3_000_000,
        sampleWindowMs: 3_600_000,
        scanEntries: 28,
        scanMs: 11,
        scanTruncated: false,
        scanMode: 'shallow',
      },
    ],
  },
  process: {
    pid: 4242,
    ownerId: 'orchestrator',
    uptimeSec: 120,
    rssBytes: 180_000_000,
    heapUsedBytes: 90_000_000,
    loadavg: [1.1, 1.4, 1.6],
    cpuCount: 10,
    memory: { freeBytes: 1_000_000_000, totalBytes: 8_000_000_000, freePct: 12.5 },
    children: [
      {
        role: 'hub',
        name: 'H1',
        pid: 4301,
        leasePid: 4301,
        leaseOwnerId: 'runtime-h1-abcdef',
        online: true,
        exitCode: null,
        startedAt: Date.UTC(2026, 5, 24, 0, 0, 0),
        exitedAt: null,
        restartCount: 0,
        apiPort: 8092,
        dbPath: '/Users/zigota/xln/db/dev/h1',
        lastErrorLine: null,
        recentStdout: [],
        recentStderr: [],
      },
      {
        role: 'hub',
        name: 'H2',
        pid: 4302,
        leasePid: 4302,
        leaseOwnerId: 'runtime-h2-fedcba',
        online: true,
        exitCode: null,
        startedAt: Date.UTC(2026, 5, 24, 0, 0, 0),
        exitedAt: null,
        restartCount: 0,
        apiPort: 8093,
        dbPath: '/Users/zigota/xln/db/dev/h2',
        lastErrorLine: null,
        recentStdout: [],
        recentStderr: [],
      },
    ],
  },
  hubs: [
    {
      entityId: 'hub-entity-h1',
      name: 'H1',
      online: true,
      runtimeId: 'runtime-h1-abcdef',
      selfRelayPresence: true,
      pid: 4301,
      apiPort: 8092,
      apiUrl: 'http://127.0.0.1:8092',
      dbPath: '/Users/zigota/xln/db/dev/h1',
      startedAt: Date.UTC(2026, 5, 24, 0, 0, 0),
      exitedAt: null,
      exitCode: null,
      restartCount: 0,
      lastErrorLine: null,
    },
  ],
  hubMesh: {
    ok: true,
    hubIds: ['hub-entity-h1', 'hub-entity-h2'],
    pairs: [
      { left: 'hub-entity-h1', right: 'hub-entity-h2', ok: true, expectedCreditAmount: '1000000' },
      { left: 'hub-entity-h2', right: 'hub-entity-h3', ok: true, expectedCreditAmount: '1000000' },
    ],
    direct: {
      openLinkCount: 2,
      links: [
        { fromRuntimeId: 'runtime-h1-abcdef', toRuntimeId: 'runtime-h2-fedcba', endpoint: 'ws://127.0.0.1:8093/rpc' },
      ],
    },
  },
  marketMaker: {
    enabled: true,
    ok: true,
    entityId: 'market-maker-entity',
    startupPhase: 'ready',
    expectedOffersPerHub: 4,
    expectedOffersPerPair: 2,
    cross: { applicable: true, ok: true, expectedRoutes: 2, routes: [] },
    hubs: [],
  },
  custody: {
    enabled: true,
    ok: true,
    entityId: 'custody-entity',
    daemonPort: 8720,
    servicePort: 8721,
  },
};

test.describe('QA cockpit scenario player', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/health', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(QA_ADMIN_HEALTH),
      });
    });
  });

  test('shows the standalone runs ledger across test surfaces', { tag: '@functional' }, async ({ page }) => {
    await page.route('**/api/qa/runs?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          runs: [QA_FIXTURE_SUMMARY, QA_FAST_SUMMARY],
          ledger: [QA_FAIL_LEDGER, QA_FAST_LEDGER],
          regression: QA_REGRESSION_REPORT,
          verdict: QA_FAIL_VERDICT,
        }),
      });
    });

    await page.goto('/runs');
    await expect(page.getByRole('heading', { name: 'Runs Ledger' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('runs-summary')).toContainText('Total');
    await expect(page.getByTestId('runs-summary')).toContainText('2');
    await expect(page.getByTestId('runs-ledger')).toContainText('qa.cockpit-fixture');
    await expect(page.getByTestId('runs-ledger')).toContainText('regulator-auditor');
    await expect(page.getByTestId('runs-ledger')).toContainText('release-gate');
    await expect(page.getByTestId('runs-ledger')).toContainText('browser 1 err / 2 warn / network 1');
    await expect(page.getByTestId('runs-ledger-row').first()).toHaveAttribute('data-run-id', QA_FIXTURE_RUN_ID);

    await page.getByTestId('runs-sort').selectOption('stack-fast');
    await expect(page.getByTestId('runs-ledger-row').first()).toHaveAttribute('data-run-id', QA_FAST_RUN_ID);

    await page.getByTestId('runs-search').fill('release-gate');
    await expect(page.getByTestId('runs-ledger-row')).toHaveCount(1);
    await expect(page.getByTestId('runs-open-qa')).toHaveAttribute('href', `/qa?runId=${QA_FIXTURE_RUN_ID}`);
  });

  test('shows and sorts the concrete Playwright test ledger', { tag: '@functional' }, async ({ page }, testInfo) => {
    await page.route('**/api/qa/runs?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          runs: [],
          ledger: [],
          testLedger: QA_TEST_LEDGER,
          regression: null,
          verdict: QA_PASS_VERDICT,
        }),
      });
    });
    await page.route('**/api/qa/catalog', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, qaAuth: QA_AUTH, catalog: [], restart: { active: false }, restartAllowed: false }),
      });
    });
    await page.route('**/api/qa/history?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, qaAuth: QA_AUTH, history: [], restart: { active: false }, restartAllowed: false }),
      });
    });
    await page.route('**/api/qa/restart-audit?**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, qaAuth: QA_AUTH, audit: [] }) });
    });
    await page.route('**/api/qa/stories?**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, qaAuth: QA_AUTH, stories: [] }) });
    });

    await page.goto('/qa');
    const ledger = page.getByTestId('qa-test-ledger');
    await expect(ledger).toBeVisible({ timeout: 30_000 });
    await expect(ledger.getByTestId('qa-test-ledger-row')).toHaveCount(3);
    await expect(ledger.getByTestId('qa-test-ledger-summary')).toContainText('3 total · 1 failed · 4.6 s');
    await expect(ledger.getByTestId('qa-test-ledger-summary')).toContainText('2 functional · 0 failed · 1.2 s');
    await expect(ledger.getByTestId('qa-test-ledger-summary')).toContainText('1 resilience · 1 failed · 3.4 s');
    await expect(ledger.locator('img')).toHaveCount(0);

    await ledger.getByTestId('qa-test-ledger-filters').getByRole('button', { name: 'Resilience 1' }).click();
    await expect(ledger.getByTestId('qa-test-ledger-row')).toHaveCount(1);
    await expect(ledger.getByTestId('qa-test-ledger-row').first()).toContainText('restores after crash');

    await ledger.getByTestId('qa-test-ledger-filters').getByRole('button', { name: 'Failed 1' }).click();
    await expect(ledger.getByTestId('qa-test-ledger-row')).toHaveCount(1);
    await expect(ledger.getByTestId('qa-test-ledger-row').first()).toHaveAttribute('data-status', 'failed');

    await ledger.getByTestId('qa-test-ledger-filters').getByRole('button', { name: 'All 3' }).click();
    await ledger.getByTestId('qa-test-sort-duration').click();
    await expect(ledger.getByTestId('qa-test-ledger-row').first()).toContainText('restores after crash');
    await ledger.getByTestId('qa-test-sort-duration').click();
    await expect(ledger.getByTestId('qa-test-ledger-row').first()).toContainText('creates a wallet');

    for (const column of ['category', 'test', 'description', 'status', 'last-run']) {
      await ledger.getByTestId(`qa-test-sort-${column}`).click();
      await expect(ledger.getByTestId(`qa-test-sort-${column}`).locator('..')).toHaveAttribute('aria-sort', /ascending|descending/);
    }

    for (const viewport of [
      { name: 'wide', width: 1600, height: 1000 },
      { name: 'laptop', width: 1280, height: 800 },
      { name: 'iphone', width: 393, height: 852 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(ledger).toBeVisible();
      const bounds = await ledger.boundingBox();
      expect(bounds, `${viewport.name} QA ledger must have layout bounds`).not.toBeNull();
      expect(bounds!.x, `${viewport.name} QA ledger must stay in the viewport`).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width, `${viewport.name} QA ledger must not overflow horizontally`)
        .toBeLessThanOrEqual(viewport.width + 1);
      await page.screenshot({
        path: testInfo.outputPath(`${viewport.name}-qa-test-ledger.png`),
        animations: 'disabled',
        fullPage: true,
      });
    }
  });

  test('plays recorded scenario videos with short copy and synced transcript', { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(90_000);
    let runsPayload = {
      ok: true,
      qaAuth: QA_AUTH,
      runs: [QA_FIXTURE_SUMMARY, QA_FAST_SUMMARY],
      ledger: [QA_FAIL_LEDGER, QA_FAST_LEDGER],
      regression: QA_REGRESSION_REPORT,
      verdict: QA_FAIL_VERDICT,
    };
    await page.route('**/api/qa/runs?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(runsPayload),
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
          releasePack: QA_RELEASE_PACK,
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
    await page.route('**/api/qa/history/backfill', async (route) => {
      const body = route.request().postDataJSON() as { confirm?: string };
      expect(body.confirm).toBe('BACKFILL_QA_HISTORY');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          result: {
            scannedRuns: 12,
            recordedRuns: 12,
            failedRuns: [],
          },
        }),
      });
    });
    await page.route('**/api/qa/artifact?**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const artifactPath = requestUrl.searchParams.get('path') || '';
      const isPng = artifactPath.endsWith('.png');
      const isVtt = artifactPath.endsWith('.vtt');
      await route.fulfill({
        status: 200,
        contentType: isPng ? 'image/png' : isVtt ? 'text/vtt; charset=utf-8' : 'video/webm',
        body: isPng ? QA_FIXTURE_PNG : isVtt ? QA_FIXTURE_VTT : QA_FIXTURE_WEBM,
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
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('backend verdict: qa.cockpit-fixture');
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('qa.cockpit-fixture');
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('3 failing surfaces');
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('benchmark SLOWER');
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('browser 1 err / 2 warn');
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('2026-06-23 23:59:59 UTC');
    await expect(page.getByText('circle = passed/total stacks')).toBeVisible();
    await expect(page.getByTestId('qa-verdict-explain')).toContainText('Root cause');
    await expect(page.getByTestId('qa-verdict-explain')).toContainText('Active reasons');
    await expect(page.getByTestId('qa-verdict-explain')).toContainText('Failing surfaces');
    await expect(page.getByTestId('qa-verdict-explain')).toContainText('Browser capture');
    await expect(page.getByTestId('qa-verdict-explain')).toContainText('1 err / 2 warn');
    await expect(page.getByTestId('qa-trend-pill').first()).toHaveText('1F/7');
    await expect(page.getByTestId('qa-trend-pill').nth(1)).toHaveText('1/1');
    await expect(page.getByTestId('qa-trend-pill').first()).toHaveAttribute('title', /FAIL 6\/7 stacks/);
    await expect(page.getByTestId('qa-admin-evidence-board')).toContainText('4 flows to inspect first');
    await expect(page.getByTestId('qa-admin-story-card')).toHaveCount(4);
    await expect(page.locator('[data-testid="qa-admin-story-card"][data-story-key="payment"]')).toContainText('qa.story.payment');
    await expect(page.locator('[data-testid="qa-admin-story-card"][data-story-key="swap"]')).toContainText('qa.story.swap');
    await expect(page.locator('[data-testid="qa-admin-story-card"][data-story-key="cross-chain-swap"]')).toContainText('qa.story.cross-chain-swap');
    await expect(page.locator('[data-testid="qa-admin-story-card"][data-story-key="dispute"]')).toContainText('qa.story.dispute');
    await expect
      .poll(async () => page.getByTestId('qa-story-video').count(), {
        timeout: 10_000,
        message: 'pre-mainnet user stories should expose four video cards',
      })
      .toBe(4);
    await expect(page.getByTestId('qa-story-video').first()).toHaveAttribute('src', /^blob:/);
    await expect(page.getByTestId('qa-storage-watchers')).toContainText('Who stores what');
    await expect(page.getByTestId('qa-storage-watchers')).toContainText('runtimeDb');
    await expect(page.getByTestId('qa-storage-watchers')).toContainText('/Users/zigota/xln/db/dev/h1');
    await expect(page.getByTestId('qa-storage-watchers')).toContainText('market-maker');
    await expect(page.getByTestId('qa-credit-line-evidence')).toContainText('1000000');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('browser');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('Browser health failed');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('assertion');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('failing shard');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('performance');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('SLOWER');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('Phase budget exceeded');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('playwright 5.7s > budget 5.0s');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('Fatal runtime marker');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('E2E_FATAL_RUNTIME_LOG scenario playback runtime crashed');
    await expect(page.getByTestId('qa-failure-class-filter')).toContainText('assertion');
    await page.getByTestId('qa-failure-class-filter').getByRole('button', { name: 'assertion' }).click();
    await expect(page.getByTestId('qa-run-row')).toHaveCount(1);
    await expect(page.getByTestId('qa-run-row').first()).toContainText('assertion');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('1 / 5 reasons');
    await expect(page.getByTestId('qa-failure-inbox')).not.toContainText('Browser health failed');
    await page.getByTestId('qa-failure-class-filter').getByRole('button', { name: 'all' }).click();
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('5 / 5 reasons');
    await expect(page.getByTestId('qa-failure-inbox')).toContainText('Browser health failed');
    await expect(page.getByTestId('qa-ux-gallery-preview')).toContainText('UX Screenshot Gallery');
    await expect(page.getByTestId('qa-ux-gallery-preview')).toContainText('desktop payment composer');
    await expect(page.getByTestId('qa-ux-gallery')).toBeVisible();
    await expect(page.getByTestId('qa-ux-gallery-count')).toContainText(`${QA_STORIES.length} curated`);
    await expect(page.getByTestId('qa-ux-release-pack')).toContainText('READY');
    await expect(page.getByTestId('qa-ux-release-pack')).toContainText(`${QA_STORIES.length}/30 screens`);
    await expect(page.getByTestId('qa-ux-gallery-count')).toContainText(`${QA_RELEASE_PACK.desktopCount} desktop`);
    await expect(page.getByTestId('qa-ux-gallery-count')).toContainText(`${QA_RELEASE_PACK.mobileCount} mobile`);
    await expect(page.getByTestId('qa-ux-gallery')).toContainText('On-chain Batch');
    await expect(page.getByTestId('qa-ux-gallery')).toContainText('Disputes');
    await expect(page.getByTestId('qa-ux-gallery')).toContainText('History');
    await page.getByTestId('qa-ux-gallery-card').filter({ hasText: 'desktop payment composer' }).click();
    await expect(page.getByTestId('qa-ux-slideshow')).toBeVisible();
    await expect(page.getByTestId('qa-ux-slideshow')).toContainText('desktop payment composer');
    await page.getByTestId('qa-ux-slideshow-next').click();
    await expect(page.getByTestId('qa-ux-slideshow')).toContainText('mobile swap ticket');
    await page.getByTestId('qa-ux-slideshow-prev').click();
    await expect(page.getByTestId('qa-ux-slideshow')).toContainText('desktop payment composer');
    await page.getByTestId('qa-ux-slideshow-close').click();
    await expect(page.getByTestId('qa-ux-slideshow')).toHaveCount(0);
    await page.locator('[data-testid="qa-admin-story-card"][data-story-key="payment"]').getByRole('button', { name: 'Open shard' }).click();
    await expect(page.locator('[data-testid="qa-suite-row"][data-shard="2"]')).toHaveClass(/selected/);
    await expect(page.getByTestId('qa-run-row').first()).toHaveAttribute('data-run-id', QA_FIXTURE_RUN_ID);
    await expect(page.getByTestId('qa-run-row').first()).toContainText('assertion');
    await page.getByTestId('qa-run-sort').selectOption('stack-fast');
    await expect(page.getByTestId('qa-run-row').first()).toHaveAttribute('data-run-id', QA_FAST_RUN_ID);
    await page.getByTestId('qa-run-sort').selectOption('date-desc');
    await expect(page.getByTestId('qa-run-row').first()).toHaveAttribute('data-run-id', QA_FIXTURE_RUN_ID);
    await page.getByTestId('qa-failure-item').filter({ hasText: 'Phase budget exceeded' }).click();
    await expect(page.locator('[data-testid="qa-suite-row"][data-shard="1"]')).toHaveClass(/selected/);
    await expect(page.locator('[data-testid="qa-phase-row"][data-phase="playwright"]')).toContainText('over budget');
    await page.getByTestId('qa-failure-class-filter').getByRole('button', { name: 'all' }).click();
    await page.getByTestId('qa-failure-item').filter({ hasText: 'Fatal runtime marker' }).click();
    await expect(page.locator('[data-testid="qa-suite-row"][data-shard="1"]')).toHaveClass(/selected/);
    await expect(page.locator('.shard-detail')).toContainText('qa.cockpit-fixture');
    await expect(page.getByTestId('qa-log-summary')).toContainText('fatal marker');
    await expect(page.getByTestId('qa-log-summary')).toContainText('E2E_FATAL_RUNTIME_LOG scenario playback runtime crashed');
    await page.getByTestId('qa-failure-class-filter').getByRole('button', { name: 'all' }).click();
    await page.getByTestId('qa-failure-item').first().click();
    await expect(page.locator(`[data-testid="qa-run-row"][data-run-id="${QA_FIXTURE_RUN_ID}"]`)).toHaveClass(/selected/);
    await expect(page.locator('[data-testid="qa-suite-row"][data-shard="1"]')).toHaveClass(/selected/);
    await expect(page.locator('.shard-detail')).toContainText('qa.cockpit-fixture');
    await expect(page.getByTestId('qa-log-summary')).toContainText('primary error');
    await expect(page.getByTestId('qa-log-summary')).toContainText('Expected: scenario playback to render active cue');
    await expect(page.getByTestId('qa-raw-log')).toHaveCount(0);
    await page.getByTestId('qa-raw-log-toggle').click();
    await expect(page.getByTestId('qa-raw-log')).toContainText('Received: no active cue');
    await page.getByTestId('qa-raw-log-toggle').click();
    await expect(page.getByTestId('qa-raw-log')).toHaveCount(0);
    await expect(page.getByTestId('qa-phase-waterfall')).toContainText('playwright');
    await expect(page.getByTestId('qa-phase-waterfall')).toContainText('7.2s');
    await expect(page.locator('[data-testid="qa-phase-row"][data-phase="playwright"]')).toContainText('5.7s');
    await expect(page.locator('[data-testid="qa-phase-row"][data-phase="playwright"]')).toContainText('budget 5.0s');
    await expect(page.locator('[data-testid="qa-phase-row"][data-phase="playwright"]')).toContainText('over budget');
    await expect(page.getByTestId('qa-video-player')).toBeVisible();
    const activeFailureCue = page.locator('[data-testid="qa-subtitle-cue"][aria-current="step"][data-failure-cue="true"]');
    await expect(activeFailureCue).toContainText('Failure');
    await expect(activeFailureCue).toContainText('Expected scenario playback to render active cue');
    await expect
      .poll(async () => page.getByTestId('qa-video-player').evaluate((node) => (node as HTMLVideoElement).currentTime), {
        timeout: 5_000,
        message: 'failure inbox should seek to the first failure cue',
      })
      .toBeGreaterThanOrEqual(0.1);

    await page.goto(`/qa?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}&shard=7`);
    await expect(page.locator(`[data-testid="qa-run-row"][data-run-id="${QA_FIXTURE_RUN_ID}"]`)).toHaveClass(/selected/, { timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`runId=${QA_FIXTURE_RUN_ID}.*shard=7`));
    await page.getByRole('button', { name: 'Runs Ledger' }).click();
    await expect(page.locator('[data-testid="qa-suite-row"][data-shard="7"]')).toHaveClass(/selected/);
    await expect(page.locator('.shard-detail')).toContainText('qa.deep-link-video');

    const errorsBeforeMissingVideo = runtimeErrors.length;
    await page.goto(`/qa?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}&shard=9`);
    await expect(page.locator(`[data-testid="qa-run-row"][data-run-id="${QA_FIXTURE_RUN_ID}"]`)).toHaveClass(/selected/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Runs Ledger' }).click();
    await expect(page.locator('[data-testid="qa-suite-row"][data-shard="9"]')).toHaveClass(/selected/);
    await expect(page.locator('[data-testid="qa-suite-row"][data-shard="9"]')).toHaveAttribute('data-has-video', 'false');
    await expect(page.locator('.shard-detail')).toContainText('qa.missing-video-empty-state');
    await expect(page.getByTestId('qa-video-missing')).toContainText('No recorded video for this shard');
    await expect(page.getByTestId('qa-video-player')).toHaveCount(0);
    await expect(page.getByTestId('qa-video-track')).toHaveCount(0);
    expect(runtimeErrors).toHaveLength(errorsBeforeMissingVideo);

    await page.getByRole('button', { name: 'Scenario Player' }).click();
    await expect(page.getByTestId('qa-scenario-player-frame')).toBeVisible();
    await page.getByRole('button', { name: 'UX Gallery' }).click();
    await expect(page.getByTestId('qa-ux-gallery-release-pack')).toContainText('release ready');
    await expect(page.getByTestId('qa-ux-gallery-filter')).toContainText('Remote Runtime Import');
    await page.getByTestId('qa-ux-gallery-filter').getByRole('button', { name: 'Remote Runtime Import' }).click();
    await expect(page.getByTestId('qa-ux-gallery')).toContainText('desktop remote runtime import');
    await expect(page.getByTestId('qa-ux-gallery')).not.toContainText('desktop payment composer');
    await page.getByTestId('qa-ux-gallery-filter').getByRole('button', { name: 'all' }).click();
    await expect(page.getByTestId('qa-ux-gallery')).toContainText('Payments');
    await expect(page.getByTestId('qa-ux-gallery')).toContainText('mobile swap ticket');
    await expect(page.getByTestId('qa-ux-gallery')).toContainText('desktop dispute controls');
    await expect(page.getByTestId('qa-ux-gallery-card').filter({ hasText: 'desktop' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Suites' }).click();
    await expect(page.getByTestId('qa-system-suites')).toContainText('Runtime Unit Tests');
    await expect(page.getByTestId('qa-system-suites')).toContainText('Contract Tests');
    await page.getByRole('button', { name: 'Benchmarks' }).click();
    await expect(page.getByTestId('qa-benchmarks')).toContainText('Swap Runtime TPS');
    await expect(page.getByTestId('qa-regression-comparator')).toContainText('Regression Comparator');
    await expect(page.getByTestId('qa-regression-comparator')).toContainText('FAIL');
    await expect(page.getByTestId('qa-regression-comparator')).toContainText('previous comparable');
    await expect(page.getByTestId('qa-regression-comparator')).toContainText('last green on main');
    await expect(page.getByTestId('qa-regression-comparator')).toContainText('new fail qa.cockpit-fixture');
    await expect(page.getByTestId('qa-regression-comparator')).toContainText('wall time +80.0%');
    await expect(page.locator('[data-testid="qa-regression-row"][data-kind="previous"]')).toContainText(QA_FAST_RUN_ID);
    await expect(page.getByTestId('qa-benchmarks')).toContainText('cpu 44.2%');
    await expect(page.getByTestId('qa-benchmarks')).toContainText('browser 1 err / 2 warn');
    await expect(page.getByTestId('qa-benchmarks')).toContainText('SLOWER +25.0%');
    await page.getByTestId('qa-test-tabs').getByRole('button', { name: 'Database' }).click();
    await expect(page.getByTestId('qa-history')).toContainText('head 95174ad2');
    await expect(page.getByTestId('qa-history')).toContainText('code b4e0f240');
    await expect(page.getByTestId('qa-history')).toContainText('browser 1 err / 2 warn');
    await expect(page.getByTestId('qa-history')).toContainText('SLOWER +25.0%');
    await expect(page.getByTestId('qa-run-ledger')).toHaveCount(0);
    await page.getByRole('button', { name: 'Runs Ledger' }).click();
    await expect(page.getByTestId('qa-run-ledger')).toContainText('Canonical Ledger');
    await expect(page.getByTestId('qa-run-ledger')).toContainText('qa.cockpit-fixture');
    await expect(page.getByTestId('qa-run-ledger')).toContainText('regulator-auditor');
    await expect(page.getByTestId('qa-run-ledger')).toContainText('release-gate');
    await expect(page.getByTestId('qa-run-ledger')).toContainText('cpu p95 41.5%');
    await expect(page.getByTestId('qa-run-ledger')).toContainText('browser 1 err / 2 warn');
    await expect(page.getByTestId('qa-run-ledger')).toContainText('network 1');
    await expect(page.getByTestId('qa-run-ledger')).toContainText('SLOWER +25.0%');
    await expect(page.getByTestId('qa-ledger-row').first()).toHaveAttribute('data-run-id', QA_FIXTURE_RUN_ID);
    await page.getByTestId('qa-test-tabs').getByRole('button', { name: 'Database' }).click();
    await expect(page.getByTestId('qa-history')).toContainText('regulator-auditor');
    await expect(page.getByTestId('qa-history')).toContainText('verify evidence playback');
    await expect(page.getByTestId('qa-history-backfill-card')).toContainText('Backfill History Index');
    await expect(page.getByTestId('qa-history-backfill')).toBeDisabled();
    await page.getByPlaceholder('BACKFILL_QA_HISTORY').fill('BACKFILL_QA_HISTORY');
    await expect(page.getByTestId('qa-history-backfill')).toBeEnabled();
    await page.getByTestId('qa-history-backfill').click();
    await expect(page.getByTestId('qa-history-backfill-result')).toContainText('scanned 12 / recorded 12 / failed 0');
    await expect(page.getByTestId('qa-retention-card')).toContainText('Delete Runs Older Than 30 Days');
    await expect(page.getByTestId('qa-retention-purge')).toBeDisabled();
    await page.getByPlaceholder('DELETE_OLDER_THAN_30_DAYS').fill('DELETE_OLDER_THAN_30_DAYS');
    await expect(page.getByTestId('qa-retention-purge')).toBeEnabled();
    await page.getByTestId('qa-retention-purge').click();
    await expect(page.getByTestId('qa-retention-result')).toContainText('deleted 1 log dirs / 1 history rows');
    await page.getByTestId('qa-history-sort').selectOption('stack-fast');
    await expect(page.getByTestId('qa-history-row').first()).toHaveAttribute('data-run-id', QA_FAST_RUN_ID);
    await page.getByRole('button', { name: 'Runs Ledger' }).click();
    await expect(page.getByTestId('qa-ledger-row').first()).toHaveAttribute('data-run-id', QA_FAST_RUN_ID);
    await page.getByTestId('qa-run-sort').selectOption('date-desc');
    await expect(page.getByTestId('qa-ledger-row').first()).toHaveAttribute('data-run-id', QA_FIXTURE_RUN_ID);
    await page.getByTestId('qa-test-tabs').getByRole('button', { name: 'Database' }).click();
    await expect(page.getByTestId('qa-history-row').first()).toHaveAttribute('data-run-id', QA_FIXTURE_RUN_ID);
    await page.getByRole('button', { name: 'Runs Ledger' }).click();
    await expect(page.locator('.run-summary')).toContainText('Benchmark');
    await expect(page.locator('.run-summary')).toContainText('wall time +25%');
    await expect(page.locator('.run-summary')).toContainText('Browser Health');
    await expect(page.locator('.run-summary')).toContainText('1 err / 2 warn');

    const previewCards = page.getByTestId('scenario-preview-card');
    await expect(previewCards.first()).toBeVisible({ timeout: 30_000 });

    const videoShard = page.getByTestId('qa-suite-row').first();
    await expect(videoShard).toHaveAttribute('data-has-video', 'true');
    await expect(videoShard).toContainText('assertion');
    await videoShard.click();

	    const watchPanel = page.getByTestId('qa-watch-panel');
	    const evidencePlaylist = page.getByTestId('qa-evidence-playlist');
	    await expect(evidencePlaylist).toContainText('Evidence Playlist');
	    await expect(evidencePlaylist.getByTestId('qa-playlist-row').first()).toHaveAttribute('data-selected', 'true');
	    await expect(evidencePlaylist.getByTestId('qa-playlist-row').first()).toContainText('1 video');
	    await expect(page.getByTestId('qa-browser-health')).toContainText('Unhandled promise rejection');
	    await expect(page.locator('.detail-artifacts')).toContainText('assertion');
	    await expect(page.getByTestId('qa-browser-health')).toContainText('HTTP 404');
	    await expect(watchPanel).toBeVisible();
	    await expect(page.getByTestId('qa-video-player')).toBeVisible();
	    await expect(page.getByTestId('qa-video-player')).toHaveAttribute('src', /^blob:/);
	    await expect(page.getByTestId('qa-video-track')).toHaveAttribute('src', /^blob:/);
	    await expect(page.getByTestId('qa-evidence-artifacts')).toContainText('Artifacts Below Playback');
	    await expect(page.getByTestId('qa-evidence-artifacts')).toContainText('No non-media artifact files captured');
    await expect(page.getByTestId('qa-evidence-artifacts')).not.toContainText('video.webm');
    await expect(page.getByTestId('qa-evidence-artifacts')).not.toContainText('cues.vtt');

    const shortDescription = (await page.getByTestId('qa-short-description').textContent())?.trim() ?? '';
    expect(shortDescription).toBe('Authored cockpit evidence summary stays exact for central bank');

    await page.getByRole('button', { name: 'Restart plan' }).click();
    await expect(page.getByTestId('qa-restart-plan')).toContainText('run-e2e-parallel-isolated');
    await expect(page.getByTestId('qa-restart-plan')).toContainText('Code hash changed');
    await expect(page.getByRole('button', { name: 'Restart run' })).toBeDisabled();

	    await expect(page.getByTestId('qa-scenario-transcript')).toBeVisible();
	    const videoBox = await page.getByTestId('qa-video-player').boundingBox();
	    const transcriptBox = await page.getByTestId('qa-scenario-transcript').boundingBox();
	    expect(videoBox).not.toBeNull();
	    expect(transcriptBox).not.toBeNull();
	    expect(transcriptBox!.x).toBeGreaterThan(videoBox!.x + videoBox!.width - 1);
	    await expect
	      .poll(async () => page.getByTestId('qa-subtitle-cue').count(), {
        timeout: 10_000,
        message: 'scenario transcript should expose multiple cues',
      })
      .toBeGreaterThan(2);

    await expect(page.getByTestId('qa-live-subtitle')).toBeVisible();
    await expect(page.getByTestId('qa-scenario-transcript')).not.toContainText('Preflight');
    await expect(page.getByTestId('qa-scenario-transcript')).not.toContainText('Health Gate');
    await expect(page.getByTestId('qa-subtitle-cue').nth(1)).toContainText('30ms-60ms');
    await expect(page.getByTestId('qa-subtitle-cue').nth(1)).toContainText('Select recorded shard');
    await expect(page.getByTestId('qa-subtitle-cue').nth(1)).toContainText('recorded video evidence');
    await page.getByTestId('qa-subtitle-cue').nth(1).click();
    await expect(page.locator('[data-testid="qa-subtitle-cue"][aria-current="step"]')).toBeVisible();
    await expect
      .poll(async () => page.getByTestId('qa-video-player').evaluate((node) => (node as HTMLVideoElement).currentTime), {
        timeout: 5_000,
        message: 'cue click should seek to video-clock offset',
      })
      .toBeGreaterThanOrEqual(0.02);

    await page.getByTestId('qa-theater-toggle').click();
    await expect(watchPanel).toHaveClass(/theater/);
    await page.getByTestId('qa-fullscreen-button').click();
    await expect(watchPanel).toHaveClass(/theater/);

    runsPayload = {
      ok: true,
      qaAuth: QA_AUTH,
      runs: [QA_FAST_SUMMARY],
      ledger: [QA_FAST_LEDGER],
      regression: {
        ...QA_REGRESSION_REPORT,
        ...qaSignal('OK', 'Within thresholds vs baseline', 'qa-regression', QA_FAST_SUMMARY.createdAt),
        status: 'ok',
        latestRunId: QA_FAST_RUN_ID,
        suiteLabel: 'qa.cockpit-green',
        comparisons: [],
      },
      verdict: QA_PASS_VERDICT,
    };
    await page.reload();
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('PASS', { timeout: 30_000 });
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('backend verdict: all green');
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('0 active reasons');
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('0 failing surfaces');
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('benchmark OK');
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('browser 0 err / 0 warn');
    await expect(page.getByTestId('qa-verdict-explain')).toContainText('No blocking QA signal is active.');

    expect(runtimeErrors).toEqual([]);
  });

  test('keeps QA evidence visible but privileged actions disabled in read mode', { tag: '@resilience' }, async ({ page }) => {
    test.setTimeout(60_000);
    let restartPlanCalled = false;
    let historyBackfillCalled = false;
    let retentionPurgeCalled = false;

    await page.route('**/api/qa/runs?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_READ_AUTH,
          runs: [QA_FIXTURE_SUMMARY],
          ledger: [QA_FAIL_LEDGER],
          regression: QA_REGRESSION_REPORT,
          verdict: QA_FAIL_VERDICT,
        }),
      });
    });
    await page.route('**/api/qa/run?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, qaAuth: QA_READ_AUTH, run: QA_FIXTURE_RUN }),
      });
    });
    await page.route('**/api/qa/catalog', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_READ_AUTH,
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
          qaAuth: QA_READ_AUTH,
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
        body: JSON.stringify({ ok: true, qaAuth: QA_READ_AUTH, audit: QA_RESTART_AUDIT }),
      });
    });
    await page.route('**/api/qa/stories?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_READ_AUTH,
          total: QA_STORIES.length,
          releasePack: QA_RELEASE_PACK,
          stories: QA_STORIES,
        }),
      });
    });
    await page.route('**/api/qa/restart?**', async (route) => {
      restartPlanCalled = true;
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, qaAuth: QA_READ_AUTH, error: 'QA_AUTH_ADMIN_REQUIRED' }),
      });
    });
    await page.route('**/api/qa/history/backfill', async (route) => {
      historyBackfillCalled = true;
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, qaAuth: QA_READ_AUTH, error: 'QA_AUTH_ADMIN_REQUIRED' }),
      });
    });
    await page.route('**/api/qa/retention', async (route) => {
      retentionPurgeCalled = true;
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, qaAuth: QA_READ_AUTH, error: 'QA_AUTH_ADMIN_REQUIRED' }),
      });
    });
    await page.route('**/api/qa/artifact?**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const artifactPath = requestUrl.searchParams.get('path') || '';
      const isPng = artifactPath.endsWith('.png');
      const isVtt = artifactPath.endsWith('.vtt');
      await route.fulfill({
        status: 200,
        contentType: isPng ? 'image/png' : isVtt ? 'text/vtt; charset=utf-8' : 'video/webm',
        body: isPng ? QA_FIXTURE_PNG : isVtt ? QA_FIXTURE_VTT : QA_FIXTURE_WEBM,
      });
    });

    await page.goto('/qa');
    await expect(page.getByTestId('qa-auth-panel')).toContainText('read', { timeout: 30_000 });
    await expect(page.getByTestId('qa-verdict-banner')).toContainText('FAIL');
    await expect(page.getByTestId('qa-ux-gallery-preview')).toBeVisible();

    await page.getByRole('button', { name: 'Runs Ledger' }).click();
    await expect(page.getByTestId('qa-run-row').first()).toHaveAttribute('data-run-id', QA_FIXTURE_RUN_ID);
    await page.getByTestId('qa-suite-row').first().click();
    await expect(page.getByTestId('qa-watch-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restart plan' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Restart run' })).toBeDisabled();

    await page.getByTestId('qa-test-tabs').getByRole('button', { name: 'Database' }).click();
    await expect(page.getByTestId('qa-history-backfill')).toBeDisabled();
    await page.getByPlaceholder('DELETE_OLDER_THAN_30_DAYS').fill('DELETE_OLDER_THAN_30_DAYS');
    await expect(page.getByTestId('qa-retention-purge')).toBeDisabled();

    expect(restartPlanCalled).toBe(false);
    expect(historyBackfillCalled).toBe(false);
    expect(retentionPurgeCalled).toBe(false);
  });

  test('enables restart run only after admin plan and typed confirmation', { tag: '@resilience' }, async ({ page }) => {
    test.setTimeout(60_000);
    let runRestartCalled = false;

    await page.route('**/api/qa/runs?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          runs: [QA_FIXTURE_SUMMARY],
          ledger: [QA_FAIL_LEDGER],
          regression: QA_REGRESSION_REPORT,
          verdict: QA_FAIL_VERDICT,
        }),
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
          restartAllowed: true,
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
          restartAllowed: true,
        }),
      });
    });
    await page.route('**/api/qa/restart-audit?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, qaAuth: QA_AUTH, audit: QA_RESTART_AUDIT }),
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
          releasePack: QA_RELEASE_PACK,
          stories: QA_STORIES,
        }),
      });
    });
    await page.route('**/api/qa/restart?**', async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.searchParams.get('mode') === 'run') runRestartCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          mode: requestUrl.searchParams.get('mode') ?? 'plan',
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
          restart: { active: false },
          restartAllowed: true,
        }),
      });
    });
    await page.route('**/api/qa/artifact?**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const artifactPath = requestUrl.searchParams.get('path') || '';
      const isPng = artifactPath.endsWith('.png');
      const isVtt = artifactPath.endsWith('.vtt');
      await route.fulfill({
        status: 200,
        contentType: isPng ? 'image/png' : isVtt ? 'text/vtt; charset=utf-8' : 'video/webm',
        body: isPng ? QA_FIXTURE_PNG : isVtt ? QA_FIXTURE_VTT : QA_FIXTURE_WEBM,
      });
    });

    await page.goto('/qa');
    await expect(page.getByTestId('qa-auth-panel')).toContainText('open', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Runs Ledger' }).click();
    await page.getByTestId('qa-suite-row').first().click();

    const restartRunButton = page.getByRole('button', { name: 'Restart run' });
    await expect(page.getByRole('button', { name: 'Restart plan' })).toBeEnabled();
    await expect(restartRunButton).toBeDisabled();

    await page.getByRole('button', { name: 'Restart plan' }).click();
    await expect(page.getByTestId('qa-restart-plan')).toContainText('run-e2e-parallel-isolated');
    await expect(restartRunButton).toBeDisabled();
    await page.getByPlaceholder('operator id').fill('operator-read-admin-test');
    await page.getByPlaceholder('why this rerun is needed').fill('verify admin restart enablement');
    await page.getByRole('textbox', { name: 'confirm' }).fill('RUN');
    await expect(restartRunButton).toBeEnabled();
    expect(runRestartCalled).toBe(false);
  });

  test('requires typed confirmation before aborting active restart', { tag: '@resilience' }, async ({ page }) => {
    test.setTimeout(60_000);
    let activeRestart = true;
    let abortConfirm = '';
    const restartStatus = () => activeRestart
      ? {
          active: true,
          auditId: 'fixture-restart-audit-active',
          pid: 4242,
          target: 'tests/e2e-qa-cockpit-fixture.spec.ts',
          title: 'QA cockpit fixture records playback transcript',
          startedAt: QA_FIXTURE_RUN.createdAt,
          timeoutMs: 300_000,
          killGraceMs: 5_000,
          terminating: false,
        }
      : { active: false };

    await page.route('**/api/qa/runs?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          runs: [QA_FIXTURE_SUMMARY],
          ledger: [QA_FAIL_LEDGER],
          regression: QA_REGRESSION_REPORT,
          verdict: QA_FAIL_VERDICT,
        }),
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
          restart: restartStatus(),
          restartAllowed: true,
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
          restart: restartStatus(),
          restartAllowed: true,
        }),
      });
    });
    await page.route('**/api/qa/restart-audit?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, qaAuth: QA_AUTH, audit: QA_RESTART_AUDIT }),
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
          releasePack: QA_RELEASE_PACK,
          stories: QA_STORIES,
        }),
      });
    });
    await page.route('**/api/qa/restart/abort', async (route) => {
      let body: { confirm?: string } = {};
      try {
        body = route.request().postDataJSON() as { confirm?: string };
      } catch {
        body = {};
      }
      abortConfirm = String(body.confirm || '');
      activeRestart = false;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          restart: restartStatus(),
          restartAllowed: true,
        }),
      });
    });
    await page.route('**/api/qa/artifact?**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const artifactPath = requestUrl.searchParams.get('path') || '';
      const isPng = artifactPath.endsWith('.png');
      const isVtt = artifactPath.endsWith('.vtt');
      await route.fulfill({
        status: 200,
        contentType: isPng ? 'image/png' : isVtt ? 'text/vtt; charset=utf-8' : 'video/webm',
        body: isPng ? QA_FIXTURE_PNG : isVtt ? QA_FIXTURE_VTT : QA_FIXTURE_WEBM,
      });
    });

    await page.goto('/qa');
    await expect(page.getByTestId('qa-auth-panel')).toContainText('open', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Suites' }).click();
    await expect(page.getByTestId('qa-restart-abort-card')).toContainText('Active restart');
    const abortButton = page.getByTestId('qa-restart-abort');
    await expect(abortButton).toBeDisabled();
    await page.getByPlaceholder('ABORT_RESTART').fill('NOPE');
    await expect(abortButton).toBeDisabled();
    await page.getByPlaceholder('ABORT_RESTART').fill('ABORT_RESTART');
    await expect(abortButton).toBeEnabled();
    await abortButton.click();
    await expect.poll(() => abortConfirm).toBe('ABORT_RESTART');
    await expect(page.getByTestId('qa-restart-abort-card')).toHaveCount(0);
  });

  test('windows large shard and artifact lists behind show-more controls', { tag: '@resilience' }, async ({ page }) => {
    test.setTimeout(60_000);
    const baseShard = QA_FIXTURE_RUN.shards[0]!;
    const largeArtifacts = Array.from({ length: 90 }, (_, index) => ({
      name: `artifact-${String(index + 1).padStart(3, '0')}.json`,
      relativePath: `test-results-shard-0/large/artifact-${index + 1}.json`,
      sizeBytes: 128 + index,
      kind: 'text',
      sensitivity: 'internal',
      contentType: 'application/json',
      url: `/api/qa/artifact?runId=${encodeURIComponent(QA_FIXTURE_RUN_ID)}&path=${encodeURIComponent(`test-results-shard-0/large/artifact-${index + 1}.json`)}`,
    }));
    const largeShards = Array.from({ length: 240 }, (_, index) => ({
      ...baseShard,
      shard: index,
      status: 'passed',
      durationMs: 700 + index,
      target: `large-shard-${index}`,
      logTail: `large shard ${index}`,
      artifacts: index === 0 ? largeArtifacts : [],
      hasVideo: false,
      hasTrace: false,
    }));
    const largeRun = {
      ...QA_FIXTURE_RUN,
      status: 'passed',
      passedShards: largeShards.length,
      failedShards: 0,
      totalShards: largeShards.length,
      failingTargets: [],
      shards: largeShards,
    };
    const largeSummary = {
      ...QA_FIXTURE_SUMMARY,
      status: 'passed',
      passedShards: largeShards.length,
      failedShards: 0,
      totalShards: largeShards.length,
      failingTargets: [],
      shards: undefined,
    };

    await page.route('**/api/qa/runs?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          qaAuth: QA_AUTH,
          runs: [largeSummary],
          ledger: [],
          regression: QA_REGRESSION_REPORT,
          verdict: QA_PASS_VERDICT,
        }),
      });
    });
    await page.route('**/api/qa/run?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, qaAuth: QA_AUTH, run: largeRun }),
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
          restartAllowed: true,
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
          history: [],
          restart: { active: false },
          restartAllowed: true,
        }),
      });
    });
    await page.route('**/api/qa/restart-audit?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, qaAuth: QA_AUTH, audit: [] }),
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
          releasePack: QA_RELEASE_PACK,
          stories: QA_STORIES,
        }),
      });
    });
    await page.route('**/api/qa/artifact?**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const artifactPath = requestUrl.searchParams.get('path') || '';
      const isPng = artifactPath.endsWith('.png');
      const isVtt = artifactPath.endsWith('.vtt');
      const isJson = artifactPath.endsWith('.json');
      await route.fulfill({
        status: 200,
        contentType: isPng ? 'image/png' : isVtt ? 'text/vtt; charset=utf-8' : isJson ? 'application/json' : 'video/webm',
        body: isPng
          ? QA_FIXTURE_PNG
          : isVtt
            ? QA_FIXTURE_VTT
            : isJson
              ? JSON.stringify({ ok: true, artifactPath })
              : QA_FIXTURE_WEBM,
      });
    });

    await page.goto('/qa');
    await expect(page.getByTestId('qa-auth-panel')).toContainText('open', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Runs Ledger' }).click();
    await expect(page.getByTestId('qa-suite-row')).toHaveCount(80);
    await expect(page.getByTestId('qa-shards-show-more')).toContainText('80/240');
    await page.getByTestId('qa-shards-show-more').click();
    await expect(page.getByTestId('qa-suite-row')).toHaveCount(160);
    await page.getByTestId('qa-shards-show-more').click();
    await expect(page.getByTestId('qa-suite-row')).toHaveCount(240);
    await expect(page.getByTestId('qa-shards-show-more')).toHaveCount(0);

    const artifactRows = page.locator('[data-testid="qa-evidence-artifacts"] .artifact-list button');
    await expect(artifactRows).toHaveCount(40);
    await expect(page.getByTestId('qa-artifacts-show-more')).toContainText('40/90');
    await page.getByTestId('qa-artifacts-show-more').click();
    await expect(artifactRows).toHaveCount(80);
    await page.getByTestId('qa-artifacts-show-more').click();
    await expect(artifactRows).toHaveCount(90);
    await expect(page.getByTestId('qa-artifacts-show-more')).toHaveCount(0);
  });
});
