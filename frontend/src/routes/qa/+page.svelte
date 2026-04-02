<script lang="ts">
  import { onMount } from 'svelte';

  type QaSummary = {
    manifestVersion: number;
    runId: string;
    createdAt: number;
    completedAt: number | null;
    status: 'passed' | 'failed' | 'unknown';
    totalMs: number | null;
    totalShards: number;
    passedShards: number;
    failedShards: number;
    args?: Record<string, unknown> | null;
    failingTargets: string[];
  };

  type QaArtifact = {
    name: string;
    relativePath: string;
    sizeBytes: number;
    kind: 'video' | 'image' | 'trace' | 'json' | 'text' | 'archive' | 'other';
    contentType: string;
    url?: string;
  };

  type QaSlowStep = {
    label: string;
    ms: number;
  };

  type QaShard = {
    shard: number;
    status: 'passed' | 'failed' | 'unknown';
    durationMs: number | null;
    target: string | null;
    title: string | null;
    requireMarketMaker: boolean | null;
    logRelativePath: string | null;
    logTail: string | null;
    error: string | null;
    phaseMs: {
      preflight: number;
      anvilBoot: number;
      apiBoot: number;
      apiHealthy: number;
      viteBoot: number;
      playwright: number;
    } | null;
    slowSteps: QaSlowStep[];
    artifacts: QaArtifact[];
    hasVideo: boolean;
    hasTrace: boolean;
  };

  type QaRun = {
    manifestVersion: number;
    runId: string;
    createdAt: number;
    completedAt: number | null;
    status: 'passed' | 'failed' | 'unknown';
    totalMs: number | null;
    totalShards: number;
    passedShards: number;
    failedShards: number;
    args?: Record<string, unknown> | null;
    shards: QaShard[];
  };

  let runs = $state<QaSummary[]>([]);
  let selectedRunId = $state('');
  let selectedRun = $state<QaRun | null>(null);
  let selectedShardIndex = $state(0);
  let loadingRuns = $state(true);
  let loadingRun = $state(false);
  let error = $state<string | null>(null);
  let autoRefresh = $state(true);

  const selectedShard = $derived(
    selectedRun?.shards?.[selectedShardIndex] ?? null,
  );
  const selectedVideo = $derived(
    selectedShard?.artifacts.find((artifact) => artifact.kind === 'video') ?? null,
  );
  const selectedImages = $derived(
    selectedShard?.artifacts.filter((artifact) => artifact.kind === 'image') ?? [],
  );
  const latestRun = $derived(runs[0] ?? null);
  const previousRun = $derived(runs[1] ?? null);
  const recentPassRate = $derived(
    runs.length === 0 ? 0 : Math.round((runs.filter((run) => run.status === 'passed').length / runs.length) * 100),
  );
  const durationDeltaMs = $derived(
    latestRun?.totalMs && previousRun?.totalMs ? latestRun.totalMs - previousRun.totalMs : null,
  );
  const latestTrend = $derived(runs.slice(0, 12));

  function formatDate(timestamp: number | null | undefined): string {
    if (!timestamp) return 'n/a';
    return new Date(timestamp).toLocaleString();
  }

  function formatMs(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
  }

  function formatCount(run: QaSummary | QaRun | null): string {
    if (!run) return '0/0';
    return `${run.passedShards}/${run.totalShards}`;
  }

  function getRunLabel(run: QaSummary): string {
    const parts = run.runId.split('-');
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : run.runId;
  }

  function pickDefaultShard(run: QaRun): number {
    const failedIndex = run.shards.findIndex((shard) => shard.status === 'failed');
    return failedIndex >= 0 ? failedIndex : 0;
  }

  function describeShard(shard: QaShard): string {
    return shard.target || shard.title || `shard ${shard.shard}`;
  }

  async function loadRuns(preserveSelection = true): Promise<void> {
    loadingRuns = true;
    error = null;
    try {
      const response = await fetch('/api/qa/runs?limit=20', { cache: 'no-store' });
      const payload = await response.json() as { ok?: boolean; runs?: QaSummary[]; error?: string };
      if (!response.ok || !payload.ok || !Array.isArray(payload.runs)) {
        throw new Error(payload.error || 'Failed to load QA runs');
      }
      runs = payload.runs;
      const nextRunId = preserveSelection && selectedRunId && runs.some((run) => run.runId === selectedRunId)
        ? selectedRunId
        : runs[0]?.runId || '';
      if (nextRunId && nextRunId !== selectedRunId) {
        selectedRunId = nextRunId;
        await loadRun(nextRunId);
      } else if (!selectedRunId && nextRunId) {
        selectedRunId = nextRunId;
        await loadRun(nextRunId);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loadingRuns = false;
    }
  }

  async function loadRun(runId: string): Promise<void> {
    loadingRun = true;
    error = null;
    try {
      const response = await fetch(`/api/qa/run?runId=${encodeURIComponent(runId)}`, { cache: 'no-store' });
      const payload = await response.json() as { ok?: boolean; run?: QaRun; error?: string };
      if (!response.ok || !payload.ok || !payload.run) {
        throw new Error(payload.error || 'Failed to load QA run');
      }
      selectedRun = payload.run;
      selectedShardIndex = pickDefaultShard(payload.run);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loadingRun = false;
    }
  }

  async function selectRun(runId: string): Promise<void> {
    if (!runId || runId === selectedRunId) return;
    selectedRunId = runId;
    await loadRun(runId);
  }

  onMount(() => {
    void loadRuns(false);
    const timer = setInterval(() => {
      if (!autoRefresh) return;
      void loadRuns(true);
      if (selectedRunId) void loadRun(selectedRunId);
    }, 15000);
    return () => clearInterval(timer);
  });
</script>

<svelte:head>
  <title>QA Cockpit</title>
</svelte:head>

<div class="qa-shell">
  <aside class="sidebar">
    <div class="sidebar-head">
      <div>
        <div class="eyebrow">XLN QA</div>
        <h1>Test Cockpit</h1>
      </div>
      <label class="refresh-toggle">
        <input bind:checked={autoRefresh} type="checkbox" />
        <span>Auto</span>
      </label>
    </div>

    <div class="metric-stack">
      <article class="metric-card">
        <span class="metric-label">Latest</span>
        <strong class:selectedPass={latestRun?.status === 'passed'} class:selectedFail={latestRun?.status === 'failed'}>
          {latestRun?.status ?? 'n/a'}
        </strong>
        <small>{latestRun ? formatMs(latestRun.totalMs) : 'n/a'}</small>
      </article>
      <article class="metric-card">
        <span class="metric-label">Pass Rate</span>
        <strong>{recentPassRate}%</strong>
        <small>{runs.length} recent runs</small>
      </article>
      <article class="metric-card">
        <span class="metric-label">Trend</span>
        <strong class:trendUp={typeof durationDeltaMs === 'number' && durationDeltaMs > 0} class:trendDown={typeof durationDeltaMs === 'number' && durationDeltaMs < 0}>
          {durationDeltaMs === null ? 'n/a' : `${durationDeltaMs > 0 ? '+' : ''}${formatMs(durationDeltaMs)}`}
        </strong>
        <small>vs previous wall time</small>
      </article>
    </div>

    <div class="trend-strip">
      {#each latestTrend as run}
        <button
          class="trend-pill"
          class:pass={run.status === 'passed'}
          class:fail={run.status === 'failed'}
          class:selected={run.runId === selectedRunId}
          onclick={() => selectRun(run.runId)}
        >
          {run.failedShards > 0 ? run.failedShards : run.passedShards}
        </button>
      {/each}
    </div>

    <div class="run-list">
      {#if loadingRuns && runs.length === 0}
        <div class="empty">Loading runs…</div>
      {:else}
        {#each runs as run}
          <button class="run-row" class:selected={run.runId === selectedRunId} onclick={() => selectRun(run.runId)}>
            <div class="run-row-top">
              <span class="status-dot" class:pass={run.status === 'passed'} class:fail={run.status === 'failed'}></span>
              <strong>{getRunLabel(run)}</strong>
              <span class="run-duration">{formatMs(run.totalMs)}</span>
            </div>
            <div class="run-row-meta">
              <span>{formatCount(run)}</span>
              <span>{formatDate(run.createdAt)}</span>
            </div>
            {#if run.failingTargets.length > 0}
              <div class="run-row-failures">{run.failingTargets.join(' · ')}</div>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </aside>

  <main class="content">
    {#if error}
      <div class="error-banner">{error}</div>
    {/if}

    {#if selectedRun}
      <section class="run-summary">
        <div>
          <div class="eyebrow">Selected Run</div>
          <h2>{selectedRun.runId}</h2>
          <p>{formatDate(selectedRun.createdAt)}</p>
        </div>
        <div class="summary-grid">
          <article class="summary-card">
            <span>Status</span>
            <strong class:pass={selectedRun.status === 'passed'} class:fail={selectedRun.status === 'failed'}>
              {selectedRun.status}
            </strong>
          </article>
          <article class="summary-card">
            <span>Wall</span>
            <strong>{formatMs(selectedRun.totalMs)}</strong>
          </article>
          <article class="summary-card">
            <span>Shards</span>
            <strong>{formatCount(selectedRun)}</strong>
          </article>
          <article class="summary-card">
            <span>Parallel</span>
            <strong>{String(selectedRun.args?.shards ?? 'n/a')}</strong>
          </article>
        </div>
      </section>

      <section class="shard-grid">
        {#each selectedRun.shards as shard, index}
          <button class="shard-card" class:selected={index === selectedShardIndex} class:pass={shard.status === 'passed'} class:fail={shard.status === 'failed'} onclick={() => (selectedShardIndex = index)}>
            <div class="shard-card-top">
              <span>#{shard.shard}</span>
              <span>{formatMs(shard.durationMs)}</span>
            </div>
            <strong>{describeShard(shard)}</strong>
            <div class="shard-card-meta">
              <span>{shard.status}</span>
              <span>{shard.hasVideo ? 'video' : 'no video'}</span>
              <span>{shard.artifacts.length} artifacts</span>
            </div>
          </button>
        {/each}
      </section>

      {#if selectedShard}
        <section class="shard-detail">
          <div class="detail-head">
            <div>
              <div class="eyebrow">Shard {selectedShard.shard}</div>
              <h3>{describeShard(selectedShard)}</h3>
            </div>
            <div class="detail-meta">
              <span>{selectedShard.status}</span>
              <span>{formatMs(selectedShard.durationMs)}</span>
            </div>
          </div>

          <div class="detail-layout">
            <div class="media-panel">
              {#if selectedVideo?.url}
                <!-- svelte-ignore a11y_media_has_caption -->
                <video class="video-player" controls preload="metadata" src={selectedVideo.url}></video>
              {:else}
                <div class="empty-media">No video for this shard</div>
              {/if}

              {#if selectedImages.length > 0}
                <div class="image-strip">
                  {#each selectedImages as image}
                    <a class="image-thumb" href={image.url} target="_blank" rel="noreferrer">
                      <img alt={image.name} src={image.url} loading="lazy" />
                      <span>{image.name}</span>
                    </a>
                  {/each}
                </div>
              {/if}
            </div>

            <div class="info-panel">
              <section class="panel-block">
                <h4>Phases</h4>
                {#if selectedShard.phaseMs}
                  <dl class="phase-list">
                    <div><dt>pre</dt><dd>{formatMs(selectedShard.phaseMs.preflight)}</dd></div>
                    <div><dt>anvil</dt><dd>{formatMs(selectedShard.phaseMs.anvilBoot)}</dd></div>
                    <div><dt>api</dt><dd>{formatMs(selectedShard.phaseMs.apiBoot)}</dd></div>
                    <div><dt>health</dt><dd>{formatMs(selectedShard.phaseMs.apiHealthy)}</dd></div>
                    <div><dt>vite</dt><dd>{formatMs(selectedShard.phaseMs.viteBoot)}</dd></div>
                    <div><dt>pw</dt><dd>{formatMs(selectedShard.phaseMs.playwright)}</dd></div>
                  </dl>
                {:else}
                  <div class="empty">No phase timings</div>
                {/if}
              </section>

              <section class="panel-block">
                <h4>Slow Steps</h4>
                {#if selectedShard.slowSteps.length > 0}
                  <ul class="slow-step-list">
                    {#each selectedShard.slowSteps.slice(0, 10) as step}
                      <li><span>{step.label}</span><strong>{formatMs(step.ms)}</strong></li>
                    {/each}
                  </ul>
                {:else}
                  <div class="empty">No slow-step data</div>
                {/if}
              </section>

              <section class="panel-block">
                <h4>Artifacts</h4>
                <div class="artifact-list">
                  {#each selectedShard.artifacts as artifact}
                    <a href={artifact.url} target="_blank" rel="noreferrer">
                      <span>{artifact.kind}</span>
                      <strong>{artifact.name}</strong>
                    </a>
                  {/each}
                </div>
              </section>
            </div>
          </div>

          <section class="log-panel">
            <div class="log-head">
              <h4>Log Tail</h4>
              {#if selectedShard.logRelativePath}
                <a href={`/api/qa/artifact?runId=${encodeURIComponent(selectedRun.runId)}&path=${encodeURIComponent(selectedShard.logRelativePath)}`} target="_blank" rel="noreferrer">
                  Open full log
                </a>
              {/if}
            </div>
            <pre>{selectedShard.logTail || selectedShard.error || 'No log tail available.'}</pre>
          </section>
        </section>
      {/if}
    {:else if loadingRun || loadingRuns}
      <div class="empty-state">Loading QA cockpit…</div>
    {:else}
      <div class="empty-state">No runs found yet.</div>
    {/if}
  </main>
</div>

<style>
  :global(body) {
    background:
      radial-gradient(circle at top, rgba(196, 155, 71, 0.12), transparent 32%),
      #09090b;
  }

  .qa-shell {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 340px minmax(0, 1fr);
    color: #f1efe7;
  }

  .sidebar {
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(10, 10, 14, 0.88);
    backdrop-filter: blur(18px);
    padding: 1.25rem;
    display: grid;
    gap: 1rem;
    align-content: start;
  }

  .sidebar-head,
  .run-row-top,
  .run-row-meta,
  .detail-head,
  .log-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .eyebrow {
    color: #d8af4f;
    font-size: 0.72rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  h4,
  p {
    margin: 0;
  }

  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.4rem; }
  h3 { font-size: 1.15rem; }
  h4 { font-size: 0.92rem; text-transform: uppercase; letter-spacing: 0.12em; color: #cfc6af; }

  .refresh-toggle,
  .metric-card,
  .run-row,
  .summary-card,
  .shard-card,
  .panel-block,
  .log-panel,
  .empty-media,
  .empty-state,
  .error-banner {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    border-radius: 18px;
  }

  .refresh-toggle {
    padding: 0.45rem 0.7rem;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    cursor: pointer;
  }

  .metric-stack,
  .summary-grid {
    display: grid;
    gap: 0.75rem;
  }

  .metric-stack {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .metric-card,
  .summary-card {
    padding: 0.9rem;
    display: grid;
    gap: 0.3rem;
  }

  .metric-label {
    font-size: 0.72rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #8f8b80;
  }

  .trend-strip {
    display: flex;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .trend-pill {
    min-width: 2.1rem;
    height: 2rem;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    cursor: pointer;
  }

  .trend-pill.pass,
  .status-dot.pass,
  strong.pass,
  strong.selectedPass {
    color: #84e0a1;
  }

  .trend-pill.fail,
  .status-dot.fail,
  strong.fail,
  strong.selectedFail {
    color: #ff9284;
  }

  .trend-pill.selected,
  .run-row.selected,
  .shard-card.selected {
    border-color: rgba(216, 175, 79, 0.56);
    box-shadow: 0 0 0 1px rgba(216, 175, 79, 0.26) inset;
  }

  .run-list {
    display: grid;
    gap: 0.7rem;
    align-content: start;
    max-height: calc(100vh - 18rem);
    overflow: auto;
    padding-right: 0.15rem;
  }

  .run-row,
  .shard-card {
    width: 100%;
    text-align: left;
    color: inherit;
    padding: 0.95rem;
    cursor: pointer;
  }

  .run-row-failures,
  .run-row-meta,
  .run-duration,
  .detail-meta,
  small,
  p {
    color: #9b978a;
  }

  .status-dot {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 999px;
    background: #888;
    flex: 0 0 auto;
  }

  .content {
    padding: 1.5rem;
    display: grid;
    gap: 1rem;
    align-content: start;
  }

  .run-summary,
  .shard-detail {
    display: grid;
    gap: 1rem;
  }

  .summary-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .shard-grid {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .shard-card-top,
  .shard-card-meta,
  .phase-list div,
  .slow-step-list li,
  .artifact-list a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .shard-card {
    display: grid;
    gap: 0.55rem;
  }

  .shard-card-meta {
    color: #9b978a;
    font-size: 0.86rem;
  }

  .detail-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
    gap: 1rem;
  }

  .media-panel,
  .info-panel {
    display: grid;
    gap: 1rem;
  }

  .video-player,
  .empty-media {
    width: 100%;
    min-height: 340px;
  }

  .empty-media,
  .empty-state {
    display: grid;
    place-items: center;
    color: #9b978a;
    padding: 2rem;
  }

  .image-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.75rem;
  }

  .image-thumb {
    color: inherit;
    text-decoration: none;
    display: grid;
    gap: 0.45rem;
  }

  .image-thumb img {
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .panel-block,
  .log-panel {
    padding: 1rem;
    display: grid;
    gap: 0.85rem;
  }

  .phase-list,
  .slow-step-list,
  .artifact-list {
    display: grid;
    gap: 0.65rem;
  }

  .phase-list div,
  .slow-step-list li,
  .artifact-list a {
    padding-bottom: 0.55rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .phase-list dt,
  .artifact-list span {
    color: #8f8b80;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.72rem;
  }

  .phase-list dd,
  .slow-step-list strong {
    margin: 0;
  }

  .artifact-list a {
    color: inherit;
    text-decoration: none;
  }

  .log-panel pre {
    margin: 0;
    max-height: 420px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.85rem;
    line-height: 1.55;
    color: #d8d4c8;
  }

  .error-banner {
    padding: 0.9rem 1rem;
    color: #ffb2a7;
    border-color: rgba(255, 108, 84, 0.24);
  }

  .trendUp { color: #ffb2a7; }
  .trendDown { color: #84e0a1; }

  @media (max-width: 1100px) {
    .qa-shell {
      grid-template-columns: 1fr;
    }

    .sidebar {
      border-right: 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .detail-layout,
    .summary-grid,
    .metric-stack {
      grid-template-columns: 1fr;
    }
  }
</style>
