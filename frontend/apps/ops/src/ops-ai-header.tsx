import { useEffect, useRef, useState } from 'react';

import { AI_WAKE_WORD } from './ops-ai-decode';
import { aiModelOptionLabel, aiRamBarState, shouldOfferAiMlxLoad } from './ops-ai-model';
import type { OpsAiSnapshot } from './ops-ai-source';

/** Reads the live analyser on its own animation frame so 60fps level updates
 *  re-render only these bars, never the whole console. */
function OpsAiVisualizer({ analyser, silent, speaking }: Readonly<{
  analyser: AnalyserNode | null;
  silent: boolean;
  speaking: boolean;
}>) {
  const [levels, setLevels] = useState<number[]>(() => new Array(16).fill(0));
  const frame = useRef<number | null>(null);
  useEffect(() => {
    if (silent || !analyser) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      setLevels(new Array(16).fill(0));
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    const update = (): void => {
      analyser.getByteFrequencyData(data);
      setLevels(Array.from(data, value => value / 255));
      frame.current = requestAnimationFrame(update);
    };
    update();
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  }, [analyser, silent]);
  return <div className={`ops-ai-visualizer${speaking ? ' is-speaking' : ''}`} aria-hidden="true">
    {levels.map((level, index) => (
      <span key={index} style={{ height: `${Math.max(4, level * 24)}px`, opacity: 0.4 + level * 0.6 }} />
    ))}
  </div>;
}

export function OpsAiHeader({ snapshot, analyser, isListening, isSpeaking, cameraActive, onToggleListening, onToggleCamera, onSelectModel, onSetCouncilMode, onSetAgentMode, onLoadMlxModel, onEjectMlxModel }: Readonly<{
  snapshot: OpsAiSnapshot;
  analyser: AnalyserNode | null;
  isListening: boolean;
  isSpeaking: boolean;
  cameraActive: boolean;
  onToggleListening: () => void;
  onToggleCamera: () => void;
  onSelectModel: (modelId: string) => void;
  onSetCouncilMode: (next: boolean) => void;
  onSetAgentMode: (next: boolean) => void;
  onLoadMlxModel: (modelId: string) => void;
  onEjectMlxModel: () => void;
}>) {
  const stats = snapshot.systemStats;
  return <>
    {stats ? (
      <div className="ops-ai-health" data-testid="ai-health">
        <div className={`ops-ai-health-item ops-ai-ram ops-ai-ram-${aiRamBarState(stats.memory.usedPercent)}`}>
          <span>RAM</span>
          <div className="ops-ai-health-track"><div className="ops-ai-health-fill" style={{ width: `${stats.memory.usedPercent}%` }} /></div>
          <strong>{stats.memory.usedGB}/{stats.memory.totalGB}GB</strong>
        </div>
        {stats.gpu ? (
          <div className={`ops-ai-health-item ops-ai-gpu${stats.gpu.active ? ' is-inferencing' : ''}`}>
            <span>GPU</span>
            <div className="ops-ai-health-track"><div className="ops-ai-health-fill" style={{ width: `${stats.gpu.utilization}%` }} /></div>
            <strong>{stats.gpu.utilization}%</strong>
            {stats.gpu.active ? <i className="ops-ai-pulse" title="Model is actively inferencing" /> : null}
          </div>
        ) : null}
        {snapshot.mlxActiveModel ? (
          <div className="ops-ai-health-item ops-ai-mlx is-loaded" data-testid="ai-mlx-active">
            <b>MLX</b>
            <span>{stats.mlx.activeModelName || snapshot.mlxActiveModel}</span>
            {stats.mlx.activeModelParams ? <small>{stats.mlx.activeModelParams}</small> : null}
            <button aria-label="Eject model from memory" onClick={onEjectMlxModel} title="Eject model from memory" type="button">
              <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="14">
                <path d="M9 9L15 15M15 9L9 15M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="ops-ai-health-item ops-ai-mlx"><b>MLX</b><span>No model loaded</span></div>
        )}
      </div>
    ) : null}

    {snapshot.mlxLoading ? (
      <div className="ops-ai-mlx-toast" role="status">
        <i className="ops-ai-spinner" aria-hidden="true" />
        <span>Loading model... {snapshot.mlxLoadProgress}</span>
      </div>
    ) : null}

    <header className="ops-ai-header">
      <div className="ops-ai-model-selector">
        <select data-testid="ai-model-select" disabled={snapshot.councilMode || snapshot.mlxLoading}
          onChange={event => onSelectModel(event.currentTarget.value)} value={snapshot.selectedModel}>
          {snapshot.models.map(model => (
            <option key={model.id} value={model.id}>{aiModelOptionLabel(model, snapshot.mlxActiveModel)}</option>
          ))}
        </select>
        {snapshot.models.length === 0 ? <small>No models — local AI service unavailable.</small> : null}
        {shouldOfferAiMlxLoad(snapshot.selectedModel, snapshot.models, snapshot.mlxActiveModel) ? (
          <button disabled={snapshot.mlxLoading} onClick={() => onLoadMlxModel(snapshot.selectedModel)} type="button">Load</button>
        ) : null}
      </div>
      <label className="ops-ai-toggle">
        <input checked={snapshot.councilMode} onChange={event => onSetCouncilMode(event.currentTarget.checked)} type="checkbox" /> Council Mode
      </label>
      <label className={`ops-ai-toggle${snapshot.agentModeEnabled ? ' is-active' : ''}`}>
        <input checked={snapshot.agentModeEnabled} disabled={snapshot.availableTools.length === 0}
          onChange={event => onSetAgentMode(event.currentTarget.checked)} type="checkbox" /> Agent Mode
        {snapshot.availableTools.length > 0 ? <small>({snapshot.availableTools.length} tools)</small> : null}
      </label>
      <div className="ops-ai-header-actions">
        <OpsAiVisualizer analyser={analyser} silent={!isListening && !isSpeaking} speaking={isSpeaking} />
        <button className={`ops-ai-icon${isListening ? ' is-active' : ''}`} onClick={onToggleListening} title={`Voice (${AI_WAKE_WORD})`} type="button">
          {isListening ? '...' : 'MIC'}
        </button>
        <button className={`ops-ai-icon${cameraActive ? ' is-active' : ''}`} onClick={onToggleCamera} title="Camera vision" type="button">
          {cameraActive ? 'CAM ON' : 'CAM'}
        </button>
      </div>
    </header>
  </>;
}
