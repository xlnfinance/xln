import { consumeQaTokenFromUrl, qaFetch, readQaToken, writeQaToken } from '$lib/qa/apiClient';

export type OpsRunCategory = 'unit' | 'contract' | 'e2e' | 'scenario' | 'benchmark' | 'release' | 'unknown';
export type OpsRunRow = Readonly<{
  runId: string;
  createdAt: number;
  status: 'passed' | 'failed' | 'unknown';
  category: OpsRunCategory;
  suiteKey: string;
  suiteLabel: string;
  gitHead: string | null;
  codeHash: string | null;
  dirty: boolean;
  startedBy: string;
  durationMs: number | null;
  playwrightMs: number | null;
  failedShard: string | null;
  artifactBytes: number;
  browserErrors: number;
  browserWarnings: number;
  networkFailures: number;
  benchmarkStatus: string | null;
  benchmarkDeltaPct: number | null;
}>;
export type OpsRunsPage = Readonly<{ auth: 'open' | 'read' | 'admin' | 'locked'; ledger: readonly OpsRunRow[] }>;

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};
const text = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};
const optionalText = (value: unknown, code: string): string | null => value === null || value === undefined ? null : text(value, code);
const number = (value: unknown, code: string, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new Error(code);
  return value;
};
const optionalNumber = (value: unknown, code: string, minimum = 0): number | null => value === null || value === undefined ? null : number(value, code, minimum);

const parseRun = (value: unknown, index: number): OpsRunRow => {
  const raw = record(value, `OPS_RUN_INVALID:${index}`);
  const status = text(raw['status'], `OPS_RUN_STATUS_INVALID:${index}`);
  if (status !== 'passed' && status !== 'failed' && status !== 'unknown') throw new Error(`OPS_RUN_STATUS_UNKNOWN:${status}`);
  const category = text(raw['category'], `OPS_RUN_CATEGORY_INVALID:${index}`);
  if (!['unit', 'contract', 'e2e', 'scenario', 'benchmark', 'release', 'unknown'].includes(category)) throw new Error(`OPS_RUN_CATEGORY_UNKNOWN:${category}`);
  const timing = raw['timing'] === undefined ? {} : record(raw['timing'], `OPS_RUN_TIMING_INVALID:${index}`);
  if (typeof raw['dirty'] !== 'boolean') throw new Error(`OPS_RUN_DIRTY_INVALID:${index}`);
  return Object.freeze({
    runId: text(raw['runId'], `OPS_RUN_ID_INVALID:${index}`),
    createdAt: number(raw['createdAt'], `OPS_RUN_CREATED_INVALID:${index}`, 1),
    status,
    category: category as OpsRunCategory,
    suiteKey: text(raw['suiteKey'], `OPS_RUN_SUITE_KEY_INVALID:${index}`),
    suiteLabel: text(raw['suiteLabel'], `OPS_RUN_SUITE_LABEL_INVALID:${index}`),
    gitHead: optionalText(raw['gitHead'], `OPS_RUN_GIT_HEAD_INVALID:${index}`),
    codeHash: optionalText(raw['codeHash'], `OPS_RUN_CODE_HASH_INVALID:${index}`),
    dirty: raw['dirty'],
    startedBy: text(raw['startedBy'], `OPS_RUN_OWNER_INVALID:${index}`),
    durationMs: optionalNumber(raw['durationMs'], `OPS_RUN_DURATION_INVALID:${index}`),
    playwrightMs: optionalNumber(timing['playwrightMs'], `OPS_RUN_PLAYWRIGHT_INVALID:${index}`),
    failedShard: optionalText(raw['failedShard'], `OPS_RUN_FAILED_SHARD_INVALID:${index}`),
    artifactBytes: number(raw['artifactBytes'], `OPS_RUN_ARTIFACT_BYTES_INVALID:${index}`),
    browserErrors: number(raw['browserErrors'], `OPS_RUN_BROWSER_ERRORS_INVALID:${index}`),
    browserWarnings: number(raw['browserWarnings'], `OPS_RUN_BROWSER_WARNINGS_INVALID:${index}`),
    networkFailures: number(raw['networkFailures'], `OPS_RUN_NETWORK_FAILURES_INVALID:${index}`),
    benchmarkStatus: optionalText(raw['benchmarkStatus'], `OPS_RUN_BENCHMARK_STATUS_INVALID:${index}`),
    benchmarkDeltaPct: optionalNumber(raw['benchmarkDeltaPct'], `OPS_RUN_BENCHMARK_DELTA_INVALID:${index}`, Number.NEGATIVE_INFINITY),
  });
};

export const parseOpsRunsPage = (value: unknown): OpsRunsPage => {
  const raw = record(value, 'OPS_RUNS_PAYLOAD_INVALID');
  if (raw['ok'] === false) throw new Error(optionalText(raw['error'], 'OPS_RUNS_ERROR_INVALID') ?? 'OPS_RUNS_READ_FAILED');
  if (!Array.isArray(raw['ledger'])) throw new Error('OPS_RUNS_LEDGER_INVALID');
  const authRaw = raw['qaAuth'] === undefined ? {} : record(raw['qaAuth'], 'OPS_RUNS_AUTH_INVALID');
  const disabled = authRaw['disabled'];
  if (disabled !== undefined && typeof disabled !== 'boolean') throw new Error('OPS_RUNS_AUTH_DISABLED_INVALID');
  const scope = optionalText(authRaw['scope'], 'OPS_RUNS_AUTH_SCOPE_INVALID');
  const auth = disabled === true ? 'open' : scope === 'read' || scope === 'admin' ? scope : 'locked';
  const ledger = raw['ledger'].map(parseRun);
  const ids = new Set<string>();
  for (const run of ledger) {
    if (ids.has(run.runId)) throw new Error(`OPS_RUN_DUPLICATE:${run.runId}`);
    ids.add(run.runId);
  }
  return Object.freeze({ auth, ledger: Object.freeze(ledger.toSorted((left, right) => right.createdAt - left.createdAt || left.runId.localeCompare(right.runId))) });
};

export const readOpsRuns = async (): Promise<OpsRunsPage> => {
  const response = await qaFetch('/api/qa/runs?limit=50', { cache: 'no-store' });
  const value: unknown = await response.json();
  if (!response.ok) {
    const raw = record(value, 'OPS_RUNS_HTTP_BODY_INVALID');
    throw new Error(optionalText(raw['error'], 'OPS_RUNS_HTTP_ERROR_INVALID') ?? `OPS_RUNS_HTTP_${response.status}`);
  }
  return parseOpsRunsPage(value);
};

export const initializeOpsQaToken = (): string => consumeQaTokenFromUrl() || readQaToken();
export const saveOpsQaToken = (token: string): void => writeQaToken(token);
