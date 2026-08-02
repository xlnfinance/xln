import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  applyQaRunSeverity,
  assertQaReleaseRunSeverity,
  compareQaRunWithHistory,
  classifyQaArtifactSensitivity,
  classifyQaShardFailure,
  deriveQaTestDescription,
  deriveQaTestHandle,
  normalizeQaBrowserIssues,
  parseQaTimelineSteps,
  QA_RUN_MANIFEST_VERSION,
  redactQaSecretText,
  recordQaRunHistory,
  summarizeQaBrowserIssues,
  summarizeQaFailureClasses,
  summarizeQaRunBrowserHealth,
} from '../qa/report';
import { qaRunTestCategory } from '../qa/test-categories';
import type {
  QaArtifact,
  QaArtifactKind,
  QaBrowserIssue,
  QaRunManifest,
  QaSlowStep,
  QaTestCategory,
} from '../qa/types';
import { assertQaCandidateIdentity, buildQaCandidateIdentity } from '../qa/candidate';
import { compareStableText } from '../protocol/serialization';
import { tailLog } from './e2e-fatal-log-monitor';
import { parseJsonLinesStrict, parseJsonStrict } from './e2e-failure-capsule';
import { deriveE2EShardPaths, summarizePerfSamples } from './e2e-isolated-runtime';
import type { QaCodeFingerprint } from './e2e-isolated-runtime';
import type {
  CliArgs,
  E2EBrowserHealthCounters,
  E2EPrimaryFailureIdentity,
  E2EShardRunStatus,
  RunResult,
  RunTask,
} from './run-e2e-parallel-isolated';
import { LOCAL_TEST_PORT_POOL_VERSION } from './local-test-port-lease';

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null;

/**
 * Converts completed shard evidence into a durable QA manifest.
 *
 * Reporting can read artifacts but cannot control a test stack. This keeps a
 * report failure separate from the runtime behavior the shard was proving.
 */
export const buildE2EGateConfig = (args: CliArgs, tasks: readonly RunTask[]): Record<string, unknown> => ({
  schemaVersion: 1,
  runner: 'run-e2e-parallel-isolated',
  manifestVersion: QA_RUN_MANIFEST_VERSION,
  args: {
    shards: args.shards,
    portPool: LOCAL_TEST_PORT_POOL_VERSION,
    stackTimeoutMs: args.stackTimeoutMs,
    testTimeoutMs: args.testTimeoutMs,
    phaseWarnMs: args.phaseWarnMs,
    anvilBin: args.anvilBin,
    maxFailures: args.maxFailures,
    maxMmConcurrency: args.maxMmConcurrency,
    maxResetConcurrency: args.maxResetConcurrency,
    workersPerShard: args.workersPerShard,
    videoMode: args.videoMode,
    traceMode: args.traceMode,
    screenshotMode: args.screenshotMode,
    reporter: args.reporter,
    qaCategory: args.qaCategory ?? null,
    pwGrep: args.pwGrep ?? null,
    pwProject: args.pwProject ?? null,
    pwFiles: [...args.pwFiles],
    batchFiles: args.batchFiles,
    includeAllSpecs: args.includeAllSpecs,
    excludeMarketMaker: args.excludeMarketMaker,
    marketMakerOnly: args.marketMakerOnly,
    strictBrowserHealth: args.strictBrowserHealth,
    skipBuild: args.skipBuild,
    startAt: args.startAt,
    preserveArtifacts: args.preserveArtifacts,
    prewaitHealth: args.prewaitHealth,
  },
  tasks: tasks
    .slice()
    .sort((left, right) => left.shard - right.shard)
    .map(task => ({
      shard: task.shard,
      totalShards: task.totalShards,
      pwTargets: [...task.pwTargets],
      requireMarketMaker: task.requireMarketMaker,
      requireCustody: task.requireCustody,
      usePlaywrightShard: task.usePlaywrightShard,
      scenario: task.scenario,
      title: task.title ?? null,
      grep: task.grep ?? null,
      tags: [...task.tags].sort(compareStableText),
      testCategory: task.testCategory,
    })),
});

export const parseStepTimings = (path: string): QaSlowStep[] => {
  try {
    return parseQaTimelineSteps(readFileSync(path, 'utf8'));
  } catch (error) {
    console.warn(`[e2e] step timing unavailable path=${path}: ${String(error)}`);
    return [];
  }
};

const detectArtifactKind = (name: string): QaArtifactKind => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.webm')) return 'video';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image';
  if (lower.endsWith('.zip')) return 'trace';
  if (lower.endsWith('.vtt')) return 'text';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text';
  if (lower.endsWith('.tar') || lower.endsWith('.gz')) return 'archive';
  return 'other';
};

const detectArtifactContentType = (name: string): string => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
};

const artifactKindRank = (kind: QaArtifactKind): number => {
  if (kind === 'video') return 0;
  if (kind === 'image') return 1;
  if (kind === 'trace') return 2;
  if (kind === 'text') return 3;
  if (kind === 'json') return 4;
  if (kind === 'archive') return 5;
  return 6;
};

export const collectShardArtifacts = (logsDir: string, shard: number): QaArtifact[] => {
  const resultsDir = deriveE2EShardPaths(logsDir, shard).resultsDir;
  if (!existsSync(resultsDir)) return [];
  const artifacts: QaArtifact[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const fileStat = statSync(absolutePath);
      const relativePath = absolutePath.slice(logsDir.length + 1);
      const kind = detectArtifactKind(entry.name);
      const contentType = detectArtifactContentType(entry.name);
      artifacts.push({
        name: entry.name,
        relativePath,
        sizeBytes: fileStat.size,
        kind,
        sensitivity: classifyQaArtifactSensitivity({ name: entry.name, relativePath, kind, contentType }),
        contentType,
      });
    }
  };

  walk(resultsDir);
  return artifacts.sort(
    (a, b) => artifactKindRank(a.kind) - artifactKindRank(b.kind) || compareStableText(a.name, b.name),
  );
};

const formatWebVttTime = (ms: number): string => {
  const safeMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const millis = safeMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
};

const cleanCueText = (label: string): string =>
  String(label || '')
    .replace(/^(E2E-TIMING|MESH-TIMING):/i, '')
    .replace(/[_./:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const writeShardCueArtifacts = (logsDir: string, shard: number, steps: QaSlowStep[]): void => {
  const cues = steps
    .filter(step => Number.isFinite(Number(step.startMs)) && Number.isFinite(Number(step.endMs)))
    .map((step, index) => ({
      id: `cue-${String(index + 1).padStart(2, '0')}`,
      label: step.label,
      text: cleanCueText(step.label) || step.label,
      startMs: Math.max(0, Math.floor(Number(step.startMs))),
      endMs: Math.max(0, Math.floor(Number(step.endMs))),
      durationMs: Math.max(0, Math.floor(Number(step.ms))),
    }))
    .filter(cue => cue.endMs >= cue.startMs);
  if (cues.length === 0) return;

  const dir = join(deriveE2EShardPaths(logsDir, shard).resultsDir, 'qa-cues');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cues.json'), `${JSON.stringify({ cues }, null, 2)}\n`);
  const vtt = [
    'WEBVTT',
    '',
    ...cues.flatMap(cue => [
      cue.id,
      `${formatWebVttTime(cue.startMs)} --> ${formatWebVttTime(cue.endMs)}`,
      cue.text,
      '',
    ]),
  ].join('\n');
  writeFileSync(join(dir, 'cues.vtt'), vtt);
};

export const readShardLastRunStatus = (logsDir: string, shard: number): 'passed' | 'failed' | 'unknown' => {
  const lastRunPath = join(deriveE2EShardPaths(logsDir, shard).resultsDir, '.last-run.json');
  if (!existsSync(lastRunPath)) return 'unknown';
  const parsed = parseJsonStrict(readFileSync(lastRunPath, 'utf8'), lastRunPath);
  const status = isRecord(parsed) ? String(parsed['status'] ?? 'missing') : 'invalid-shape';
  if (status === 'passed' || status === 'failed') return status;
  throw new Error(`E2E_LAST_RUN_STATUS_INVALID:path=${lastRunPath}:status=${status}`);
};

export const resolveE2EShardManifestStatus = (
  resultStatus: E2EShardRunStatus,
  playwrightStatus: 'passed' | 'failed' | 'unknown',
): E2EShardRunStatus => {
  // Runner success is necessary; Playwright's terminal record is stronger
  // evidence whenever that record exists.
  if (resultStatus !== 'passed') return resultStatus;
  return playwrightStatus === 'unknown' ? resultStatus : playwrightStatus;
};

export const shardBrowserEventsPath = (logsDir: string, shard: number): string =>
  deriveE2EShardPaths(logsDir, shard).browserEventsPath;

export const readShardBrowserIssues = (logsDir: string, shard: number): QaBrowserIssue[] => {
  const eventsPath = shardBrowserEventsPath(logsDir, shard);
  if (!existsSync(eventsPath)) return [];
  const events = parseJsonLinesStrict(readFileSync(eventsPath, 'utf8'), eventsPath);
  const invalidIndex = events.findIndex(event => !isRecord(event));
  if (invalidIndex >= 0) {
    throw new Error(`E2E_BROWSER_EVENT_INVALID:path=${eventsPath}:record=${invalidIndex + 1}`);
  }
  return normalizeQaBrowserIssues(events).slice(0, 200);
};

export const assertE2EBrowserHealthGate = (health: E2EBrowserHealthCounters | undefined, strict: boolean): void => {
  if (!strict) return;
  if (!health) throw new Error('E2E_BROWSER_HEALTH_MANIFEST_MISSING');
  const counters = [
    health.issueCount,
    health.errorCount,
    health.warningCount,
    health.networkFailureCount,
    health.httpErrorCount,
  ];
  if (counters.some(value => !Number.isInteger(value) || value < 0)) {
    throw new Error(`E2E_BROWSER_HEALTH_MANIFEST_INVALID:${JSON.stringify(health)}`);
  }
  if (counters.some(value => value > 0)) {
    throw new Error(
      `E2E_BROWSER_HEALTH_GATE_FAILED:issues=${health.issueCount} errors=${health.errorCount} ` +
        `warnings=${health.warningCount} network=${health.networkFailureCount} http=${health.httpErrorCount}`,
    );
  }
};

export const readShardTitle = (logsDir: string, shard: number): string | null => {
  const resultsDir = deriveE2EShardPaths(logsDir, shard).resultsDir;
  if (!existsSync(resultsDir)) return null;
  const entry = readdirSync(resultsDir, { withFileTypes: true }).find(
    item => item.isDirectory() && !item.name.startsWith('.'),
  );
  return entry?.name ?? null;
};

export const writeRunManifest = (
  logsDir: string,
  args: CliArgs,
  results: RunResult[],
  tasks: readonly RunTask[],
  totalMs: number,
  createdAt: number,
  codeFingerprint: QaCodeFingerprint,
  primaryFailure: E2EPrimaryFailureIdentity | null,
): QaRunManifest => {
  const gateConfig = buildE2EGateConfig(args, tasks);
  const candidate = buildQaCandidateIdentity({
    gitHead: codeFingerprint.gitHead,
    codeHash: codeFingerprint.codeHash,
    gateConfig,
  });
  const taskByShard = new Map(tasks.map(task => [task.shard, task] as const));
  const shards = results
    .slice()
    .sort((a, b) => a.shard - b.shard)
    .map(result => {
      const task = taskByShard.get(result.shard);
      if (!task) throw new Error(`QA_RUN_TASK_MISSING:${result.shard}`);
      const timelineSteps = parseStepTimings(result.logPath).slice(0, 80);
      const slowSteps = timelineSteps
        .slice()
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 12);
      writeShardCueArtifacts(logsDir, result.shard, timelineSteps);
      const artifacts = collectShardArtifacts(logsDir, result.shard);
      const browserIssues = readShardBrowserIssues(logsDir, result.shard);
      const lastRunStatus = readShardLastRunStatus(logsDir, result.shard);
      const status = resolveE2EShardManifestStatus(result.status, lastRunStatus);
      // Redact before persistence. Published evidence must not rely on a later
      // UI layer to remove secrets.
      const logTail = redactQaSecretText(tailLog(result.logPath));
      const error = result.error ? redactQaSecretText(result.error) : null;
      return {
        candidateId: candidate.candidateId,
        gateConfigHash: candidate.gateConfigHash,
        shard: result.shard,
        portBase: result.portBase,
        status,
        resultClass: result.resultClass,
        durationMs: result.durationMs,
        handle: deriveQaTestHandle(result.target, result.title),
        description: deriveQaTestDescription(result.target, result.title),
        scenario: result.scenario,
        target: result.target,
        title: result.title || readShardTitle(logsDir, result.shard),
        tags: [...task.tags],
        testCategory: task.testCategory,
        requireMarketMaker: result.requireMarketMaker,
        requireCustody: result.requireCustody,
        error,
        diagnostics: (result.diagnostics ?? []).map(message => redactQaSecretText(message)),
        failureCapsule: result.failureCapsule ?? null,
        failureCapsuleRelativePath: result.failureCapsulePath ? relative(logsDir, result.failureCapsulePath) : null,
        failureClass: status === 'cancelled' ? null : classifyQaShardFailure({ status, error, logTail, browserIssues }),
        phaseMs: result.phaseMs,
        perf: result.perf,
        browserIssues,
        browserHealth: summarizeQaBrowserIssues(browserIssues, createdAt),
        timelineSteps,
        logRelativePath: result.logPath.slice(logsDir.length + 1),
        logTail,
        slowSteps,
        artifacts,
        hasVideo: artifacts.some(artifact => artifact.kind === 'video'),
        hasTrace: artifacts.some(artifact => artifact.kind === 'trace'),
      };
    });
  const passedShards = shards.filter(shard => shard.status === 'passed').length;
  const failedShards = shards.filter(shard => shard.status === 'failed').length;
  const cancelledShards = shards.filter(shard => shard.status === 'cancelled').length;
  const status: QaRunManifest['status'] = failedShards > 0 ? 'failed' : 'passed';
  const testCategories: QaTestCategory[] = [];
  for (const shard of shards) {
    if (!shard.testCategory) throw new Error(`QA_RUN_TEST_CATEGORY_REQUIRED:shard=${shard.shard}`);
    testCategories.push(shard.testCategory);
  }
  let manifest: QaRunManifest = applyQaRunSeverity({
    manifestVersion: QA_RUN_MANIFEST_VERSION,
    candidate,
    gateConfig,
    runId: logsDir.split('/').at(-1) || logsDir,
    createdAt,
    completedAt: Date.now(),
    status,
    testCategory: qaRunTestCategory(testCategories),
    totalMs,
    code: codeFingerprint,
    perf: summarizePerfSamples(shards.flatMap(shard => shard.perf?.samples ?? [])),
    browserHealth: summarizeQaRunBrowserHealth({ shards }),
    totalShards: shards.length,
    passedShards,
    failedShards,
    cancelledShards,
    primaryFailureShard: primaryFailure?.shard ?? null,
    primaryFailureCapsule: primaryFailure?.failureCapsule ?? null,
    failureClasses: summarizeQaFailureClasses(shards),
    args: {
      shards: args.shards,
      portPool: LOCAL_TEST_PORT_POOL_VERSION,
      workersPerShard: args.workersPerShard,
      maxFailures: args.maxFailures,
      phaseWarnMs: args.phaseWarnMs,
      videoMode: args.videoMode,
      traceMode: args.traceMode,
      screenshotMode: args.screenshotMode,
      pwFiles: args.pwFiles,
      pwGrep: args.pwGrep ?? null,
      pwProject: args.pwProject ?? null,
      qaCategory: args.qaCategory ?? null,
      strictBrowserHealth: args.strictBrowserHealth,
    },
    shards,
  });
  manifest.benchmark = compareQaRunWithHistory(manifest);
  manifest = applyQaRunSeverity(manifest);
  assertQaCandidateIdentity(manifest.candidate, manifest.gateConfig);
  assertQaReleaseRunSeverity(manifest);
  writeFileSync(join(logsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  recordQaRunHistory(manifest, logsDir);
  return manifest;
};

type QaRunBenchmark = NonNullable<QaRunManifest['benchmark']>;

export const formatBenchmarkMetric = (metric: QaRunBenchmark['metrics'][number]): string =>
  `${metric.label} ${metric.deltaPct > 0 ? '+' : ''}${metric.deltaPct}% (${metric.baseline}->${metric.current}${metric.unit})`;

export const printBenchmarkComparison = (benchmark: QaRunManifest['benchmark']): void => {
  if (!benchmark) return;
  console.log('-'.repeat(72));
  console.log(`Benchmark: ${benchmark.status.toUpperCase()} suite=${benchmark.suiteLabel}`);
  if (benchmark.comparedRunId) {
    console.log(
      `Compared : ${benchmark.comparedRunId} ` +
        `head=${benchmark.comparedGitHead?.slice(0, 12) ?? 'n/a'} ` +
        `code=${benchmark.comparedCodeHash?.slice(0, 16) ?? 'n/a'}`,
    );
  }
  console.log(`Reason   : ${benchmark.reason}`);
  const important = benchmark.metrics
    .filter(metric => metric.verdict !== 'ok')
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
    .slice(0, 6);
  if (important.length > 0) {
    console.log(`Deltas   : ${important.map(formatBenchmarkMetric).join(' | ')}`);
  }
  if (benchmark.likelyCauses.length > 0) {
    console.log(`Causes   : ${benchmark.likelyCauses.join(' | ')}`);
  }
};

export const publishQaRunIfConfigured = (logsDir: string): void => {
  const remoteBase = String(process.env['XLN_QA_PUBLISH_REMOTE'] || '').trim();
  if (!remoteBase) return;

  const runId = logsDir.split('/').at(-1) || 'run';
  const remoteTarget = `${remoteBase.replace(/\/+$/, '')}/${runId}/`;
  const startedAt = Date.now();
  const remoteMatch = remoteBase.match(/^([^:]+):(.+)$/);
  if (remoteMatch) {
    const remoteHost = remoteMatch[1];
    const remotePath = remoteMatch[2];
    if (!remoteHost || !remotePath) return;
    const mkdirResult = spawnSync('ssh', [remoteHost, 'mkdir', '-p', remotePath], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (mkdirResult.status !== 0) {
      const stderr = String(mkdirResult.stderr || '').trim();
      const stdout = String(mkdirResult.stdout || '').trim();
      console.warn(`[qa] publish mkdir failed target=${remoteBase} status=${mkdirResult.status ?? 'null'}`);
      if (stdout) console.warn(`[qa] publish mkdir stdout: ${stdout}`);
      if (stderr) console.warn(`[qa] publish mkdir stderr: ${stderr}`);
      return;
    }
  } else {
    mkdirSync(remoteBase, { recursive: true });
  }
  const result = spawnSync('rsync', ['-az', `${logsDir}/`, remoteTarget], {
    stdio: 'pipe',
    encoding: 'utf8',
  });

  if (result.status === 0) {
    console.log(`[qa] publish=${Date.now() - startedAt}ms target=${remoteTarget}`);
    return;
  }

  const stderr = String(result.stderr || '').trim();
  const stdout = String(result.stdout || '').trim();
  console.warn(`[qa] publish failed target=${remoteTarget} status=${result.status ?? 'null'}`);
  if (stdout) console.warn(`[qa] publish stdout: ${stdout}`);
  if (stderr) console.warn(`[qa] publish stderr: ${stderr}`);
};
