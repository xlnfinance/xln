import { useMemo, useState } from 'react';

import {
  filterQaTestLedger,
  sortQaTestLedger,
  summarizeQaTestLedger,
  type QaTestLedgerFilter,
  type QaTestLedgerSortDirection,
  type QaTestLedgerSortKey,
} from '../../../packages/runtime-client/src/qa-test-ledger';
import type { QaTestLedgerEntry } from '../../../packages/runtime-client/src/qa-types';

const formatDuration = (value: number | null): string => {
  if (value === null) return 'n/a';
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(1)} s`;
};

const metric = (count: number, failed: number, durationMs: number): string =>
  `${count} ${count === 1 ? 'test' : 'tests'} · ${failed} failed · ${formatDuration(durationMs)}`;

const FILTERS: readonly QaTestLedgerFilter[] = ['all', 'functional', 'resilience', 'failed'];
const COLUMNS: readonly Readonly<{ key: QaTestLedgerSortKey; label: string }>[] = [
  { key: 'category', label: 'Category' }, { key: 'test', label: 'Test' },
  { key: 'description', label: 'Description' }, { key: 'status', label: 'Status' },
  { key: 'duration', label: 'Duration' }, { key: 'last-run', label: 'Last run' },
];

export function OpsQaTestLedger({ rows }: Readonly<{ rows: readonly QaTestLedgerEntry[] }>) {
  const [filter, setFilter] = useState<QaTestLedgerFilter>('all');
  const [sort, setSort] = useState<QaTestLedgerSortKey>('last-run');
  const [direction, setDirection] = useState<QaTestLedgerSortDirection>('desc');
  const summary = useMemo(() => summarizeQaTestLedger(rows), [rows]);
  const visible = useMemo(() => sortQaTestLedger(filterQaTestLedger(rows, filter), sort, direction), [rows, filter, sort, direction]);
  const filterCount = (value: QaTestLedgerFilter): number => {
    if (value === 'all') return summary.total.count;
    if (value === 'failed') return summary.total.failed;
    return summary[value].count;
  };
  const setSortKey = (key: QaTestLedgerSortKey): void => {
    if (key === sort) setDirection(value => value === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setDirection(key === 'last-run' ? 'desc' : 'asc'); }
  };

  return (
    <section className="ops-qa-test-ledger" data-testid="qa-test-ledger">
      <header>
        <div><span>CONCRETE PLAYWRIGHT TESTS</span><h2>Test ledger</h2></div>
        <p data-testid="qa-test-ledger-summary">
          {metric(summary.total.count, summary.total.failed, summary.total.durationMs)} · {' '}
          {summary.functional.count} functional · {summary.resilience.count} resilience
        </p>
      </header>
      <div className="ops-qa-filters" data-testid="qa-test-ledger-filters">
        {FILTERS.map(value => (
          <button aria-pressed={filter === value} key={value} onClick={() => setFilter(value)} type="button">
            {value === 'all' ? 'All' : value[0]?.toUpperCase() + value.slice(1)} {filterCount(value)}
          </button>
        ))}
      </div>
      <div className="ops-qa-table-wrap">
        <table>
          <thead><tr>{COLUMNS.map(column => (
            <th aria-sort={sort === column.key ? `${direction}ending` : 'none'} key={column.key}>
              <button data-testid={`qa-test-sort-${column.key}`} onClick={() => setSortKey(column.key)} type="button">{column.label}</button>
            </th>
          ))}</tr></thead>
          <tbody>{visible.map(row => (
            <tr data-status={row.status} data-testid="qa-test-ledger-row" key={row.testId}>
              <td>{row.category}</td><td><strong>{row.title}</strong><code>{row.target}</code></td>
              <td>{row.description}</td><td data-status={row.status}>{row.status}</td>
              <td>{formatDuration(row.durationMs)}</td><td>{new Date(row.lastRunAt).toISOString().slice(0, 10)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {visible.length === 0 ? <p className="ops-qa-empty">No tests match this filter.</p> : null}
    </section>
  );
}
