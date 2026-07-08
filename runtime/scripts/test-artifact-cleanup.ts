import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const TEST_ARTIFACT_CLEANUP_DONE_ENV = 'XLN_TEST_ARTIFACT_CLEANUP_DONE';
export const KEEP_TEST_ARTIFACTS_ENV = 'XLN_KEEP_TEST_ARTIFACTS';
export const TEST_WORKSPACE_MAX_BYTES_ENV = 'XLN_TEST_WORKSPACE_MAX_BYTES';
export const DEFAULT_TEST_WORKSPACE_MAX_BYTES = 50 * 1024 * 1024 * 1024;

const E2E_TEST_ARTIFACT_DIRS = [
  '.logs/e2e-parallel',
  'frontend/.svelte-kit-e2e',
  'frontend/build',
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
  '.logs/scenarios-parallel',
  '.logs/bootstrap-soundcheck',
  '.logs/bootstrap-benchmark',
  '.logs/bootstrap-template',
  '.logs/soak',
  '.logs/system-tests',
  '.logs/gates',
  '.logs/bench-radapter',
  '.tmp-tests',
  'build',
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
  maxBytes: number;
};

export const withoutTestArtifactCleanupDoneEnv = (
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> => {
  const next = { ...env };
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

const pidIsAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

const estimateBudgetedWorkspaceBytes = (cwd: string): number =>
  BUDGETED_WORKSPACE_PATHS.reduce((sum, relativePath) => sum + estimatePathBytes(join(cwd, relativePath)), 0);

export const cleanupTestArtifactsBeforeRun = (options: CleanupOptions): TestArtifactCleanupSummary => {
  const cwd = resolve(options.cwd || process.cwd());
  const argv = options.argv || process.argv.slice(2);
  const env = options.env || process.env;
  const log = options.log || ((message: string) => console.log(message));
  const maxBytes = parseMaxBytes(env);

  if (options.skipIfAlreadyDone !== false && env[TEST_ARTIFACT_CLEANUP_DONE_ENV] === '1') {
    return { skipped: true, removed: [], estimatedBudgetedBytes: 0, maxBytes };
  }
  if (shouldKeepArtifacts(argv, env)) {
    return { skipped: true, removed: [], estimatedBudgetedBytes: 0, maxBytes };
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

  const estimatedBudgetedBytes = estimateBudgetedWorkspaceBytes(cwd);
  if (estimatedBudgetedBytes > maxBytes) {
    throw new Error(
      `TEST_WORKSPACE_BUDGET_EXCEEDED: estimated=${estimatedBudgetedBytes} max=${maxBytes} reason=${options.reason}`,
    );
  }
  if (removed.length > 0) {
    log(`test artifact cleanup (${options.reason}): removed ${removed.join(', ')}`);
  }
  log(
    `test artifact budget (${options.reason}): ${(estimatedBudgetedBytes / (1024 * 1024 * 1024)).toFixed(2)}GiB / ${(maxBytes / (1024 * 1024 * 1024)).toFixed(0)}GiB`,
  );
  return { skipped: false, removed, estimatedBudgetedBytes, maxBytes };
};
