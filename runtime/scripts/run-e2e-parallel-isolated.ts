/**
 * Parallel Playwright runner with fully isolated local stacks per shard:
 * - dedicated anvil RPC
 * - dedicated runtime server
 * - dedicated vite preview server (single frontend build shared by all shards)
 *
 * Usage:
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --shards=3
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --base-port=20000
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --video=on --trace=on-first-retry --max-failures=1
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deriveQaTestDescription, deriveQaTestHandle } from '../qa-report';

type CliArgs = {
  shards: number;
  basePort: number;
  stackTimeoutMs: number;
  testTimeoutMs: number;
  phaseWarnMs: number;
  anvilBin: string;
  maxFailures: number;
  maxMmConcurrency: number;
  workersPerShard: number;
  videoMode: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
  traceMode: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
  screenshotMode: 'off' | 'on' | 'only-on-failure';
  reporter: 'line' | 'list' | 'dot';
  pwGrep?: string;
  pwProject?: string;
  pwFiles: string[];
  skipBuild: boolean;
};

type RunResult = {
  shard: number;
  status: 'passed' | 'failed';
  durationMs: number;
  logPath: string;
  target: string;
  title: string;
  requireMarketMaker: boolean;
  phaseMs: {
    preflight: number;
    anvilBoot: number;
    apiBoot: number;
    apiHealthy: number;
    viteBoot: number;
    playwright: number;
  };
  error?: string;
};

type RunTask = {
  shard: number;
  totalShards: number;
  pwTargets: string[];
  requireMarketMaker: boolean;
  usePlaywrightShard: boolean;
  title?: string;
  grep?: string;
};

type RunnerLockPayload = {
  pid: number;
  startedAt: number;
  cwd: string;
};

const parseArgs = (): CliArgs => {
  const args = process.argv.slice(2);
  const longMode = process.env.E2E_LONG === '1';
  const cpu = (() => {
    try {
      return Math.max(1, availableParallelism());
    } catch {
      return 8;
    }
  })();
  const defaultShards = Math.max(2, Math.min(8, Math.floor(cpu / 2)));
  const getFlag = (name: string): string | undefined => {
    const eq = args.find(a => a.startsWith(`--${name}=`));
    if (eq) return eq.split('=')[1];
    const i = args.findIndex(a => a === `--${name}`);
    if (i >= 0 && i + 1 < args.length) {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) return next;
    }
    return undefined;
  };

  const shardsRaw = Number(getFlag('shards') || String(defaultShards));
  const basePortRaw = Number(getFlag('base-port') || '20000');
  const defaultStackTimeoutMs = Math.min(420000, 180000 + Math.max(0, shardsRaw - 8) * 15000);
  const stackTimeoutRaw = Number(getFlag('stack-timeout-ms') || String(defaultStackTimeoutMs));
  const testTimeoutRaw = Number(getFlag('test-timeout-ms') || (longMode ? '1200000' : '360000'));
  const phaseWarnRaw = Number(getFlag('phase-warn-ms') || '30000');
  const maxFailuresRaw = Number(getFlag('max-failures') || '1');
  const maxMmConcurrencyRaw = Number(getFlag('max-mm-concurrency') || String(Math.min(2, shardsRaw || defaultShards)));
  const workersPerShardRaw = Number(getFlag('workers-per-shard') || '1');
  const videoRaw = String(getFlag('video') || 'on').toLowerCase();
  const traceRaw = String(getFlag('trace') || 'on-first-retry').toLowerCase();
  const screenshotRaw = String(getFlag('screenshot') || 'only-on-failure').toLowerCase();
  const reporterRaw = String(getFlag('reporter') || 'line').toLowerCase();
  const pwFiles = (getFlag('pw-files') || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const coerceVideo = (mode: string): CliArgs['videoMode'] =>
    mode === 'off' || mode === 'retain-on-failure' || mode === 'on-first-retry' ? mode : 'on';
  const coerceTrace = (mode: string): CliArgs['traceMode'] =>
    mode === 'off' || mode === 'on' || mode === 'retain-on-failure' ? mode : 'on-first-retry';
  const coerceScreenshot = (mode: string): CliArgs['screenshotMode'] =>
    mode === 'off' || mode === 'on' ? mode : 'only-on-failure';
  const coerceReporter = (mode: string): CliArgs['reporter'] => (mode === 'list' || mode === 'dot' ? mode : 'line');

  return {
    shards: Number.isFinite(shardsRaw) && shardsRaw > 0 ? Math.floor(shardsRaw) : 2,
    basePort: Number.isFinite(basePortRaw) && basePortRaw > 0 ? Math.floor(basePortRaw) : 20000,
    stackTimeoutMs: Number.isFinite(stackTimeoutRaw) && stackTimeoutRaw > 0 ? Math.floor(stackTimeoutRaw) : 180000,
    testTimeoutMs:
      Number.isFinite(testTimeoutRaw) && testTimeoutRaw > 0 ? Math.floor(testTimeoutRaw) : longMode ? 1200000 : 360000,
    phaseWarnMs: Number.isFinite(phaseWarnRaw) && phaseWarnRaw > 0 ? Math.floor(phaseWarnRaw) : 30000,
    anvilBin: getFlag('anvil-bin') || 'anvil',
    maxFailures: Number.isFinite(maxFailuresRaw) && maxFailuresRaw >= 0 ? Math.floor(maxFailuresRaw) : 1,
    maxMmConcurrency:
      Number.isFinite(maxMmConcurrencyRaw) && maxMmConcurrencyRaw > 0 ? Math.floor(maxMmConcurrencyRaw) : 2,
    workersPerShard: Number.isFinite(workersPerShardRaw) && workersPerShardRaw > 0 ? Math.floor(workersPerShardRaw) : 1,
    videoMode: coerceVideo(videoRaw),
    traceMode: coerceTrace(traceRaw),
    screenshotMode: coerceScreenshot(screenshotRaw),
    reporter: coerceReporter(reporterRaw),
    pwGrep: getFlag('pw-grep'),
    pwProject: getFlag('pw-project'),
    pwFiles,
    skipBuild: args.includes('--skip-build'),
  };
};

const RUNNER_LOCK_PATH = resolve(process.cwd(), '.logs', 'e2e-parallel', '.runner-lock.json');

const readRunnerLock = (): RunnerLockPayload | null => {
  try {
    return JSON.parse(readFileSync(RUNNER_LOCK_PATH, 'utf8')) as RunnerLockPayload;
  } catch {
    return null;
  }
};

const pidIsAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const acquireRunnerLock = (): (() => void) => {
  mkdirSync(resolve(process.cwd(), '.logs', 'e2e-parallel'), { recursive: true });
  const current: RunnerLockPayload = {
    pid: process.pid,
    startedAt: Date.now(),
    cwd: process.cwd(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(RUNNER_LOCK_PATH, JSON.stringify(current, null, 2), { flag: 'wx' });
      const release = () => {
        const active = readRunnerLock();
        if (!active || active.pid !== process.pid) return;
        try {
          unlinkSync(RUNNER_LOCK_PATH);
        } catch {}
      };
      process.once('exit', release);
      process.once('SIGINT', () => {
        release();
        process.exit(130);
      });
      process.once('SIGTERM', () => {
        release();
        process.exit(143);
      });
      return release;
    } catch {
      const existing = readRunnerLock();
      if (existing && pidIsAlive(existing.pid)) {
        throw new Error(`RUNNER_LOCKED pid=${existing.pid} startedAt=${existing.startedAt} path=${RUNNER_LOCK_PATH}`);
      }
      try {
        unlinkSync(RUNNER_LOCK_PATH);
      } catch {}
    }
  }

  throw new Error(`RUNNER_LOCK_FAILED path=${RUNNER_LOCK_PATH}`);
};

const tsTag = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
};

const tail = (path: string, lines = 60): string => {
  try {
    const text = readFileSync(path, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '(unable to read log tail)';
  }
};

const assertRunnerPreflight = async (): Promise<void> => {
  const typechainIndex = resolve(process.cwd(), 'jurisdictions', 'typechain-types', 'index.ts');
  if (!existsSync(typechainIndex)) {
    throw new Error(`RUNNER_PREFLIGHT_FAILED missing ${typechainIndex}`);
  }
  await import(resolve(process.cwd(), 'runtime', 'jadapter', 'browservm.ts'));
};

type StepTiming = { label: string; ms: number };

const parseStepTimings = (path: string): StepTiming[] => {
  try {
    const text = readFileSync(path, 'utf8');
    const out: StepTiming[] = [];
    const re = /\[(E2E-TIMING|MESH-TIMING)\]\s+(.+?)\s+(\d+)ms/g;
    let match: RegExpExecArray | null = null;
    while ((match = re.exec(text)) !== null) {
      const prefix = String(match[1] || '').trim();
      const label = `${prefix}:${String(match[2] || '').trim()}`;
      const ms = Number(match[3] || '0');
      if (!label || !Number.isFinite(ms)) continue;
      out.push({ label, ms });
    }
    return out;
  } catch {
    return [];
  }
};

const detectArtifactKind = (name: string): 'video' | 'image' | 'trace' | 'json' | 'text' | 'archive' | 'other' => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.webm')) return 'video';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image';
  if (lower.endsWith('.zip')) return 'trace';
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
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
};

const artifactKindRank = (kind: string): number => {
  if (kind === 'video') return 0;
  if (kind === 'image') return 1;
  if (kind === 'trace') return 2;
  if (kind === 'text') return 3;
  if (kind === 'json') return 4;
  if (kind === 'archive') return 5;
  return 6;
};

const collectShardArtifacts = (
  logsDir: string,
  shard: number,
): Array<{ name: string; relativePath: string; sizeBytes: number; kind: string; contentType: string }> => {
  const resultsDir = join(logsDir, `test-results-shard-${shard}`);
  if (!existsSync(resultsDir)) return [];
  const artifacts: Array<{ name: string; relativePath: string; sizeBytes: number; kind: string; contentType: string }> =
    [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const fileStat = statSync(absolutePath);
      artifacts.push({
        name: entry.name,
        relativePath: absolutePath.slice(logsDir.length + 1),
        sizeBytes: fileStat.size,
        kind: detectArtifactKind(entry.name),
        contentType: detectArtifactContentType(entry.name),
      });
    }
  };

  walk(resultsDir);
  return artifacts.sort((a, b) => artifactKindRank(a.kind) - artifactKindRank(b.kind) || a.name.localeCompare(b.name));
};

const readShardLastRunStatus = (logsDir: string, shard: number): 'passed' | 'failed' | 'unknown' => {
  const lastRunPath = join(logsDir, `test-results-shard-${shard}`, '.last-run.json');
  if (!existsSync(lastRunPath)) return 'unknown';
  try {
    const parsed = JSON.parse(readFileSync(lastRunPath, 'utf8')) as { status?: unknown };
    return parsed.status === 'passed' || parsed.status === 'failed' ? parsed.status : 'unknown';
  } catch {
    return 'unknown';
  }
};

const readShardTitle = (logsDir: string, shard: number): string | null => {
  const resultsDir = join(logsDir, `test-results-shard-${shard}`);
  if (!existsSync(resultsDir)) return null;
  const entry = readdirSync(resultsDir, { withFileTypes: true }).find(
    item => item.isDirectory() && !item.name.startsWith('.'),
  );
  return entry?.name ?? null;
};

const writeRunManifest = (
  logsDir: string,
  args: CliArgs,
  results: RunResult[],
  totalMs: number,
  createdAt: number,
): void => {
  const shards = results
    .slice()
    .sort((a, b) => a.shard - b.shard)
    .map(result => {
      const slowSteps = parseStepTimings(result.logPath)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 12);
      const artifacts = collectShardArtifacts(logsDir, result.shard);
      return {
        shard: result.shard,
        status:
          readShardLastRunStatus(logsDir, result.shard) === 'unknown'
            ? result.status
            : readShardLastRunStatus(logsDir, result.shard),
        durationMs: result.durationMs,
        handle: deriveQaTestHandle(result.target, result.title),
        description: deriveQaTestDescription(result.target, result.title),
        target: result.target,
        title: result.title || readShardTitle(logsDir, result.shard),
        requireMarketMaker: result.requireMarketMaker,
        error: result.error ?? null,
        phaseMs: result.phaseMs,
        logRelativePath: result.logPath.slice(logsDir.length + 1),
        slowSteps,
        artifacts,
        hasVideo: artifacts.some(artifact => artifact.kind === 'video'),
        hasTrace: artifacts.some(artifact => artifact.kind === 'trace'),
      };
    });
  const passedShards = shards.filter(shard => shard.status === 'passed').length;
  const failedShards = shards.filter(shard => shard.status === 'failed').length;
  const manifest = {
    manifestVersion: 1,
    runId: logsDir.split('/').at(-1) || logsDir,
    createdAt,
    completedAt: Date.now(),
    status: failedShards > 0 ? 'failed' : 'passed',
    totalMs,
    totalShards: shards.length,
    passedShards,
    failedShards,
    args: {
      shards: args.shards,
      basePort: args.basePort,
      workersPerShard: args.workersPerShard,
      maxFailures: args.maxFailures,
      phaseWarnMs: args.phaseWarnMs,
      videoMode: args.videoMode,
      traceMode: args.traceMode,
      screenshotMode: args.screenshotMode,
      pwFiles: args.pwFiles,
      pwGrep: args.pwGrep ?? null,
      pwProject: args.pwProject ?? null,
    },
    shards,
  };
  writeFileSync(join(logsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
};

const publishQaRunIfConfigured = (logsDir: string): void => {
  const remoteBase = String(process.env.XLN_QA_PUBLISH_REMOTE || '').trim();
  if (!remoteBase) return;

  const runId = logsDir.split('/').at(-1) || 'run';
  const remoteTarget = `${remoteBase.replace(/\/+$/, '')}/${runId}/`;
  const startedAt = Date.now();
  const remoteMatch = remoteBase.match(/^([^:]+):(.+)$/);
  if (remoteMatch) {
    const [, remoteHost, remotePath] = remoteMatch;
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

type PlaywrightTarget = {
  target: string;
  requireMarketMaker: boolean;
  title?: string;
  grep?: string;
};

const extractTopLevelTestTitle = (line: string): string | undefined => {
  const match = line.match(/^\s*test(?:\.(?:only|fail))?\(\s*(['"`])((?:\\.|.)*?)\1/);
  return match?.[2]?.replace(/\\(['"`])/g, '$1').trim() || undefined;
};

const buildGrepMatcher = (grep: string): ((entry: PlaywrightTarget) => boolean) => {
  try {
    const pattern = new RegExp(grep);
    return entry => pattern.test(entry.title || entry.target);
  } catch {
    const needle = grep.toLowerCase();
    return entry => `${entry.title || ''} ${entry.target}`.toLowerCase().includes(needle);
  }
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const collectSpecsFromSuite = (suite: any, out: Array<{ title: string; file?: string; line?: number }>): void => {
  for (const spec of suite?.specs ?? []) {
    const title = String(spec?.title || '').trim();
    if (!title) continue;
    out.push({
      title,
      file: typeof spec?.file === 'string' ? spec.file : undefined,
      line: Number.isFinite(Number(spec?.line)) ? Number(spec.line) : undefined,
    });
  }
  for (const child of suite?.suites ?? []) collectSpecsFromSuite(child, out);
};

const listDynamicPlaywrightTargets = (
  file: string,
  requiresMarketMaker: (file: string) => boolean,
): PlaywrightTarget[] => {
  const env = {
    ...process.env,
    PW_SKIP_WEBSERVER: '1',
    PW_BASE_URL: process.env['PW_BASE_URL'] || 'https://localhost:1',
    E2E_BASE_URL: process.env['E2E_BASE_URL'] || 'https://localhost:1',
    E2E_API_BASE_URL: process.env['E2E_API_BASE_URL'] || 'http://127.0.0.1:1',
    E2E_ANVIL_RPC: process.env['E2E_ANVIL_RPC'] || 'http://127.0.0.1:1',
    E2E_RESET_BASE_URL: process.env['E2E_RESET_BASE_URL'] || 'http://127.0.0.1:1',
  };
  const res = Bun.spawnSync(
    ['bunx', 'playwright', 'test', '--config', 'playwright.config.ts', '--list', '--reporter=json', file],
    {
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const stdout = Buffer.from(res.stdout).toString('utf8').trim();
  let parsed: any = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const stderr = Buffer.from(res.stderr).toString('utf8').trim();
    throw new Error(`Failed to list tests for ${file}: ${stderr || stdout || `exit=${String(res.exitCode)}`}`);
  }
  const specs: Array<{ title: string; file?: string; line?: number }> = [];
  for (const suite of parsed?.suites ?? []) collectSpecsFromSuite(suite, specs);
  if (specs.length === 0) {
    throw new Error(`No isolated tests discovered for ${file}`);
  }
  return specs.map(spec => ({
    target: file,
    requireMarketMaker: requiresMarketMaker(file),
    title: spec.title,
    grep: escapeRegExp(spec.title),
  }));
};

const expandPlaywrightTargets = (pwFiles: string[]): PlaywrightTarget[] => {
  const out: PlaywrightTarget[] = [];
  const requiresMarketMaker = (file: string): boolean => /e2e-swap\.spec\.ts$/.test(file);
  const unsplittableSpecs = new Set<string>();
  const updateBraceDepth = (line: string, depth: number): number => {
    let next = depth;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let escaped = false;

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i] || '';
      const nxt = line[i + 1] || '';

      if (!inSingle && !inDouble && !inTemplate && ch === '/' && nxt === '/') break;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (!inDouble && !inTemplate && ch === "'") {
        inSingle = !inSingle;
        continue;
      }
      if (!inSingle && !inTemplate && ch === '"') {
        inDouble = !inDouble;
        continue;
      }
      if (!inSingle && !inDouble && ch === '`') {
        inTemplate = !inTemplate;
        continue;
      }
      if (inSingle || inDouble || inTemplate) continue;
      if (ch === '{') next += 1;
      else if (ch === '}') next = Math.max(0, next - 1);
    }

    return next;
  };

  for (const file of pwFiles) {
    const explicitLineTarget = file.match(/^(.+\.spec\.ts):\d+(?::\d+)?$/);
    if (explicitLineTarget) {
      const sourceFile = explicitLineTarget[1]!;
      out.push({
        target: file,
        requireMarketMaker: requiresMarketMaker(sourceFile),
        title: file,
      });
      continue;
    }

    if (unsplittableSpecs.has(file)) {
      out.push({
        target: file,
        requireMarketMaker: requiresMarketMaker(file),
        title: file,
      });
      continue;
    }

    const absolute = resolve(process.cwd(), file);
    const text = readFileSync(absolute, 'utf8');
    const lines = text.split('\n');
    let added = 0;
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      const matchesTopLevelTest = braceDepth <= 1 && /^\s*test(?:\.(?:only|fail))?\(/.test(line);
      if (matchesTopLevelTest) {
        out.push({
          target: `${file}:${i + 1}`,
          requireMarketMaker: requiresMarketMaker(file),
          title: extractTopLevelTestTitle(line) || `${file}:${i + 1}`,
        });
        added += 1;
      }
      braceDepth = updateBraceDepth(line, braceDepth);
    }
    if (added === 0) {
      out.push(...listDynamicPlaywrightTargets(file, requiresMarketMaker));
    }
  }
  return out;
};

const listPlaywrightSpecFiles = (): string[] => {
  const excludedDefaultSpecs = new Set<string>([
    // Legacy shared-page AHB flow. Useful assertions were ported into
    // tests/e2e-ahb-isolated.spec.ts; keep this out of the canonical isolated bar.
    'tests/e2e-ahb-payment.spec.ts',
    // Keep the default bar focused on fast isolated product checks.
    'tests/e2e-multiroute-load.spec.ts',
    'tests/e2e-runtime-persistence.spec.ts',
  ]);
  const res = Bun.spawnSync(['rg', '--files', 'tests'], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const text = Buffer.from(res.stdout).toString('utf8');
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.endsWith('.spec.ts'))
    .filter(line => !excludedDefaultSpecs.has(line))
    .sort();
};

const waitForProcessExit = async (proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> => {
  if (proc.exitCode !== null) return true;
  return await new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('exit', onExit);
      proc.off('close', onClose);
      resolve(value);
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(proc.exitCode !== null), timeoutMs);
    proc.once('exit', onExit);
    proc.once('close', onClose);
  });
};

const stopProcess = async (proc: ChildProcessWithoutNullStreams | null): Promise<void> => {
  if (!proc || proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    return;
  }
  const exitedAfterTerm = await waitForProcessExit(proc, 1200);
  if (exitedAfterTerm || proc.exitCode !== null) return;
  try {
    proc.kill('SIGKILL');
  } catch {
    return;
  }
  await waitForProcessExit(proc, 1200);
};

const pidsOnPort = (port: number): number[] => {
  const res = Bun.spawnSync(['lsof', '-ti', `tcp:${port}`], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const text = Buffer.from(res.stdout).toString('utf8').trim();
  if (!text) return [];
  return text
    .split(/\s+/)
    .map(v => Number(v))
    .filter(v => Number.isFinite(v) && v > 0);
};

const freePort = async (port: number, log?: ReturnType<typeof createWriteStream>): Promise<void> => {
  const first = pidsOnPort(port).filter(pid => pid !== process.pid);
  if (first.length === 0) return;

  log?.write(`[preflight] port ${port} busy by pids=${first.join(',')} -> SIGTERM\n`);
  for (const pid of first) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  await delay(300);

  const second = pidsOnPort(port).filter(pid => pid !== process.pid);
  if (second.length > 0) {
    log?.write(`[preflight] port ${port} still busy by pids=${second.join(',')} -> SIGKILL\n`);
    for (const pid of second) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await delay(150);
  }

  const remain = pidsOnPort(port).filter(pid => pid !== process.pid);
  if (remain.length > 0) {
    throw new Error(`Port ${port} still in use after cleanup: ${remain.join(',')}`);
  }
};

type ProcessTableEntry = { pid: number; command: string };

const readProcessTable = (): ProcessTableEntry[] => {
  const res = Bun.spawnSync(['ps', '-axo', 'pid=,command='], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return Buffer.from(res.stdout)
    .toString('utf8')
    .split(/\r?\n/)
    .map((line): ProcessTableEntry | null => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) return null;
      const pid = Number.parseInt(match[1]!, 10);
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
      return { pid, command: match[2]!.trim() };
    })
    .filter((row): row is ProcessTableEntry => row !== null);
};

const killPids = async (pids: number[], label: string): Promise<void> => {
  const unique = Array.from(new Set(pids)).filter(pid => pid > 0 && pid !== process.pid);
  if (unique.length === 0) return;
  console.warn(`[preflight] killing stale ${label}: ${unique.join(',')}`);
  for (const pid of unique) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  await delay(1_000);
  for (const pid of unique) {
    if (!pidIsAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  await delay(250);
};

const reapStaleIsolatedE2EProcesses = async (currentLogsDir: string): Promise<void> => {
  const marker = `${resolve(process.cwd(), '.logs', 'e2e-parallel')}/`;
  const currentMarker = `${currentLogsDir}/`;
  const stalePids = readProcessTable()
    .filter(({ command }) => command.includes(marker) && !command.includes(currentMarker))
    .filter(
      ({ command }) =>
        command.includes('runtime/orchestrator/orchestrator.ts') ||
        command.includes('runtime/orchestrator/hub-node.ts') ||
        command.includes('runtime/orchestrator/mm-node.ts') ||
        command.includes(' --state ') ||
        command.includes('vite-cache-shard-'),
    )
    .map(({ pid }) => pid);
  await killPids(stalePids, 'isolated e2e process(es)');
};

const waitForRpcReady = async (rpcUrl: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) {
        const body = (await res.json()) as any;
        const chainId = Number.parseInt(String(body?.result || '0x0'), 16);
        if (chainId === 31337) return;
      }
    } catch {
      // retry
    }
    await delay(200);
  }
  throw new Error(`RPC not ready at ${rpcUrl}`);
};

const waitForHttpReady = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // retry
    }
    await delay(250);
  }
  throw new Error(`HTTP endpoint not ready: ${url}`);
};

const waitForServerHealthy = async (apiUrl: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastHealth: any = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/api/health`);
      if (res.ok) {
        const body = await res.json();
        lastHealth = body;
        const resetDone = body?.reset?.inProgress !== true;
        const meshReady = body?.hubMesh?.ok === true;
        const mmReady = body?.marketMaker?.enabled === true ? body?.marketMaker?.ok === true : true;
        const hasTs = typeof body?.timestamp === 'number';
        if (hasTs && resetDone && meshReady && mmReady) return;
      }
    } catch {
      // retry
    }
    await delay(250);
  }
  const marketMakerPhase =
    typeof lastHealth?.marketMaker?.startupPhase === 'string' ? lastHealth.marketMaker.startupPhase : null;
  const snapshot = lastHealth
    ? JSON.stringify(
        {
          reset: lastHealth?.reset || null,
          hubMesh: lastHealth?.hubMesh || null,
          marketMaker: lastHealth?.marketMaker || null,
          hubs: Array.isArray(lastHealth?.hubs)
            ? lastHealth.hubs.map((h: any) => ({
                entityId: h?.entityId,
                name: h?.name,
                online: h?.online,
              }))
            : [],
        },
        null,
        2,
      )
    : 'no-health-payload';
  throw new Error(
    `SERVER_HEALTH_TIMEOUT phase=${String(marketMakerPhase)} api=${apiUrl} timeoutMs=${timeoutMs}\n${snapshot}`,
  );
};

const waitForHttpsReady = async (url: string, timeoutMs: number): Promise<void> => {
  // Use curl -k for self-signed local certs.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const p = spawn('curl', ['-k', '-sSf', url], { stdio: 'ignore' });
      p.once('exit', code => resolve(code === 0));
      p.once('error', () => resolve(false));
    });
    if (ok) return;
    await delay(250);
  }
  throw new Error(`HTTPS endpoint not ready: ${url}`);
};

const sanitizeChildEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = { ...env };
  if (next['FORCE_COLOR'] && next['NO_COLOR']) {
    delete next['NO_COLOR'];
  }
  return next;
};

const runCmd = async (
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; log?: ReturnType<typeof createWriteStream>; timeoutMs?: number },
): Promise<number | null> => {
  const proc = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeChildEnv(opts.env ?? process.env),
    cwd: opts.cwd,
  });

  proc.stdout.on('data', chunk => opts.log?.write(chunk.toString()));
  proc.stderr.on('data', chunk => opts.log?.write(chunk.toString()));

  const timeout = opts.timeoutMs
    ? setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, opts.timeoutMs)
    : null;

  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    proc.once('error', rejectExit);
    proc.once('exit', resolveExit);
  });
  if (timeout) clearTimeout(timeout);
  return code;
};

const fetchJsonWithTimeout = async (url: string, timeoutMs = 2000): Promise<unknown | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const captureShardFailureForensics = async (options: {
  logsDir: string;
  shard: number;
  apiUrl: string;
  log: ReturnType<typeof createWriteStream>;
}): Promise<void> => {
  const outputDir = join(options.logsDir, `test-results-shard-${options.shard}`, 'failure-debug');
  mkdirSync(outputDir, { recursive: true });

  const health = await fetchJsonWithTimeout(`${options.apiUrl}/api/health`);
  if (health) {
    writeFileSync(join(outputDir, 'health.json'), JSON.stringify(health, null, 2));
  }

  const entities = await fetchJsonWithTimeout(`${options.apiUrl}/api/debug/entities?limit=5000`);
  if (entities) {
    writeFileSync(join(outputDir, 'entities.json'), JSON.stringify(entities, null, 2));
  }

  const events = await fetchJsonWithTimeout(`${options.apiUrl}/api/debug/events?last=500`);
  if (events) {
    writeFileSync(join(outputDir, 'events.json'), JSON.stringify(events, null, 2));
  }

  const entityEntries = Array.isArray((entities as { entities?: unknown })?.entities)
    ? (entities as { entities: Array<Record<string, unknown>> }).entities
    : [];

  for (const entry of entityEntries) {
    const runtimeId = typeof entry.runtimeId === 'string' ? entry.runtimeId.trim() : '';
    const dbPath = typeof entry.dbPath === 'string' ? entry.dbPath.trim() : '';
    const entityId = typeof entry.entityId === 'string' ? entry.entityId.trim().toLowerCase() : 'unknown';
    if (!runtimeId || !dbPath) continue;

    const receiptDump = spawnSync(
      'bun',
      ['runtime/scripts/read-frame-receipts.ts', '--runtime-id', runtimeId, '--tail', '20', '--json'],
      {
        cwd: process.cwd(),
        env: sanitizeChildEnv({
          ...process.env,
          XLN_DB_PATH: dbPath,
        }),
        encoding: 'utf8',
      },
    );

    if (receiptDump.status === 0 && receiptDump.stdout) {
      writeFileSync(join(outputDir, `receipts-${entityId.slice(-8)}.json`), receiptDump.stdout);
      continue;
    }

    const stderr = String(receiptDump.stderr || '').trim();
    if (stderr) {
      writeFileSync(join(outputDir, `receipts-${entityId.slice(-8)}.error.txt`), stderr);
    }
  }

  options.log.write(`[forensics] wrote failure debug bundle: ${outputDir}\n`);
};

const runShard = async (task: RunTask, args: CliArgs, logsDir: string): Promise<RunResult> => {
  const shard = task.shard;
  const totalShards = task.totalShards;
  const startedAt = Date.now();
  const logPath = join(logsDir, `e2e-shard-${String(shard).padStart(2, '0')}.log`);
  const log = createWriteStream(logPath, { flags: 'w' });

  let anvil: ChildProcessWithoutNullStreams | null = null;
  let api: ChildProcessWithoutNullStreams | null = null;
  let vite: ChildProcessWithoutNullStreams | null = null;
  let teardownReason: string | null = null;
  const rpcPort = args.basePort + shard * 20 + 0;
  const apiPort = args.basePort + shard * 20 + 2;
  const webPort = args.basePort + shard * 20 + 4;
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `https://localhost:${webPort}`;
  const dbPath = join(logsDir, `db-e2e-shard-${shard}`);
  // Keep anvil's live state outside orchestrator dbRoot. Reset intentionally rm -rf's dbRoot.
  const anvilStatePath = join(logsDir, `anvil-state-shard-${shard}.json`);
  mkdirSync(dbPath, { recursive: true });

  const phaseMs: RunResult['phaseMs'] = {
    preflight: 0,
    anvilBoot: 0,
    apiBoot: 0,
    apiHealthy: 0,
    viteBoot: 0,
    playwright: 0,
  };
  const markPhase = (phase: keyof RunResult['phaseMs'], started: number): void => {
    const ms = Date.now() - started;
    phaseMs[phase] = ms;
    const warn = ms > args.phaseWarnMs;
    log.write(`[timing] ${phase}=${ms}ms${warn ? ` (>${args.phaseWarnMs}ms)` : ''}\n`);
  };

  try {
    log.write(`shard=${shard}/${totalShards}\nrpc=${rpcUrl}\napi=${apiUrl}\nweb=${webUrl}\ndb=${dbPath}\n\n`);

    // Hard preflight: kill stale processes that kept shard ports occupied
    // from previous crashed/aborted runs.
    // Layout:
    // - rpc: anvil
    // - api: production runtime/server.ts on an isolated shard port
    // - web: vite preview
    // - extra reserved ports kept for any local child APIs the server may spawn
    const preflightStart = Date.now();
    await freePort(rpcPort, log);
    await freePort(apiPort, log);
    await freePort(webPort, log);
    await freePort(apiPort + 10, log);
    await freePort(apiPort + 11, log);
    await freePort(apiPort + 12, log);
    await freePort(apiPort + 13, log);
    markPhase('preflight', preflightStart);

    const anvilStart = Date.now();
    anvil = spawn(
      args.anvilBin,
      [
        '--host',
        '127.0.0.1',
        '--port',
        String(rpcPort),
        '--chain-id',
        '31337',
        '--block-gas-limit',
        '60000000',
        '--code-size-limit',
        '65536',
        '--state',
        anvilStatePath,
        '--silent',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: sanitizeChildEnv(process.env) },
    );
    anvil.stdout.on('data', c => log.write(`[anvil] ${c.toString()}`));
    anvil.stderr.on('data', c => log.write(`[anvil:err] ${c.toString()}`));
    await waitForRpcReady(rpcUrl, args.stackTimeoutMs);
    markPhase('anvilBoot', anvilStart);

    const apiStart = Date.now();
    api = spawn(
      'bun',
      [
        'runtime/orchestrator/orchestrator.ts',
        '--host',
        '127.0.0.1',
        '--port',
        String(apiPort),
        '--public-ws-base-url',
        `ws://127.0.0.1:${apiPort}`,
        '--rpc-url',
        rpcUrl,
        '--db-root',
        dbPath,
        '--allow-reset',
        ...(task.requireMarketMaker ? ['--mm'] : []),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizeChildEnv({
          ...process.env,
          USE_ANVIL: 'true',
          ANVIL_RPC: rpcUrl,
          XLN_SKIP_STALE_REAP: '1',
          XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS: String(args.stackTimeoutMs),
        }),
      },
    );
    api.stdout.on('data', c => log.write(`[api] ${c.toString()}`));
    api.stderr.on('data', c => log.write(`[api:err] ${c.toString()}`));
    await waitForHttpReady(`${apiUrl}/api`, args.stackTimeoutMs);
    markPhase('apiBoot', apiStart);
    const healthStart = Date.now();
    await waitForServerHealthy(apiUrl, args.stackTimeoutMs);
    markPhase('apiHealthy', healthStart);

    const shardViteCacheDir = join(logsDir, `vite-cache-shard-${shard}`);
    const viteStart = Date.now();
    // Spawn Vite directly. `bun run preview` starts an extra child node
    // process, so killing the Bun wrapper can leave `node .../vite preview`
    // alive until the next global preflight cleanup.
    vite = spawn(
      'node',
      [
        resolve(process.cwd(), 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
        'preview',
        '--host',
        '0.0.0.0',
        '--port',
        String(webPort),
        '--strictPort',
      ],
      {
        cwd: resolve(process.cwd(), 'frontend'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizeChildEnv({
          ...process.env,
          ANVIL_RPC: rpcUrl,
          RPC_ETHEREUM: rpcUrl,
          VITE_DEV_PORT: String(webPort),
          VITE_API_PROXY_TARGET: apiUrl,
          VITE_CACHE_DIR: shardViteCacheDir,
        }),
      },
    );
    vite.stdout.on('data', c => log.write(`[vite] ${c.toString()}`));
    vite.stderr.on('data', c => log.write(`[vite:err] ${c.toString()}`));
    await waitForHttpsReady(webUrl, args.stackTimeoutMs);
    markPhase('viteBoot', viteStart);

    const shardArg = `${shard + 1}/${totalShards}`;
    const playwrightArgs = ['playwright', 'test', '--config', 'playwright.config.ts'];
    if (task.usePlaywrightShard) {
      playwrightArgs.push('--shard', shardArg);
    }
    const grep = task.grep || args.pwGrep;
    if (grep) {
      playwrightArgs.push('--grep', grep);
    }
    if (args.pwProject) {
      playwrightArgs.push(`--project=${args.pwProject}`);
    }
    playwrightArgs.push(`--workers=${args.workersPerShard}`);
    playwrightArgs.push(`--reporter=${args.reporter}`);
    if (args.maxFailures > 0) playwrightArgs.push(`--max-failures=${args.maxFailures}`);
    for (const target of task.pwTargets) playwrightArgs.push(target);
    log.write(`[runner] playwright args: ${JSON.stringify(playwrightArgs)}\n`);

    const playwrightStart = Date.now();
    const code = await runCmd('bunx', playwrightArgs, {
      env: {
        ...process.env,
        PW_BASE_URL: webUrl,
        PW_SKIP_WEBSERVER: '1',
        PW_WORKERS: String(args.workersPerShard),
        PW_VIDEO: args.videoMode,
        PW_TRACE: args.traceMode,
        PW_SCREENSHOT: args.screenshotMode,
        PW_SIMPLE_REPORTER: '1',
        PW_REPORTER: args.reporter,
        PW_OUTPUT_DIR: join(logsDir, `test-results-shard-${shard}`),
        E2E_BASE_URL: webUrl,
        E2E_API_BASE_URL: apiUrl,
        E2E_ANVIL_RPC: rpcUrl,
        E2E_RESET_BASE_URL: apiUrl,
        E2E_FAST: process.env.E2E_FAST ?? '1',
        E2E_ISOLATED_BASELINE_READY: '1',
        XLN_INCLUDE_MARKET_MAKER: task.requireMarketMaker ? '1' : '0',
      },
      log,
      timeoutMs: args.testTimeoutMs,
    });
    markPhase('playwright', playwrightStart);

    if (code !== 0) {
      await captureShardFailureForensics({
        logsDir,
        shard,
        apiUrl,
        log,
      });
      return {
        shard,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        logPath,
        target: task.pwTargets[0] || `shard-${task.shard}`,
        title: task.title || task.pwTargets[0] || `shard-${task.shard}`,
        requireMarketMaker: task.requireMarketMaker,
        phaseMs,
        error: `playwright_exit_${code}`,
      };
    }

    return {
      shard,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      logPath,
      target: task.pwTargets[0] || `shard-${task.shard}`,
      title: task.title || task.pwTargets[0] || `shard-${task.shard}`,
      requireMarketMaker: task.requireMarketMaker,
      phaseMs,
    };
  } catch (error) {
    teardownReason = (error as Error).message;
    try {
      await captureShardFailureForensics({
        logsDir,
        shard,
        apiUrl,
        log,
      });
    } catch {
      // Best effort only.
    }
    return {
      shard,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      logPath,
      target: task.pwTargets[0] || `shard-${task.shard}`,
      title: task.title || task.pwTargets[0] || `shard-${task.shard}`,
      requireMarketMaker: task.requireMarketMaker,
      phaseMs,
      error: (error as Error).message,
    };
  } finally {
    if (teardownReason && api && api.exitCode === null) {
      const teardownLabel = phaseMs.apiHealthy > 0 ? 'shard teardown' : 'startup failure';
      log.write(`[runner] ${teardownLabel} -> SIGTERM api pid=${api.pid} reason=${teardownReason.split('\n')[0]}\n`);
    }
    await Promise.all([stopProcess(vite), stopProcess(api), stopProcess(anvil)]);
    log.end();
  }
};

async function main(): Promise<void> {
  const args = parseArgs();
  const releaseRunnerLock = acquireRunnerLock();
  const logsDir = resolve(process.cwd(), '.logs', 'e2e-parallel', tsTag());
  mkdirSync(logsDir, { recursive: true });

  console.log('\n' + '='.repeat(72));
  console.log('E2E Parallel Runner (isolated stack per shard)');
  console.log('='.repeat(72));
  console.log(`Shards   : ${args.shards}`);
  console.log(`BasePort : ${args.basePort}`);
  console.log(`Workers/shard: ${args.workersPerShard}`);
  console.log(`MM concurrency: ${args.maxMmConcurrency}`);
  console.log(`Max failures : ${args.maxFailures}`);
  console.log(`Phase warn ms: ${args.phaseWarnMs}`);
  console.log(`Artifacts    : video=${args.videoMode}, trace=${args.traceMode}, screenshot=${args.screenshotMode}`);
  console.log(`Logs     : ${logsDir}`);
  console.log('='.repeat(72) + '\n');

  try {
    if (!args.skipBuild) {
      const buildLogPath = join(logsDir, 'build-runtime.log');
      const buildLog = createWriteStream(buildLogPath, { flags: 'w' });
      const buildCode = await runCmd('bash', ['-lc', './scripts/build-runtime.sh'], {
        env: process.env,
        log: buildLog,
        timeoutMs: 300000,
      });
      buildLog.write('\n=== frontend build ===\n');
      const frontendBuildCode = await runCmd('bun', ['run', 'build'], {
        cwd: resolve(process.cwd(), 'frontend'),
        env: process.env,
        log: buildLog,
        timeoutMs: 300000,
      });
      buildLog.end();
      if (buildCode !== 0 || frontendBuildCode !== 0) {
        console.error(`❌ prebuild failed (runtime/frontend). See log: ${buildLogPath}`);
        process.exit(1);
      }
    } else {
      console.log('⏩ skip-build enabled');
    }

    try {
      await assertRunnerPreflight();
      await reapStaleIsolatedE2EProcesses(logsDir);
    } catch (error) {
      console.error(`❌ runner preflight failed: ${String(error instanceof Error ? error.message : error)}`);
      process.exit(1);
    }

    const startedAt = Date.now();
    const sourceFiles = args.pwFiles.length > 0 ? args.pwFiles : listPlaywrightSpecFiles();
    let expandedTargets = expandPlaywrightTargets(sourceFiles);
    if (args.pwGrep) {
      const matchesGrep = buildGrepMatcher(args.pwGrep);
      expandedTargets = expandedTargets.filter(matchesGrep);
      if (expandedTargets.length === 0) {
        throw new Error(`No isolated test targets matched --pw-grep=${args.pwGrep}`);
      }
    }
    const tasks: RunTask[] = expandedTargets.map((entry, index, entries) => ({
      shard: index,
      totalShards: entries.length,
      pwTargets: [entry.target],
      requireMarketMaker: entry.requireMarketMaker,
      usePlaywrightShard: false,
      title: entry.title,
      grep: entry.grep,
    }));
    writeFileSync(
      join(logsDir, 'targets.json'),
      JSON.stringify(
        tasks.map(task => ({
          shard: task.shard,
          target: task.pwTargets[0],
          title: task.title || task.pwTargets[0],
          handle: deriveQaTestHandle(task.pwTargets[0], task.title || task.pwTargets[0]),
          description: deriveQaTestDescription(task.pwTargets[0], task.title || task.pwTargets[0]),
          requireMarketMaker: task.requireMarketMaker,
          grep: task.grep,
        })),
        null,
        2,
      ),
    );
    console.log(`Targets  : ${tasks.length} isolated test stack${tasks.length === 1 ? '' : 's'}`);

    const maxConcurrency = Math.max(1, Math.min(args.shards, tasks.length));
    const results: RunResult[] = new Array(tasks.length);
    const claimed = new Array<boolean>(tasks.length).fill(false);
    let claimedCount = 0;
    let activeMarketMakerTasks = 0;
    const claimTask = async (): Promise<{ taskIndex: number; task: RunTask } | null> => {
      while (claimedCount < tasks.length) {
        for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
          if (claimed[taskIndex]) continue;
          const task = tasks[taskIndex];
          if (!task) continue;
          if (task.requireMarketMaker && activeMarketMakerTasks >= args.maxMmConcurrency) continue;
          claimed[taskIndex] = true;
          claimedCount += 1;
          if (task.requireMarketMaker) activeMarketMakerTasks += 1;
          return { taskIndex, task };
        }
        await delay(250);
      }
      return null;
    };
    const runWorker = async (): Promise<void> => {
      while (true) {
        const claim = await claimTask();
        if (!claim) break;
        try {
          results[claim.taskIndex] = await runShard(claim.task, args, logsDir);
        } finally {
          if (claim.task.requireMarketMaker) activeMarketMakerTasks = Math.max(0, activeMarketMakerTasks - 1);
        }
      }
    };
    await Promise.all(Array.from({ length: maxConcurrency }, () => runWorker()));
    const totalMs = Date.now() - startedAt;
    const failed = results.filter(r => r.status === 'failed');
    writeRunManifest(logsDir, args, results, totalMs, startedAt);
    publishQaRunIfConfigured(logsDir);

    console.log('\n' + '='.repeat(72));
    console.log('E2E Summary');
    console.log('='.repeat(72));
    for (const r of results.sort((a, b) => a.shard - b.shard)) {
      const sec = (r.durationMs / 1000).toFixed(1);
      const p = r.phaseMs;
      console.log(
        `${r.status === 'passed' ? 'PASS' : 'FAIL'}  shard=${r.shard}  ${sec.padStart(8)}s  ` +
          `phases[pre=${p.preflight} anvil=${p.anvilBoot} api=${p.apiBoot} health=${p.apiHealthy} vite=${p.viteBoot} pw=${p.playwright}]  ` +
          `log=${r.logPath}`,
      );
      const steps = parseStepTimings(r.logPath)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 8);
      if (steps.length > 0) {
        console.log(`      slow-steps: ${steps.map(s => `${s.label}=${s.ms}ms`).join(' | ')}`);
      }
    }
    console.log('-'.repeat(72));
    console.log(`Total wall time: ${(totalMs / 1000).toFixed(1)}s (${totalMs}ms)`);
    console.log(`Logs: ${logsDir}`);

    if (failed.length > 0) {
      for (const f of failed) {
        console.log(`\n--- shard ${f.shard} (tail: ${f.logPath}) ---`);
        console.log(tail(f.logPath, 80));
      }
      process.exit(1);
    }

    process.exit(0);
  } finally {
    releaseRunnerLock();
  }
}

main().catch(err => {
  console.error('E2E isolated parallel runner failed:', (err as Error).message);
  process.exit(1);
});
