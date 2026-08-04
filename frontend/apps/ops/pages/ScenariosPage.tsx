import { useEffect } from 'react';
import { useExternalStore } from '../../../packages/react-adapters/use-external-store';
import { ScenarioGraph } from '../components/ScenarioGraph';
import { OPS_SCENARIOS, opsScenarioController, opsScenarioExternalStore } from '../data/ops-scenario-store';
import { OpsDockWorkspace } from '../workspace/OpsDockWorkspace';
import { DeltaDiagnostic } from '../components/DeltaDiagnostic';

export const ScenariosPage = () => {
  const state = useExternalStore(opsScenarioExternalStore);
  useEffect(() => { opsScenarioController.start(); return () => opsScenarioController.stop(); }, []);
  const scenario = OPS_SCENARIOS.find(item => item.id === state.scenarioId) ?? OPS_SCENARIOS[0]!;
  return (
    <section className="ops-page ops-scenarios" data-testid="ops-scenarios-page">
      <header className="ops-page-head"><div><p className="ops-eyebrow">deterministic lab</p><h1>Scenarios</h1><p>Real Runtime scenarios execute with persistence disabled, then every watcher and loop is stopped.</p></div><a href={`/embed?scenario=${encodeURIComponent(state.scenarioId)}`} target="_blank" rel="noreferrer">Open focused embed</a></header>
      <div className="ops-scenario-layout"><aside className="ops-scenario-list" aria-label="Scenario registry">{OPS_SCENARIOS.map(item => <button type="button" key={item.id} className={item.id === state.scenarioId ? 'is-active' : ''} disabled={state.status === 'loading'} onClick={() => void opsScenarioController.load(item.id)} data-testid={`scenario-card-${item.id}`}><strong>{item.title}</strong><span>{item.description}</span><small>{item.tags.join(' · ')}</small></button>)}</aside>
        <div><section className="ops-panel ops-scenario-toolbar"><label>Scenario<select value={state.scenarioId} disabled={state.status === 'loading'} onChange={event => void opsScenarioController.load(event.target.value)} data-testid="scenario-select">{OPS_SCENARIOS.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><button type="button" disabled={state.status === 'loading'} onClick={() => void opsScenarioController.load(state.scenarioId)}>Run exact scenario</button><output data-testid="scenario-status">{state.status === 'ready' ? `${scenario.title}: ${state.frames.length} frames` : state.status}</output></section>
          {state.error ? <div className="ops-error" role="alert" data-testid="scenario-error">{state.error}</div> : null}{state.diagnostics.length ? <div className="ops-notice" role="status">{state.diagnostics.map(item => <code key={item}>{item}</code>)}</div> : null}
          <ScenarioGraph graph={state.graph}/>
          <section className="ops-panel ops-playback"><button type="button" disabled={state.index === 0} onClick={() => opsScenarioController.setFrame(state.index - 1)}>Previous</button><button type="button" disabled={state.frames.length < 2} onClick={state.playing ? opsScenarioController.pause : opsScenarioController.play}>{state.playing ? 'Pause' : 'Play'}</button><button type="button" disabled={state.index >= state.frames.length - 1} onClick={() => opsScenarioController.setFrame(state.index + 1)}>Next</button><input type="range" min="0" max={Math.max(0, state.frames.length - 1)} value={state.index} onChange={event => opsScenarioController.setFrame(Number(event.target.value))} aria-label="Scenario frame"/><output>{state.frames.length ? `${state.index + 1}/${state.frames.length}` : '0/0'}</output><label>interval<input type="number" min="100" max="5000" step="100" value={state.playbackMs} onChange={event => opsScenarioController.setPlaybackMs(Number(event.target.value))}/></label></section>
        </div></div>
      <OpsDockWorkspace/>
      <DeltaDiagnostic/>
    </section>
  );
};
