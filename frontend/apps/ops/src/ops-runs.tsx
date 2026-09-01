import { useDeferredValue, useMemo, useState, useSyncExternalStore } from 'react';

import { QA } from '../../../../core/config/qa';
import { readQaToken } from '../../../packages/browser/src/qa-api-client';
import { formatQaBytes } from '../../../packages/runtime-client/src/qa-admin-evidence';
import { benchmarkLabel, formatDate, formatMs, formatPct, shortHash, statusLabel } from '../../../packages/runtime-client/src/qa-cockpit-helpers';
import type { QaRunCategory, QaRunLedgerEntry } from '../../../packages/runtime-client/src/qa-types';
import { OpsShell } from './ops-shell';
import { filterOpsRuns, opsRunsCategories, readOpsRunsSort, summarizeOpsRuns, type OpsRunsSortKey } from './ops-runs-model';
import { opsRunsSource } from './ops-runs-runtime';
import './styles/ops-runs.css';

function OpsRunsRow({ row, selected, onSelect }: Readonly<{
  row: QaRunLedgerEntry;
  selected: boolean;
  onSelect: () => void;
}>) {
  const alertCount = row.browserErrors + row.networkFailures + row.failedTargets.length;
  return <button className={selected ? 'is-selected' : ''} data-run-id={row.runId} data-status={row.status} data-testid="runs-ledger-row" onClick={onSelect} type="button">
    <strong>{statusLabel(row)}</strong>
    <span><b>{row.suiteLabel}</b><small>{row.category} · {row.testCategory}</small></span>
    <span><b>{formatMs(row.durationMs)}</b><small>{formatDate(row.createdAt)}</small></span>
    <span data-alert={alertCount > 0}><b>{alertCount} signals</b><small>{row.failedShard ?? 'no failed shard'}</small></span>
    <code>head {shortHash(row.gitHead)}</code>
  </button>;
}

function OpsRunsInspector({ row }: Readonly<{ row: QaRunLedgerEntry | null }>) {
  if (!row) return <aside className="ops-runs-inspector"><p>Select a run to inspect its authority and failure evidence.</p></aside>;
  return <aside className="ops-runs-inspector" data-status={row.status} data-testid="runs-inspector">
    <header><span>SELECTED RUN</span><strong>{statusLabel(row)}</strong></header>
    <h2>{row.suiteLabel}</h2><code>{row.runId}</code>
    <dl>
      <div><dt>Started</dt><dd>{formatDate(row.createdAt)}</dd></div><div><dt>Owner</dt><dd>{row.startedBy}</dd></div>
      <div><dt>Wall</dt><dd>{formatMs(row.durationMs)}</dd></div><div><dt>Browser</dt><dd>{row.browserErrors} err / {row.browserWarnings} warn</dd></div>
      <div><dt>Network</dt><dd>{row.networkFailures}</dd></div><div><dt>Artifacts</dt><dd>{formatQaBytes(row.artifactBytes)}</dd></div>
      <div><dt>CPU p95 / peak</dt><dd>{row.cpuP95Pct ?? 'n/a'}% / {row.cpuPeakPct ?? 'n/a'}%</dd></div><div><dt>RAM peak</dt><dd>{row.ramPeakKb ?? 'n/a'} KB</dd></div>
    </dl>
    <section><span>BENCHMARK</span><strong>{benchmarkLabel(row.benchmarkStatus)} {formatPct(row.benchmarkDeltaPct)}</strong><small>{row.benchmarkComparedRunId ?? 'no comparable baseline'}</small></section>
    <section><span>AUTHORITY</span><code>head {row.gitHead ?? 'n/a'}</code><code>code {row.codeHash ?? 'n/a'}</code><small>{row.gitBranch ?? 'branch n/a'}{row.dirty ? ' · dirty' : ''}</small></section>
    {row.failedTargets.length > 0 ? <section><span>FAILED TARGETS</span>{row.failedTargets.map(target => <code key={target}>{target}</code>)}</section> : null}
    <a data-testid="runs-open-qa" href={`/qa?runId=${encodeURIComponent(row.runId)}`}>Open full QA evidence</a>
  </aside>;
}

export function OpsRunsPage() {
  const source = useSyncExternalStore(opsRunsSource.subscribe, opsRunsSource.getSnapshot, opsRunsSource.getSnapshot);
  const [token, setToken] = useState(readQaToken);
  const [category, setCategory] = useState<QaRunCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<OpsRunsSortKey>('date-desc');
  const [windowSize, setWindowSize] = useState<number>(QA.LEDGER_WINDOW_STEP);
  const deferredQuery = useDeferredValue(query);
  const rows = useMemo(() => filterOpsRuns(source.rows, category, deferredQuery, sort), [source.rows, category, deferredQuery, sort]);
  const categories = useMemo(() => opsRunsCategories(source.rows), [source.rows]);
  const summary = useMemo(() => summarizeOpsRuns(source.rows), [source.rows]);
  const selected = source.rows.find(row => row.runId === source.selectedRunId) ?? null;
  const changeFilter = (next: QaRunCategory | 'all'): void => { setCategory(next); setWindowSize(QA.LEDGER_WINDOW_STEP); };

  return <OpsShell activePath="/runs"><div className="ops-runs">
    <header className="ops-runs-header"><div><span>EXECUTION EVIDENCE / ALL SURFACES</span><h1>Runs Ledger</h1><p>Unit, contract, browser, scenario, benchmark, and release runs in one authority trail.</p></div>
      <form onSubmit={event => { event.preventDefault(); void opsRunsSource.applyToken(token); }}><label>QA access <strong>{source.auth}</strong></label>{source.auth === 'open' ? <small>Authentication disabled by server policy.</small> : <><input autoComplete="off" onChange={event => setToken(event.currentTarget.value)} placeholder="optional operator token" type="password" value={token} /><button type="submit">Apply</button><button onClick={() => { setToken(''); void opsRunsSource.clearToken(); }} type="button">Clear</button></>}</form>
    </header>
    {source.error ? <section className="ops-runs-error" data-testid="runs-error" role="alert"><span>RUN LEDGER UNAVAILABLE</span><strong>{source.error}</strong><button onClick={() => void opsRunsSource.refresh()} type="button">Retry</button></section> : null}
    <section className="ops-runs-summary" data-testid="runs-summary"><span>Total <b>{summary.total}</b></span><span>Passed <b>{summary.passed}</b></span><span data-alert={summary.failed > 0}>Failed <b>{summary.failed}</b></span><span data-alert={summary.benchmarkAlerts > 0}>Benchmark <b>{summary.benchmarkAlerts}</b></span><span data-alert={summary.browserAlerts > 0}>Browser / network <b>{summary.browserAlerts}</b></span></section>
    <section className="ops-runs-toolbar"><div data-testid="runs-category-filter"><button aria-pressed={category === 'all'} onClick={() => changeFilter('all')} type="button">all</button>{categories.map(value => <button aria-pressed={category === value} key={value} onClick={() => changeFilter(value)} type="button">{value}</button>)}</div><label>Search<input data-testid="runs-search" onChange={event => { setQuery(event.currentTarget.value); setWindowSize(QA.LEDGER_WINDOW_STEP); }} placeholder="run, suite, owner, hash" value={query} /></label><label>Sort<select data-testid="runs-sort" onChange={event => { setSort(readOpsRunsSort(event.currentTarget.value)); setWindowSize(QA.LEDGER_WINDOW_STEP); }} value={sort}><option value="date-desc">Newest</option><option value="date-asc">Oldest</option><option value="stack-fast">Stack fastest</option><option value="stack-slow">Stack slowest</option><option value="browser-fast">Browser fastest</option><option value="browser-slow">Browser slowest</option></select></label><button disabled={source.refreshing} onClick={() => void opsRunsSource.refresh()} type="button">{source.refreshing ? 'Refreshing…' : 'Refresh'}</button></section>
    <div className="ops-runs-layout" data-testid="runs-ledger"><section className="ops-runs-table"><header><span>STATUS</span><span>SUITE</span><span>WALL / START</span><span>SIGNALS</span><span>AUTHORITY</span></header>{source.status === 'loading' ? <p>Loading run evidence…</p> : rows.slice(0, windowSize).map(row => <OpsRunsRow key={row.runId} onSelect={() => opsRunsSource.selectRun(row.runId)} row={row} selected={row.runId === source.selectedRunId} />)}{source.status !== 'loading' && rows.length === 0 ? <p>No runs match this filter.</p> : null}{windowSize < rows.length ? <button className="ops-runs-more" data-testid="runs-show-more" onClick={() => setWindowSize(size => size + QA.LEDGER_WINDOW_STEP)} type="button">Show more · {windowSize}/{rows.length}</button> : null}</section><OpsRunsInspector row={selected} /></div>
  </div></OpsShell>;
}
