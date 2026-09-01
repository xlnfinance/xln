import type { QaRunCategory, QaRunLedgerEntry } from '../../../packages/runtime-client/src/qa-types';
import { decodeOpsQaRuns, opsQaAuthLabel, type OpsQaAuthLabel } from './ops-qa-model';

export type OpsRunsSortKey =
  | 'date-desc'
  | 'date-asc'
  | 'stack-fast'
  | 'stack-slow'
  | 'browser-fast'
  | 'browser-slow';

export type OpsRunsPayload = Readonly<{
  auth: OpsQaAuthLabel;
  rows: readonly QaRunLedgerEntry[];
}>;

export type OpsRunsSummary = Readonly<{
  total: number;
  passed: number;
  failed: number;
  benchmarkAlerts: number;
  browserAlerts: number;
}>;

export const decodeOpsRuns = (value: unknown): OpsRunsPayload => {
  const payload = decodeOpsQaRuns(value);
  return { auth: opsQaAuthLabel(payload.auth), rows: payload.ledger };
};

export const requestedOpsRunId = (url: URL): string => String(url.searchParams.get('runId') || '').trim();

export const readOpsRunsSort = (value: string): OpsRunsSortKey => {
  const options: readonly OpsRunsSortKey[] = [
    'date-desc', 'date-asc', 'stack-fast', 'stack-slow', 'browser-fast', 'browser-slow',
  ];
  const match = options.find(option => option === value);
  if (!match) throw new Error(`OPS_RUNS_SORT_INVALID:${value}`);
  return match;
};

const sortValue = (row: QaRunLedgerEntry, key: OpsRunsSortKey): number => {
  if (key.startsWith('stack')) return row.durationMs ?? Number.POSITIVE_INFINITY;
  return row.timing.playwrightMs ?? Number.POSITIVE_INFINITY;
};

const compareOpsRuns = (left: QaRunLedgerEntry, right: QaRunLedgerEntry, key: OpsRunsSortKey): number => {
  if (key === 'date-asc') return left.createdAt - right.createdAt || left.runId.localeCompare(right.runId);
  if (key === 'date-desc') return right.createdAt - left.createdAt || right.runId.localeCompare(left.runId);
  const difference = sortValue(left, key) - sortValue(right, key);
  return key.endsWith('slow') ? -difference || right.createdAt - left.createdAt : difference || right.createdAt - left.createdAt;
};

const matchesQuery = (row: QaRunLedgerEntry, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.runId, row.category, row.suiteKey, row.suiteLabel, row.startedBy, row.status,
    row.failedShard, row.auditAction, row.gitHead, row.codeHash]
    .some(value => String(value ?? '').toLowerCase().includes(needle));
};

export const filterOpsRuns = (
  rows: readonly QaRunLedgerEntry[],
  category: QaRunCategory | 'all',
  query: string,
  sort: OpsRunsSortKey,
): readonly QaRunLedgerEntry[] => rows
  .filter(row => category === 'all' || row.category === category)
  .filter(row => matchesQuery(row, query))
  .toSorted((left, right) => compareOpsRuns(left, right, sort));

export const opsRunsCategories = (rows: readonly QaRunLedgerEntry[]): readonly QaRunCategory[] =>
  Array.from(new Set(rows.map(row => row.category))).sort();

export const summarizeOpsRuns = (rows: readonly QaRunLedgerEntry[]): OpsRunsSummary => {
  const summary = { total: rows.length, passed: 0, failed: 0, benchmarkAlerts: 0, browserAlerts: 0 };
  for (const row of rows) {
    if (row.status === 'passed') summary.passed += 1;
    if (row.status === 'failed') summary.failed += 1;
    if (row.benchmarkStatus === 'slower' || row.benchmarkStatus === 'mixed') summary.benchmarkAlerts += 1;
    if (row.browserErrors > 0 || row.networkFailures > 0) summary.browserAlerts += 1;
  }
  return summary;
};
