import { useMemo, useRef, useState } from 'react';

import {
  buildQaScenarioCues,
  qaScenarioCueIndexAt,
  qaScenarioDescription,
  qaScenarioFailureCueIndex,
  qaScenarioSummary,
  qaScenarioTitle,
} from '../../../packages/runtime-client/src/qa-scenario-player';
import type { QaArtifact, QaShard } from '../../../packages/runtime-client/src/qa-types';
import { useQaBlobUrl } from './ops-qa-media';

const videoArtifact = (artifacts: readonly QaArtifact[]): QaArtifact | null =>
  artifacts.find(artifact => artifact.kind === 'video' || artifact.contentType.startsWith('video/')) ?? null;
const trackArtifact = (artifacts: readonly QaArtifact[]): QaArtifact | null =>
  artifacts.find(artifact => artifact.contentType.startsWith('text/vtt') || artifact.name.endsWith('.vtt')) ?? null;

export function OpsQaScenarioPlayer({ runId, shard }: Readonly<{ runId: string; shard: QaShard }>) {
  const video = videoArtifact(shard.artifacts);
  const track = trackArtifact(shard.artifacts);
  const videoUrl = useQaBlobUrl(video?.url ?? '');
  const trackUrl = useQaBlobUrl(track?.url ?? '');
  const videoRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<HTMLElement>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [theater, setTheater] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const cues = useMemo(() => buildQaScenarioCues(shard), [shard]);
  const activeIndex = qaScenarioCueIndexAt(cues, currentMs);
  const failureIndex = qaScenarioFailureCueIndex(shard, cues);
  const activeCue = cues[activeIndex] ?? cues[0] ?? null;
  const seek = (startMs: number): void => {
    const element = videoRef.current;
    if (element) element.currentTime = Math.max(0, startMs / 1_000);
    setCurrentMs(startMs);
  };
  const fullscreen = async (): Promise<void> => {
    setFullscreenError('');
    try {
      const host = hostRef.current;
      if (!host?.requestFullscreen) { setTheater(true); return; }
      await host.requestFullscreen();
    } catch (error: unknown) {
      setTheater(true);
      setFullscreenError(error instanceof Error ? error.message : String(error));
    }
  };

  return <section className={`ops-qa-player${theater ? ' is-theater' : ''}`} data-run-id={runId} data-testid="qa-watch-panel" ref={hostRef}>
    <header><div><span>RECORDED SCENARIO</span><h3>{qaScenarioTitle(shard)}</h3><p data-testid="qa-short-description">{qaScenarioSummary(shard)}</p></div>
      <div><button data-testid="qa-theater-toggle" onClick={() => setTheater(value => !value)} type="button">{theater ? 'Exit theater' : 'Theater'}</button><button data-testid="qa-fullscreen-button" onClick={() => void fullscreen()} type="button">Fullscreen</button></div>
    </header>
    <p>{qaScenarioDescription(shard)}</p>
    {fullscreenError ? <p className="ops-qa-error">Fullscreen fallback: {fullscreenError}</p> : null}
    <div className="ops-qa-player-layout">
      <div className="ops-qa-video-stage">
        {video?.url && videoUrl.blobUrl ? <video
          controls data-testid="qa-video-player" onTimeUpdate={event => setCurrentMs(event.currentTarget.currentTime * 1_000)}
          preload="metadata" ref={videoRef} src={videoUrl.blobUrl}
        >{track?.url && trackUrl.blobUrl ? <track data-testid="qa-video-track" default kind="captions" src={trackUrl.blobUrl} /> : null}</video>
          : <div className="ops-qa-video-missing" data-testid="qa-video-missing">{videoUrl.error || 'No recorded video for this shard'}</div>}
        <div className="ops-qa-live-subtitle" data-testid="qa-live-subtitle"><span>{activeCue ? `${activeCue.startMs}ms–${activeCue.endMs}ms` : 'No cue'}</span><strong>{activeCue?.title ?? 'Evidence only'}</strong><p>{activeCue?.text ?? shard.description ?? 'No authored transcript.'}</p></div>
      </div>
      <div className="ops-qa-transcript" data-testid="qa-scenario-transcript">
        <header><span>TRANSCRIPT</span><strong>{cues.length} cues</strong></header>
        {cues.map((cue, index) => <button
          aria-current={index === activeIndex ? 'step' : undefined}
          data-failure-cue={index === failureIndex ? 'true' : 'false'}
          data-testid="qa-subtitle-cue"
          key={cue.id}
          onClick={() => seek(cue.startMs)}
          type="button"
        ><span>{cue.startMs}ms–{cue.endMs}ms</span><strong>{index === failureIndex ? 'Failure · ' : ''}{cue.title}</strong><small>{cue.text}</small></button>)}
      </div>
    </div>
  </section>;
}
