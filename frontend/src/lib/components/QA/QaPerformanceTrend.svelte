<script lang="ts">
  import type { QaHistoryEntry } from '$lib/qa/types';
  import { buildQaPerformanceTrends, type QaPerformanceTrend } from '$lib/qa/performanceTrend';

  let { history = [] }: { history?: QaHistoryEntry[] } = $props();
  const trends = $derived(buildQaPerformanceTrends(history));

  function formatValue(trend: QaPerformanceTrend): string {
    if (trend.metric === 'wall') {
      return trend.latest < 1_000
        ? `${Math.round(trend.latest)} ms`
        : `${(trend.latest / 1_000).toFixed(1)} s`;
    }
    return `${trend.latest.toFixed(trend.latest < 10 ? 1 : 0)}${trend.unit ? ` ${trend.unit}` : ''}`;
  }

  function formatDelta(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return `${rounded > 0 ? '+' : ''}${rounded}%`;
  }
</script>

<section class="perf-trends" data-testid="qa-performance-trends">
  <header>
    <div>
      <span>Measured history</span>
      <h3>CPU / RAM / latency across runs</h3>
    </div>
    <small>lower is better · disk-backed QA history</small>
  </header>
  <div class="trend-grid">
    {#each trends as trend (trend.metric)}
      <article data-testid={`qa-performance-trend-${trend.metric}`}>
        <div class="metric-head">
          <span>{trend.label}</span>
          <strong>{formatValue(trend)}</strong>
        </div>
        <svg viewBox="0 0 240 72" role="img" aria-label={`${trend.label} over ${trend.samples} runs`}>
          <line x1="0" y1="68" x2="240" y2="68" />
          <polyline points={trend.points} />
        </svg>
        <div class="metric-foot">
          <small>{trend.samples} runs</small>
          <b class:good={trend.improved} class:bad={!trend.improved}>{formatDelta(trend.deltaPct)}</b>
        </div>
      </article>
    {:else}
      <p class="empty">Two comparable QA runs are required.</p>
    {/each}
  </div>
</section>

<style>
  .perf-trends {
    display: grid;
    gap: 0.75rem;
    padding: 0.85rem;
    border: 1px solid rgba(216, 175, 79, 0.2);
    border-radius: 10px;
    background: linear-gradient(145deg, rgba(216, 175, 79, 0.06), rgba(5, 7, 10, 0.82));
  }

  header,
  .metric-head,
  .metric-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  header span,
  .metric-head span {
    color: #d8af4f;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h3 { margin: 0.18rem 0 0; font-size: 1rem; }
  header small, .metric-foot small { color: rgba(226, 232, 240, 0.58); }

  .trend-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.65rem;
  }

  article {
    min-width: 0;
    padding: 0.65rem;
    border: 1px solid rgba(148, 163, 184, 0.16);
    border-radius: 8px;
    background: rgba(2, 6, 12, 0.62);
  }

  svg { display: block; width: 100%; height: 72px; margin: 0.35rem 0; overflow: visible; }
  line { stroke: rgba(148, 163, 184, 0.2); stroke-width: 1; }
  polyline { fill: none; stroke: #d8af4f; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  .good { color: #65d6a3; }
  .bad { color: #ff8a8a; }
  .empty { grid-column: 1 / -1; margin: 0; color: rgba(226, 232, 240, 0.55); }

  @media (max-width: 980px) { .trend-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 560px) {
    header { align-items: flex-start; flex-direction: column; }
    .trend-grid { grid-template-columns: 1fr; }
  }
</style>
