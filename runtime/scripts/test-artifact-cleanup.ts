import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitizeChildProcessEnv } from '../server/child-process-env';

export const TEST_ARTIFACT_CLEANUP_DONE_ENV = 'XLN_TEST_ARTIFACT_CLEANUP_DONE';
export const KEEP_TEST_ARTIFACTS_ENV = 'XLN_KEEP_TEST_ARTIFACTS';
export const TEST_WORKSPACE_MAX_BYTES_ENV = 'XLN_TEST_WORKSPACE_MAX_BYTES';
export const DEFAULT_TEST_WORKSPACE_MAX_BYTES = 50 * 1024 * 1024 * 1024;
export const FOUNDRY_HOME_ENV = 'XLN_FOUNDRY_HOME';
export const FOUNDRY_MAX_BYTES_ENV = 'XLN_FOUNDRY_MAX_BYTES';
export const DEFAULT_FOUNDRY_MAX_BYTES = 50 * 1024 * 1024 * 1024;
export const TEST_ARTIFACT_RUN_LOCK_PATH = '.logs/.test-artifact-run-lock.json';
export const TEST_ARTIFACT_RUN_TOKEN_ENV = 'XLN_TEST_ARTIFACT_RUN_TOKEN';

type TestArtifactRunLock = {
  pid: number;
  reason: string;
  startedAt: string;
  token: string;
};

const ownedRunLocks = new Map<string, string>();
let runLockSequence = 0;
let exitCleanupRegistered = false;

const E2E_TEST_ARTIFACT_DIRS = [
  '.logs/e2e-parallel',
  'frontend/.svelte-kit-e2e',
  'frontend/test-results',
  'frontend/playwright-report',
  'tests/test-results',
  'e2e/test-results',
  'debates/test-results',
  '.svelte-kit-e2e',
  'test-results',
  'playwright-report',
];

const GENERATED_TEST_ARTIFACT_DIRS = [
  ...E2E_TEST_ARTIFACT_DIRS,
  'frontend/build',
  '.logs/scenarios-parallel',
  '.logs/bootstrap-soundcheck',
  '.logs/bootstrap-benchmark',
  '.logs/bootstrap-template',
  '.logs/soak',
  '.logs/system-tests',
  '.logs/gates',
  '.logs/bench-radapter',
  '.tmp-tests',
  'db-tmp',
  'build',
  'frontend/.svelte-kit/output',
  'native/dist',
  'native/extension/dist',
];

const BUDGETED_WORKSPACE_PATHS = [
  '.logs',
  'db',
  'db-tmp',
  'build',
  'frontend/build',
  'frontend/.svelte-kit',
  'frontend/.svelte-kit-e2e',
  '.svelte-kit-e2e',
  'test-results',
  'playwright-report',
  'frontend/test-results',
  'frontend/playwright-report',
  'tests/test-results',
  'e2e/test-results',
  'debates/test-results',
  '.tmp-tests',
  '.logs/soak',
  '.logs/system-tests',
  '.logs/gates',
  '.logs/bench-radapter',
  'native/dist',
  'native/extension/dist',
];

type CleanupOptions = {
  cwd?: string;
  argv?: string[];
  env?: Record<string, string | undefined>;
  reason: string;
  scope?: 'all' | 'e2e';
  skipIfAlreadyDone?: boolean;
  log?: (message: string) => void;
};

export type TestArtifactCleanupSummary = {
  skipped: boolean;
  removed: string[];
  estimatedBudgetedBytes: number;
  estimatedWorkspaceBytes: number;
  maxBytes: number;
  foundry: FoundryCleanupSummary;
};

export type FoundryCleanupSummary = {
  home: string;
  maxBytes: number;
  bytesBefore: number;
  bytesAfter: number;
  cleaned: boolean;
};

export const withoutTestArtifactCleanupDoneEnv = (
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> => {
  const next = sanitizeChildProcessEnv(env);
  delete next[TEST_ARTIFACT_CLEANUP_DONE_ENV];
  return next;
};

const hasFlag = (argv: string[], name: string): boolean =>
  argv.includes(`--${name}`);

const shouldKeepArtifacts = (argv: string[], env: Record<string, string | undefined>): boolean => {
  const raw = String(env[KEEP_TEST_ARTIFACTS_ENV] || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || hasFlag(argv, 'keep-test-artifacts') || hasFlag(argv, 'no-cleanup');
};

const parseMaxBytes = (env: Record<string, string | undefined>): number => {
  const raw = String(env[TEST_WORKSPACE_MAX_BYTES_ENV] || '').trim();
  if (!raw) return DEFAULT_TEST_WORKSPACE_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TEST_WORKSPACE_MAX_BYTES;
};

const parsePositiveByteLimit = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(String(raw || '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const pidIsAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
};

const readTestArtifactRunLock = (path: string): TestArtifactRunLock => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `TEST_ARTIFACT_RUN_LOCK_MALFORMED:path=${path}:` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = parsed as Partial<TestArtifactRunLock>;
  const pid = Number(body.pid);
  const reason = String(body.reason || '').trim();
  const startedAt = String(body.startedAt || '').trim();
  const token = String(body.token || '').trim();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !reason || !startedAt || !token) {
    throw new Error(`TEST_ARTIFACT_RUN_LOCK_MALFORMED:path=${path}:shape`);
  }
  return { pid, reason, startedAt, token };
};

const writeTestArtifactRunLockAtomically = (path: string, body: TestArtifactRunLock): void => {
  const tempPath = `${path}.${process.pid}-${body.pid}-${++runLockSequence}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(body)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
};

const registerOwnedRunLock = (path: string, token: string): void => {
  ownedRunLocks.set(path, token);
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once('exit', removeOwnedTestArtifactRunLocks);
};

const removeOwnedTestArtifactRunLocks = (): void => {
  for (const [path, token] of ownedRunLocks) {
    if (!existsSync(path)) continue;
    try {
      const observed = readTestArtifactRunLock(path);
      if (
        observed.token === token &&
        (observed.pid === process.pid || !pidIsAlive(observed.pid))
      ) {
        unlinkSync(path);
      }
    } catch (error) {
      // Exit cleanup must not replace the original process result. A malformed
      // or foreign lock remains as forensic evidence for the next fail-loud run.
      process.stderr.write(
        `TEST_ARTIFACT_RUN_LOCK_RELEASE_FAILED:path=${path}:` +
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  ownedRunLocks.clear();
};

const useOwnedRunLock = (
  path: string,
  token: string,
  env: Record<string, string | undefined>,
): TestArtifactRunLock => {
  const observed = readTestArtifactRunLock(path);
  if (observed.token !== token) {
    throw new Error(`TEST_ARTIFACT_RUN_LOCK_OWNERSHIP_LOST:path=${path}`);
  }
  env[TEST_ARTIFACT_RUN_TOKEN_ENV] = token;
  return observed;
};

const useInheritedRunLock = (
  path: string,
  token: string,
  env: Record<string, string | undefined>,
): TestArtifactRunLock => {
  if (!existsSync(path)) throw new Error(`TEST_ARTIFACT_RUN_LEASE_MISSING:path=${path}`);
  let observed = readTestArtifactRunLock(path);
  if (observed.token !== token) throw new Error(`TEST_ARTIFACT_RUN_LEASE_MISMATCH:path=${path}`);
  if (observed.pid !== process.pid && !pidIsAlive(observed.pid)) {
    observed = { ...observed, pid: process.pid };
    writeTestArtifactRunLockAtomically(path, observed);
  }
  // Reclaiming a dead child's lease does not transfer ownership of the root
  // run token. Only the process that created the lock may release it on exit;
  // otherwise a nested runner deletes the lease between sequential gate steps.
  env[TEST_ARTIFACT_RUN_TOKEN_ENV] = token;
  return observed;
};

const createTestArtifactRunLock = (
  path: string,
  reason: string,
  env: Record<string, string | undefined>,
): TestArtifactRunLock => {
  const token = `${process.pid}-${Date.now()}-${++runLockSequence}`;
  const body = { pid: process.pid, reason, startedAt: new Date().toISOString(), token };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify(body)}\n`, { encoding: 'utf8', flag: 'wx' });
      registerOwnedRunLock(path, token);
      env[TEST_ARTIFACT_RUN_TOKEN_ENV] = token;
      return body;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const observed = readTestArtifactRunLock(path);
      if (observed.pid !== process.pid && pidIsAlive(observed.pid)) {
        throw new Error(
          `TEST_ARTIFACT_CLEANUP_ACTIVE_RUN:pid=${observed.pid}:reason=${observed.reason}:` +
          `startedAt=${observed.startedAt}:path=${path}`,
        );
      }
      unlinkSync(path);
    }
  }
  throw new Error(`TEST_ARTIFACT_RUN_LOCK_ACQUIRE_FAILED:path=${path}`);
};

const claimTestArtifactRunLock = (
  cwd: string,
  reason: string,
  env: Record<string, string | undefined>,
): TestArtifactRunLock => {
  const path = join(cwd, TEST_ARTIFACT_RUN_LOCK_PATH);
  const ownedToken = ownedRunLocks.get(path);
  if (ownedToken) return useOwnedRunLock(path, ownedToken, env);

  mkdirSync(join(cwd, '.logs'), { recursive: true });
  const inheritedToken = String(env[TEST_ARTIFACT_RUN_TOKEN_ENV] || '').trim();
  return inheritedToken
    ? useInheritedRunLock(path, inheritedToken, env)
    : createTestArtifactRunLock(path, reason, env);
};

export const transferTestArtifactRunLease = (
  cwd: string,
  childPid: number,
  env: Record<string, string | undefined> = process.env,
): void => {
  if (!Number.isSafeInteger(childPid) || childPid <= 0) {
    throw new Error(`TEST_ARTIFACT_RUN_LEASE_CHILD_PID_INVALID:pid=${childPid}`);
  }
  const path = join(resolve(cwd), TEST_ARTIFACT_RUN_LOCK_PATH);
  const token = String(env[TEST_ARTIFACT_RUN_TOKEN_ENV] || '').trim();
  if (!token) throw new Error(`TEST_ARTIFACT_RUN_LEASE_TOKEN_REQUIRED:path=${path}`);
  const observed = readTestArtifactRunLock(path);
  if (observed.token !== token) {
    throw new Error(`TEST_ARTIFACT_RUN_LEASE_MISMATCH:path=${path}`);
  }
  writeTestArtifactRunLockAtomically(path, { ...observed, pid: childPid });
};

/**
 * Playwright targets inherit a cleanup lease from the top-level E2E runner.
 * The parent already performed deletion plus the expensive workspace/Foundry
 * budget scans. Validate the exact token-bound lock here without repeating
 * those scans once per Playwright target.
 */
export const validateInheritedTestArtifactRunLease = (options: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  reason: string;
  log?: (message: string) => void;
}): void => {
  const cwd = resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  if (env[TEST_ARTIFACT_CLEANUP_DONE_ENV] !== '1') {
    throw new Error('TEST_ARTIFACT_RUN_LEASE_MARKER_REQUIRED');
  }
  if (!String(env[TEST_ARTIFACT_RUN_TOKEN_ENV] || '').trim()) {
    throw new Error('TEST_ARTIFACT_RUN_LEASE_REQUIRED: parent cleanup marker has no run token');
  }
  claimTestArtifactRunLock(cwd, options.reason, env);
  (options.log || ((message: string) => console.log(message)))(
    `test artifact cleanup (${options.reason}): inherited parent lease validated`,
  );
};

const assertNoLiveE2eRunnerLock = (cwd: string): void => {
  const lockPath = join(cwd, '.logs', 'e2e-parallel', '.runner-lock.json');
  if (!existsSync(lockPath)) return;
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; startedAt?: unknown };
    const pid = Number(lock.pid);
    if (pidIsAlive(pid)) {
      throw new Error(`TEST_ARTIFACT_CLEANUP_LOCKED: pid=${pid} startedAt=${String(lock.startedAt || '')} path=${lockPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('TEST_ARTIFACT_CLEANUP_LOCKED')) throw error;
  }
};

const estimatePathBytes = (path: string): number => {
  if (!existsSync(path)) return 0;
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = stat.size;
  for (const name of readdirSync(path)) {
    total += estimatePathBytes(join(path, name));
  }
  return total;
};

const estimateFoundryBytes = (path: string, maxBytes: number): number => {
  if (!existsSync(path)) return 0;
  const result = spawnSync('du', ['-sk', path], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status === 0) {
    const kb = Number(String(result.stdout || '').trim().split(/\s+/)[0]);
    if (Number.isFinite(kb) && kb >= 0) return Math.floor(kb * 1024);
  }
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === 'ETIMEDOUT') {
    // A normal Foundry install measures in milliseconds. If walking it exceeds
    // the bounded gate budget, treat it as over-budget and clean only Anvil tmp.
    return maxBytes + 1;
  }
  throw new Error(`FOUNDRY_SIZE_SCAN_FAILED: home=${path} status=${String(result.status)} error=${String(result.error || result.stderr || '')}`);
};

const activeAnvilPids = (): number[] => {
  const result = spawnSync('ps', ['-ax', '-o', 'pid=', '-o', 'comm='], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`FOUNDRY_ANVIL_PROCESS_SCAN_FAILED: ${String(result.stderr || '').trim()}`);
  }
  return String(result.stdout || '')
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .filter(match => /(^|\/)anvil$/.test(match[2] || ''))
    .map(match => Number(match[1]));
};

export const cleanupFoundryIfOverBudget = (
  env: Record<string, string | undefined> = process.env,
  log: (message: string) => void = message => console.log(message),
): FoundryCleanupSummary => {
  const foundryHome = resolve(env[FOUNDRY_HOME_ENV] || join(homedir(), '.foundry'));
  const maxBytes = parsePositiveByteLimit(env[FOUNDRY_MAX_BYTES_ENV], DEFAULT_FOUNDRY_MAX_BYTES);
  const bytesBefore = estimateFoundryBytes(foundryHome, maxBytes);
  if (bytesBefore <= maxBytes) {
    return { home: foundryHome, maxBytes, bytesBefore, bytesAfter: bytesBefore, cleaned: false };
  }

  const anvilTmp = join(foundryHome, 'anvil', 'tmp');
  if (!existsSync(anvilTmp)) {
    throw new Error(`FOUNDRY_BUDGET_EXCEEDED_NO_SAFE_TARGET: home=${foundryHome} bytes>${maxBytes}`);
  }
  const livePids = activeAnvilPids();
  const defaultFoundryHome = resolve(join(homedir(), '.foundry'));
  if (foundryHome === defaultFoundryHome && livePids.length > 0) {
    throw new Error(`FOUNDRY_ANVIL_TMP_CLEANUP_BLOCKED: activeAnvilPids=${livePids.join(',')}`);
  }

  for (const child of readdirSync(anvilTmp)) {
    rmSync(join(anvilTmp, child), { recursive: true, force: true });
  }
  const bytesAfter = estimateFoundryBytes(foundryHome, maxBytes);
  if (bytesAfter > maxBytes) {
    throw new Error(`FOUNDRY_BUDGET_STILL_EXCEEDED: home=${foundryHome} bytes>${maxBytes}`);
  }
  log(`foundry cleanup: removed stale anvil state; ${(bytesBefore / (1024 ** 3)).toFixed(2)}GiB+ -> ${(bytesAfter / (1024 ** 3)).toFixed(2)}GiB`);
  return { home: foundryHome, maxBytes, bytesBefore, bytesAfter, cleaned: true };
};

const estimateBudgetedWorkspaceBytes = (cwd: string): number =>
  BUDGETED_WORKSPACE_PATHS.reduce((sum, relativePath) => sum + estimatePathBytes(join(cwd, relativePath)), 0);

const estimateWorkspaceBytes = (cwd: string): number => {
  const result = spawnSync('du', ['-sk', cwd], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status === 0) {
    const [rawKb] = String(result.stdout || '').trim().split(/\s+/);
    const kb = Number(rawKb);
    if (Number.isFinite(kb) && kb >= 0) return Math.floor(kb * 1024);
  }
  return estimatePathBytes(cwd);
};

const assertWorkspaceBudget = (
  cwd: string,
  maxBytes: number,
  reason: string,
): Pick<TestArtifactCleanupSummary, 'estimatedBudgetedBytes' | 'estimatedWorkspaceBytes'> => {
  const estimatedBudgetedBytes = estimateBudgetedWorkspaceBytes(cwd);
  const estimatedWorkspaceBytes = estimateWorkspaceBytes(cwd);
  if (estimatedWorkspaceBytes > maxBytes) {
    throw new Error(
      `TEST_WORKSPACE_BUDGET_EXCEEDED: workspace=${estimatedWorkspaceBytes} budgeted=${estimatedBudgetedBytes} max=${maxBytes} reason=${reason}`,
    );
  }
  return { estimatedBudgetedBytes, estimatedWorkspaceBytes };
};

const logWorkspaceBudget = (
  reason: string,
  maxBytes: number,
  estimatedBudgetedBytes: number,
  estimatedWorkspaceBytes: number,
  log: (message: string) => void,
): void => {
  log(
    `test artifact budget (${reason}): workspace=${(estimatedWorkspaceBytes / (1024 * 1024 * 1024)).toFixed(2)}GiB budgeted=${(estimatedBudgetedBytes / (1024 * 1024 * 1024)).toFixed(2)}GiB / ${(maxBytes / (1024 * 1024 * 1024)).toFixed(0)}GiB`,
  );
};

export const cleanupTestArtifactsBeforeRun = (options: CleanupOptions): TestArtifactCleanupSummary => {
  const cwd = resolve(options.cwd || process.cwd());
  const argv = options.argv || process.argv.slice(2);
  const env = options.env || process.env;
  const log = options.log || ((message: string) => console.log(message));
  const maxBytes = parseMaxBytes(env);
  if (
    options.skipIfAlreadyDone !== false &&
    env[TEST_ARTIFACT_CLEANUP_DONE_ENV] === '1' &&
    !String(env[TEST_ARTIFACT_RUN_TOKEN_ENV] || '').trim()
  ) {
    throw new Error('TEST_ARTIFACT_RUN_LEASE_REQUIRED: parent cleanup marker has no run token');
  }
  claimTestArtifactRunLock(cwd, options.reason, env);
  // Explicit test environments without XLN_FOUNDRY_HOME are isolated fixtures;
  // never let a unit test unexpectedly inspect or mutate the developer's home.
  const foundry = options.env && !(FOUNDRY_HOME_ENV in env)
    ? { home: '', maxBytes: DEFAULT_FOUNDRY_MAX_BYTES, bytesBefore: 0, bytesAfter: 0, cleaned: false }
    : cleanupFoundryIfOverBudget(env, log);

  if (options.skipIfAlreadyDone !== false && env[TEST_ARTIFACT_CLEANUP_DONE_ENV] === '1') {
    const { estimatedBudgetedBytes, estimatedWorkspaceBytes } = assertWorkspaceBudget(cwd, maxBytes, options.reason);
    log(`test artifact cleanup (${options.reason}): already completed by parent runner`);
    logWorkspaceBudget(options.reason, maxBytes, estimatedBudgetedBytes, estimatedWorkspaceBytes, log);
    return { skipped: true, removed: [], estimatedBudgetedBytes, estimatedWorkspaceBytes, maxBytes, foundry };
  }
  if (shouldKeepArtifacts(argv, env)) {
    const { estimatedBudgetedBytes, estimatedWorkspaceBytes } = assertWorkspaceBudget(cwd, maxBytes, options.reason);
    log(`test artifact cleanup (${options.reason}): preserving existing artifacts`);
    logWorkspaceBudget(options.reason, maxBytes, estimatedBudgetedBytes, estimatedWorkspaceBytes, log);
    return { skipped: true, removed: [], estimatedBudgetedBytes, estimatedWorkspaceBytes, maxBytes, foundry };
  }

  assertNoLiveE2eRunnerLock(cwd);

  const cleanupPaths = options.scope === 'e2e' ? E2E_TEST_ARTIFACT_DIRS : GENERATED_TEST_ARTIFACT_DIRS;
  const removed: string[] = [];
  for (const relativePath of cleanupPaths) {
    const absolutePath = join(cwd, relativePath);
    if (!existsSync(absolutePath)) continue;
    log(`test artifact cleanup (${options.reason}): removing ${relativePath}`);
    rmSync(absolutePath, { recursive: true, force: true });
    removed.push(relativePath);
  }
  mkdirSync(join(cwd, '.logs'), { recursive: true });

  const { estimatedBudgetedBytes, estimatedWorkspaceBytes } = assertWorkspaceBudget(cwd, maxBytes, options.reason);
  if (removed.length > 0) {
    log(`test artifact cleanup (${options.reason}): removed ${removed.join(', ')}`);
  }
  logWorkspaceBudget(options.reason, maxBytes, estimatedBudgetedBytes, estimatedWorkspaceBytes, log);
  return { skipped: false, removed, estimatedBudgetedBytes, estimatedWorkspaceBytes, maxBytes, foundry };
};

const cliFlagValue = (argv: string[], name: string): string | undefined => {
  const prefix = `--${name}=`;
  const inline = argv.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.findIndex(arg => arg === `--${name}`);
  if (index >= 0) {
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) return next;
  }
  return undefined;
};

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    const cwd = cliFlagValue(argv, 'cwd') || process.cwd();
    const reason = cliFlagValue(argv, 'reason') || 'manual';
    if (hasFlag(argv, 'validate-inherited-lease')) {
      validateInheritedTestArtifactRunLease({ cwd, reason });
    } else {
      cleanupTestArtifactsBeforeRun({
        cwd,
        reason,
        scope: cliFlagValue(argv, 'scope') === 'e2e' ? 'e2e' : 'all',
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
