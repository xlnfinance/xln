import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { compareStableText, safeStringify } from '../serialization-utils';
import { makeQaSeveritySignal, type QaSeveritySignal } from './severity';
import {
  QA_HISTORY_DB_PATH,
  auditQaUxReleasePack,
  backfillQaHistoryFromLogs,
  buildQaSystemVerdict,
  classifyQaArtifactSensitivity,
  enrichQaRunUrls,
  listQaHistory,
  listQaRunSummaries,
  listQaStoryScreenshots,
  purgeQaRunsOlderThan,
  isQaTextArtifactPath,
  qaArtifactContentType,
  readQaRun,
  redactQaSecretText,
  resolveQaArtifactPath,
  resolveQaStoryScreenshotPath,
  stripQaRunPerfSamples,
  summarizeQaPerf,
  type QaCodeFingerprint,
  type QaStorySource,
} from './report';

type JsonHeaders = Record<string, string>;
type QaAuthScope = 'read' | 'admin';

type QaAuthContext = {
  scope: QaAuthScope;
  disabled: boolean;
  actorKeyId: string;
};

type QaRestartState = {
  proc: ChildProcess;
  auditId: string;
  startedAt: number;
  target: string;
  title: string;
  command: string[];
  logPath: string;
  timeoutMs: number;
  watchdogAt: number;
  killGraceMs: number;
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  sigkillTimer: ReturnType<typeof setTimeout> | null;
  terminalStatus: QaRestartTerminalStatus | null;
  writeLog: (text: string) => void;
  closeLog: (suffix?: string) => void;
};

type QaRestartIntent = {
  target: string;
  title: string;
  operatorId: string;
  reason: string;
  confirm: string;
  expectedGitHead: string;
};

type QaApiDeps = {
  computeRestartFingerprint?: () => QaCodeFingerprint;
  spawnRestart?: typeof spawn;
};

export type QaRestartAuditRecord = {
  auditId: string;
  status: 'started' | QaRestartTerminalStatus;
  actorKeyId: string;
  scope: QaAuthScope;
  operatorId: string;
  action: 'restart-run';
  target: string;
  title: string;
  reason: string;
  expectedGitHead: string | null;
  actualGitHead: string | null;
  gitBranch: string | null;
  codeHash: string | null;
  dirty: boolean;
  startedAt: number;
  finishedAt: number | null;
  pid: number | null;
  exitCode: number | null;
  logPath: string;
  requestIp: string | null;
  userAgent: string | null;
};

export type QaRestartAuditEntry = QaRestartAuditRecord & QaSeveritySignal;

let activeRestart: QaRestartState | null = null;
let restartCooldownUntil = 0;
let restartAuditReconciled = false;

type QaRestartTerminalStatus = 'finished' | 'spawn_error' | 'watchdog_timeout' | 'aborted' | 'orphaned';

const qaRestartAllowed = (): boolean => process.env['XLN_QA_RESTART_ALLOWED'] === '1';
const qaAuthDisabled = (): boolean => process.env['XLN_QA_AUTH_DISABLED'] === '1';
const qaRestartCooldownMs = (): number => {
  const raw = Number(process.env['XLN_QA_RESTART_COOLDOWN_MS'] || '5000');
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 5000;
};
const qaRestartWatchdogMs = (): number => {
  const raw = Number(process.env['XLN_QA_RESTART_WATCHDOG_MS'] || '330000');
  return Number.isFinite(raw) ? Math.max(1000, Math.floor(raw)) : 330000;
};
const qaRestartKillGraceMs = (): number => {
  const raw = Number(process.env['XLN_QA_RESTART_KILL_GRACE_MS'] || '10000');
  return Number.isFinite(raw) ? Math.max(500, Math.floor(raw)) : 10000;
};

const publicQaPath = (filePath: string): string => {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  if (!isAbsolute(raw)) {
    return normalized.replace(/^\.?\//, '');
  }
  const cwdRelative = relative(process.cwd(), raw).replace(/\\/g, '/');
  if (cwdRelative && !cwdRelative.startsWith('../') && cwdRelative !== '..') return cwdRelative;
  const logIndex = normalized.indexOf('/.logs/');
  if (logIndex >= 0) return normalized.slice(logIndex + 1);
  return basename(raw);
};

const QA_REQUIRED_RESTART_ENV_KEYS = [
  'ANVIL_RPC',
  'BUN_INSTALL',
  'CI',
  'DEBUG',
  'DEV_VERBOSE',
  'E2E_BASE_URL',
  'HOME',
  'NODE_ENV',
  'PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PW_TEST_HTML_REPORT_OPEN',
  'RUNTIME_VERBOSE_LOGS',
  'SHELL',
  'TMPDIR',
  'USE_ANVIL',
  'XLN_LOG_FULL_PAYLOADS',
  'XLN_LOG_LEVEL',
  'XLN_LOG_SCOPES',
  'XLN_MESH_RESET_ALLOWED',
] as const;

const splitTokenList = (value: string | undefined): string[] =>
  String(value || '')
    .split(/[\s,]+/g)
    .map(token => token.trim())
    .filter(Boolean);

const safeTokenEquals = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const tokenMatches = (token: string, candidates: string[]): boolean =>
  candidates.some(candidate => safeTokenEquals(token, candidate));

const actorKeyIdForToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 16);

const extractQaToken = (request: Request): string => {
  const auth = String(request.headers.get('authorization') || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  return bearer || String(request.headers.get('x-xln-qa-token') || '').trim();
};

const jsonResponse = (
  body: Record<string, unknown>,
  status: number,
  headers: JsonHeaders,
): Response => new Response(safeStringify(body), {
  status,
  headers: {
    ...headers,
    'Cache-Control': 'no-store',
  },
});

const etagForBody = (body: string): string =>
  `"qa-${createHash('sha256').update(body).digest('hex').slice(0, 24)}"`;

const jsonEtagResponse = (
  request: Request,
  body: Record<string, unknown>,
  headers: JsonHeaders,
): Response => {
  const text = safeStringify(body);
  const etag = etagForBody(text);
  const responseHeaders = {
    ...headers,
    'Cache-Control': 'private, no-cache',
    ETag: etag,
  };
  const requestedEtags = String(request.headers.get('if-none-match') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (requestedEtags.includes(etag)) {
    return new Response(null, {
      status: 304,
      headers: responseHeaders,
    });
  }
  return new Response(text, {
    headers: responseHeaders,
  });
};

const qaAuthPayload = (auth: QaAuthContext): Record<string, unknown> => ({
  scope: auth.scope,
  disabled: auth.disabled,
  actorKeyId: auth.actorKeyId,
});

const authenticateQaRequest = (request: Request): QaAuthContext | Response => {
  if (qaAuthDisabled()) return { scope: 'admin', disabled: true, actorKeyId: 'auth-disabled' };

  const readTokens = splitTokenList(process.env['XLN_QA_READ_TOKEN']);
  const adminTokens = splitTokenList(process.env['XLN_QA_ADMIN_TOKEN']);
  if (readTokens.length === 0 && adminTokens.length === 0) {
    return { scope: 'admin', disabled: true, actorKeyId: 'qa-open' };
  }

  const token = extractQaToken(request);
  if (!token) return jsonResponse({ ok: false, error: 'QA_AUTH_REQUIRED' }, 401, {});
  if (adminTokens.length > 0 && tokenMatches(token, adminTokens)) {
    return { scope: 'admin', disabled: false, actorKeyId: actorKeyIdForToken(token) };
  }
  if (readTokens.length > 0 && tokenMatches(token, readTokens)) {
    return { scope: 'read', disabled: false, actorKeyId: actorKeyIdForToken(token) };
  }
  return jsonResponse({ ok: false, error: 'QA_AUTH_INVALID' }, 401, {});
};

const requireQaScope = (
  request: Request,
  requiredScope: QaAuthScope,
  headers: JsonHeaders,
): QaAuthContext | Response => {
  const auth = authenticateQaRequest(request);
  if (auth instanceof Response) {
    return new Response(auth.body, {
      status: auth.status,
      headers: {
        ...headers,
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Bearer realm="xln-qa"',
      },
    });
  }
  if (requiredScope === 'admin' && auth.scope !== 'admin') {
    return jsonResponse({ ok: false, error: 'QA_AUTH_ADMIN_REQUIRED', qaAuth: qaAuthPayload(auth) }, 403, headers);
  }
  return auth;
};

export const buildQaRestartEnv = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = {};
  for (const key of QA_REQUIRED_RESTART_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) next[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (/^(PW_|PLAYWRIGHT_)/.test(key)) next[key] = value;
  }
  return next;
};

const mediaHeaders = (filePath: string): HeadersInit => ({
  'Cache-Control': 'no-store',
  'Content-Type': qaArtifactContentType(filePath),
  'X-Content-Type-Options': 'nosniff',
});

const spawnText = (cmd: string, args: string[]): string => {
  const result = spawnSync(cmd, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
};

export const computeQaRestartFingerprint = (): QaCodeFingerprint => {
  const gitHead = spawnText('git', ['rev-parse', 'HEAD']) || null;
  const gitBranch = spawnText('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
  const gitStatus = spawnText('git', ['status', '--short', '--untracked-files=all']);
  const sourceRaw = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'pipe',
    encoding: 'buffer',
  });
  if (sourceRaw.status !== 0) {
    throw new Error(`GIT_LS_FILES_FAILED:${String(sourceRaw.stderr || '').trim()}`);
  }
  const files = Buffer.from(sourceRaw.stdout)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort(compareStableText);
  const hash = createHash('sha256');
  let trackedBytes = 0;
  for (const file of files) {
    const absolutePath = resolve(process.cwd(), file);
    if (!existsSync(absolutePath)) continue;
    const data = readFileSync(absolutePath);
    trackedBytes += data.length;
    hash.update(file);
    hash.update('\0');
    hash.update(data);
    hash.update('\0');
  }
  return {
    gitHead,
    gitBranch,
    gitStatus,
    dirty: gitStatus.length > 0,
    codeHash: hash.digest('hex'),
    computedAt: Date.now(),
    trackedFileCount: files.length,
    trackedBytes,
  };
};

const openQaRestartAuditDb = (): Database => {
  mkdirSync(resolve(process.cwd(), '.logs'), { recursive: true });
  const db = new Database(QA_HISTORY_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS qa_restart_audit (
      audit_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      actor_key_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      title TEXT NOT NULL,
      reason TEXT NOT NULL,
      expected_git_head TEXT,
      actual_git_head TEXT,
      git_branch TEXT,
      code_hash TEXT,
      dirty INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      pid INTEGER,
      exit_code INTEGER,
      log_path TEXT NOT NULL,
      request_ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS qa_restart_audit_started_idx ON qa_restart_audit(started_at DESC);
    CREATE INDEX IF NOT EXISTS qa_restart_audit_status_idx ON qa_restart_audit(status, started_at DESC);
  `);
  return db;
};

const nullableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const normalizeRestartAuditStatus = (value: unknown): QaRestartAuditEntry['status'] => {
  const status = String(value || '').trim();
  if (
    status === 'finished' ||
    status === 'spawn_error' ||
    status === 'watchdog_timeout' ||
    status === 'aborted' ||
    status === 'orphaned'
  ) return status;
  return 'started';
};

const qaRestartAuditSeverity = (entry: QaRestartAuditRecord): QaSeveritySignal => {
  const evidence = [
    { label: 'audit', value: entry.auditId },
    { label: 'target', value: entry.target },
    ...(entry.exitCode !== null ? [{ label: 'exit code', value: entry.exitCode }] : []),
    ...(entry.actualGitHead ? [{ label: 'git head', value: entry.actualGitHead.slice(0, 12) }] : []),
    ...(entry.codeHash ? [{ label: 'code hash', value: entry.codeHash.slice(0, 16) }] : []),
  ];
  if (entry.status === 'started') {
    return makeQaSeveritySignal({
      severity: 'DEGRADED',
      reason: 'Restart run is still executing',
      since: entry.startedAt,
      owner: 'restart',
      evidence,
    });
  }
  if (entry.status === 'finished' && (entry.exitCode ?? 0) === 0) {
    return makeQaSeveritySignal({
      severity: 'OK',
      reason: 'Restart run finished successfully',
      since: entry.finishedAt ?? entry.startedAt,
      owner: 'restart',
      evidence,
    });
  }
  if (entry.status === 'aborted') {
    return makeQaSeveritySignal({
      severity: 'WARN',
      reason: 'Restart run was aborted by operator',
      since: entry.finishedAt ?? entry.startedAt,
      owner: 'restart',
      evidence,
    });
  }
  if (entry.status === 'watchdog_timeout' || entry.status === 'orphaned') {
    return makeQaSeveritySignal({
      severity: 'BLOCKED',
      reason: `Restart run is ${entry.status}`,
      since: entry.finishedAt ?? entry.startedAt,
      owner: 'restart',
      evidence,
    });
  }
  return makeQaSeveritySignal({
    severity: 'FAIL',
    reason: entry.status === 'spawn_error' ? 'Restart process failed to spawn' : 'Restart run exited with failure',
    since: entry.finishedAt ?? entry.startedAt,
    owner: 'restart',
    evidence,
  });
};

const rowToRestartAuditEntry = (row: Record<string, unknown>): QaRestartAuditEntry => {
  const entry: QaRestartAuditRecord = {
    auditId: String(row['audit_id'] || ''),
    status: normalizeRestartAuditStatus(row['status']),
    actorKeyId: String(row['actor_key_id'] || ''),
    scope: row['scope'] === 'admin' ? 'admin' : 'read',
    operatorId: String(row['operator_id'] || ''),
    action: 'restart-run',
    target: String(row['target'] || ''),
    title: String(row['title'] || ''),
    reason: String(row['reason'] || ''),
    expectedGitHead: typeof row['expected_git_head'] === 'string' ? row['expected_git_head'] : null,
    actualGitHead: typeof row['actual_git_head'] === 'string' ? row['actual_git_head'] : null,
    gitBranch: typeof row['git_branch'] === 'string' ? row['git_branch'] : null,
    codeHash: typeof row['code_hash'] === 'string' ? row['code_hash'] : null,
    dirty: Number(row['dirty'] || 0) === 1,
    startedAt: Number(row['started_at'] || 0),
    finishedAt: nullableNumber(row['finished_at']),
    pid: nullableNumber(row['pid']),
    exitCode: nullableNumber(row['exit_code']),
    logPath: publicQaPath(String(row['log_path'] || '')),
    requestIp: typeof row['request_ip'] === 'string' ? row['request_ip'] : null,
    userAgent: typeof row['user_agent'] === 'string' ? row['user_agent'] : null,
  };
  const severity = qaRestartAuditSeverity(entry);
  return {
    ...entry,
    severity: severity.severity,
    since: severity.since,
    owner: severity.owner,
    evidence: severity.evidence,
  };
};

const requestIp = (request: Request): string | null => {
  const forwarded = String(request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim();
  return forwarded || String(request.headers.get('x-real-ip') || '').trim() || null;
};

const userAgent = (request: Request): string | null =>
  String(request.headers.get('user-agent') || '').trim() || null;

const buildAuditId = (startedAt: number, auth: QaAuthContext, target: string, title: string): string =>
  createHash('sha256')
    .update(`${startedAt}\0${auth.actorKeyId}\0${target}\0${title}\0${process.pid}`)
    .digest('hex')
    .slice(0, 24);

export const insertQaRestartAudit = (entry: QaRestartAuditRecord): void => {
  const db = openQaRestartAuditDb();
  try {
    db.query(`
      INSERT INTO qa_restart_audit (
        audit_id,
        status,
        actor_key_id,
        scope,
        operator_id,
        action,
        target,
        title,
        reason,
        expected_git_head,
        actual_git_head,
        git_branch,
        code_hash,
        dirty,
        started_at,
        finished_at,
        pid,
        exit_code,
        log_path,
        request_ip,
        user_agent
      ) VALUES (
        $auditId,
        $status,
        $actorKeyId,
        $scope,
        $operatorId,
        $action,
        $target,
        $title,
        $reason,
        $expectedGitHead,
        $actualGitHead,
        $gitBranch,
        $codeHash,
        $dirty,
        $startedAt,
        $finishedAt,
        $pid,
        $exitCode,
        $logPath,
        $requestIp,
        $userAgent
      )
    `).run({
      $auditId: entry.auditId,
      $status: entry.status,
      $actorKeyId: entry.actorKeyId,
      $scope: entry.scope,
      $operatorId: entry.operatorId,
      $action: entry.action,
      $target: entry.target,
      $title: entry.title,
      $reason: entry.reason,
      $expectedGitHead: entry.expectedGitHead,
      $actualGitHead: entry.actualGitHead,
      $gitBranch: entry.gitBranch,
      $codeHash: entry.codeHash,
      $dirty: entry.dirty ? 1 : 0,
      $startedAt: entry.startedAt,
      $finishedAt: entry.finishedAt,
      $pid: entry.pid,
      $exitCode: entry.exitCode,
      $logPath: entry.logPath,
      $requestIp: entry.requestIp,
      $userAgent: entry.userAgent,
    });
  } finally {
    db.close();
  }
};

export const finishQaRestartAudit = (
  auditId: string,
  status: QaRestartTerminalStatus,
  exitCode: number | null,
  finishedAt = Date.now(),
): void => {
  const db = openQaRestartAuditDb();
  try {
    db.query(`
      UPDATE qa_restart_audit
      SET status = $status,
          finished_at = $finishedAt,
          exit_code = $exitCode
      WHERE audit_id = $auditId
    `).run({
      $auditId: auditId,
      $status: status,
      $finishedAt: finishedAt,
      $exitCode: exitCode,
    });
  } finally {
    db.close();
  }
};

const markStaleQaRestartAuditsOrphaned = (finishedAt = Date.now()): number => {
  const db = openQaRestartAuditDb();
  try {
    const result = db.query(`
      UPDATE qa_restart_audit
      SET status = 'orphaned',
          finished_at = $finishedAt,
          exit_code = NULL
      WHERE status = 'started'
        AND started_at < $finishedAt
    `).run({ $finishedAt: finishedAt });
    return Number(result.changes || 0);
  } finally {
    db.close();
  }
};

const reconcileQaRestartAuditOnce = (): void => {
  if (restartAuditReconciled) return;
  restartAuditReconciled = true;
  if (activeRestart) return;
  markStaleQaRestartAuditsOrphaned();
};

export const listQaRestartAudit = (limit = 50): QaRestartAuditEntry[] => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
  const db = openQaRestartAuditDb();
  try {
    const rows = db.query(`
      SELECT *
      FROM qa_restart_audit
      ORDER BY started_at DESC
      LIMIT $limit
    `).all({ $limit: safeLimit }) as Array<Record<string, unknown>>;
    return rows.map(rowToRestartAuditEntry);
  } finally {
    db.close();
  }
};

const QA_TEST_CATALOG = [
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
    id: 'frontend-check',
    group: 'Frontend',
    label: 'Frontend Type + Build',
    command: 'cd frontend && bun run check',
    description: 'Svelte diagnostics, type checking, static build, and assets.',
  },
  {
    id: 'release-gate',
    group: 'Gate',
    label: 'Release Gate',
    command: 'bun run check',
    description: 'Repository gate: runtime checks, frontend check, and no banned patterns.',
  },
  {
    id: 'swap-runtime-bench',
    group: 'Benchmark',
    label: 'Swap Runtime TPS',
    command: 'bun run bench:swap:runtime',
    description: 'Measures deterministic swap runtime throughput against release threshold.',
  },
  {
    id: 'radapter-hub10k-bench',
    group: 'Benchmark',
    label: 'Runtime Adapter 10k Hub',
    command: 'bun run bench:radapter:hub10k',
    description: 'Reads compact remote hub snapshots under hot/cold account load.',
  },
];

const clearRestartTimers = (state: QaRestartState): void => {
  if (state.watchdogTimer) clearTimeout(state.watchdogTimer);
  if (state.sigkillTimer) clearTimeout(state.sigkillTimer);
  state.watchdogTimer = null;
  state.sigkillTimer = null;
};

const finishActiveRestart = (
  state: QaRestartState,
  status: QaRestartTerminalStatus,
  exitCode: number | null,
  suffix = '',
): void => {
  clearRestartTimers(state);
  finishQaRestartAudit(state.auditId, status, exitCode);
  state.closeLog(suffix);
  restartCooldownUntil = Date.now() + qaRestartCooldownMs();
  if (activeRestart === state) activeRestart = null;
};

const requestActiveRestartStop = (
  state: QaRestartState,
  status: Extract<QaRestartTerminalStatus, 'watchdog_timeout' | 'aborted'>,
  reason: string,
): void => {
  if (state.terminalStatus) return;
  state.terminalStatus = status;
  state.writeLog(`\nQA_RESTART_${status.toUpperCase()}:${reason}\n`);
  state.proc.kill('SIGTERM');
  state.sigkillTimer = setTimeout(() => {
    if (state.proc.exitCode !== null) return;
    state.writeLog(`\nQA_RESTART_SIGKILL:${reason}\n`);
    state.proc.kill('SIGKILL');
  }, state.killGraceMs);
  state.sigkillTimer.unref?.();
};

const reapQaRestartState = (now = Date.now()): void => {
  if (!activeRestart) return;
  const state = activeRestart;
  if (state.proc.exitCode !== null) {
    finishActiveRestart(state, state.terminalStatus ?? 'finished', state.proc.exitCode);
    return;
  }
  if (now >= state.watchdogAt) {
    requestActiveRestartStop(state, 'watchdog_timeout', `timeoutMs=${state.timeoutMs}`);
  }
};

export const readQaRestartStatus = (now = Date.now()): Record<string, unknown> => {
  if (!activeRestart) {
    const cooldownRemainingMs = Math.max(0, restartCooldownUntil - now);
    const severity = cooldownRemainingMs > 0
      ? makeQaSeveritySignal({
        severity: 'WARN',
        reason: 'Restart cooldown is active',
        since: restartCooldownUntil - cooldownRemainingMs,
        owner: 'restart',
        evidence: [{ label: 'cooldown remaining', value: cooldownRemainingMs, unit: 'ms' }],
      })
      : makeQaSeveritySignal({
        severity: 'OK',
        reason: 'No restart run is active',
        since: 0,
        owner: 'restart',
        evidence: [{ label: 'active', value: false }],
      });
    return cooldownRemainingMs > 0
      ? { ...severity, active: false, cooldownUntil: restartCooldownUntil, cooldownRemainingMs }
      : { ...severity, active: false };
  }
  const severity = makeQaSeveritySignal({
    severity: activeRestart.terminalStatus ? 'WARN' : 'DEGRADED',
    reason: activeRestart.terminalStatus
      ? `Restart run is terminating: ${activeRestart.terminalStatus}`
      : 'Restart run is executing',
    since: activeRestart.startedAt,
    owner: 'restart',
    evidence: [
      { label: 'audit', value: activeRestart.auditId },
      { label: 'target', value: activeRestart.target },
      { label: 'watchdog at', value: activeRestart.watchdogAt },
    ],
  });
  return {
    ...severity,
    active: true,
    auditId: activeRestart.auditId,
    startedAt: activeRestart.startedAt,
    target: activeRestart.target,
    title: activeRestart.title,
    pid: activeRestart.proc.pid ?? null,
    command: activeRestart.command,
    logPath: activeRestart.logPath,
    timeoutMs: activeRestart.timeoutMs,
    watchdogAt: activeRestart.watchdogAt,
    killGraceMs: activeRestart.killGraceMs,
    terminating: activeRestart.terminalStatus !== null,
    terminalStatus: activeRestart.terminalStatus,
  };
};

const restartStatus = (): Record<string, unknown> => {
  reapQaRestartState();
  return readQaRestartStatus();
};

const sanitizeE2ETarget = (target: string): string => {
  const normalized = target.trim().replace(/\\/g, '/');
  if (!/^tests\/[a-zA-Z0-9._/-]+\.spec\.ts$/.test(normalized) || normalized.includes('..') || normalized.includes('\0')) {
    throw new Error('INVALID_QA_RESTART_TARGET');
  }
  if (normalized.endsWith('/e2e-qa-cockpit.spec.ts') || normalized === 'tests/e2e-qa-cockpit.spec.ts') {
    throw new Error('QA_RESTART_SELF_TARGET_DENIED');
  }
  return normalized;
};

const buildRestartCommand = (target: string, title: string): string[] => [
  'runtime/scripts/run-e2e-parallel-isolated.ts',
  '--pw-project=chromium',
  `--pw-files=${JSON.stringify([`${target}::${title}`])}`,
  '--shards=1',
  '--workers-per-shard=1',
  '--max-reset-concurrency=1',
  '--stack-timeout-ms=300000',
  '--video=on',
  '--trace=off',
  '--screenshot=only-on-failure',
  '--max-failures=1',
];

const readRestartBody = async (request: Request): Promise<Record<string, unknown>> => {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') throw new Error('QA_RESTART_BODY_REQUIRED');
  return body;
};

const readRestartTarget = async (body: Record<string, unknown>): Promise<{ target: string; title: string }> => {
  if (typeof body['runId'] === 'string' && typeof body['shard'] === 'number') {
    const run = await readQaRun(body['runId']);
    const shard = run.shards.find((candidate) => candidate.shard === body['shard']);
    if (!shard) throw new Error('QA_RESTART_SHARD_NOT_FOUND');
    return {
      target: sanitizeE2ETarget(String(shard.target || '')),
      title: String(shard.title || shard.target || '').trim(),
    };
  }
  return {
    target: sanitizeE2ETarget(String(body['target'] || '')),
    title: String(body['title'] || '').trim(),
  };
};

const readRestartIntent = async (
  body: Record<string, unknown>,
  fingerprint: QaCodeFingerprint,
): Promise<QaRestartIntent> => {
  const target = await readRestartTarget(body);
  const operatorId = String(body['operatorId'] || '').trim();
  const reason = String(body['reason'] || '').trim();
  const confirm = String(body['confirm'] || '').trim();
  const expectedGitHead = String(body['expectedGitHead'] || '').trim();
  if (!operatorId) throw new Error('QA_RESTART_OPERATOR_REQUIRED');
  if (!reason) throw new Error('QA_RESTART_REASON_REQUIRED');
  if (confirm !== 'RUN') throw new Error('QA_RESTART_CONFIRM_REQUIRED');
  if (!expectedGitHead) throw new Error('QA_RESTART_EXPECTED_HEAD_REQUIRED');
  if (!fingerprint.gitHead) throw new Error('QA_RESTART_GIT_HEAD_UNAVAILABLE');
  if (expectedGitHead !== fingerprint.gitHead) throw new Error('QA_RESTART_HEAD_MISMATCH');
  return {
    ...target,
    operatorId,
    reason,
    confirm,
    expectedGitHead,
  };
};

export async function maybeHandleQaRequest(
  request: Request,
  pathname: string,
  headers: JsonHeaders,
  deps: QaApiDeps = {},
): Promise<Response | null> {
  if (!pathname.startsWith('/api/qa/')) return null;

  const requiredScope: QaAuthScope =
    (
      pathname === '/api/qa/restart' ||
      pathname === '/api/qa/restart/abort' ||
      pathname === '/api/qa/retention' ||
      pathname === '/api/qa/history/backfill'
    ) && request.method === 'POST'
      ? 'admin'
      : 'read';
  const auth = requireQaScope(request, requiredScope, headers);
  if (auth instanceof Response) return auth;
  reconcileQaRestartAuditOnce();
  reapQaRestartState();
  const authInfo = qaAuthPayload(auth);
  const restartAllowed = qaRestartAllowed() && auth.scope === 'admin';

  if (pathname === '/api/qa/catalog' && request.method === 'GET') {
    return jsonEtagResponse(
      request,
      {
        ok: true,
        qaAuth: authInfo,
        catalog: QA_TEST_CATALOG,
        restart: restartStatus(),
        restartAllowed,
      },
      headers,
    );
  }

  if (pathname === '/api/qa/history' && request.method === 'GET') {
    try {
      const url = new URL(request.url);
      const limitRaw = Number(url.searchParams.get('limit') || '120');
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 120;
      const history = await listQaHistory(limit);
      return jsonEtagResponse(request, { ok: true, qaAuth: authInfo, history, restart: restartStatus(), restartAllowed }, headers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 500, headers });
    }
  }

  if (pathname === '/api/qa/history/backfill' && request.method === 'POST') {
    try {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      const confirm = String(body?.['confirm'] || '').trim();
      if (confirm !== 'BACKFILL_QA_HISTORY') {
        return new Response(safeStringify({ ok: false, error: 'QA_HISTORY_BACKFILL_CONFIRM_REQUIRED' }), {
          status: 400,
          headers,
        });
      }
      const limitRaw = Number(body?.['limit'] ?? 500);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2_000, Math.floor(limitRaw))) : 500;
      const result = await backfillQaHistoryFromLogs(limit);
      return new Response(safeStringify({ ok: true, qaAuth: authInfo, result }), {
        headers: { ...headers, 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 500, headers });
    }
  }

  if (pathname === '/api/qa/restart' && request.method === 'GET') {
    return jsonEtagResponse(request, { ok: true, qaAuth: authInfo, restart: restartStatus(), restartAllowed }, headers);
  }

  if (pathname === '/api/qa/restart-audit' && request.method === 'GET') {
    const url = new URL(request.url);
    const limitRaw = Number(url.searchParams.get('limit') || '50');
    const audit = listQaRestartAudit(limitRaw);
    return jsonEtagResponse(request, { ok: true, qaAuth: authInfo, audit }, headers);
  }

  if (pathname === '/api/qa/restart/abort' && request.method === 'POST') {
    try {
      if (!restartAllowed) {
        return new Response(safeStringify({ ok: false, error: 'QA_RESTART_DISABLED', restartAllowed: false }), {
          status: 403,
          headers,
        });
      }
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      const confirm = String(body?.['confirm'] || '').trim();
      if (confirm !== 'ABORT_RESTART') {
        return new Response(safeStringify({ ok: false, error: 'QA_RESTART_ABORT_CONFIRM_REQUIRED' }), {
          status: 400,
          headers,
        });
      }
      if (!activeRestart) {
        return new Response(safeStringify({ ok: false, error: 'QA_RESTART_NOT_RUNNING', restart: readQaRestartStatus() }), {
          status: 409,
          headers,
        });
      }
      requestActiveRestartStop(activeRestart, 'aborted', `operator=${auth.actorKeyId}`);
      return new Response(safeStringify({ ok: true, qaAuth: authInfo, restart: readQaRestartStatus(), restartAllowed }), {
        status: 202,
        headers: { ...headers, 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 500, headers });
    }
  }

  if (pathname === '/api/qa/retention' && request.method === 'POST') {
    try {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      const confirm = String(body?.['confirm'] || '').trim();
      if (confirm !== 'DELETE_OLDER_THAN_30_DAYS') {
        return new Response(safeStringify({ ok: false, error: 'QA_RETENTION_CONFIRM_REQUIRED' }), {
          status: 400,
          headers,
        });
      }
      const result = purgeQaRunsOlderThan(30);
      return new Response(safeStringify({ ok: true, qaAuth: authInfo, result }), {
        headers: { ...headers, 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 500, headers });
    }
  }

  if (pathname === '/api/qa/restart' && request.method === 'POST') {
    try {
      const url = new URL(request.url);
      const mode = String(url.searchParams.get('mode') || 'run');
      const body = await readRestartBody(request);
      const { target, title } = await readRestartTarget(body);
      if (!title) throw new Error('QA_RESTART_TITLE_REQUIRED');
      const command = buildRestartCommand(target, title);
      const fingerprint = (deps.computeRestartFingerprint ?? computeQaRestartFingerprint)();
      if (mode === 'plan') {
        return new Response(safeStringify({
          ok: true,
          qaAuth: authInfo,
          mode,
          target,
          title,
          command: ['bun', ...command],
          expectedGitHead: fingerprint.gitHead,
          gitBranch: fingerprint.gitBranch,
          codeHash: fingerprint.codeHash,
          dirty: fingerprint.dirty,
        }), {
          headers: { ...headers, 'Cache-Control': 'no-store' },
        });
      }
      if (mode !== 'run') {
        return new Response(safeStringify({ ok: false, error: 'QA_RESTART_MODE_INVALID' }), {
          status: 400,
          headers,
        });
      }
      if (!restartAllowed) {
        return new Response(safeStringify({ ok: false, error: 'QA_RESTART_DISABLED', restartAllowed: false }), {
          status: 403,
          headers,
        });
      }
      const currentRestart = restartStatus();
      if (currentRestart['active'] === true) {
        return new Response(safeStringify({ ok: false, error: 'QA_RESTART_ALREADY_RUNNING', restart: currentRestart }), {
          status: 409,
          headers,
        });
      }
      const cooldownRemainingMs = Number(currentRestart['cooldownRemainingMs'] || 0);
      if (cooldownRemainingMs > 0) {
        return new Response(safeStringify({ ok: false, error: 'QA_RESTART_COOLDOWN_ACTIVE', restart: currentRestart }), {
          status: 429,
          headers,
        });
      }
      const intent = await readRestartIntent(body, fingerprint);
      const startedAt = Date.now();
      const logRoot = resolve(process.cwd(), '.logs', 'qa-restarts');
      mkdirSync(logRoot, { recursive: true });
      const logPath = join(logRoot, `${startedAt}-${intent.target.replace(/[^a-zA-Z0-9]+/g, '-')}.log`);
      const publicLogPath = publicQaPath(logPath);
      const auditId = buildAuditId(startedAt, auth, intent.target, intent.title);
      insertQaRestartAudit({
        auditId,
        status: 'started',
        actorKeyId: auth.actorKeyId,
        scope: auth.scope,
        operatorId: intent.operatorId,
        action: 'restart-run',
        target: intent.target,
        title: intent.title,
        reason: intent.reason,
        expectedGitHead: intent.expectedGitHead,
        actualGitHead: fingerprint.gitHead,
        gitBranch: fingerprint.gitBranch,
        codeHash: fingerprint.codeHash,
        dirty: fingerprint.dirty,
        startedAt,
        finishedAt: null,
        pid: null,
        exitCode: null,
        logPath: publicLogPath,
        requestIp: requestIp(request),
        userAgent: userAgent(request),
      });
      const log = createWriteStream(logPath, { flags: 'w' });
      let logClosed = false;
      const writeLog = (text: string): void => {
        if (!logClosed) log.write(text);
      };
      const closeLog = (suffix = ''): void => {
        if (logClosed) return;
        logClosed = true;
        log.end(suffix);
      };
      const proc = (deps.spawnRestart ?? spawn)('bun', command, {
        cwd: process.cwd(),
        env: buildQaRestartEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout?.on('data', chunk => writeLog(chunk.toString()));
      proc.stderr?.on('data', chunk => writeLog(chunk.toString()));
      proc.once('error', error => {
        const suffix = `\nQA_RESTART_SPAWN_ERROR:${error.message}\n`;
        if (activeRestart?.proc === proc) {
          finishActiveRestart(activeRestart, 'spawn_error', null, suffix);
          return;
        }
        finishQaRestartAudit(auditId, 'spawn_error', null);
        closeLog(suffix);
      });
      proc.once('exit', code => {
        if (activeRestart?.proc === proc) {
          finishActiveRestart(activeRestart, activeRestart.terminalStatus ?? 'finished', code ?? null);
          return;
        }
        closeLog();
      });
      const pid = proc.pid ?? null;
      if (pid !== null) {
        const db = openQaRestartAuditDb();
        try {
          db.query(`UPDATE qa_restart_audit SET pid = $pid WHERE audit_id = $auditId`).run({
            $pid: pid,
            $auditId: auditId,
          });
        } finally {
          db.close();
        }
      }
      const timeoutMs = qaRestartWatchdogMs();
      const watchdogAt = startedAt + timeoutMs;
      const killGraceMs = qaRestartKillGraceMs();
      const watchdogTimer = setTimeout(() => {
        if (activeRestart?.proc !== proc) return;
        reapQaRestartState(Date.now());
      }, timeoutMs);
      watchdogTimer.unref?.();
      activeRestart = {
        proc,
        auditId,
        startedAt,
        target: intent.target,
        title: intent.title,
        command: ['bun', ...command],
        logPath: publicLogPath,
        timeoutMs,
        watchdogAt,
        killGraceMs,
        watchdogTimer,
        sigkillTimer: null,
        terminalStatus: null,
        writeLog,
        closeLog,
      };
      return new Response(safeStringify({ ok: true, qaAuth: authInfo, restart: readQaRestartStatus(), restartAllowed: true }), {
        status: 202,
        headers: { ...headers, 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 400, headers });
    }
  }

  if (pathname === '/api/qa/stories' && request.method === 'GET') {
    try {
      const url = new URL(request.url);
      const limitRaw = Number(url.searchParams.get('limit') || '200');
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 200;
      const allStories = await listQaStoryScreenshots(500);
      const stories = allStories.slice(0, limit);
      const releasePack = auditQaUxReleasePack(allStories);
      return jsonEtagResponse(
        request,
        {
          ok: true,
          qaAuth: authInfo,
          total: stories.length,
          releasePack,
          stories,
        },
        headers,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 500, headers });
    }
  }

  if (pathname === '/api/qa/story-image' && request.method === 'GET') {
    const url = new URL(request.url);
    const source = String(url.searchParams.get('source') || '').trim() as QaStorySource;
    const relativePath = String(url.searchParams.get('path') || '').trim();
    if (!source || !relativePath) {
      return new Response(safeStringify({ ok: false, error: 'source and path are required' }), { status: 400, headers });
    }
    try {
      const absolutePath = await resolveQaStoryScreenshotPath(source, relativePath);
      return new Response(Bun.file(absolutePath), {
        headers: mediaHeaders(absolutePath),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 404, headers });
    }
  }

  if (pathname === '/api/qa/runs' && request.method === 'GET') {
    try {
      const url = new URL(request.url);
      const limitRaw = Number(url.searchParams.get('limit') || '20');
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20;
      const runs = await listQaRunSummaries(limit);
      return jsonEtagResponse(
        request,
        {
          ok: true,
          qaAuth: authInfo,
          runs,
          verdict: buildQaSystemVerdict(runs),
        },
        headers,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 500, headers });
    }
  }

  if (pathname === '/api/qa/run' && request.method === 'GET') {
    const url = new URL(request.url);
    const runId = String(url.searchParams.get('runId') || '').trim();
    if (!runId) {
      return new Response(safeStringify({ ok: false, error: 'runId is required' }), { status: 400, headers });
    }
    try {
      const run = await readQaRun(runId);
      return jsonEtagResponse(
        request,
        {
          ok: true,
          qaAuth: authInfo,
          run: stripQaRunPerfSamples(enrichQaRunUrls(run)),
        },
        headers,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 404, headers });
    }
  }

  if (pathname === '/api/qa/run/perf' && request.method === 'GET') {
    const url = new URL(request.url);
    const runId = String(url.searchParams.get('runId') || '').trim();
    if (!runId) {
      return new Response(safeStringify({ ok: false, error: 'runId is required' }), { status: 400, headers });
    }
    try {
      const run = await readQaRun(runId);
      const runPerf = run.perf ?? null;
      return jsonEtagResponse(
        request,
        {
          ok: true,
          qaAuth: authInfo,
          runId: run.runId,
          perf: runPerf ? summarizeQaPerf(runPerf) : null,
          samples: runPerf?.samples ?? [],
          shards: run.shards.map(shard => ({
            shard: shard.shard,
            handle: shard.handle,
            title: shard.title,
            perf: shard.perf ? summarizeQaPerf(shard.perf) : null,
            samples: shard.perf?.samples ?? [],
          })),
        },
        headers,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 404, headers });
    }
  }

  if (pathname === '/api/qa/artifact' && request.method === 'GET') {
    const url = new URL(request.url);
    const runId = String(url.searchParams.get('runId') || '').trim();
    const relativePath = String(url.searchParams.get('path') || '').trim();
    if (!runId || !relativePath) {
      return new Response(safeStringify({ ok: false, error: 'runId and path are required' }), { status: 400, headers });
    }
    try {
      const absolutePath = await resolveQaArtifactPath(runId, relativePath);
      const sensitivity = classifyQaArtifactSensitivity({
        name: relativePath.split('/').pop() ?? relativePath,
        relativePath,
        contentType: qaArtifactContentType(absolutePath),
      });
      if (sensitivity === 'secret-bearing' && auth.scope !== 'admin') {
        return new Response(safeStringify({
          ok: false,
          error: 'QA_ARTIFACT_ADMIN_REQUIRED',
          sensitivity,
          qaAuth: authInfo,
        }), {
          status: 403,
          headers: { ...headers, 'Cache-Control': 'no-store' },
        });
      }
      if (isQaTextArtifactPath(absolutePath)) {
        return new Response(redactQaSecretText(await Bun.file(absolutePath).text()), {
          headers: mediaHeaders(absolutePath),
        });
      }
      return new Response(Bun.file(absolutePath), {
        headers: mediaHeaders(absolutePath),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 404, headers });
    }
  }

  return null;
}
