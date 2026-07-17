import type { QaTestLedgerEntry } from './types';

export type QaTestLedgerFilter = 'all' | 'functional' | 'resilience' | 'failed';
export type QaTestLedgerSortKey = 'category' | 'test' | 'description' | 'status' | 'duration' | 'last-run';
export type QaTestLedgerSortDirection = 'asc' | 'desc';

export type QaTestLedgerMetric = {
  count: number;
  failed: number;
  measured: number;
  durationMs: number;
};

export type QaTestLedgerSummary = {
  total: QaTestLedgerMetric;
  functional: QaTestLedgerMetric;
  resilience: QaTestLedgerMetric;
  unknown: QaTestLedgerMetric;
};

const compareText = (left: string, right: string): number => {
  const a = left.trim().toLocaleLowerCase();
  const b = right.trim().toLocaleLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
};

const compareOptionalNumber = (left: number | null, right: number | null): number => {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left - right;
};

const compareLedgerRows = (
  left: QaTestLedgerEntry,
  right: QaTestLedgerEntry,
  key: QaTestLedgerSortKey,
): number => {
  if (key === 'category') return compareText(left.category, right.category);
  if (key === 'test') return compareText(left.title, right.title) || compareText(left.target, right.target);
  if (key === 'description') return compareText(left.description, right.description);
  if (key === 'status') return compareText(left.status, right.status);
  if (key === 'duration') return compareOptionalNumber(left.durationMs, right.durationMs);
  return left.lastRunAt - right.lastRunAt;
};

export const filterQaTestLedger = (
  rows: readonly QaTestLedgerEntry[],
  filter: QaTestLedgerFilter,
): QaTestLedgerEntry[] => {
  if (filter === 'all') return [...rows];
  if (filter === 'failed') return rows.filter(row => row.status === 'failed');
  return rows.filter(row => row.category === filter);
};

export const sortQaTestLedger = (
  rows: readonly QaTestLedgerEntry[],
  key: QaTestLedgerSortKey,
  direction: QaTestLedgerSortDirection,
): QaTestLedgerEntry[] => [...rows].sort((left, right) => {
  if (key === 'duration' && (left.durationMs === null || right.durationMs === null)) {
    return compareOptionalNumber(left.durationMs, right.durationMs) || compareText(left.testId, right.testId);
  }
  const primary = compareLedgerRows(left, right, key);
  const directed = direction === 'asc' ? primary : -primary;
  return directed || compareText(left.testId, right.testId);
});

const emptyMetric = (): QaTestLedgerMetric => ({ count: 0, failed: 0, measured: 0, durationMs: 0 });

const addRow = (metric: QaTestLedgerMetric, row: QaTestLedgerEntry): void => {
  metric.count += 1;
  if (row.status === 'failed') metric.failed += 1;
  if (row.durationMs !== null) {
    metric.measured += 1;
    metric.durationMs += row.durationMs;
  }
};

export const summarizeQaTestLedger = (rows: readonly QaTestLedgerEntry[]): QaTestLedgerSummary => {
  const summary: QaTestLedgerSummary = {
    total: emptyMetric(),
    functional: emptyMetric(),
    resilience: emptyMetric(),
    unknown: emptyMetric(),
  };
  for (const row of rows) {
    addRow(summary.total, row);
    addRow(summary[row.category], row);
  }
  return summary;
};
