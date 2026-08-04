import { useEffect, useMemo, useState } from 'react';
import { decodeNetworkTrailFromHash, type NetworkTrail } from '$lib/network3d/networkTimelineSource';
import { useExternalStore } from '../../../packages/react-adapters/use-external-store';
import { ScenarioGraph } from '../components/ScenarioGraph';
import { parseEmbedCommand, postEmbedState } from '../data/ops-embed-contract';
import { OPS_SCENARIOS, opsScenarioController, opsScenarioExternalStore } from '../data/ops-scenario-store';
import { projectTrailGraphFrame } from '../data/ops-trail-graph';

const trailHash = (): string => new URLSearchParams(window.location.hash.replace(/^#/, '')).get('trail')?.trim() ?? '';
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error || 'OPS_EMBED_FAILED');

export const EmbedPage = () => {
  const scenarioState = useExternalStore(opsScenarioExternalStore); const query = useMemo(() => new URL(window.location.href).searchParams, []); const scenarioId = query.get('scenario')?.trim() ?? ''; const autoplay = query.get('autoplay') === '1'; const speed = Number(query.get('speed') ?? 1);
  const [trail, setTrail] = useState<NetworkTrail | null>(null); const [trailIndex, setTrailIndex] = useState(0); const [trailPlaying, setTrailPlaying] = useState(false); const [error, setError] = useState<string | null>(null); const [integrationError, setIntegrationError] = useState<string | null>(null);
  const trailGraphs = useMemo(() => !trail ? [] : trail.index.frames.map(item => trail.frames[String(item.height)]).map((frame, index) => { if (!frame) throw new Error(`OPS_EMBED_TRAIL_FRAME_MISSING:${index}`); return projectTrailGraphFrame(frame); }), [trail]);
  const recorded = trailGraphs.length > 0; const frame = recorded ? trailGraphs[trailIndex] ?? null : scenarioState.graph; const playing = recorded ? trailPlaying : scenarioState.playing; const frameIndex = recorded ? trailIndex : scenarioState.index; const frameCount = recorded ? trailGraphs.length : scenarioState.frames.length;
  useEffect(() => {
    if (!Number.isFinite(speed) || speed <= 0 || speed > 10) { setError('OPS_EMBED_SPEED_INVALID'); return; }
    const encoded = trailHash();
    if (encoded) { void decodeNetworkTrailFromHash(encoded).then(value => { setTrail(value); setTrailIndex(0); setTrailPlaying(autoplay); }).catch(cause => setError(errorMessage(cause))); return; }
    if (scenarioId && !OPS_SCENARIOS.some(item => item.id === scenarioId || item.runtimeId === scenarioId)) { setError(`OPS_EMBED_SCENARIO_UNKNOWN:${scenarioId}`); return; }
    const mapped = OPS_SCENARIOS.find(item => item.id === scenarioId || item.runtimeId === scenarioId)?.id ?? '';
    opsScenarioController.start(mapped); opsScenarioController.setPlaybackMs(700 / speed); if (autoplay) { const wait = window.setInterval(() => { if (opsScenarioExternalStore.getSnapshot().status === 'ready') { window.clearInterval(wait); opsScenarioController.play(); } }, 50); return () => { window.clearInterval(wait); opsScenarioController.stop(); }; }
    return () => opsScenarioController.stop();
  }, [autoplay, scenarioId, speed]);
  useEffect(() => {
    if (!trailPlaying || trailGraphs.length < 2) return;
    const timer = window.setInterval(() => setTrailIndex(index => { if (index >= trailGraphs.length - 1) { setTrailPlaying(false); return index; } return index + 1; }), Math.max(100, 700 / speed)); return () => window.clearInterval(timer);
  }, [speed, trailGraphs.length, trailPlaying]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      try { const command = parseEmbedCommand(event.data); setIntegrationError(null); if (command.command === 'play') recorded ? setTrailPlaying(true) : opsScenarioController.play(); else if (command.command === 'pause') recorded ? setTrailPlaying(false) : opsScenarioController.pause(); else if (command.frame !== undefined) recorded ? setTrailIndex(Math.max(0, Math.min(trailGraphs.length - 1, command.frame))) : opsScenarioController.setFrame(command.frame); }
      catch (cause) { setIntegrationError(errorMessage(cause)); }
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  }, [recorded, trailGraphs.length]);
  useEffect(() => postEmbedState({ status: error ? 'error' : recorded ? 'ready' : scenarioState.status, scenarioId: recorded ? trail?.runtimeId ?? 'trail' : scenarioState.scenarioId, frame: frameIndex, frames: frameCount, playing }), [error, frameCount, frameIndex, playing, recorded, scenarioState.scenarioId, scenarioState.status, trail?.runtimeId]);
  const seek = (index: number): void => recorded ? setTrailIndex(index) : opsScenarioController.setFrame(index);
  const toggle = (): void => { if (recorded) setTrailPlaying(value => !value); else playing ? opsScenarioController.pause() : opsScenarioController.play(); };
  return <section className="ops-embed" data-testid="ops-embed-page"><header><a href="/" className="ops-brand">xln<span>/embed</span></a><div><span>{recorded ? `recorded · ${trail?.runtimeId}` : `scenario · ${scenarioState.scenarioId || 'none'}`}</span><span>same-origin messages only</span></div></header>{error ? <div className="ops-error" role="alert" data-testid="embed-scenario-error">{error}</div> : null}{integrationError ? <div className="ops-error" role="alert" data-testid="embed-message-error">{integrationError}</div> : null}<ScenarioGraph graph={frame}/><footer><button type="button" onClick={toggle} disabled={frameCount < 2}>{playing ? 'Pause' : 'Play'}</button><input type="range" min="0" max={Math.max(0, frameCount - 1)} value={frameIndex} onChange={event => seek(Number(event.target.value))} aria-label="Embed frame"/><output>{frameCount ? `${frameIndex + 1}/${frameCount}` : '0/0'}</output><span>{speed}×</span></footer></section>;
};
