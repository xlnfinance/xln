import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { RuntimeScenarioSnapshot } from '../../../packages/browser/src/runtime-scenario-source';
import { SCENARIO_OPTIONS, type ScenarioId } from '../../../packages/runtime-client/src/scenario-player-model';
import { OpsShell } from './ops-shell';
import { opsScenariosSource } from './ops-scenarios-runtime';
import './styles/ops-scenarios.css';

function ScenarioGraph({ snapshot }: Readonly<{ snapshot: RuntimeScenarioSnapshot }>) {
  const { visual } = snapshot;
  return <section className="ops-scenario-stage" aria-label="Scenario preview">
    <div className="ops-scenario-graph-shell">
      {snapshot.status === 'loading' ? <div className="ops-scenario-layer" data-testid="scenario-loading">Running deterministic Runtime scenario…</div> : null}
      {snapshot.status === 'error' ? <div className="ops-scenario-layer is-error" data-testid="scenario-error" role="alert">{snapshot.error}</div> : null}
      {snapshot.diagnostics.length > 0 ? <div className="ops-scenario-diagnostics" data-testid="scenario-diagnostics">{snapshot.diagnostics.map(message => <span key={message}>{message}</span>)}</div> : null}
      <svg className="ops-scenario-graph" data-testid="scenario-graph" role="img" aria-label="Scenario entity graph" viewBox="0 0 100 64">
        <defs><filter id="ops-hub-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.6" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
        {visual.edges.map(edge => <line className={edge.disputed ? 'is-disputed' : undefined} key={edge.key} x1={edge.from.x} x2={edge.to.x} y1={edge.from.y} y2={edge.to.y} />)}
        {visual.nodes.map(node => <g className={`${node.isHub ? 'is-hub ' : ''}${node.disputed ? 'is-disputed ' : ''}${node.debtCount > 0 ? 'is-debtor' : ''}`} data-testid="scenario-node" key={node.id}><circle cx={node.x} cy={node.y} r={node.isHub ? 4.8 : 4.1} /><text x={node.x} y={node.y + 8.2}>{node.label}</text></g>)}
      </svg>
      <div className="ops-scenario-stage-index"><span>COMMITTED HEIGHT</span><strong>H{snapshot.height}</strong></div>
    </div>
    <div className="ops-scenario-narrative"><div><span>FRAME {snapshot.frameCount > 0 ? `${snapshot.currentFrame + 1}/${snapshot.frameCount}` : '0/0'}</span><h2 data-testid="scenario-frame-title">{visual.title || snapshot.option.title}</h2><p>{visual.description || snapshot.option.description}</p></div>{visual.collapse ? <strong data-testid="scenario-collapse-badge">hub collapse / dispute path</strong> : null}</div>
    <div className="ops-scenario-timeline" data-testid="scenario-timeline"><input aria-label="Scenario frame" data-testid="scenario-frame-range" disabled={snapshot.frameCount === 0} max={Math.max(0, snapshot.frameCount - 1)} min="0" onChange={event => opsScenariosSource.goToFrame(Number(event.currentTarget.value))} type="range" value={snapshot.currentFrame} /><div><button data-testid="scenario-restart" disabled={snapshot.status !== 'ready'} onClick={opsScenariosSource.restart} type="button">Restart</button><button data-testid="scenario-prev" disabled={snapshot.currentFrame <= 0} onClick={() => opsScenariosSource.step(-1)} type="button">Prev</button>{snapshot.playing ? <button data-testid="scenario-pause" onClick={opsScenariosSource.pause} type="button">Pause</button> : <button data-testid="scenario-play" disabled={snapshot.status !== 'ready' || snapshot.frameCount <= 1} onClick={opsScenariosSource.play} type="button">Play</button>}<button data-testid="scenario-next" disabled={snapshot.currentFrame >= snapshot.frameCount - 1} onClick={() => opsScenariosSource.step(1)} type="button">Next</button><select aria-label="Playback speed" data-testid="scenario-speed" onChange={event => opsScenariosSource.setPlaybackMs(Number(event.currentTarget.value))} value={snapshot.playbackMs}><option value="1000">1x</option><option value="700">1.5x</option><option value="350">3x</option></select></div></div>
  </section>;
}

export function OpsScenariosPage() {
  const snapshot = useSyncExternalStore(opsScenariosSource.subscribe, opsScenariosSource.getSnapshot, opsScenariosSource.getSnapshot);
  const selectedPreset = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedPreset.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [snapshot.option.id]);
  const load = (id: ScenarioId): void => { void opsScenariosSource.loadScenario(id); };
  const preview = (): void => {
    if (snapshot.status !== 'ready') throw new Error('SCENARIO_PREVIEW_NOT_READY');
    window.location.assign(snapshot.previewHref);
  };
  return <OpsShell activePath="/scenarios"><div className="ops-scenarios" data-scenario-id={snapshot.option.id} data-state={snapshot.status} data-testid="scenario-player">
    <header className="ops-scenarios-header"><div><p>DETERMINISTIC RUNTIME / BROWSERVM</p><h1>Scenario Player</h1><span>Run protocol narratives, inspect every committed frame, and reconstruct the selected state in the wallet.</span></div><div className="ops-scenarios-header-actions"><a href="/app" rel="noreferrer" target="_blank">Open live wallet</a><button data-testid="preview-in-wallet" disabled={snapshot.status !== 'ready'} onClick={preview} type="button">Preview in wallet</button></div></header>
    <div className="ops-scenarios-toolbar"><label htmlFor="scenario-select">Scenario</label><select data-testid="scenario-select" disabled={snapshot.status === 'loading'} id="scenario-select" onChange={event => load(event.currentTarget.value as ScenarioId)} value={snapshot.option.id}>{SCENARIO_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.title}</option>)}</select><button data-testid="scenario-run" disabled={snapshot.status === 'loading'} onClick={() => load(snapshot.option.id)} type="button">Run</button><output className={snapshot.status === 'error' ? 'is-bad' : undefined} data-testid="scenario-status">{snapshot.statusText}</output></div>
    <div className="ops-scenarios-workspace"><aside className="ops-scenarios-index" aria-label="Scenario presets"><p>SCENARIO INDEX</p>{SCENARIO_OPTIONS.map((option, index) => <button className={snapshot.option.id === option.id ? 'is-selected' : undefined} data-testid={`scenario-card-${option.id}`} disabled={snapshot.status === 'loading'} key={option.id} onClick={() => load(option.id)} ref={snapshot.option.id === option.id ? selectedPreset : undefined} type="button"><span>{String(index + 1).padStart(2, '0')}</span><strong>{option.title}</strong><small>{option.intent}</small><i>{option.tags.join(' / ')}</i></button>)}</aside><ScenarioGraph snapshot={snapshot} /><aside className="ops-scenario-inspector"><p>FRAME INSPECT</p><h2>{snapshot.option.title}</h2><span>{snapshot.option.description}</span><dl><div><dt>Entities</dt><dd>{snapshot.visual.nodes.length}</dd></div><div><dt>Accounts</dt><dd>{snapshot.visual.accountCount}</dd></div><div><dt>Disputes</dt><dd>{snapshot.visual.activeDisputes}</dd></div><div><dt>Debts</dt><dd>{snapshot.visual.debtCount}</dd></div></dl><label><span>Validated frame projection</span><textarea aria-label="Frame inspect" data-testid="scenario-builder-inspect" readOnly value={snapshot.inspectText} /></label></aside></div>
  </div></OpsShell>;
}
