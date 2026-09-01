import { useMemo, useState } from 'react';

import { QA } from '../../../../core/config/qa';
import {
  benchmarkLabel,
  browserHealth,
  buildFailureClassOptions,
  buildFailureInbox,
  compareRunsForSort,
  formatBrowserHealth,
  formatCount,
  formatDate,
  formatMs,
  runMatchesFailureClass,
  shortHash,
} from '../../../packages/runtime-client/src/qa-cockpit-helpers';
import type { QaFailureClassFilter, QaFailureInboxItem, RunSortKey } from '../../../packages/runtime-client/src/qa-types';
import { deriveOpsQaVerdict, readOpsQaRunSort } from './ops-qa-model';
import type { OpsQaSourceSnapshot } from './ops-qa-source';

const runLabel = (runId: string): string => runId.split('-').slice(-2).join('-') || runId;

export function OpsQaRunRail({ source, onSelectRun }: Readonly<{
  source: OpsQaSourceSnapshot;
  onSelectRun: (runId: string) => void;
}>) {
  const [sort, setSort] = useState<RunSortKey>('date-desc');
  const [failureClass, setFailureClass] = useState<QaFailureClassFilter>('all');
  const [windowSize, setWindowSize] = useState<number>(QA.RUN_WINDOW_STEP);
  const failureInbox = useMemo(() => buildFailureInbox([...source.runs], [...source.restartAudit]), [source.runs, source.restartAudit]);
  const failureClasses = useMemo(() => buildFailureClassOptions([...source.runs], failureInbox), [source.runs, failureInbox]);
  const visible = useMemo(() => [...source.runs]
    .filter(run => runMatchesFailureClass(run, failureClass))
    .sort((left, right) => compareRunsForSort(left, right, sort))
    .slice(0, windowSize), [source.runs, failureClass, sort, windowSize]);
  const latest = source.runs[0] ?? null;
  const passRate = source.runs.length === 0 ? 0 : Math.round((source.runs.filter(run => run.status === 'passed').length / source.runs.length) * 100);

  return (
    <aside className="ops-qa-run-rail">
      <header><div><span>RUN INDEX</span><h2>Evidence</h2></div><strong>{passRate}% pass</strong></header>
      <div className="ops-qa-run-metrics">
        <span>latest <b data-status={latest?.status ?? 'unknown'}>{latest?.status ?? 'n/a'}</b></span>
        <span>wall <b>{formatMs(latest?.totalMs)}</b></span>
        <span>runs <b>{source.runs.length}</b></span>
      </div>
      <p className="ops-qa-trend-note">circle = passed/total stacks · F = failed stacks</p>
      <div className="ops-qa-trend" data-testid="qa-trend-strip">{source.runs.slice(0, QA.RECENT_TREND_LIMIT).map(run => (
        <button
          aria-label={`${run.status.toUpperCase()} ${formatCount(run)} stacks · ${formatMs(run.totalMs)}`}
          className={run.runId === source.selectedRunId ? 'is-selected' : ''}
          data-status={run.status}
          data-testid="qa-trend-pill"
          key={run.runId}
          onClick={() => onSelectRun(run.runId)}
          title={`${run.status.toUpperCase()} ${formatCount(run)} stacks · ${formatMs(run.totalMs)}`}
          type="button"
        >{run.failedShards > 0 ? `${run.failedShards}F/${run.totalShards}` : formatCount(run)}</button>
      ))}</div>
      <label className="ops-qa-select">Sort runs<select data-testid="qa-run-sort" onChange={event => setSort(readOpsQaRunSort(event.currentTarget.value))} value={sort}>
        <option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option>
        <option value="stack-fast">Stack fastest</option><option value="stack-slow">Stack slowest</option>
        <option value="bootstrap-fast">Bootstrap fastest</option><option value="bootstrap-slow">Bootstrap slowest</option>
        <option value="playwright-fast">Browser fastest</option><option value="playwright-slow">Browser slowest</option>
        <option value="test-fast">Test fastest</option><option value="test-slow">Test slowest</option>
      </select></label>
      {failureClasses.length > 0 ? <div className="ops-qa-failure-filter" data-testid="qa-failure-class-filter">
        <span>Failure class</span><div className="ops-qa-filters">
          {(['all', ...failureClasses] as const).map(value => <button aria-pressed={failureClass === value} key={value} onClick={() => setFailureClass(value)} type="button">{value}</button>)}
        </div>
      </div> : null}
      <div className="ops-qa-run-list">{visible.map(run => (
        <button
          className={run.runId === source.selectedRunId ? 'is-selected' : ''}
          data-run-id={run.runId}
          data-status={run.status}
          data-testid="qa-run-row"
          key={run.runId}
          onClick={() => onSelectRun(run.runId)}
          type="button"
        >
          <span><i />{runLabel(run.runId)}<b>{formatMs(run.totalMs)}</b></span>
          <small>{formatCount(run)} · {formatDate(run.createdAt)}</small>
          <small>browser {formatBrowserHealth(browserHealth(run))}</small>
          {(run.failureClasses ?? []).length > 0 ? <em>{run.failureClasses?.join(' · ')}</em> : null}
        </button>
      ))}</div>
      {visible.length < source.runs.length ? <button className="ops-qa-more" data-testid="qa-runs-show-more" onClick={() => setWindowSize(size => size + QA.RUN_WINDOW_STEP)} type="button">Show more runs</button> : null}
    </aside>
  );
}

export function OpsQaVerdict({ source, onOpenFailure }: Readonly<{
  source: OpsQaSourceSnapshot;
  onOpenFailure: (item: QaFailureInboxItem) => void;
}>) {
  const failures = useMemo(() => buildFailureInbox([...source.runs], [...source.restartAudit]), [source.runs, source.restartAudit]);
  const verdict = useMemo(() => deriveOpsQaVerdict(source.systemVerdict, source.runs, source.restartAudit), [source.systemVerdict, source.runs, source.restartAudit]);
  return <>
    <section className="ops-qa-verdict" data-status={verdict.status} data-testid="qa-verdict-banner">
      <div><span>SYSTEM VERDICT</span><h2>{verdict.status}</h2><p>{verdict.reason}</p></div>
      <div className="ops-qa-verdict-meta">
        <span>{verdict.activeCount} active reasons</span><span>{verdict.failingSurfaceCount} failing surfaces</span>
        <span>benchmark {benchmarkLabel(verdict.regressionStatus)}</span>
        <span>browser {verdict.browserErrorCount} err / {verdict.browserWarningCount} warn</span>
        <code>head {shortHash(verdict.gitHead)}</code><code>code {shortHash(verdict.codeHash)}</code>
        <span>{formatDate(verdict.latestAt)}</span>
      </div>
    </section>
    <section className="ops-qa-verdict-grid" data-testid="qa-verdict-explain">
      <article><span>Root cause</span><strong>{failures[0]?.title ?? verdict.status}</strong><small>{failures[0]?.detail ?? 'No blocking QA signal is active.'}</small></article>
      <article><span>Active reasons</span><strong>{verdict.activeCount}</strong><small>{verdict.activeCount === 0 ? 'No blocking QA signal is active.' : 'Independent signals keep the verdict non-green.'}</small></article>
      <article><span>Failing surfaces</span><strong>{verdict.failingSurfaceCount}</strong><small>Run, browser, benchmark, restart, and Runtime evidence.</small></article>
      <article><span>Browser capture</span><strong>{verdict.browserErrorCount} err / {verdict.browserWarningCount} warn</strong><small>Console, page, network, and HTTP evidence.</small></article>
    </section>
    {failures.length > 0 ? <section className="ops-qa-failure-inbox" data-testid="qa-failure-inbox">
      <header><div><span>FAILURE INBOX</span><h3>{failures.length} reasons</h3></div><small>latest first</small></header>
      <div>{failures.slice(0, 8).map(item => <button data-testid="qa-failure-item" key={item.id} onClick={() => onOpenFailure(item)} type="button">
        <strong>{item.severity}</strong><span>{item.failureClass}</span><div><b>{item.title}</b><small>{item.detail}</small></div><time>{formatDate(item.createdAt)}</time>
      </button>)}</div>
    </section> : null}
  </>;
}
