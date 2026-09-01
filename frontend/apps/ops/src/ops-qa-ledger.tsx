import { useMemo, useState } from 'react';

import { QA } from '../../../../core/config/qa';
import { formatQaBytes } from '../../../packages/runtime-client/src/qa-admin-evidence';
import { benchmarkLabel, formatMs, formatPct, shortHash, statusLabel } from '../../../packages/runtime-client/src/qa-cockpit-helpers';
import type { QaRunLedgerEntry } from '../../../packages/runtime-client/src/qa-types';

export function OpsQaCanonicalLedger({ rows }: Readonly<{ rows: readonly QaRunLedgerEntry[] }>) {
  const [category, setCategory] = useState('all');
  const [windowSize, setWindowSize] = useState<number>(QA.LEDGER_WINDOW_STEP);
  const categories = useMemo(() => Array.from(new Set(rows.map(row => row.category))).sort(), [rows]);
  const filtered = useMemo(() => (category === 'all' ? rows : rows.filter(row => row.category === category))
    .slice(0, windowSize), [rows, category, windowSize]);
  return <section className="ops-qa-canonical-ledger" data-testid="qa-run-ledger">
    <header><div><span>CANONICAL LEDGER</span><h2>Runs across test surfaces</h2></div><strong>{filtered.length}/{rows.length}</strong></header>
    <div className="ops-qa-filters" data-testid="qa-ledger-category-filter"><button aria-pressed={category === 'all'} onClick={() => setCategory('all')} type="button">all</button>{categories.map(value => <button aria-pressed={category === value} key={value} onClick={() => setCategory(value)} type="button">{value}</button>)}</div>
    <div className="ops-qa-ledger-list">{filtered.map(row => <article data-run-id={row.runId} data-status={row.status} data-testid="qa-ledger-row" key={row.runId}>
      <strong>{statusLabel(row)}</strong><span>{row.category}</span><span>{row.suiteLabel}</span><span>by {row.startedBy}</span>
      <span>{formatMs(row.durationMs)}</span><span>{formatQaBytes(row.artifactBytes)} artifacts</span>
      <span>cpu p95 {row.cpuP95Pct ?? 'n/a'}%</span><span>browser {row.browserErrors} err / {row.browserWarnings} warn</span>
      <span>network {row.networkFailures}</span><span>{benchmarkLabel(row.benchmarkStatus)} {formatPct(row.benchmarkDeltaPct)}</span>
      <code>head {shortHash(row.gitHead)}</code><code>code {shortHash(row.codeHash)}</code>
    </article>)}</div>
    {filtered.length === 0 ? <p className="ops-qa-empty">No canonical ledger rows indexed.</p> : null}
    {filtered.length < rows.length ? <button className="ops-qa-more" data-testid="qa-ledger-show-more" onClick={() => setWindowSize(size => size + QA.LEDGER_WINDOW_STEP)} type="button">Show more ledger rows</button> : null}
  </section>;
}
