import { useEffect, useMemo, useState } from 'react';

import { QA } from '../../../../core/config/qa';
import { fetchQaBlobUrl } from '../../../packages/browser/src/qa-api-client';
import {
  buildPhaseWaterfall,
  formatBrowserHealth,
  formatDate,
  formatMs,
  phaseLimitLabel,
  shardBrowserHealth,
  shortHash,
} from '../../../packages/runtime-client/src/qa-cockpit-helpers';
import type { QaArtifact, QaShard, ShardSortKey } from '../../../packages/runtime-client/src/qa-types';
import {
  isOpsQaAdmin,
  OPS_QA_CONFIRMATIONS,
  planOpsQaRestart,
  runOpsQaRestart,
  type OpsQaRestartPlan,
} from './ops-qa-actions';
import { readOpsQaShardSort, sortOpsQaShards } from './ops-qa-model';
import { OpsQaScenarioPlayer } from './ops-qa-player';
import type { OpsQaSourceSnapshot } from './ops-qa-source';
import { OpsQaCanonicalLedger } from './ops-qa-ledger';

const artifactLabel = (artifact: QaArtifact): string => artifact.kind === 'json' ? 'JSON' : artifact.kind === 'text' ? 'Log' : artifact.kind;
const isPlaybackArtifact = (artifact: QaArtifact): boolean => artifact.kind === 'video' || artifact.kind === 'image' || artifact.contentType.startsWith('text/vtt');

const openArtifact = async (url: string): Promise<void> => {
  const objectUrl = await fetchQaBlobUrl(url);
  window.open(objectUrl, '_blank', 'noopener,noreferrer');
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
};

export function OpsQaRunView({ source, onSelectShard, onRefresh }: Readonly<{
  source: OpsQaSourceSnapshot;
  onSelectShard: (index: number) => void;
  onRefresh: () => Promise<void>;
}>) {
  const run = source.selectedRun;
  const [sort, setSort] = useState<ShardSortKey>('index');
  const [windowSize, setWindowSize] = useState<number>(QA.SHARD_WINDOW_STEP);
  useEffect(() => setWindowSize(QA.SHARD_WINDOW_STEP), [run?.runId]);
  const entries = useMemo(() => run ? sortOpsQaShards(run.shards, sort) : [], [run, sort]);
  if (!run) return <p className="ops-qa-empty">No QA run selected.</p>;
  const visible = entries.slice(0, windowSize);
  const selected = run.shards[source.selectedShardIndex] ?? null;

  return <div className="ops-qa-run-view">
    <OpsQaCanonicalLedger rows={source.ledger} />
    <section className="ops-qa-run-summary">
      <div><span>SELECTED RUN</span><h2>{run.runId}</h2><p>{formatDate(run.createdAt)}</p></div>
      <div><article><span>Status</span><strong data-status={run.status}>{run.status}</strong></article><article><span>Stack</span><strong>{formatMs(run.totalMs)}</strong></article><article><span>Tests</span><strong>{run.passedShards}/{run.totalShards}</strong></article><article><span>Code</span><strong>{shortHash(run.code?.codeHash)}</strong></article></div>
    </section>
    <section className="ops-qa-shards">
      <header><div><span>E2E SUITE</span><h2>{run.totalShards} isolated tests</h2></div><label className="ops-qa-select">Sort tests<select data-testid="qa-shard-sort" onChange={event => setSort(readOpsQaShardSort(event.currentTarget.value))} value={sort}><option value="index">Recorded order</option><option value="duration-fast">Test fastest</option><option value="duration-slow">Test slowest</option><option value="bootstrap-fast">Bootstrap fastest</option><option value="bootstrap-slow">Bootstrap slowest</option><option value="playwright-fast">Browser fastest</option><option value="playwright-slow">Browser slowest</option></select></label></header>
      <div>{visible.map(({ shard, index }) => <button
        className={index === source.selectedShardIndex ? 'is-selected' : ''}
        data-has-video={shard.hasVideo} data-shard={shard.shard} data-status={shard.status} data-testid="qa-suite-row"
        key={shard.shard} onClick={() => onSelectShard(index)} type="button"
      ><span><i />#{shard.shard}</span><div><strong>{shard.title ?? shard.handle ?? shard.target ?? `Shard ${shard.shard}`}</strong><code>{shard.handle ?? 'unlabeled'}</code><small>{shard.description ?? shard.target ?? 'No description'}</small></div><aside><strong>{formatMs(shard.durationMs)}</strong><span>{shard.status}</span></aside></button>)}</div>
      {visible.length < entries.length ? <button className="ops-qa-more" data-testid="qa-shards-show-more" onClick={() => setWindowSize(size => size + QA.SHARD_WINDOW_STEP)} type="button">Show {Math.min(QA.SHARD_WINDOW_STEP, entries.length - visible.length)} more shards · {visible.length}/{entries.length}</button> : null}
    </section>
    {selected ? <OpsQaShardDetail onRefresh={onRefresh} runId={run.runId} shard={selected} source={source} /> : null}
  </div>;
}

function OpsQaShardDetail({ runId, shard, source, onRefresh }: Readonly<{
  runId: string; shard: QaShard; source: OpsQaSourceSnapshot; onRefresh: () => Promise<void>;
}>) {
  const [plan, setPlan] = useState<OpsQaRestartPlan | null>(null);
  const [operatorId, setOperatorId] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [artifactWindow, setArtifactWindow] = useState<number>(QA.ARTIFACT_WINDOW_STEP);
  useEffect(() => { setPlan(null); setShowLog(false); setArtifactWindow(QA.ARTIFACT_WINDOW_STEP); }, [runId, shard.shard]);
  const phases = useMemo(() => buildPhaseWaterfall(shard.phaseMs), [shard.phaseMs]);
  const browser = shardBrowserHealth(shard);
  const artifacts = shard.artifacts.filter(artifact => !isPlaybackArtifact(artifact));
  const admin = isOpsQaAdmin(source.auth);
  const ready = admin && source.restartAllowed && plan !== null && operatorId.trim() !== '' && reason.trim() !== '' && confirm.trim() === OPS_QA_CONFIRMATIONS.restart && plan.expectedGitHead !== '';
  const planRestart = async (): Promise<void> => {
    setBusy(true); setError('');
    try { setPlan(await planOpsQaRestart(runId, shard.shard)); } catch (cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const runRestart = async (): Promise<void> => {
    if (!ready || !plan) return;
    setBusy(true); setError('');
    try {
      await runOpsQaRestart({ runId, shard: shard.shard, operatorId: operatorId.trim(), reason: reason.trim(), confirm: confirm.trim(), expectedGitHead: plan.expectedGitHead });
      setPlan(null); await onRefresh();
    } catch (cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };

  return <section className="ops-qa-shard-detail">
    <header><div><span>SHARD {shard.shard}</span><h2>{shard.title ?? shard.handle ?? `Shard ${shard.shard}`}</h2><code>{shard.handle ?? shard.target ?? 'unlabeled'}</code><p>{shard.description ?? 'No description recorded.'}</p></div><div><strong data-status={shard.status}>{shard.status}</strong><span>{formatMs(shard.durationMs)}</span><button disabled={!admin || busy} onClick={() => void planRestart()} type="button">Restart plan</button><button disabled={!ready || busy} onClick={() => void runRestart()} type="button">Restart run</button></div></header>
    {error ? <p className="ops-qa-error" role="alert">{error}</p> : null}
    {plan ? <section className="ops-qa-restart-plan" data-testid="qa-restart-plan"><strong>Restart command</strong><code>{plan.command.join(' ')}</code><small>Code {shortHash(plan.codeHash)}{plan.dirty ? ' · dirty' : ''}</small><div data-testid="qa-restart-confirm"><label>operator<input onChange={event => setOperatorId(event.currentTarget.value)} placeholder="operator id" value={operatorId} /></label><label>reason<input onChange={event => setReason(event.currentTarget.value)} placeholder="why this rerun is needed" value={reason} /></label><label>confirm<input aria-label="confirm" onChange={event => setConfirm(event.currentTarget.value)} placeholder={OPS_QA_CONFIRMATIONS.restart} value={confirm} /></label><label>expected HEAD<input readOnly value={plan.expectedGitHead} /></label></div></section> : null}
    <OpsQaScenarioPlayer runId={runId} shard={shard} />
    <div className="ops-qa-shard-grid">
      <section><header><span>PHASES</span><strong>{formatMs(phases?.totalMs)}</strong></header>{phases ? <div data-testid="qa-phase-waterfall">{phases.segments.map(segment => <article data-over-limit={segment.overLimit} data-phase={segment.key} data-testid="qa-phase-row" key={segment.key}><span>{segment.label}</span><strong>{formatMs(segment.ms)}</strong><small>{phaseLimitLabel(segment)}</small>{segment.overLimit ? <em>over budget</em> : null}</article>)}</div> : <p className="ops-qa-empty">No phase timings.</p>}</section>
      <section data-testid="qa-browser-health"><header><span>BROWSER HEALTH</span><strong>{formatBrowserHealth(browser)}</strong></header><div>{(shard.browserIssues ?? []).slice(0, QA.BROWSER_ISSUE_PREVIEW_LIMIT).map((issue, index) => <article data-status={issue.severity} key={`${issue.timestamp}:${index}`}><strong>{issue.type}{issue.status ? ` ${issue.status}` : ''}</strong><span>{issue.message}</span><small>{issue.url ?? ''}</small></article>)}</div>{(shard.browserIssues ?? []).length === 0 ? <p className="ops-qa-empty">No browser issues captured.</p> : null}</section>
    </div>
    <section className="ops-qa-artifacts" data-testid="qa-evidence-artifacts"><header><div><span>ARTIFACTS BELOW PLAYBACK</span><h3>Evidence files</h3></div><strong>{artifacts.length}</strong></header><div className="artifact-list">{artifacts.slice(0, artifactWindow).map(artifact => <button key={artifact.relativePath} onClick={() => { if (artifact.url) void openArtifact(artifact.url).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }} type="button"><span>{artifactLabel(artifact)}</span><strong>{artifact.name}</strong><small>{artifact.sizeBytes} bytes · {artifact.sensitivity}</small></button>)}</div>{artifacts.length === 0 ? <p className="ops-qa-empty">No non-media artifact files captured.</p> : null}{artifactWindow < artifacts.length ? <button className="ops-qa-more" data-testid="qa-artifacts-show-more" onClick={() => setArtifactWindow(size => size + QA.ARTIFACT_WINDOW_STEP)} type="button">Show {Math.min(QA.ARTIFACT_WINDOW_STEP, artifacts.length - artifactWindow)} more artifacts · {artifactWindow}/{artifacts.length}</button> : null}</section>
    <section className="ops-qa-log"><header><span>EVIDENCE SUMMARY</span><strong>{shard.failureClass ?? 'no failure class'}</strong></header><div data-testid="qa-log-summary"><span>status {shard.status}</span><span>browser {formatBrowserHealth(browser)}</span>{shard.error ? <p><b>primary error</b>{shard.error}</p> : null}</div><button data-testid="qa-raw-log-toggle" onClick={() => setShowLog(value => !value)} type="button">{showLog ? 'Hide raw log tail' : 'Show raw log tail'}</button>{showLog ? <pre data-testid="qa-raw-log">{shard.logTail || 'No log tail available.'}</pre> : null}</section>
  </section>;
}
