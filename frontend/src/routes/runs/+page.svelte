<script lang="ts">
  import { onMount } from 'svelte';
  import { DISPLAY, QA } from '@xln/runtime/constants';
  import { consumeQaTokenFromUrl, qaFetch, readQaToken, writeQaToken } from '$lib/qa/apiClient';

  type QaBenchmarkStatus = 'ok' | 'faster' | 'slower' | 'mixed' | 'failed' | 'insufficient';
  type QaRunCategory = 'unit' | 'contract' | 'e2e' | 'scenario' | 'benchmark' | 'release' | 'unknown';
  type RunSortKey = 'date-desc' | 'date-asc' | 'stack-fast' | 'stack-slow' | 'browser-fast' | 'browser-slow';

  type QaRunLedgerEntry = {
    runId: string;
    createdAt: number;
    completedAt: number | null;
    status: 'passed' | 'failed' | 'unknown';
    category: QaRunCategory;
    suiteKey: string;
    suiteLabel: string;
    gitHead: string | null;
    gitBranch: string | null;
    codeHash: string | null;
    dirty: boolean;
    startedBy: string;
    durationMs: number | null;
    timing: {
      bootstrapMs?: number | null;
      playwrightMs?: number | null;
      avgShardMs?: number | null;
    };
    failedShard: string | null;
    failedTargets: string[];
    artifactBytes: number;
    cpuP95Pct: number | null;
    cpuPeakPct: number | null;
    ramPeakKb: number | null;
    browserErrors: number;
    browserWarnings: number;
    networkFailures: number;
    benchmarkStatus: QaBenchmarkStatus | null;
    benchmarkDeltaPct: number | null;
    benchmarkComparedRunId: string | null;
    auditAction: string | null;
  };

  let ledger = $state<QaRunLedgerEntry[]>([]);
  let loading = $state(true);
  let error = $state('');
  let qaToken = $state('');
  let categoryFilter = $state<QaRunCategory | 'all'>('all');
  let query = $state('');
  let sortKey = $state<RunSortKey>('date-desc');
  let visibleLimit = $state(QA.LEDGER_WINDOW_STEP);
  let qaAuthLabel = $state('locked');

  const categoryOptions = $derived(Array.from(new Set(ledger.map(row => row.category))).sort());
  const filteredLedger = $derived(
    ledger
      .filter(row => categoryFilter === 'all' || row.category === categoryFilter)
      .filter(row => {
        const needle = query.trim().toLowerCase();
        if (!needle) return true;
        return [
          row.runId,
          row.category,
          row.suiteKey,
          row.suiteLabel,
          row.startedBy,
          row.status,
          row.failedShard,
          row.auditAction,
          row.gitHead,
          row.codeHash,
        ].some(value => String(value ?? '').toLowerCase().includes(needle));
      })
  );
  const sortedLedger = $derived([...filteredLedger].sort((a, b) => compareRuns(a, b, sortKey)));
  const visibleLedger = $derived(sortedLedger.slice(0, visibleLimit));
  const passedCount = $derived(ledger.filter(row => row.status === 'passed').length);
  const failedCount = $derived(ledger.filter(row => row.status === 'failed').length);
  const benchmarkAlertCount = $derived(ledger.filter(row => row.benchmarkStatus === 'slower' || row.benchmarkStatus === 'mixed' || row.benchmarkStatus === 'failed').length);
  const browserAlertCount = $derived(ledger.filter(row => row.browserErrors > 0 || row.networkFailures > 0).length);

  function finiteSortValue(value: number | null | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  function runTimingValue(run: QaRunLedgerEntry, key: RunSortKey): number {
    if (key.startsWith('stack')) return finiteSortValue(run.durationMs, Number.POSITIVE_INFINITY);
    return finiteSortValue(run.timing?.playwrightMs, Number.POSITIVE_INFINITY);
  }

  function compareRuns(a: QaRunLedgerEntry, b: QaRunLedgerEntry, key: RunSortKey): number {
    if (key === 'date-asc') return a.createdAt - b.createdAt || a.runId.localeCompare(b.runId);
    if (key === 'date-desc') return b.createdAt - a.createdAt || b.runId.localeCompare(a.runId);
    const descending = key.endsWith('slow');
    const av = runTimingValue(a, key);
    const bv = runTimingValue(b, key);
    return descending ? bv - av || b.createdAt - a.createdAt : av - bv || b.createdAt - a.createdAt;
  }

  function shortHash(value: string | null | undefined): string {
    const raw = String(value || '').trim();
    return raw ? raw.slice(0, DISPLAY.SHORT_HASH_HEX_CHARS) : 'n/a';
  }

  function formatDate(timestamp: number | null | undefined): string {
    if (!timestamp) return 'n/a';
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return 'n/a';
    const p2 = (n: number): string => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
  }

  function formatMs(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
  }

  function formatBytes(bytes: number | null | undefined): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function formatPct(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
  }

  function statusLabel(status: QaRunLedgerEntry['status']): string {
    if (status === 'passed') return 'PASS';
    if (status === 'failed') return 'FAIL';
    return 'UNKNOWN';
  }

  function benchmarkLabel(status: QaBenchmarkStatus | null): string {
    if (!status) return 'n/a';
    if (status === 'insufficient') return 'NEW';
    return status.toUpperCase();
  }

  function resetWindow(): void {
    visibleLimit = QA.LEDGER_WINDOW_STEP;
  }

  async function loadRuns(): Promise<void> {
    loading = true;
    error = '';
    try {
      const response = await qaFetch('/api/qa/runs?limit=50', { cache: 'no-store' });
      const payload = await response.json() as {
        ok?: boolean;
        error?: string;
        qaAuth?: { disabled?: boolean; scope?: string };
        ledger?: QaRunLedgerEntry[];
      };
      if (!response.ok || payload.ok === false) throw new Error(payload.error || `QA runs HTTP ${response.status}`);
      qaAuthLabel = payload.qaAuth?.disabled ? 'open' : payload.qaAuth?.scope ?? 'locked';
      ledger = payload.ledger ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function saveToken(): void {
    writeQaToken(qaToken);
    void loadRuns();
  }

  onMount(() => {
    qaToken = consumeQaTokenFromUrl() || readQaToken();
    void loadRuns();
  });
</script>

<svelte:head>
  <title>Runs Ledger | xln</title>
  <meta name="description" content="xln unified run ledger across QA, benchmark, release, contract, unit, and scenario surfaces" />
</svelte:head>

<main class="runs-page">
  <section class="runs-hero">
    <div>
      <div class="eyebrow">Run Evidence</div>
      <h1>Runs Ledger</h1>
      <p>One operator ledger across unit, contract, e2e, scenario, benchmark, and release gates.</p>
    </div>
    <div class="auth-card" data-testid="runs-auth-panel">
      <span>qa auth</span>
      <strong>{qaAuthLabel}</strong>
      <div>
        <input bind:value={qaToken} type="password" autocomplete="off" placeholder="read token" />
        <button type="button" onclick={saveToken}>Apply</button>
      </div>
    </div>
  </section>

  <section class="summary-grid" data-testid="runs-summary">
    <article><span>Total</span><strong>{ledger.length}</strong></article>
    <article><span>Passed</span><strong>{passedCount}</strong></article>
    <article class:bad={failedCount > 0}><span>Failed</span><strong>{failedCount}</strong></article>
    <article class:warn={benchmarkAlertCount > 0}><span>Benchmark</span><strong>{benchmarkAlertCount}</strong></article>
    <article class:warn={browserAlertCount > 0}><span>Browser/Network</span><strong>{browserAlertCount}</strong></article>
  </section>

  <section class="ledger-panel" data-testid="runs-ledger">
    <div class="toolbar">
      <div class="filter-chips" data-testid="runs-category-filter">
        <button type="button" class:active={categoryFilter === 'all'} onclick={() => { categoryFilter = 'all'; resetWindow(); }}>all</button>
        {#each categoryOptions as category}
          <button type="button" class:active={categoryFilter === category} onclick={() => { categoryFilter = category; resetWindow(); }}>{category}</button>
        {/each}
      </div>
      <div class="controls">
        <input bind:value={query} oninput={resetWindow} placeholder="filter run, suite, owner, hash" data-testid="runs-search" />
        <select bind:value={sortKey} onchange={resetWindow} data-testid="runs-sort">
          <option value="date-desc">Newest</option>
          <option value="date-asc">Oldest</option>
          <option value="stack-fast">Stack fastest</option>
          <option value="stack-slow">Stack slowest</option>
          <option value="browser-fast">Browser fastest</option>
          <option value="browser-slow">Browser slowest</option>
        </select>
        <button type="button" onclick={loadRuns}>Refresh</button>
      </div>
    </div>

    {#if loading}
      <div class="empty">Loading runs...</div>
    {:else if error}
      <div class="error" data-testid="runs-error">{error}</div>
    {:else if visibleLedger.length === 0}
      <div class="empty">No runs match this filter</div>
    {:else}
      <div class="ledger-table">
        {#each visibleLedger as row}
          <article
            class:ok={row.status === 'passed'}
            class:bad={row.status === 'failed'}
            data-testid="runs-ledger-row"
            data-run-id={row.runId}
          >
            <strong>{statusLabel(row.status)}</strong>
            <span>{row.category}</span>
            <span title={row.suiteKey}>{row.suiteLabel}</span>
            <span>by {row.startedBy}</span>
            <span>{formatDate(row.createdAt)}</span>
            <span>{formatMs(row.durationMs)}</span>
            <span class:warn={row.failedShard !== null}>{row.failedShard ?? 'no failed shard'}</span>
            <span>artifacts {formatBytes(row.artifactBytes)}</span>
            <span class:warn={row.browserErrors > 0 || row.networkFailures > 0}>
              browser {row.browserErrors} err / {row.browserWarnings} warn / network {row.networkFailures}
            </span>
            <span>cpu {row.cpuPeakPct ?? 'n/a'}%</span>
            <span class:warn={row.benchmarkStatus === 'slower' || row.benchmarkStatus === 'mixed' || row.benchmarkStatus === 'failed'}>
              {benchmarkLabel(row.benchmarkStatus)} {formatPct(row.benchmarkDeltaPct)}
            </span>
            <code title={row.gitHead ?? ''}>head {shortHash(row.gitHead)}</code>
            <code title={row.codeHash ?? ''}>code {shortHash(row.codeHash)}</code>
            {#if row.auditAction}<em>{row.auditAction}</em>{/if}
            {#if row.dirty}<em>dirty</em>{/if}
            <a data-testid="runs-open-qa" href={`/qa?runId=${encodeURIComponent(row.runId)}`}>Open QA</a>
          </article>
        {/each}
      </div>

      {#if visibleLedger.length < sortedLedger.length}
        <button class="window-more" type="button" data-testid="runs-show-more" onclick={() => (visibleLimit += QA.LEDGER_WINDOW_STEP)}>
          Show {Math.min(QA.LEDGER_WINDOW_STEP, sortedLedger.length - visibleLedger.length)} more runs · {visibleLedger.length}/{sortedLedger.length}
        </button>
      {/if}
    {/if}
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #08090b;
    color: #f1efe7;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .runs-page {
    min-height: 100vh;
    padding: 1.2rem;
    display: grid;
    gap: 1rem;
  }

  .runs-hero,
  .summary-grid,
  .ledger-panel {
    width: min(1600px, 100%);
    margin: 0 auto;
  }

  .runs-hero {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.09);
    padding-bottom: 1rem;
  }

  .eyebrow {
    color: #d8af4f;
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    margin-top: 0.2rem;
    font-size: clamp(1.7rem, 2.4vw, 2.6rem);
    letter-spacing: 0;
  }

  p {
    margin-top: 0.35rem;
    color: #b7b2a4;
  }

  .auth-card,
  .summary-grid article,
  .ledger-panel {
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
  }

  .auth-card {
    min-width: min(360px, 100%);
    padding: 0.8rem;
    display: grid;
    gap: 0.5rem;
  }

  .auth-card span,
  .summary-grid span {
    color: #8f8b80;
    font-size: 0.72rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .auth-card strong {
    font-size: 1rem;
  }

  .auth-card div,
  .controls {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  input,
  select,
  button,
  a {
    min-height: 36px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.2);
    color: #f1efe7;
    font: inherit;
  }

  input,
  select {
    padding: 0 0.7rem;
  }

  button,
  a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.8rem;
    text-decoration: none;
    cursor: pointer;
  }

  button:hover,
  a:hover {
    border-color: rgba(216, 175, 79, 0.5);
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .summary-grid article {
    display: grid;
    gap: 0.25rem;
    padding: 0.8rem;
    border-left: 3px solid rgba(255, 255, 255, 0.12);
  }

  .summary-grid strong {
    font-size: 1.4rem;
  }

  .summary-grid article.bad {
    border-left-color: #ff7b72;
  }

  .summary-grid article.warn {
    border-left-color: #d8af4f;
  }

  .ledger-panel {
    padding: 1rem;
    display: grid;
    gap: 0.8rem;
  }

  .toolbar {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .filter-chips {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .filter-chips button {
    min-height: 32px;
    font-size: 0.8rem;
    text-transform: uppercase;
  }

  .filter-chips button.active {
    border-color: rgba(216, 175, 79, 0.62);
    background: rgba(216, 175, 79, 0.14);
  }

  .ledger-table {
    display: grid;
    gap: 0.55rem;
  }

  .ledger-table article {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    border-left: 3px solid #6b7280;
    border-radius: 8px;
    padding: 0.75rem;
    background: rgba(0, 0, 0, 0.2);
  }

  .ledger-table article.ok {
    border-left-color: #3fb950;
  }

  .ledger-table article.bad {
    border-left-color: #ff7b72;
  }

  .ledger-table span,
  .ledger-table strong,
  .ledger-table code,
  .ledger-table em {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .ledger-table code,
  .ledger-table em {
    color: #9ec2ff;
    font-style: normal;
  }

  .ledger-table .warn {
    color: #f1d48a;
  }

  .empty,
  .error {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 1rem;
    color: #b7b2a4;
    background: rgba(0, 0, 0, 0.18);
  }

  .error {
    color: #ffb1a6;
  }

  .window-more {
    justify-self: center;
  }

  @media (max-width: 900px) {
    .runs-hero {
      display: grid;
      align-items: start;
    }

    .summary-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
