import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { OpsHltControls } from './ops-hlt-controls';
import {
  buildOpsHltStartRequest,
  OPS_HLT_DEFAULT_CONTROLS,
  opsHltVerdict,
  previewOpsHlt,
  type OpsHltPhase,
  type OpsHltTab,
} from './ops-hlt-model';
import { OpsHltProgress } from './ops-hlt-progress';
import { opsHltSource } from './ops-hlt-runtime';
import { OpsShell } from './ops-shell';
import './styles/ops-hlt.css';
import './styles/ops-hlt-progress.css';

export function OpsHltPage() {
  const source = useSyncExternalStore(opsHltSource.subscribe, opsHltSource.getSnapshot, opsHltSource.getSnapshot);
  const [controls, setControls] = useState(OPS_HLT_DEFAULT_CONTROLS);
  const [activeTab, setActiveTab] = useState<OpsHltTab>('control');
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const preview = useMemo(() => previewOpsHlt(controls), [controls]);
  const verdict = opsHltVerdict(source.data);
  const run = source.data?.run ?? null;

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const copyCommand = async (): Promise<void> => {
    await navigator.clipboard.writeText(preview.isolatedCommand);
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1_500);
  };

  const startRun = (phase: OpsHltPhase): void => {
    void opsHltSource.startRun(buildOpsHltStartRequest(controls, phase));
  };

  return (
    <OpsShell activePath="/qa/hlt">
      <div className="ops-hlt" data-testid="hlt-dashboard">
        <header className="ops-hlt-header">
          <div>
            <p>load stand / isolated</p>
            <h1>HLT</h1>
            <span>Record real sovereign traffic. Replay exact H1 inputs. Measure only committed economic completion.</span>
          </div>
          <div className="ops-hlt-head-actions">
            {run?.active ? (
              <button className="is-danger" data-testid="hlt-abort" disabled={source.busy} onClick={() => void opsHltSource.abortRun()} type="button">
                {source.busy ? 'Stopping…' : 'Stop shard'}
              </button>
            ) : null}
            <a href="/qa">QA cockpit</a>
            <button data-testid="hlt-copy-command" onClick={() => void copyCommand()} type="button">{copied ? 'Copied' : 'Copy smoke'}</button>
          </div>
        </header>

        {source.error ? (
          <section className="ops-hlt-error" data-testid="hlt-error" role="alert">
            <span>HLT ERROR</span><strong>{source.error}</strong><button onClick={() => void opsHltSource.refresh()} type="button">Retry read</button>
          </section>
        ) : null}
        {source.status === 'loading' && !source.data ? <section className="ops-hlt-loading" aria-live="polite">Reading HLT evidence…</section> : null}
        {source.data?.snapshotError ? (
          <details className="ops-hlt-schema" data-testid="hlt-snapshot-error">
            <summary>Older result schema excluded; the next run will replace it.</summary><code>{source.data.snapshotError}</code>
          </details>
        ) : null}

        <section className={`ops-hlt-verdict is-${verdict.status.toLowerCase()}`}>
          <div><span>CURRENT HLT STATE</span><strong>{source.error && source.data ? 'STALE' : verdict.status}</strong></div>
          <p>{source.error && source.data ? 'Latest read failed; displaying the last verified HLT snapshot' : verdict.detail}</p>
          <button disabled={source.status === 'loading'} onClick={() => void opsHltSource.refresh()} type="button">Refresh evidence</button>
        </section>

        {run && run.status !== 'idle' ? (
          <section className="ops-hlt-run" data-status={run.status} data-testid="hlt-run">
            <div><span>{run.phase === 'replay' ? 'REPLAY LAST RECORDING' : 'LIVE TEST + RECORDING'}</span><strong data-testid="hlt-run-status">{run.status}{run.pid === null ? '' : ` · pid ${run.pid}`}</strong></div>
            <p data-testid="hlt-run-workdir">{run.workDir ?? run.error ?? 'Work directory not reported'}</p>
            {run.logTail ? <details><summary>Run diagnostics</summary><pre data-testid="hlt-run-log">{run.logTail}</pre></details> : null}
          </section>
        ) : null}

        <nav className="ops-hlt-tabs" aria-label="HLT views">
          <button aria-current={activeTab === 'control' ? 'page' : undefined} onClick={() => setActiveTab('control')} type="button">Control</button>
          <button aria-current={activeTab === 'progress' ? 'page' : undefined} onClick={() => setActiveTab('progress')} type="button">HLT Progress</button>
        </nav>

        {activeTab === 'control' ? (
          <OpsHltControls busy={source.busy} controls={controls} onStart={startRun} preview={preview} runActive={run?.active === true} setControls={setControls} />
        ) : <OpsHltProgress snapshot={source.data} />}
      </div>
    </OpsShell>
  );
}
