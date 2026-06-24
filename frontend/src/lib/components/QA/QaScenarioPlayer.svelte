<script lang="ts">
  import {
    buildQaScenarioCues,
    qaScenarioCueIndexAt,
    qaScenarioDescription,
    qaScenarioFailureCueIndex,
    qaScenarioSummary,
    qaScenarioTimelineMs,
    qaScenarioTitle,
    qaScenarioUsesVideoClock,
    type QaScenarioMetadata,
    type QaScenarioCue,
    type QaScenarioPhaseMs,
    type QaScenarioStep,
  } from '$lib/qa/scenarioPlayer';
  import { fetchQaBlobUrl } from '$lib/qa/apiClient';

  type QaArtifact = {
    name: string;
    relativePath: string;
    sizeBytes: number;
    kind: 'video' | 'image' | 'trace' | 'json' | 'text' | 'archive' | 'other';
    sensitivity: 'public' | 'internal' | 'secret-bearing';
    contentType: string;
    url?: string;
  };

  type QaShard = {
    shard: number;
    status: 'passed' | 'failed' | 'unknown';
    durationMs: number | null;
    handle: string | null;
    description: string | null;
    scenario?: QaScenarioMetadata | null;
    target: string | null;
    title: string | null;
    error?: string | null;
    logTail?: string | null;
    phaseMs: QaScenarioPhaseMs | null;
    timelineSteps?: QaScenarioStep[];
    slowSteps: QaScenarioStep[];
    artifacts: QaArtifact[];
  };

  type Props = {
    runId: string;
    shard: QaShard;
    failureCueFocusKey?: string;
  };

  let { runId, shard, failureCueFocusKey = '' }: Props = $props();

  let videoElement = $state<HTMLVideoElement | null>(null);
  let fullscreenHost = $state<HTMLElement | null>(null);
  let currentTimeSec = $state(0);
  let durationSec = $state(0);
  let theater = $state(false);
  let fullscreenError = $state<string | null>(null);
  let mediaError = $state<string | null>(null);
  let videoBlobUrl = $state<string | null>(null);
  let trackBlobUrl = $state<string | null>(null);
  let imageBlobUrls = $state<Record<string, string>>({});
  let selectedKey = $state('');
  let appliedFailureCueFocusKey = $state('');

  function revokeObjectUrlAfterMediaDetach(url: string): void {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const selectedVideo = $derived.by(() =>
    shard.artifacts.find(artifact => artifact.kind === 'video' && artifact.name === 'video.webm' && artifact.url) ??
    shard.artifacts.find(artifact => artifact.kind === 'video' && artifact.url) ??
    null
  );
  const selectedImages = $derived(shard.artifacts.filter(artifact => artifact.kind === 'image' && artifact.url));
  const selectedTrack = $derived(
    shard.artifacts.find(artifact => artifact.name === 'cues.vtt' && artifact.url) ??
    shard.artifacts.find(artifact => artifact.contentType.startsWith('text/vtt') && artifact.url) ??
    null
  );
  const selectedImageKey = $derived(selectedImages.map(image => image.url).filter(Boolean).join('|'));
  const scenarioTitle = $derived(qaScenarioTitle(shard));
  const scenarioDescription = $derived(qaScenarioDescription(shard));
  const shortDescription = $derived(qaScenarioSummary(shard));
  const cues = $derived(buildQaScenarioCues(shard));
  const timelineMs = $derived(qaScenarioTimelineMs(cues));
  const usesVideoClock = $derived(qaScenarioUsesVideoClock(cues));
  const playbackMs = $derived(
    usesVideoClock
      ? currentTimeSec * 1000
      : durationSec > 0 && timelineMs > 0
      ? Math.min(timelineMs, (currentTimeSec / durationSec) * timelineMs)
      : currentTimeSec * 1000,
  );
  const activeCueIndex = $derived(qaScenarioCueIndexAt(cues, playbackMs));
  const activeCue = $derived<QaScenarioCue | null>(cues[activeCueIndex] ?? cues[0] ?? null);
  const failureCueIndex = $derived(qaScenarioFailureCueIndex(shard, cues));
  const playbackPct = $derived(timelineMs > 0 ? Math.min(100, Math.max(0, (playbackMs / timelineMs) * 100)) : 0);

  $effect(() => {
    const nextKey = `${runId}:${shard.shard}`;
    if (nextKey === selectedKey) return;
    selectedKey = nextKey;
    appliedFailureCueFocusKey = '';
    currentTimeSec = 0;
    durationSec = 0;
    fullscreenError = null;
    mediaError = null;
  });

  $effect(() => {
    const sourceUrl = selectedVideo?.url ?? '';
    let objectUrl: string | null = null;
    let cancelled = false;
    videoBlobUrl = null;
    mediaError = null;
    if (!sourceUrl) return;
    void fetchQaBlobUrl(sourceUrl)
      .then((url) => {
        objectUrl = url;
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        videoBlobUrl = url;
      })
      .catch((error) => {
        if (!cancelled) mediaError = error instanceof Error ? error.message : String(error);
      });
    return () => {
      cancelled = true;
      if (objectUrl) revokeObjectUrlAfterMediaDetach(objectUrl);
    };
  });

  $effect(() => {
    const sourceUrl = selectedTrack?.url ?? '';
    let objectUrl: string | null = null;
    let cancelled = false;
    trackBlobUrl = null;
    if (!sourceUrl) return;
    void fetchQaBlobUrl(sourceUrl)
      .then((url) => {
        objectUrl = url;
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        trackBlobUrl = url;
      })
      .catch((error) => {
        if (!cancelled) mediaError = error instanceof Error ? error.message : String(error);
      });
    return () => {
      cancelled = true;
      if (objectUrl) revokeObjectUrlAfterMediaDetach(objectUrl);
    };
  });

  $effect(() => {
    const key = selectedImageKey;
    const images = selectedImages.slice(0, 4).filter((image): image is QaArtifact & { url: string } => Boolean(image.url));
    let objectUrls: string[] = [];
    let cancelled = false;
    imageBlobUrls = {};
    if (!key || images.length === 0) return;
    void Promise.all(
      images.map(async (image) => [image.url, await fetchQaBlobUrl(image.url)] as const),
    )
      .then((entries) => {
        objectUrls = entries.map(([, blobUrl]) => blobUrl);
        if (cancelled) {
          for (const blobUrl of objectUrls) URL.revokeObjectURL(blobUrl);
          return;
        }
        imageBlobUrls = Object.fromEntries(entries);
      })
      .catch((error) => {
        if (!cancelled) mediaError = error instanceof Error ? error.message : String(error);
      });
    return () => {
      cancelled = true;
      for (const blobUrl of objectUrls) revokeObjectUrlAfterMediaDetach(blobUrl);
    };
  });

  $effect(() => {
    const key = failureCueFocusKey;
    const cue = failureCueIndex >= 0 ? cues[failureCueIndex] : null;
    if (!key || key === appliedFailureCueFocusKey || !cue) return;
    currentTimeSec = cue.startMs / 1000;
    if (!videoBlobUrl || !videoElement) return;
    if (durationSec <= 0) {
      videoElement.load();
      return;
    }
    if (seekToCue(cue)) appliedFailureCueFocusKey = key;
  });

  function formatTime(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function syncVideoClock(): void {
    if (!videoElement) return;
    currentTimeSec = Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : 0;
    durationSec = Number.isFinite(videoElement.duration) ? videoElement.duration : 0;
  }

  function seekToCue(cue: QaScenarioCue): boolean {
    if (!videoElement) return false;
    const safeTimelineMs = timelineMs > 0 ? timelineMs : cue.endMs;
    const videoDuration = Number.isFinite(videoElement.duration) ? videoElement.duration : 0;
    try {
      videoElement.currentTime = usesVideoClock
        ? cue.startMs / 1000
        : videoDuration > 0
        ? (cue.startMs / safeTimelineMs) * videoDuration
        : cue.startMs / 1000;
      syncVideoClock();
      return true;
    } catch (error) {
      mediaError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  function imageSrc(image: QaArtifact): string {
    return image.url ? imageBlobUrls[image.url] ?? '' : '';
  }

  async function openFullScreen(): Promise<void> {
    theater = true;
    fullscreenError = null;
    if (!fullscreenHost?.requestFullscreen) {
      fullscreenError = 'Fullscreen API unavailable; theater mode is active.';
      return;
    }
    try {
      await fullscreenHost.requestFullscreen();
    } catch (error) {
      fullscreenError = error instanceof Error ? error.message : String(error);
    }
  }

  async function closeTheater(): Promise<void> {
    theater = false;
    fullscreenError = null;
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch (error) {
      fullscreenError = error instanceof Error ? error.message : String(error);
    }
  }
</script>

<section
  class="qa-scenario-player"
  class:theater
  bind:this={fullscreenHost}
  data-testid="qa-watch-panel"
>
  <div class="watch-head">
    <div>
      <div class="eyebrow">Scenario Watch</div>
      <h4>{scenarioTitle}</h4>
      <p data-testid="qa-short-description">{shortDescription}</p>
    </div>
    <div class="watch-actions">
      <button data-testid="qa-theater-toggle" class="player-action" onclick={() => (theater ? closeTheater() : (theater = true))}>
        {theater ? 'Exit theater' : 'Theater'}
      </button>
      <button data-testid="qa-fullscreen-button" class="player-action" onclick={openFullScreen}>
        Full screen
      </button>
      {#if selectedVideo?.url && videoBlobUrl}
        <a class="player-action" href={videoBlobUrl} target="_blank" rel="noreferrer">
          {formatBytes(selectedVideo.sizeBytes)}
        </a>
      {/if}
    </div>
  </div>

  {#if fullscreenError}
    <div class="fullscreen-note">{fullscreenError}</div>
  {/if}

  <div class="player-grid">
    <div class="video-stage">
      {#if selectedVideo?.url && videoBlobUrl}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={videoElement}
          data-testid="qa-video-player"
          class="video-player"
          controls
          preload="metadata"
          src={videoBlobUrl}
          onloadedmetadata={syncVideoClock}
          ontimeupdate={syncVideoClock}
          onseeked={syncVideoClock}
          onplay={syncVideoClock}
        >
          {#if trackBlobUrl}
            <track kind="subtitles" label="Scenario transcript" srclang="en" src={trackBlobUrl} default data-testid="qa-video-track" />
          {/if}
        </video>
        {#if activeCue}
          <div class="subtitle-overlay" data-testid="qa-live-subtitle">
            <strong>{activeCue.title}</strong>
            <span>{activeCue.text}</span>
          </div>
        {/if}
      {:else if selectedVideo?.url}
        <div class="empty-media" data-testid="qa-video-loading">
          {mediaError ?? 'Loading protected video artifact...'}
        </div>
      {:else}
        <div class="empty-media" data-testid="qa-video-missing">
          No recorded video for this shard
        </div>
      {/if}
    </div>

    <aside class="scenario-aside">
      <div class="brief-card">
        <span>10-word brief</span>
        <strong>{shortDescription}</strong>
        <p>{scenarioDescription}</p>
      </div>

      {#if selectedImages.length > 0}
        <div class="preview-strip" data-testid="qa-preview-strip">
          {#each selectedImages.slice(0, 4) as image}
            {#if imageSrc(image)}
              <a href={imageSrc(image)} target="_blank" rel="noreferrer">
                <img alt={image.name} src={imageSrc(image)} loading="lazy" />
              </a>
            {/if}
          {/each}
        </div>
      {/if}

      <section class="transcript-panel">
        <div class="transcript-head">
          <h4>Scenario Transcript</h4>
          <span>{cues.length} cues</span>
        </div>
        <div class="transcript-list" data-testid="qa-scenario-transcript">
          {#each cues as cue, index}
            <button
              class="transcript-cue"
              class:active={index === activeCueIndex}
              class:failure={index === failureCueIndex}
              aria-current={index === activeCueIndex ? 'step' : undefined}
              data-failure-cue={index === failureCueIndex ? 'true' : undefined}
              data-testid="qa-subtitle-cue"
              onclick={() => seekToCue(cue)}
            >
              <time>{formatTime(cue.startMs)}</time>
              <span>
                <strong>{cue.title}</strong>
                <small>{cue.text}</small>
              </span>
              <em>{cue.meta}</em>
            </button>
          {/each}
        </div>
      </section>
    </aside>
  </div>

  <div class="subtitle-progress" aria-hidden="true">
    <i style={`width:${playbackPct}%`}></i>
  </div>
</section>

<style>
  .qa-scenario-player {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    padding: 1rem;
    display: grid;
    gap: 0.85rem;
  }

  .qa-scenario-player.theater {
    position: fixed;
    inset: 0;
    z-index: 1000;
    border-radius: 0;
    background: #050506;
    overflow: auto;
    padding: 1rem;
  }

  .watch-head,
  .watch-actions,
  .transcript-head,
  .transcript-cue {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .watch-head {
    align-items: flex-start;
  }

  .eyebrow {
    color: #d8af4f;
    font-size: 0.72rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  h4,
  p {
    margin: 0;
  }

  h4 {
    color: #f6f2e8;
    font-size: 0.92rem;
    letter-spacing: 0;
    text-transform: none;
  }

  .watch-head p {
    margin-top: 0.25rem;
    color: #b7b1a4;
    font-size: 0.9rem;
  }

  .watch-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .player-action {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    padding: 0 0.75rem;
    color: #f1efe7;
    background: rgba(255, 255, 255, 0.055);
    text-decoration: none;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    cursor: pointer;
  }

  .player-action:hover {
    border-color: rgba(216, 175, 79, 0.58);
    color: #fff4d8;
  }

  .fullscreen-note {
    border: 1px solid rgba(216, 175, 79, 0.28);
    border-radius: 8px;
    padding: 0.7rem;
    color: #f1d48a;
    background: rgba(216, 175, 79, 0.08);
    font-size: 0.82rem;
  }

  .player-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(240px, 0.3fr);
    gap: 1rem;
    align-items: stretch;
  }

  .video-stage {
    position: relative;
    min-width: 0;
    overflow: hidden;
    border-radius: 8px;
    background: #050506;
  }

  .video-player,
  .empty-media {
    width: 100%;
    aspect-ratio: 16 / 9;
    min-height: 260px;
    display: block;
    background: #050506;
  }

  .qa-scenario-player.theater .video-player,
  .qa-scenario-player.theater .empty-media {
    max-height: 72vh;
  }

  .empty-media {
    display: grid;
    place-items: center;
    color: #9b978a;
  }

  .subtitle-overlay {
    position: absolute;
    left: 50%;
    bottom: 1rem;
    transform: translateX(-50%);
    width: min(92%, 760px);
    border-radius: 8px;
    padding: 0.7rem 0.85rem;
    background: rgba(0, 0, 0, 0.78);
    color: #f8f4ea;
    text-align: center;
    display: grid;
    gap: 0.2rem;
    pointer-events: none;
  }

  .subtitle-overlay span {
    color: #d8d4c8;
    font-size: 0.86rem;
    line-height: 1.35;
  }

  .scenario-aside {
    display: grid;
    gap: 0.8rem;
    align-content: start;
  }

  .brief-card {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 0.9rem;
    background: rgba(0, 0, 0, 0.22);
    display: grid;
    gap: 0.45rem;
  }

  .brief-card span,
  .transcript-head span,
  .transcript-cue em {
    color: #8f8b80;
    font-size: 0.74rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .brief-card strong {
    color: #f7f1e4;
    line-height: 1.3;
  }

  .brief-card p {
    color: #aaa398;
    font-size: 0.86rem;
    line-height: 1.45;
  }

  .preview-strip {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .preview-strip img {
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: 7px;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .subtitle-progress {
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
  }

  .subtitle-progress i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: #d8af4f;
  }

  .transcript-panel {
    display: grid;
    gap: 0.75rem;
  }

  .transcript-list {
    max-height: 320px;
    overflow: auto;
    display: grid;
    gap: 0.45rem;
    padding-right: 0.15rem;
  }

  .qa-scenario-player.theater .transcript-list {
    max-height: none;
  }

  .transcript-cue {
    width: 100%;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 8px;
    padding: 0.75rem;
    color: inherit;
    background: rgba(255, 255, 255, 0.025);
    text-align: left;
    cursor: pointer;
  }

  .transcript-cue.active {
    border-color: rgba(216, 175, 79, 0.62);
    background: rgba(216, 175, 79, 0.12);
  }

  .transcript-cue.failure {
    border-color: rgba(239, 91, 91, 0.55);
  }

  .transcript-cue.failure.active {
    background: rgba(239, 91, 91, 0.14);
  }

  .transcript-cue time {
    color: #d8af4f;
    font-variant-numeric: tabular-nums;
    min-width: 2.6rem;
  }

  .transcript-cue span {
    min-width: 0;
    display: grid;
    gap: 0.18rem;
  }

  .transcript-cue strong,
  .transcript-cue small {
    overflow-wrap: anywhere;
  }

  .transcript-cue small {
    color: #a8a095;
    line-height: 1.35;
  }

  .transcript-cue em {
    font-style: normal;
    text-align: right;
  }

  @media (max-width: 980px) {
    .player-grid {
      grid-template-columns: 1fr;
    }

    .watch-head {
      display: grid;
    }

    .watch-actions {
      justify-content: flex-start;
    }
  }

  @media (max-width: 640px) {
    .transcript-cue {
      align-items: flex-start;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
    }

    .transcript-cue em {
      grid-column: 2;
      text-align: left;
    }
  }
</style>
