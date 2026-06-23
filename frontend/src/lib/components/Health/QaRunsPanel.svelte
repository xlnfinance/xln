<script lang="ts">
  import { onMount } from 'svelte';

  type QaSummary = {
    runId: string;
    createdAt: number;
    completedAt: number | null;
    status: 'passed' | 'failed' | 'unknown';
    totalMs: number | null;
    totalShards: number;
    passedShards: number;
    failedShards: number;
    failingTargets: string[];
  };

  type Props = {
    limit?: number;
    refreshMs?: number;
  };

  let { limit = 8, refreshMs = 15_000 }: Props = $props();

  let runs = $state<QaSummary[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const latestRun = $derived(runs[0] ?? null);
  const passRate = $derived(
    runs.length === 0 ? 0 : Math.round((runs.filter((run) => run.status === 'passed').length / runs.length) * 100),
  );
  const failedRuns = $derived(runs.filter((run) => run.status === 'failed').length);

  function formatMs(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
  }

  function formatDate(timestamp: number | null | undefined): string {
    if (!timestamp) return 'n/a';
    return new Date(timestamp).toLocaleString();
  }

  function runLabel(run: QaSummary): string {
    const parts = run.runId.split('-');
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : run.runId;
  }

  async function loadRuns(silent = false): Promise<void> {
    if (!silent) {
      loading = true;
      error = null;
    }
    try {
      const response = await fetch(`/api/qa/runs?limit=${Math.max(1, Math.floor(limit))}`, { cache: 'no-store' });
      const payload = await response.json() as { ok?: boolean; runs?: QaSummary[]; error?: string };
      if (!response.ok || !payload.ok || !Array.isArray(payload.runs)) {
        throw new Error(payload.error || `QA runs HTTP ${response.status}`);
      }
      runs = payload.runs;
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err || 'Failed to load QA runs');
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadRuns();
    const timer = setInterval(() => {
      void loadRuns(true);
    }, Math.max(5_000, refreshMs));
    return () => clearInterval(timer);
  });
</script>

<section id="qa-runs" class="admin-panel qa-runs">
  <div class="panel-head">
    <div>
      <h2>QA Runs</h2>
      <p class="sub">Latest isolated Playwright/bootstrap evidence</p>
    </div>
    <div class="panel-actions">
      <button class="ghost" onclick={() => loadRuns()} disabled={loading}>Refresh</button>
      <a class="panel-link" href="/qa">Open cockpit</a>
    </div>
  </div>

  {#if error}
    <div class="inline-error">{error}</div>
  {/if}

  <div class="qa-metrics">
    <article>
      <span>Latest</span>
      <strong class:ok={latestRun?.status === 'passed'} class:bad={latestRun?.status === 'failed'}>
        {latestRun?.status ?? (loading ? 'loading' : 'n/a')}
      </strong>
      <small>{latestRun ? formatMs(latestRun.totalMs) : 'no runs'}</small>
    </article>
    <article>
      <span>Pass Rate</span>
      <strong>{passRate}%</strong>
      <small>{runs.length} recent runs</small>
    </article>
    <article>
      <span>Failures</span>
      <strong class:ok={failedRuns === 0} class:bad={failedRuns > 0}>{failedRuns}</strong>
      <small>{latestRun ? `${latestRun.passedShards}/${latestRun.totalShards} latest shards` : 'no shard data'}</small>
    </article>
  </div>

  <div class="run-strip">
    {#if loading && runs.length === 0}
      <div class="empty">Loading QA runs...</div>
    {:else if runs.length === 0}
      <div class="empty">No QA runs found.</div>
    {:else}
      {#each runs as run}
        <article class="run-row" class:ok={run.status === 'passed'} class:bad={run.status === 'failed'}>
          <div>
            <strong>{runLabel(run)}</strong>
            <span>{formatDate(run.createdAt)}</span>
          </div>
          <div>
            <span>{run.passedShards}/{run.totalShards}</span>
            <strong>{formatMs(run.totalMs)}</strong>
          </div>
          {#if run.failingTargets.length > 0}
            <small>{run.failingTargets.slice(0, 2).join(' · ')}</small>
          {/if}
        </article>
      {/each}
    {/if}
  </div>
</section>

<style>
  .admin-panel {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
    padding: 16px;
  }

  .panel-head,
  .panel-actions,
  .run-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    letter-spacing: 0;
  }

  .sub {
    margin: 4px 0 0;
    color: #8b949e;
    font-size: 12px;
  }

  .panel-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .panel-link,
  button.ghost {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    padding: 0 10px;
    color: #dbeafe;
    background: rgba(255, 255, 255, 0.04);
    text-decoration: none;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  button.ghost:disabled {
    opacity: 0.55;
    cursor: wait;
  }

  .inline-error {
    margin-top: 12px;
    border: 1px solid rgba(248, 81, 73, 0.35);
    border-radius: 6px;
    padding: 10px;
    color: #ffb3ad;
    background: rgba(248, 81, 73, 0.08);
    font-size: 12px;
  }

  .qa-metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 14px;
  }

  .qa-metrics article {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.18);
  }

  .qa-metrics span,
  .run-row span,
  .qa-metrics small,
  .run-row small {
    color: #8b949e;
    font-size: 12px;
  }

  .qa-metrics strong {
    display: block;
    margin-top: 6px;
    color: #f8fafc;
    font-size: 22px;
    letter-spacing: 0;
  }

  .ok {
    color: #7ee787 !important;
  }

  .bad {
    color: #ff7b72 !important;
  }

  .run-strip {
    display: grid;
    gap: 8px;
    margin-top: 12px;
  }

  .run-row {
    align-items: flex-start;
    border-left: 3px solid #6b7280;
    border-radius: 6px;
    padding: 10px 12px;
    background: rgba(0, 0, 0, 0.22);
  }

  .run-row.ok {
    border-left-color: #3fb950;
  }

  .run-row.bad {
    border-left-color: #f85149;
  }

  .run-row > div {
    display: grid;
    gap: 3px;
  }

  .run-row > div:last-of-type {
    text-align: right;
  }

  .run-row strong {
    color: #f8fafc;
    font-size: 13px;
  }

  .run-row small {
    grid-column: 1 / -1;
    color: #ffb3ad;
  }

  .empty {
    padding: 12px;
    color: #8b949e;
    font-size: 12px;
  }

  @media (max-width: 760px) {
    .panel-head,
    .run-row {
      align-items: stretch;
      flex-direction: column;
    }

    .panel-actions,
    .run-row > div:last-of-type {
      justify-content: flex-start;
      text-align: left;
    }

    .qa-metrics {
      grid-template-columns: 1fr;
    }
  }
</style>
