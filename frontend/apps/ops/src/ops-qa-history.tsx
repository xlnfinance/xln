import { useMemo, useState } from 'react';

import { QA } from '../../../../core/config/qa';
import { benchmarkLabel, browserHealthFromHistory, compareRunsForSort, formatBrowserHealth, formatDate, formatMs, formatPct, shortHash } from '../../../packages/runtime-client/src/qa-cockpit-helpers';
import type { QaHistoryBackfillResult, QaRetentionPurgeResult, RunSortKey } from '../../../packages/runtime-client/src/qa-types';
import { backfillOpsQaHistory, isOpsQaAdmin, OPS_QA_CONFIRMATIONS, purgeOpsQaHistory } from './ops-qa-actions';
import { readOpsQaRunSort } from './ops-qa-model';
import type { OpsQaSourceSnapshot } from './ops-qa-source';

export function OpsQaHistory({ source, onRefresh }: Readonly<{
  source: OpsQaSourceSnapshot;
  onRefresh: () => Promise<void>;
}>) {
  const [sort, setSort] = useState<RunSortKey>('date-desc');
  const [windowSize, setWindowSize] = useState<number>(QA.HISTORY_WINDOW_STEP);
  const [backfillConfirm, setBackfillConfirm] = useState('');
  const [retentionConfirm, setRetentionConfirm] = useState('');
  const [backfillResult, setBackfillResult] = useState<QaHistoryBackfillResult | null>(null);
  const [retentionResult, setRetentionResult] = useState<QaRetentionPurgeResult | null>(null);
  const [busy, setBusy] = useState<'backfill' | 'retention' | ''>('');
  const [error, setError] = useState('');
  const history = useMemo(() => [...source.history].sort((left, right) => compareRunsForSort(left, right, sort)), [source.history, sort]);
  const admin = isOpsQaAdmin(source.auth);
  const runBackfill = async (): Promise<void> => {
    if (!admin || backfillConfirm.trim() !== OPS_QA_CONFIRMATIONS.backfill) return;
    setBusy('backfill'); setError(''); setBackfillResult(null);
    try { setBackfillResult(await backfillOpsQaHistory(backfillConfirm.trim())); setBackfillConfirm(''); await onRefresh(); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };
  const runRetention = async (): Promise<void> => {
    if (!admin || retentionConfirm.trim() !== OPS_QA_CONFIRMATIONS.retention) return;
    setBusy('retention'); setError(''); setRetentionResult(null);
    try { setRetentionResult(await purgeOpsQaHistory(retentionConfirm.trim())); setRetentionConfirm(''); await onRefresh(); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };
  return <section className="ops-qa-history" data-testid="qa-history">
    <header><div><span>PERSISTENT HISTORY</span><h2>QA run database</h2><p>SQLite-backed evidence with git HEAD, code hash, status, and performance.</p></div><label className="ops-qa-select">Sort<select data-testid="qa-history-sort" onChange={event => setSort(readOpsQaRunSort(event.currentTarget.value))} value={sort}><option value="date-desc">Newest</option><option value="date-asc">Oldest</option><option value="stack-fast">Stack fastest</option><option value="stack-slow">Stack slowest</option><option value="playwright-fast">Browser fastest</option><option value="playwright-slow">Browser slowest</option></select></label></header>
    <div className="ops-qa-history-list">{history.slice(0, windowSize).map(row => <article data-run-id={row.runId} data-status={row.status} data-testid="qa-history-row" key={row.runId}><strong>{row.status}</strong><span>{formatDate(row.createdAt)}</span><span>{formatMs(row.totalMs)}</span><span>{row.passedShards}/{row.totalShards}</span><span>browser {formatBrowserHealth(browserHealthFromHistory(row))}</span><span>{benchmarkLabel(row.benchmarkStatus)} {formatPct(row.benchmarkDeltaPct)}</span><code>head {shortHash(row.gitHead)}</code><code>code {shortHash(row.codeHash)}</code><small>{row.suiteKey ?? 'indexed run'}</small></article>)}</div>
    {windowSize < history.length ? <button className="ops-qa-more" data-testid="qa-history-show-more" onClick={() => setWindowSize(size => size + QA.HISTORY_WINDOW_STEP)} type="button">Show more history rows · {windowSize}/{history.length}</button> : null}
    {error ? <p className="ops-qa-error" role="alert">{error}</p> : null}
    <div className="ops-qa-maintenance">
      <section data-testid="qa-history-backfill-card"><div><span>MAINTENANCE</span><h3>Backfill history index</h3><p>One-shot index rebuild from run manifests already on disk.</p></div><label>confirm phrase<input onChange={event => setBackfillConfirm(event.currentTarget.value)} placeholder={OPS_QA_CONFIRMATIONS.backfill} value={backfillConfirm} /></label><button data-testid="qa-history-backfill" disabled={!admin || busy !== '' || backfillConfirm.trim() !== OPS_QA_CONFIRMATIONS.backfill} onClick={() => void runBackfill()} type="button">{busy === 'backfill' ? 'Backfilling…' : 'Backfill index'}</button>{backfillResult ? <small data-testid="qa-history-backfill-result">scanned {backfillResult.scannedRuns} / recorded {backfillResult.recordedRuns} / failed {backfillResult.failedRuns.length}</small> : null}</section>
      <section data-testid="qa-retention-card"><div><span>MAINTENANCE</span><h3>Delete runs older than 30 days</h3><p>New runs and current audit history stay untouched.</p></div><label>confirm phrase<input onChange={event => setRetentionConfirm(event.currentTarget.value)} placeholder={OPS_QA_CONFIRMATIONS.retention} value={retentionConfirm} /></label><button data-testid="qa-retention-purge" disabled={!admin || busy !== '' || retentionConfirm.trim() !== OPS_QA_CONFIRMATIONS.retention} onClick={() => void runRetention()} type="button">{busy === 'retention' ? 'Deleting…' : 'Delete old runs'}</button>{retentionResult ? <small data-testid="qa-retention-result">deleted {retentionResult.deletedLogDirs} log dirs / {retentionResult.deletedHistoryRows} history rows</small> : null}</section>
    </div>
    <section className="ops-qa-audit"><header><span>OPERATIONS AUDIT</span><h3>Restart trail</h3></header><div>{source.restartAudit.map(row => <article data-status={row.status} key={row.auditId}><strong>{row.status}</strong><span>{formatDate(row.startedAt)}</span><span>{row.operatorId}</span><span>{row.reason}</span><code>head {shortHash(row.actualGitHead)}</code><span>{row.exitCode === null ? 'running' : `exit ${row.exitCode}`}</span></article>)}</div></section>
  </section>;
}
