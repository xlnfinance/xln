<script lang="ts">
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';
  import type {
    RuntimeAdapterActivityPage,
    RuntimeAdapterReadQuery,
    RuntimeActivityEvent,
  } from '@xln/runtime/xln-api';
  import { runtimeControllerHandle, runtimeAdapterHeight } from '$lib/stores/runtimeControllerStore';
  import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
  import {
    Calendar,
    ChevronLeft,
    ChevronRight,
    ChevronsDown,
    Filter,
    RefreshCw,
    Search,
  } from 'lucide-svelte';

  export let entityId: string;
  export let runtimeId: string | undefined = undefined;

  type ActivityKind = 'all' | 'onchain' | 'offchain';
  type ViewMode = 'paged' | 'infinite' | 'timeframe';

  type ActivityEvent = RuntimeActivityEvent;

  type ActivityResponse = RuntimeAdapterActivityPage & {
    partial?: boolean;
    failures?: Array<{ hub?: string; apiPort?: number; error?: string }>;
  };

  const typeOptions = [
    { id: 'payment', label: 'Payments' },
    { id: 'swap', label: 'Swaps' },
    { id: 'cross_swap', label: 'Cross-j' },
    { id: 'htlc', label: 'HTLC' },
    { id: 'settlement', label: 'Settlement' },
    { id: 'account', label: 'Accounts' },
    { id: 'j_event', label: 'J-events' },
    { id: 'j_batch', label: 'Batches' },
    { id: 'error', label: 'Errors' },
  ];

  let kind: ActivityKind = 'all';
  let mode: ViewMode = 'paged';
  let search = '';
  let selectedTypes: string[] = [];
  let pageSize = 80;
  let events: ActivityEvent[] = [];
  let loading = false;
  let error: string | null = null;
  let partialFailures: ActivityResponse['failures'] = [];
  let nextBeforeHeight: number | null = null;
  let latestHeight = 0;
  let scannedFrames = 0;
  let cursorStack: Array<number | null> = [null];
  let cursorIndex = 0;
  let fromLocal = '';
  let toLocal = '';
  let lastEntityId = '';
  let lastRuntimeKey = '';
  let mounted = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const normalizeEntityId = (value: string): string => value.trim().toLowerCase();
  const normalizeRuntimeId = (value: string | undefined): string => String(value || '').trim().toLowerCase();

  function semanticKey(event: ActivityEvent): string {
    const rawType = String(event.rawType || '');
    if (event.source === 'runtime_log' && rawType.startsWith('Htlc') && event.hash) {
      return [
        event.runtimeId || '',
        event.source,
        rawType,
        event.entityId || '',
        event.counterpartyId || '',
        event.direction,
        event.hash,
        event.amount || '',
        event.tokenId ?? '',
      ].join('|');
    }
    return event.id;
  }

  function dedupe(input: ActivityEvent[]): ActivityEvent[] {
    const byKey = new Map<string, ActivityEvent>();
    for (const event of input) {
      const key = semanticKey(event);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, event);
        continue;
      }

      const eventHappenedEarlier =
        event.timestamp < existing.timestamp ||
        (event.timestamp === existing.timestamp && event.height < existing.height);
      if (eventHappenedEarlier) byKey.set(key, event);
    }
    return Array.from(byKey.values()).sort((a, b) => b.timestamp - a.timestamp || b.height - a.height);
  }

  function localToTimestamp(value: string): number | undefined {
    if (!value) return undefined;
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : undefined;
  }

  function buildActivityQuery(beforeHeight: number | null): RuntimeAdapterReadQuery {
    const query: RuntimeAdapterReadQuery = {
      entityId: normalizeEntityId(entityId),
      kind,
      limit: pageSize,
      scanLimit: 100,
    };
    if (selectedTypes.length > 0) query.types = selectedTypes;
    if (search.trim()) query.q = search.trim();
    if (beforeHeight !== null) query.beforeHeight = beforeHeight;
    if (mode === 'timeframe') {
      const from = localToTimestamp(fromLocal);
      const to = localToTimestamp(toLocal);
      if (from !== undefined) query.fromTimestamp = from;
      if (to !== undefined) query.toTimestamp = to;
    }
    return query;
  }

  function activeRuntimeKey(): string {
    const handle = $runtimeControllerHandle;
    return normalizeRuntimeId(handle.runtimeId || handle.id);
  }

  function assertRequestedRuntimeActive(): void {
    const requested = normalizeRuntimeId(runtimeId);
    if (!requested) return;
    const active = activeRuntimeKey();
    if (!active || active === requested) return;
    throw new Error(`History is connected to runtime ${active}; select runtime ${requested} to inspect this entity.`);
  }

  async function readActivitySources(beforeHeight: number | null): Promise<ActivityResponse> {
    assertRequestedRuntimeActive();
    const body = await runtimeQueryClient.readActivity(buildActivityQuery(beforeHeight));
    return {
      ...body,
      failures: [],
    };
  }

  async function loadActivity(options: { append?: boolean; beforeHeight?: number | null } = {}): Promise<void> {
    const currentEntity = normalizeEntityId(entityId);
    if (!/^0x[0-9a-f]{64}$/.test(currentEntity)) return;
    loading = true;
    error = null;
    try {
      const body = await readActivitySources(options.beforeHeight ?? null);
      latestHeight = Number(body.latestHeight || 0);
      scannedFrames = Number(body.scannedFrames || 0);
      nextBeforeHeight = body.nextBeforeHeight ?? null;
      partialFailures = Array.isArray(body.failures) ? body.failures : [];
      const nextEvents = Array.isArray(body.events) ? body.events : [];
      events = options.append ? dedupe([...events, ...nextEvents]) : dedupe(nextEvents);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load activity history';
    } finally {
      loading = false;
    }
  }

  function resetAndLoad(): void {
    cursorStack = [null];
    cursorIndex = 0;
    events = [];
    void loadActivity();
  }

  function scheduleReload(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => resetAndLoad(), 250);
  }

  function toggleType(type: string): void {
    selectedTypes = selectedTypes.includes(type)
      ? selectedTypes.filter((item) => item !== type)
      : [...selectedTypes, type];
    resetAndLoad();
  }

  function clearFilters(): void {
    search = '';
    selectedTypes = [];
    fromLocal = '';
    toLocal = '';
    resetAndLoad();
  }

  function goOlderPage(): void {
    if (nextBeforeHeight === null || loading) return;
    const nextCursor = nextBeforeHeight;
    if (cursorIndex === cursorStack.length - 1) cursorStack = [...cursorStack, nextCursor];
    cursorIndex += 1;
    void loadActivity({ beforeHeight: nextCursor });
  }

  function goNewerPage(): void {
    if (cursorIndex <= 0 || loading) return;
    cursorIndex -= 1;
    void loadActivity({ beforeHeight: cursorStack[cursorIndex] ?? null });
  }

  function loadMore(): void {
    if (nextBeforeHeight === null || loading) return;
    void loadActivity({ append: true, beforeHeight: nextBeforeHeight });
  }

  function setKind(next: ActivityKind): void {
    kind = next;
    resetAndLoad();
  }

  function setMode(next: ViewMode): void {
    mode = next;
    resetAndLoad();
  }

  function formatTimestamp(timestamp: number): string {
    if (!timestamp) return 'No timestamp';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  }

  function shortId(value: string | undefined): string {
    const normalized = String(value || '').toLowerCase();
    return normalized.length > 14 ? `${normalized.slice(0, 6)}...${normalized.slice(-4)}` : normalized || 'n/a';
  }

  function formatAmount(value: string | undefined): string {
    if (!value) return '';
    try {
      const raw = BigInt(value);
      const sign = raw < 0n ? '-' : '';
      const abs = raw < 0n ? -raw : raw;
      const base = 10n ** 18n;
      if (abs < base) return `${sign}${abs.toString()}`;
      const whole = abs / base;
      const fraction = (abs % base).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
      return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
    } catch {
      return value;
    }
  }

  function eventTone(event: ActivityEvent): string {
    if (event.status === 'error' || event.type === 'error') return 'danger';
    if (event.kind === 'onchain') return 'chain';
    if (event.type === 'payment') return event.direction === 'in' ? 'in' : 'out';
    if (event.type === 'cross_swap') return 'cross';
    if (event.type === 'swap') return 'swap';
    return 'neutral';
  }

  function directionLabel(event: ActivityEvent): string {
    if (event.direction === 'in') return 'Incoming';
    if (event.direction === 'out') return 'Outgoing';
    return event.kind === 'onchain' ? 'On-chain' : 'Activity';
  }

  $: if (browser && mounted && entityId && entityId !== lastEntityId) {
    lastEntityId = entityId;
    resetAndLoad();
  }

  $: {
    const key = `${activeRuntimeKey()}:${Math.max(0, Math.floor(Number($runtimeAdapterHeight || 0)))}`;
    if (browser && mounted && key !== lastRuntimeKey) {
      lastRuntimeKey = key;
      resetAndLoad();
    }
  }

  onMount(() => {
    mounted = true;
    lastRuntimeKey = `${activeRuntimeKey()}:${Math.max(0, Math.floor(Number($runtimeAdapterHeight || 0)))}`;
    resetAndLoad();
    return () => {
      mounted = false;
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });
</script>

<section class="history-shell" data-testid="entity-history-panel">
  <div class="history-header">
    <div>
      <p class="eyebrow">Entity history</p>
      <h2>Activity</h2>
    </div>
    <button class="icon-button" type="button" onclick={() => loadActivity({ beforeHeight: cursorStack[cursorIndex] ?? null })} disabled={loading} title="Refresh history" data-testid="history-refresh">
      <RefreshCw size={17} />
    </button>
  </div>

  <div class="summary-strip">
    <div>
      <span class="summary-label">Runtime height</span>
      <strong>{latestHeight || 'n/a'}</strong>
    </div>
    <div>
      <span class="summary-label">Loaded</span>
      <strong>{events.length}</strong>
    </div>
    <div>
      <span class="summary-label">Scanned</span>
      <strong>{scannedFrames}</strong>
    </div>
  </div>

  <div class="segmented" aria-label="History type">
    <button type="button" class:active={kind === 'all'} onclick={() => setKind('all')} data-testid="history-kind-all">All</button>
    <button type="button" class:active={kind === 'offchain'} onclick={() => setKind('offchain')} data-testid="history-kind-offchain">Off-chain</button>
    <button type="button" class:active={kind === 'onchain'} onclick={() => setKind('onchain')} data-testid="history-kind-onchain">On-chain</button>
  </div>

  <div class="controls">
    <label class="search-field">
      <Search size={15} />
      <input bind:value={search} oninput={scheduleReload} placeholder="Search title, order, counterparty" data-testid="history-search" />
    </label>
    <label class="select-field">
      <Filter size={15} />
      <select bind:value={pageSize} onchange={resetAndLoad} data-testid="history-page-size">
        <option value={40}>40</option>
        <option value={80}>80</option>
        <option value={160}>160</option>
      </select>
    </label>
  </div>

  <div class="mode-tabs" aria-label="History mode">
    <button type="button" class:active={mode === 'paged'} onclick={() => setMode('paged')} data-testid="history-mode-paged">Pagination</button>
    <button type="button" class:active={mode === 'infinite'} onclick={() => setMode('infinite')} data-testid="history-mode-infinite">Infinite</button>
    <button type="button" class:active={mode === 'timeframe'} onclick={() => setMode('timeframe')} data-testid="history-mode-timeframe">Timeframe</button>
  </div>

  {#if mode === 'timeframe'}
    <div class="timeframe">
      <label>
        <Calendar size={15} />
        <span>From</span>
        <input type="datetime-local" bind:value={fromLocal} data-testid="history-from" />
      </label>
      <label>
        <Calendar size={15} />
        <span>To</span>
        <input type="datetime-local" bind:value={toLocal} data-testid="history-to" />
      </label>
      <button type="button" onclick={resetAndLoad} data-testid="history-apply-timeframe">Apply</button>
    </div>
  {/if}

  <div class="type-filter" aria-label="Activity filters">
    {#each typeOptions as option}
      <button
        type="button"
        class:active={selectedTypes.includes(option.id)}
        onclick={() => toggleType(option.id)}
        data-testid={`history-type-${option.id}`}
      >
        {option.label}
      </button>
    {/each}
    {#if selectedTypes.length > 0 || search || fromLocal || toLocal}
      <button class="clear" type="button" onclick={clearFilters} data-testid="history-clear-filters">Clear</button>
    {/if}
  </div>

  {#if partialFailures?.length}
    <div class="notice">Partial history: {partialFailures.length} runtime{partialFailures.length === 1 ? '' : 's'} did not answer.</div>
  {/if}
  {#if error}
    <div class="notice error">{error}</div>
  {/if}

  <div class="activity-list" class:loading={loading && events.length === 0}>
    {#if loading && events.length === 0}
      {#each Array.from({ length: 5 }) as _}
        <div class="skeleton"></div>
      {/each}
    {:else if events.length === 0}
      <div class="empty-state">
        <strong>No history in this window</strong>
        <span>Try fewer filters or load an older frame window.</span>
      </div>
    {:else}
      {#each events as event (event.id)}
        <article class="activity-row tone-{eventTone(event)}" data-testid="entity-history-event">
          <div class="rail">
            <div class="dot"></div>
            <div class="line"></div>
          </div>
          <div class="event-main">
            <div class="event-top">
              <div>
                <div class="event-title">{event.title}</div>
                <div class="event-subtitle">{event.subtitle}</div>
              </div>
              <div class="event-time">{formatTimestamp(event.timestamp)}</div>
            </div>
            <div class="event-meta">
              <span>{directionLabel(event)}</span>
              <span>{event.kind}</span>
              <span>{event.type}</span>
              <span>R#{event.height}</span>
              {#if event.counterpartyId}<span>{shortId(event.counterpartyId)}</span>{/if}
              {#if event.orderId}<span>order {event.orderId.slice(0, 10)}</span>{/if}
            </div>
          </div>
          <div class="event-amount">
            {#if event.amount}
              <strong data-testid="history-event-amount">{formatAmount(event.amount)}</strong>
              <span>token {event.tokenId ?? '?'}</span>
            {:else if event.quoteAmount}
              <strong data-testid="history-event-amount">{formatAmount(event.quoteAmount)}</strong>
              <span>token {event.quoteTokenId ?? '?'}</span>
            {:else}
              <strong data-testid="history-event-amount">{event.status}</strong>
              <span>{event.source}</span>
            {/if}
          </div>
        </article>
      {/each}
    {/if}
  </div>

  <div class="pager">
    {#if mode === 'paged'}
      <button type="button" onclick={goNewerPage} disabled={cursorIndex <= 0 || loading} data-testid="history-newer-page">
        <ChevronLeft size={16} />
        Newer
      </button>
      <span>Page {cursorIndex + 1}</span>
      <button type="button" onclick={goOlderPage} disabled={nextBeforeHeight === null || loading} data-testid="history-older-page">
        Older
        <ChevronRight size={16} />
      </button>
    {:else}
      <button type="button" onclick={loadMore} disabled={nextBeforeHeight === null || loading} data-testid="history-load-older">
        <ChevronsDown size={16} />
        {loading ? 'Loading' : 'Load older'}
      </button>
      <span>{nextBeforeHeight === null ? 'End of retained history' : `Next before R#${nextBeforeHeight}`}</span>
    {/if}
  </div>
</section>

<style>
  .history-shell {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .eyebrow {
    margin: 0 0 3px 0;
    color: #7d8a9d;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .08em;
  }

  h2 {
    margin: 0;
    color: #edf3fb;
    font-size: 22px;
    line-height: 1.1;
  }

  button,
  input,
  select {
    font: inherit;
  }

  button {
    min-height: 36px;
    border: 1px solid #283546;
    background: #101925;
    color: #cfdae9;
    border-radius: 8px;
    padding: 0 11px;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: #3a4b61;
    background: #152131;
  }

  button:disabled {
    opacity: .45;
    cursor: not-allowed;
  }

  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid #6fb6ff;
    outline-offset: 2px;
  }

  .icon-button {
    width: 38px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .summary-strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border: 1px solid #1d2937;
    border-radius: 8px;
    overflow: hidden;
    background: #0a1119;
  }

  .summary-strip > div {
    padding: 10px 12px;
    border-right: 1px solid #1d2937;
  }

  .summary-strip > div:last-child {
    border-right: 0;
  }

  .summary-label {
    display: block;
    color: #738296;
    font-size: 11px;
    margin-bottom: 4px;
  }

  .summary-strip strong {
    color: #edf3fb;
    font-size: 16px;
    font-variant-numeric: tabular-nums;
  }

  .segmented,
  .mode-tabs,
  .type-filter {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .segmented button,
  .mode-tabs button,
  .type-filter button {
    min-height: 34px;
    font-size: 12px;
  }

  .segmented button.active,
  .mode-tabs button.active,
  .type-filter button.active {
    border-color: #6fb6ff;
    background: #112b3f;
    color: #e7f4ff;
  }

  .type-filter .clear {
    color: #f4c6ce;
    border-color: #56313b;
    background: #241019;
  }

  .controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 118px;
    gap: 8px;
  }

  .search-field,
  .select-field,
  .timeframe label {
    height: 38px;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid #263442;
    background: #090f16;
    border-radius: 8px;
    padding: 0 10px;
    color: #7d8da2;
  }

  .search-field input,
  .select-field select,
  .timeframe input {
    width: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    color: #d9e4f2;
    min-width: 0;
  }

  .timeframe {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 8px;
  }

  .timeframe span {
    color: #7d8da2;
    font-size: 12px;
  }

  .notice {
    border: 1px solid #4a3d1e;
    background: #1c170a;
    color: #e4c46d;
    border-radius: 8px;
    padding: 9px 11px;
    font-size: 12px;
  }

  .notice.error {
    border-color: #5b2630;
    background: #240e15;
    color: #ffa7b4;
  }

  .activity-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 180px;
  }

  .activity-row {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) minmax(104px, auto);
    gap: 12px;
    border: 1px solid #1e2a38;
    background: #0b121b;
    border-radius: 8px;
    padding: 12px;
  }

  .rail {
    position: relative;
    display: flex;
    justify-content: center;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #8190a4;
    margin-top: 4px;
    z-index: 1;
  }

  .line {
    position: absolute;
    top: 18px;
    bottom: -18px;
    width: 1px;
    background: #1f2b3a;
  }

  .activity-row:last-child .line {
    display: none;
  }

  .tone-in .dot { background: #46d28f; }
  .tone-out .dot { background: #ffb35b; }
  .tone-chain .dot { background: #69a7ff; }
  .tone-cross .dot { background: #d8b4fe; }
  .tone-swap .dot { background: #5eead4; }
  .tone-danger .dot { background: #ff6177; }

  .event-main {
    min-width: 0;
  }

  .event-top {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }

  .event-title {
    color: #ecf3fb;
    font-weight: 700;
    font-size: 14px;
  }

  .event-subtitle {
    color: #8d9caf;
    font-size: 12px;
    margin-top: 3px;
    overflow-wrap: anywhere;
  }

  .event-time {
    color: #79889b;
    font-size: 11px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .event-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 8px;
  }

  .event-meta span {
    border: 1px solid #263442;
    border-radius: 999px;
    padding: 2px 7px;
    color: #94a3b8;
    background: #0f1722;
    font-size: 11px;
  }

  .event-amount {
    text-align: right;
    min-width: 104px;
    font-variant-numeric: tabular-nums;
  }

  .event-amount strong {
    display: block;
    color: #f1f6fd;
    font-size: 14px;
    overflow-wrap: anywhere;
  }

  .event-amount span {
    display: block;
    color: #79889b;
    font-size: 11px;
    margin-top: 3px;
  }

  .empty-state {
    min-height: 180px;
    border: 1px dashed #283749;
    border-radius: 8px;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 6px;
    color: #8796aa;
    text-align: center;
  }

  .empty-state strong {
    color: #d8e2ef;
  }

  .skeleton {
    height: 72px;
    border-radius: 8px;
    background: linear-gradient(90deg, #0c131d, #121d2a, #0c131d);
    background-size: 180% 100%;
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    from { background-position: 100% 0; }
    to { background-position: -100% 0; }
  }

  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: #7c8ba0;
    font-size: 12px;
  }

  .pager button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  @media (max-width: 720px) {
    .controls,
    .timeframe {
      grid-template-columns: 1fr;
    }

    .summary-strip {
      grid-template-columns: 1fr;
    }

    .summary-strip > div {
      border-right: 0;
      border-bottom: 1px solid #1d2937;
    }

    .summary-strip > div:last-child {
      border-bottom: 0;
    }

    .activity-row {
      grid-template-columns: 16px minmax(0, 1fr);
    }

    .event-amount {
      grid-column: 2;
      text-align: left;
      min-width: 0;
    }

    .event-top {
      flex-direction: column;
      gap: 4px;
    }

    .event-time {
      white-space: normal;
    }
  }
</style>
