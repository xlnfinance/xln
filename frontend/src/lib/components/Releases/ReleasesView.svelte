<script lang="ts">
  import { onMount } from 'svelte';
  import { marked } from 'marked';
  import { Braces, Download, GitCommitHorizontal } from 'lucide-svelte';

  type Metrics = {
    code: number;
    complexity: number;
    files: number;
    testCode: number;
    testCodeRatio: number;
  };

  type ReleaseEntry = {
    version: string;
    tag: string;
    generatedAt: string;
    markdown: string;
    snapshot: string;
    sourceCommit: string;
    metrics: Metrics;
    modules: Record<string, Metrics>;
  };

  type Manifest = {
    schemaVersion: 1;
    latest: string;
    releases: ReleaseEntry[];
  };

  type MetricKey = keyof Pick<Metrics, 'code' | 'complexity' | 'files' | 'testCode' | 'testCodeRatio'>;

  const METRICS: Array<{ key: MetricKey; label: string }> = [
    { key: 'code', label: 'Code LOC' },
    { key: 'complexity', label: 'Complexity' },
    { key: 'files', label: 'Files' },
    { key: 'testCode', label: 'Test LOC' },
    { key: 'testCodeRatio', label: 'Test / source' },
  ];

  let manifest = $state<Manifest | null>(null);
  let selectedVersion = $state('');
  let selectedMetric = $state<MetricKey>('code');
  let selectedScope = $state('repository');
  let renderedMarkdown = $state('');
  let loading = $state(true);
  let error = $state('');

  let selectedRelease = $derived(manifest?.releases.find((release) => release.version === selectedVersion) ?? null);
  let scopes = $derived.by(() => {
    const names = new Set<string>();
    for (const release of manifest?.releases ?? []) Object.keys(release.modules).forEach((name) => names.add(name));
    const priority = ['runtime', 'jurisdictions', 'frontend'];
    return ['repository', ...[...names].sort((left, right) => {
      const li = priority.indexOf(left);
      const ri = priority.indexOf(right);
      if (li !== ri) return (li < 0 ? 999 : li) - (ri < 0 ? 999 : ri);
      return left.localeCompare(right);
    })];
  });
  let chartPoints = $derived.by(() => {
    const releases = [...(manifest?.releases ?? [])].reverse();
    const values = releases.map((release) => {
      const metrics = selectedScope === 'repository' ? release.metrics : release.modules[selectedScope];
      return { release, value: Number(metrics?.[selectedMetric] ?? 0) };
    });
    const maximum = Math.max(...values.map((point) => point.value), 1);
    const minimum = Math.min(...values.map((point) => point.value), 0);
    const spread = Math.max(maximum - minimum, 1);
    const chartLeft = values.length <= 3 ? 132 : 44;
    const chartWidth = values.length <= 3 ? 496 : 672;
    return values.map((point, index) => ({
      ...point,
      x: values.length === 1 ? 380 : chartLeft + index * (chartWidth / Math.max(values.length - 1, 1)),
      y: 158 - ((point.value - minimum) / spread) * 112,
    }));
  });
  let chartPath = $derived(chartPoints.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '));

  function formatMetric(value: number): string {
    if (selectedMetric === 'testCodeRatio') return `${(value * 100).toFixed(1)}%`;
    return Math.round(value).toLocaleString('en-US');
  }

  async function loadRelease(version: string): Promise<void> {
    const release = manifest?.releases.find((entry) => entry.version === version);
    if (!release) throw new Error(`Unknown release: ${version}`);
    selectedVersion = version;
    const response = await fetch(release.markdown, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Release document request failed: ${response.status}`);
    renderedMarkdown = await marked.parse(await response.text(), { gfm: true }) as string;
  }

  async function selectRelease(version: string): Promise<void> {
    error = '';
    try {
      await loadRelease(version);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function handleChartKey(event: KeyboardEvent, version: string): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void selectRelease(version);
  }

  onMount(async () => {
    try {
      const response = await fetch('/docs-catalog/releases/manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Release manifest request failed: ${response.status}`);
      manifest = await response.json() as Manifest;
      await loadRelease(manifest.latest);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>Releases | xln</title>
  <meta name="description" content="xln release history and codebase metrics" />
</svelte:head>

<div class="releases-shell">
  <header class="release-header">
    <div>
      <p class="eyebrow">xln engineering ledger</p>
      <h1>Releases</h1>
    </div>
    {#if selectedRelease}
      <div class="release-identity">
        <strong>{selectedRelease.tag}</strong>
        <span>{selectedRelease.sourceCommit.slice(0, 12)}</span>
      </div>
    {/if}
  </header>

  {#if loading}
    <p class="state-message">Loading release history...</p>
  {:else if error}
    <p class="state-message error">{error}</p>
  {:else if manifest && selectedRelease}
    <section class="metrics-band" aria-label="Release metric history">
      <div class="metric-controls">
        <label>
          <span>Metric</span>
          <select bind:value={selectedMetric}>
            {#each METRICS as metric}
              <option value={metric.key}>{metric.label}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>Scope</span>
          <select bind:value={selectedScope}>
            {#each scopes as scope}
              <option value={scope}>{scope === 'repository' ? 'Entire repository' : `${scope}/`}</option>
            {/each}
          </select>
        </label>
        <div class="current-value">
          <span>Current</span>
          <strong>{formatMetric(Number((selectedScope === 'repository' ? selectedRelease.metrics : selectedRelease.modules[selectedScope])?.[selectedMetric] ?? 0))}</strong>
        </div>
      </div>

      <div class="chart-scroll">
        <svg class="release-chart" viewBox="0 0 760 200" role="img" aria-label={`${selectedMetric} history for ${selectedScope}`}>
          <line x1="92" y1="158" x2="668" y2="158" class="axis" />
          <line x1="92" y1="46" x2="92" y2="158" class="axis" />
          <path d={chartPath} class="trend" />
          {#each chartPoints as point}
            <g
              class="point"
              class:selected={point.release.version === selectedVersion}
              onclick={() => selectRelease(point.release.version)}
              onkeydown={(event) => handleChartKey(event, point.release.version)}
              role="button"
              tabindex="0"
            >
              <circle cx={point.x} cy={point.y} r={point.release.version === selectedVersion ? 6 : 4} />
              <text x={point.x} y={point.y - 13} text-anchor="middle" class="point-value">{formatMetric(point.value)}</text>
              <text x={point.x} y="184" text-anchor="middle" class="point-label">{point.release.version}</text>
            </g>
          {/each}
        </svg>
      </div>
    </section>

    <div class="release-layout">
      <aside class="release-index" aria-label="Release versions">
        {#each manifest.releases as release}
          <button class:active={release.version === selectedVersion} onclick={() => selectRelease(release.version)}>
            <strong>{release.version}</strong>
            <span>{new Date(release.generatedAt).toLocaleDateString('en-CA')}</span>
          </button>
        {/each}
      </aside>

      <main class="release-document">
        <div class="document-actions">
          <span><GitCommitHorizontal size={15} /> {selectedRelease.sourceCommit.slice(0, 12)}</span>
          <a href={selectedRelease.snapshot} target="_blank" rel="noreferrer"><Braces size={15} /> Raw JSON</a>
          <a href={selectedRelease.snapshot} download><Download size={15} /> Snapshot</a>
        </div>
        <article class="markdown-body">{@html renderedMarkdown}</article>
      </main>
    </div>
  {/if}
</div>

<style>
  .releases-shell { min-height: 100vh; background: #090b0a; color: #e7ece9; }
  .release-header, .metrics-band, .release-layout { width: min(1440px, calc(100% - 40px)); margin-inline: auto; }
  .release-header { min-height: 150px; display: flex; align-items: end; justify-content: space-between; gap: 24px; padding: 36px 0 28px; border-bottom: 1px solid #26312b; }
  .eyebrow { margin: 0 0 8px; color: #71d59b; font: 600 12px/1.2 'SF Mono', monospace; text-transform: uppercase; }
  h1 { margin: 0; font-size: 42px; line-height: 1; letter-spacing: 0; }
  .release-identity { display: grid; justify-items: end; gap: 6px; font-family: 'SF Mono', monospace; }
  .release-identity strong { color: #71d59b; font-size: 18px; }
  .release-identity span { color: #859189; font-size: 12px; }
  .metrics-band { padding: 26px 0 20px; border-bottom: 1px solid #26312b; }
  .metric-controls { display: flex; align-items: end; gap: 16px; }
  label { display: grid; gap: 7px; color: #859189; font: 600 11px/1.2 'SF Mono', monospace; text-transform: uppercase; }
  select { min-width: 180px; height: 38px; padding: 0 34px 0 10px; border: 1px solid #344239; border-radius: 4px; background: #101411; color: #e7ece9; }
  .current-value { margin-left: auto; display: grid; justify-items: end; gap: 4px; }
  .current-value span { color: #859189; font: 600 11px 'SF Mono', monospace; text-transform: uppercase; }
  .current-value strong { color: #71d59b; font: 600 24px 'SF Mono', monospace; }
  .chart-scroll { overflow: hidden; }
  .release-chart { display: block; width: 100%; height: 200px; margin-top: 8px; }
  .axis { stroke: #344239; stroke-width: 1; }
  .trend { fill: none; stroke: #71d59b; stroke-width: 2; }
  .point { cursor: pointer; }
  .point circle { fill: #090b0a; stroke: #71d59b; stroke-width: 2; }
  .point.selected circle { fill: #71d59b; }
  .point-value, .point-label { fill: #859189; font: 11px 'SF Mono', monospace; }
  .point.selected .point-value, .point.selected .point-label { fill: #e7ece9; }
  .release-layout { display: grid; grid-template-columns: 180px minmax(0, 1fr); align-items: start; }
  .release-index { position: sticky; top: 56px; padding: 28px 20px 28px 0; display: grid; gap: 4px; }
  .release-index button { display: grid; gap: 3px; padding: 10px 12px; border: 0; border-left: 2px solid transparent; background: transparent; color: #859189; text-align: left; cursor: pointer; }
  .release-index button.active { border-left-color: #71d59b; color: #e7ece9; background: #111713; }
  .release-index strong { font: 600 14px 'SF Mono', monospace; }
  .release-index span { font: 11px 'SF Mono', monospace; }
  .release-document { min-width: 0; padding: 28px 0 80px 32px; border-left: 1px solid #26312b; }
  .document-actions { display: flex; gap: 18px; align-items: center; padding-bottom: 18px; color: #859189; font: 12px 'SF Mono', monospace; }
  .document-actions span, .document-actions a { display: inline-flex; align-items: center; gap: 6px; }
  .document-actions a { color: #a9b4ad; text-decoration: none; }
  .document-actions a:hover { color: #71d59b; }
  .state-message { width: min(1100px, calc(100% - 40px)); margin: 80px auto; color: #859189; }
  .state-message.error { color: #ff8585; }
  .markdown-body { max-width: 1120px; line-height: 1.7; color: #cbd3ce; }
  .markdown-body :global(h1), .markdown-body :global(h2), .markdown-body :global(h3) { color: #f0f4f1; letter-spacing: 0; }
  .markdown-body :global(h1) { font-size: 30px; margin: 34px 0 16px; }
  .markdown-body :global(h2) { margin: 34px 0 12px; padding-top: 8px; border-top: 1px solid #26312b; font-size: 20px; }
  .markdown-body :global(a) { color: #71d59b; }
  .markdown-body :global(code) { font-family: 'SF Mono', monospace; }
  .markdown-body :global(pre) { max-height: 52vh; overflow: auto; padding: 18px; border: 1px solid #2d3a32; border-radius: 4px; background: #050706; color: #b7c5bc; font-size: 12px; line-height: 1.5; scrollbar-color: #344239 #050706; }

  @media (max-width: 760px) {
    .release-header, .metrics-band, .release-layout { width: min(100% - 24px, 1440px); }
    .release-header { min-height: 120px; padding-top: 24px; }
    h1 { font-size: 34px; }
    .metric-controls { align-items: stretch; flex-wrap: wrap; }
    label { flex: 1 1 150px; }
    select { min-width: 0; width: 100%; }
    .current-value { width: 100%; margin-left: 0; justify-items: start; }
    .release-chart { height: 168px; margin-top: 4px; }
    .release-layout { display: block; }
    .release-index { position: static; grid-auto-flow: column; grid-auto-columns: minmax(110px, 1fr); overflow-x: auto; padding: 18px 0; }
    .release-document { padding: 22px 0 60px; border-left: 0; border-top: 1px solid #26312b; }
    .document-actions { flex-wrap: wrap; }
    .markdown-body :global(pre) { max-height: 420px; padding: 14px; font-size: 11px; }
  }
</style>
