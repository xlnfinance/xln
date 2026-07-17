<script lang="ts">
  import type { QaTestLedgerEntry } from '$lib/qa/types';
  import {
    filterQaTestLedger,
    sortQaTestLedger,
    summarizeQaTestLedger,
    type QaTestLedgerFilter,
    type QaTestLedgerSortDirection,
    type QaTestLedgerSortKey,
  } from '$lib/qa/testLedger';

  let { rows = [] }: { rows?: QaTestLedgerEntry[] } = $props();

  let filter = $state<QaTestLedgerFilter>('all');
  let sortKey = $state<QaTestLedgerSortKey>('last-run');
  let sortDirection = $state<QaTestLedgerSortDirection>('desc');

  const summary = $derived(summarizeQaTestLedger(rows));
  const visibleRows = $derived(sortQaTestLedger(filterQaTestLedger(rows, filter), sortKey, sortDirection));

  const filters: Array<{ value: QaTestLedgerFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'functional', label: 'Functional' },
    { value: 'resilience', label: 'Resilience' },
    { value: 'failed', label: 'Failed' },
  ];
  const columns: Array<{ key: QaTestLedgerSortKey; label: string }> = [
    { key: 'category', label: 'Category' },
    { key: 'test', label: 'Test' },
    { key: 'description', label: 'Description' },
    { key: 'status', label: 'Status' },
    { key: 'duration', label: 'Duration' },
    { key: 'last-run', label: 'Last run' },
  ];

  function setSort(nextKey: QaTestLedgerSortKey): void {
    if (sortKey === nextKey) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      return;
    }
    sortKey = nextKey;
    sortDirection = nextKey === 'duration' || nextKey === 'last-run' ? 'desc' : 'asc';
  }

  function ariaSort(key: QaTestLedgerSortKey): 'ascending' | 'descending' | 'none' {
    if (sortKey !== key) return 'none';
    return sortDirection === 'asc' ? 'ascending' : 'descending';
  }

  function formatDuration(value: number | null): string {
    if (value === null) return 'not run';
    if (value < 1_000) return `${Math.round(value)} ms`;
    if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1_000);
    return `${minutes}m ${seconds}s`;
  }

  function formatLastRun(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return 'not run';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }
</script>

<section class="test-ledger" data-testid="qa-test-ledger">
  <header class="ledger-head">
    <div>
      <span class="eyebrow">Playwright Test Ledger</span>
      <h2>Every browser test at a glance</h2>
    </div>
    <div class="summary" data-testid="qa-test-ledger-summary">
      <span><b>{summary.total.count}</b> total · {summary.total.failed} failed · {formatDuration(summary.total.durationMs)}</span>
      <span><b>{summary.functional.count}</b> functional · {summary.functional.failed} failed · {formatDuration(summary.functional.durationMs)}</span>
      <span><b>{summary.resilience.count}</b> resilience · {summary.resilience.failed} failed · {formatDuration(summary.resilience.durationMs)}</span>
    </div>
  </header>

  <div class="filter-row" data-testid="qa-test-ledger-filters">
    {#each filters as option}
      {@const count = option.value === 'all'
        ? summary.total.count
        : option.value === 'failed'
          ? summary.total.failed
          : summary[option.value].count}
      <button
        type="button"
        class:active={filter === option.value}
        aria-pressed={filter === option.value}
        onclick={() => (filter = option.value)}
      >
        {option.label} <span>{count}</span>
      </button>
    {/each}
  </div>

  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          {#each columns as column}
            <th aria-sort={ariaSort(column.key)}>
              <button type="button" onclick={() => setSort(column.key)} data-testid={`qa-test-sort-${column.key}`}>
                {column.label}
                <span aria-hidden="true">{sortKey === column.key ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
              </button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each visibleRows as row (row.testId)}
          <tr data-testid="qa-test-ledger-row" data-status={row.status} data-category={row.category}>
            <td><span class="category" class:unknown={row.category === 'unknown'}>{row.category}</span></td>
            <td class="test-name">
              <strong>{row.title}</strong>
              <small title={row.target}>{row.target}</small>
            </td>
            <td class="description">{row.description}</td>
            <td><span class="status" class:pass={row.status === 'passed'} class:fail={row.status === 'failed'}>{row.status}</span></td>
            <td class="numeric">{formatDuration(row.durationMs)}</td>
            <td class="last-run" title={`${row.lastRunId} · ${new Date(row.lastRunAt).toISOString()}`}>{formatLastRun(row.lastRunAt)}</td>
          </tr>
        {:else}
          <tr>
            <td class="empty" colspan="6">No {filter === 'all' ? '' : `${filter} `}tests recorded yet.</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  .test-ledger {
    display: grid;
    gap: 0.7rem;
    min-width: 0;
    border: 1px solid rgba(216, 175, 79, 0.2);
    border-radius: 10px;
    padding: 0.85rem;
    background: linear-gradient(135deg, rgba(216, 175, 79, 0.055), rgba(4, 5, 7, 0.72) 45%);
  }

  .ledger-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .eyebrow {
    color: #d8af4f;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0.18rem 0 0;
    color: #f1efe7;
    font-size: 1rem;
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.35rem;
  }

  .summary span {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    padding: 0.28rem 0.55rem;
    color: #a9a69c;
    background: rgba(0, 0, 0, 0.24);
    font-size: 0.7rem;
    white-space: nowrap;
  }

  .summary b { color: #f1efe7; }

  .filter-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .filter-row button {
    min-height: 30px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 999px;
    padding: 0 0.65rem;
    color: #aaa79e;
    background: rgba(255, 255, 255, 0.025);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }

  .filter-row button.active {
    border-color: rgba(216, 175, 79, 0.52);
    color: #f6d474;
    background: rgba(216, 175, 79, 0.11);
  }

  .filter-row span {
    margin-left: 0.25rem;
    color: #77756f;
  }

  .table-scroll {
    max-height: min(44vh, 520px);
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 7px;
  }

  table {
    width: 100%;
    min-width: 820px;
    border-collapse: collapse;
    table-layout: fixed;
    color: #d8d4c8;
    font-size: 0.74rem;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    background: #111214;
    text-align: left;
  }

  th:nth-child(1) { width: 105px; }
  th:nth-child(2) { width: 24%; }
  th:nth-child(3) { width: 30%; }
  th:nth-child(4) { width: 88px; }
  th:nth-child(5) { width: 84px; }
  th:nth-child(6) { width: 120px; }

  th button {
    width: 100%;
    min-height: 36px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.35rem;
    border: 0;
    padding: 0 0.65rem;
    color: #9b978a;
    background: transparent;
    font: inherit;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
  }

  th[aria-sort='ascending'] button,
  th[aria-sort='descending'] button { color: #f6d474; }

  td {
    min-width: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.045);
    padding: 0.48rem 0.65rem;
    vertical-align: middle;
    overflow-wrap: anywhere;
  }

  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: rgba(255, 255, 255, 0.025); }

  .test-name strong,
  .test-name small {
    display: block;
  }

  .test-name strong { color: #f1efe7; }
  .test-name small {
    margin-top: 0.12rem;
    overflow: hidden;
    color: #77756f;
    font-size: 0.66rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .description { color: #a9a69c; }
  .numeric,
  .last-run { white-space: nowrap; }

  .category,
  .status {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 0.18rem 0.42rem;
    color: #b9d2ff;
    background: rgba(83, 145, 255, 0.1);
    font-size: 0.64rem;
    font-weight: 700;
    text-transform: uppercase;
  }

  .category.unknown,
  .status { color: #aaa79e; background: rgba(255, 255, 255, 0.06); }
  .status.pass { color: #84e0a1; background: rgba(63, 185, 80, 0.12); }
  .status.fail { color: #ff9284; background: rgba(255, 91, 76, 0.12); }
  .empty { padding: 1.4rem; color: #77756f; text-align: center; }

  @media (max-width: 720px) {
    .test-ledger { padding: 0.7rem; }
    .ledger-head { align-items: stretch; flex-direction: column; }
    .summary { justify-content: flex-start; }
    .summary span { white-space: normal; }
    .table-scroll { max-height: 52vh; }
  }
</style>
