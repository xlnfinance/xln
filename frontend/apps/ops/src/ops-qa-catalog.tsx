import { useMemo, useState } from 'react';

import { abortOpsQaRestart, isOpsQaAdmin, OPS_QA_CONFIRMATIONS } from './ops-qa-actions';
import { benchmarkLabel, formatBrowserHealth, formatMs, formatPct, regressionLabel, topRegressionMetric, browserHealthFromHistory } from '../../../packages/runtime-client/src/qa-cockpit-helpers';
import type { OpsQaSourceSnapshot } from './ops-qa-source';

export function OpsQaCatalog({ source, onRefresh }: Readonly<{
  source: OpsQaSourceSnapshot;
  onRefresh: () => Promise<void>;
}>) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const groups = useMemo(() => Array.from(new Set(source.catalog.map(item => item.group))), [source.catalog]);
  const canAbort = isOpsQaAdmin(source.auth) && !busy && confirm.trim() === OPS_QA_CONFIRMATIONS.abort;
  const abort = async (): Promise<void> => {
    if (!canAbort) return;
    setBusy(true); setError('');
    try { await abortOpsQaRestart(confirm.trim()); setConfirm(''); await onRefresh(); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="ops-qa-catalog" data-testid="qa-system-suites">
    <header><div><span>SYSTEM TEST CATALOG</span><h2>All test surfaces</h2><p>{source.catalog.length} commands grouped for operators.</p></div><strong>{source.restart.active ? 'restart running' : 'idle'}</strong></header>
    {source.restart.active ? <section className="ops-qa-abort" data-testid="qa-restart-abort-card"><div><strong>Active restart</strong><span>{source.restart.target ?? 'restart'} · pid {source.restart.pid ?? 'n/a'}</span></div><label>abort confirm<input disabled={!isOpsQaAdmin(source.auth) || busy} onChange={event => setConfirm(event.currentTarget.value)} placeholder={OPS_QA_CONFIRMATIONS.abort} value={confirm} /></label><button data-testid="qa-restart-abort" disabled={!canAbort} onClick={() => void abort()} type="button">{busy ? 'Aborting…' : 'Abort restart'}</button></section> : null}
    {error ? <p className="ops-qa-error" role="alert">{error}</p> : null}
    {groups.map(group => <section className="ops-qa-catalog-group" key={group}><h3>{group}</h3><div>{source.catalog.filter(item => item.group === group).map(item => <article key={item.id}><span>{item.group}</span><strong>{item.label}</strong><p>{item.description}</p><code>{item.command}</code></article>)}</div></section>)}
  </section>;
}

export function OpsQaBenchmarks({ source }: Readonly<{ source: OpsQaSourceSnapshot }>) {
  const catalog = source.catalog.filter(item => item.group === 'Benchmark');
  return <section className="ops-qa-benchmarks" data-testid="qa-benchmarks">
    <header><div><span>PERFORMANCE</span><h2>Benchmarks + run load</h2><p>Wall time, host load, child CPU, memory, and browser evidence by code hash.</p></div><strong>{catalog.length} commands</strong></header>
    <div className="ops-qa-benchmark-catalog">{catalog.map(item => <article key={item.id}><span>{item.group}</span><strong>{item.label}</strong><p>{item.description}</p><code>{item.command}</code></article>)}</div>
    {source.regression ? <section className="ops-qa-regression" data-testid="qa-regression-comparator"><header><div><span>REGRESSION COMPARATOR</span><h3>{regressionLabel(source.regression.status)} · {source.regression.suiteLabel ?? 'latest suite'}</h3><p>{source.regression.reason}</p></div><strong>{source.regression.comparisons.length} baselines</strong></header><div>{source.regression.comparisons.map((comparison, index) => {
      const top = topRegressionMetric(comparison);
      return <article data-kind={comparison.kind} data-status={comparison.status} data-testid="qa-regression-row" key={`${comparison.kind}:${comparison.comparedRunId ?? index}`}><strong>{regressionLabel(comparison.status)}</strong><span>{comparison.label}</span><code>{comparison.comparedRunId ?? 'missing'}</code><small>{comparison.reason}</small>{top ? <b>{top.label} {formatPct(top.deltaPct)}</b> : null}{comparison.newFailingTargets.length > 0 ? <em>new fail {comparison.newFailingTargets.join(', ')}</em> : null}</article>;
    })}</div></section> : null}
    <section className="ops-qa-benchmark-history"><header><span>RECENT LOAD</span><h3>Wall / CPU / Browser trend</h3></header>{source.history.slice(0, 12).map(row => <article data-status={row.status} data-testid="qa-benchmark-metric-row" key={row.runId}><strong>{row.status}</strong><span>wall {formatMs(row.totalMs)}</span><span>load {row.peakLoad1 ?? 'n/a'}</span><span>cpu {row.maxChildCpuPct ?? 'n/a'}%</span><span>browser {formatBrowserHealth(browserHealthFromHistory(row))}</span><span>{benchmarkLabel(row.benchmarkStatus)} {formatPct(row.benchmarkDeltaPct)}</span></article>)}</section>
  </section>;
}
