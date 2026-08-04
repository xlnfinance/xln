import { useEffect, useMemo, useState } from 'react';
import { initializeOpsQaToken, readOpsRuns, saveOpsQaToken, type OpsRunCategory, type OpsRunRow } from '../data/ops-runs';

type RunSort = 'newest' | 'oldest' | 'stack-fast' | 'stack-slow' | 'browser-fast' | 'browser-slow';
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error || 'OPS_RUNS_READ_FAILED');
const duration = (value: number | null): string => value === null ? 'n/a' : value >= 60_000 ? `${(value / 60_000).toFixed(1)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${value}ms`;
const bytes = (value: number): string => value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
const sortRuns = (left: OpsRunRow, right: OpsRunRow, sort: RunSort): number => {
  if (sort === 'newest') return right.createdAt - left.createdAt || left.runId.localeCompare(right.runId);
  if (sort === 'oldest') return left.createdAt - right.createdAt || left.runId.localeCompare(right.runId);
  const browser = sort.startsWith('browser');
  const a = (browser ? left.playwrightMs : left.durationMs) ?? Number.POSITIVE_INFINITY;
  const b = (browser ? right.playwrightMs : right.durationMs) ?? Number.POSITIVE_INFINITY;
  return sort.endsWith('slow') ? b - a || right.createdAt - left.createdAt : a - b || right.createdAt - left.createdAt;
};

export const RunsPage = () => {
  const [ledger, setLedger] = useState<readonly OpsRunRow[]>(Object.freeze([]));
  const [auth, setAuth] = useState('locked');
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<OpsRunCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<RunSort>('newest');
  const [limit, setLimit] = useState(20);
  const load = async (): Promise<void> => {
    setLoading(true); setError(null);
    try { const page = await readOpsRuns(); setLedger(page.ledger); setAuth(page.auth); }
    catch (loadError) { setError(errorText(loadError)); }
    finally { setLoading(false); }
  };
  useEffect(() => { setToken(initializeOpsQaToken()); void load(); }, []);
  const categories = useMemo(() => [...new Set(ledger.map(run => run.category))].toSorted(), [ledger]);
  const visible = useMemo(() => ledger.filter(run => category === 'all' || run.category === category).filter(run => {
    const search = query.trim().toLowerCase();
    return !search || [run.runId, run.suiteKey, run.suiteLabel, run.startedBy, run.gitHead, run.codeHash].some(value => String(value ?? '').toLowerCase().includes(search));
  }).toSorted((left, right) => sortRuns(left, right, sort)), [ledger, category, query, sort]);
  const failed = ledger.filter(run => run.status === 'failed').length;
  const browserAlerts = ledger.filter(run => run.browserErrors > 0 || run.networkFailures > 0).length;
  return (
    <section className="ops-page ops-runs" data-testid="ops-runs-page">
      <header className="ops-page-head"><div><p className="ops-eyebrow">run evidence</p><h1>Runs</h1><p>One operator ledger across unit, contract, E2E, scenario, benchmark, and release gates.</p></div><div className="ops-auth" data-testid="runs-auth-panel"><span>qa auth · {auth}</span><div><input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder="QA token"/><button type="button" onClick={() => { saveOpsQaToken(token); void load(); }}>Apply</button></div></div></header>
      <section className="ops-metrics" data-testid="runs-summary"><article><span>total</span><strong>{ledger.length}</strong></article><article><span>passed</span><strong>{ledger.length - failed}</strong></article><article className={failed ? 'is-bad' : ''}><span>failed</span><strong>{failed}</strong></article><article className={browserAlerts ? 'is-warn' : ''}><span>browser/network</span><strong>{browserAlerts}</strong></article></section>
      <section className="ops-panel" data-testid="runs-ledger"><header className="ops-toolbar"><div className="ops-chips" data-testid="runs-category-filter"><button className={category === 'all' ? 'is-active' : ''} onClick={() => { setCategory('all'); setLimit(20); }}>all</button>{categories.map(value => <button key={value} className={category === value ? 'is-active' : ''} onClick={() => { setCategory(value); setLimit(20); }}>{value}</button>)}</div><div><input data-testid="runs-search" value={query} onChange={event => { setQuery(event.target.value); setLimit(20); }} placeholder="filter run, suite, owner, hash"/><select data-testid="runs-sort" value={sort} onChange={event => setSort(event.target.value as RunSort)}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="stack-fast">Stack fastest</option><option value="stack-slow">Stack slowest</option><option value="browser-fast">Browser fastest</option><option value="browser-slow">Browser slowest</option></select><button type="button" onClick={() => void load()}>Refresh</button></div></header>
        {error ? <div className="ops-error" role="alert" data-testid="runs-error">{error}</div> : loading ? <div className="ops-loading">Reading run ledger…</div> : visible.length === 0 ? <div className="ops-empty">No runs match this exact filter.</div> : <div className="ops-run-list">{visible.slice(0, limit).map(run => <article key={run.runId} className={`is-${run.status}`} data-testid="runs-ledger-row"><div data-field="status"><strong>{run.status.toUpperCase()}</strong><span>{run.category}</span></div><div data-field="suite"><strong>{run.suiteLabel}</strong><code>{run.runId}</code></div><span data-field="created">{new Date(run.createdAt).toISOString()}</span><span data-field="timing">{duration(run.durationMs)} · browser {duration(run.playwrightMs)}</span><span data-field="artifacts">{bytes(run.artifactBytes)}</span><span data-field="browser" className={run.browserErrors || run.networkFailures ? 'is-warn' : ''}>{run.browserErrors} errors · {run.browserWarnings} warnings · {run.networkFailures} network</span><code data-field="commit">{run.gitHead?.slice(0, 12) ?? 'head n/a'}{run.dirty ? '-dirty' : ''}</code><a href={`/qa?runId=${encodeURIComponent(run.runId)}`} data-testid="runs-open-qa">Open QA</a></article>)}</div>}
        {limit < visible.length ? <button className="ops-more" data-testid="runs-show-more" onClick={() => setLimit(value => value + 20)}>Show 20 more · {limit}/{visible.length}</button> : null}
      </section>
    </section>
  );
};
