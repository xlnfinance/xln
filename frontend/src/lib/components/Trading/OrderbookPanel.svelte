<!--
  OrderbookPanel.svelte

  Displays a real-time orderbook from hub's orderbookExt state.
  Reads directly from env.eReplicas (side-channel pattern - no consensus needed for view data).

  Usage:
    <OrderbookPanel hubId="0x..." pairId="1/2" />
    <OrderbookPanel hubIds={["0x...", "0x..."]} pairId="1/2" />
-->
<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import type { Readable } from 'svelte/store';
  import { xlnEnvironment } from '$lib/stores/xlnStore';
  import { formatEntityId } from '$lib/utils/format';

  export let hubId: string = '';
  export let hubIds: string[] = [];
  export let pairId: string = '1/2';  // e.g., "1/2" for ETH/USDC
  export let depth: number = 10;
  export let showOwners: boolean = false;
  export let envStore: Readable<any> = xlnEnvironment;

  type BookSide = 'bid' | 'ask';
  type LevelClickDetail = { side: BookSide; price: number; size: number };
  type SnapshotDetail = {
    pairId: string;
    bids: Array<{ price: number; size: number; total: number }>;
    asks: Array<{ price: number; size: number; total: number }>;
    spread: number | null;
    spreadPercent: string;
    sourceCount: number;
    updatedAt: number;
  };
  type MarketSnapshotPayload = {
    hubEntityId: string;
    pairId: string;
    depth: number;
    bids: Array<{ price: number; size: number; total: number }>;
    asks: Array<{ price: number; size: number; total: number }>;
    spread: number | null;
    spreadPercent: string;
    updatedAt: number;
  };
  type MarketWsMessage = {
    type?: string;
    payload?: MarketSnapshotPayload;
  };
  const dispatch = createEventDispatcher<{ levelclick: LevelClickDetail; snapshot: SnapshotDetail }>();

  interface OrderLevel {
    price: number;
    size: number;
    total: number;
    owners?: string[];
  }

  let bids: OrderLevel[] = [];
  let asks: OrderLevel[] = [];
  let spread: number | null = null;
  let spreadPercent: string = '-';
  let lastUpdate = 0;
  let sourceCount = 0;
  let sourceLabel = 'None';

  let pollInterval: number | null = null;
  const POLL_MS = 200;  // 5 updates/sec

  let marketWs: WebSocket | null = null;
  let marketRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let marketWsClosing = false;
  let marketSubKey = '';
  let streamFreshUntil = 0;
  const STREAM_STALE_MS = 3000;
  const STREAM_RETRY_MS = 2000;
  const streamSnapshots = new Map<string, MarketSnapshotPayload>();

  function normalizePairId(value: string): string | null {
    const trimmed = String(value || '').trim();
    const match = trimmed.match(/^(\d+)\/(\d+)$/);
    if (!match) return null;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 || a === b) return null;
    const left = Math.min(a, b);
    const right = Math.max(a, b);
    return `${left}/${right}`;
  }

  function canonicalPairId(): string {
    return normalizePairId(pairId) || pairId;
  }

  function uniqueSourceHubIds(): string[] {
    const raw = hubIds.length > 0 ? hubIds : (hubId ? [hubId] : []);
    const normalized = raw
      .map((id) => String(id || '').trim().toLowerCase())
      .filter(Boolean);
    return Array.from(new Set(normalized));
  }

  function sourceLabelFor(sources: string[]): string {
    if (sources.length === 1) return `Hub: ${formatEntityId(sources[0] || '')}`;
    if (sources.length > 1) return `Sources: ${sources.length}`;
    return 'Sources: 0';
  }

  function relayWsUrl(): string | null {
    if (typeof window === 'undefined') return null;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/relay`;
  }

  function wsMessageId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  }

  function streamKey(hubEntityId: string, streamPairId: string): string {
    return `${hubEntityId}:${streamPairId}`;
  }

  function findHubReplica(env: any, sourceHubId: string): any | null {
    for (const [key, replica] of env.eReplicas || []) {
      if (String(key || '').toLowerCase().startsWith(sourceHubId + ':')) {
        return replica;
      }
    }
    return null;
  }

  function accumulateBookSide(
    book: any,
    side: 'bid' | 'ask',
    sideSizes: Map<number, number>,
    sideOwners: Map<number, Set<string>>
  ) {
    const { orderQtyLots, orderOwnerIdx, orderNext, orderActive, owners, params } = book;
    const { pmin, tick } = params || { pmin: 0, tick: 1 };
    const levelHead = side === 'bid' ? (book.levelHeadBid || []) : (book.levelHeadAsk || []);
    const bitmap = side === 'bid' ? (book.bitmapBid || []) : (book.bitmapAsk || []);
    const levels = Number(book.levels || 0);

    let idx = side === 'bid' ? Number(book.bestBidIdx ?? -1) : Number(book.bestAskIdx ?? -1);
    let visitedLevels = 0;
    const maxLevelsPerBook = Math.max(depth * 6, depth);

    while (idx !== -1 && visitedLevels < maxLevelsPerBook) {
      visitedLevels += 1;
      let headIdx = levelHead[idx];
      let levelSize = 0;
      const levelOwnerSet = new Set<string>();

      while (headIdx !== -1) {
        if (orderActive[headIdx]) {
          levelSize += Number(orderQtyLots[headIdx] || 0);
          if (showOwners) {
            levelOwnerSet.add(String(owners[orderOwnerIdx[headIdx]] || '?').slice(-4));
          }
        }
        headIdx = orderNext[headIdx];
      }

      if (levelSize > 0) {
        const price = Number(pmin) + idx * Number(tick);
        sideSizes.set(price, (sideSizes.get(price) || 0) + levelSize);
        if (showOwners) {
          const ownersSet = sideOwners.get(price) || new Set<string>();
          for (const owner of levelOwnerSet) ownersSet.add(owner);
          sideOwners.set(price, ownersSet);
        }
      }

      idx = side === 'bid'
        ? findPrevLevel(bitmap, idx - 1)
        : findNextLevel(bitmap, levels, idx + 1);
    }
  }

  function buildOrderLevels(
    sideSizes: Map<number, number>,
    sideOwners: Map<number, Set<string>>,
    side: 'bid' | 'ask'
  ): OrderLevel[] {
    const sorted = Array.from(sideSizes.entries())
      .sort((a, b) => side === 'bid' ? b[0] - a[0] : a[0] - b[0])
      .slice(0, depth);

    let cumulative = 0;
    return sorted.map(([price, size]) => {
      cumulative += size;
      const entry: OrderLevel = { price, size, total: cumulative };
      if (showOwners) {
        entry.owners = Array.from(sideOwners.get(price) || []);
      }
      return entry;
    });
  }

  function updateView(nextBids: OrderLevel[], nextAsks: OrderLevel[], pair: string, sources: string[]) {
    bids = nextBids;
    asks = nextAsks;
    sourceCount = sources.length;
    sourceLabel = sourceLabelFor(sources);
    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (bestBid && bestAsk) {
      spread = bestAsk.price - bestBid.price;
      spreadPercent = ((spread / bestAsk.price) * 100).toFixed(3);
    } else {
      spread = null;
      spreadPercent = '-';
    }
    lastUpdate = Date.now();
    dispatch('snapshot', {
      pairId: pair,
      bids: bids.map(level => ({ price: level.price, size: level.size, total: level.total })),
      asks: asks.map(level => ({ price: level.price, size: level.size, total: level.total })),
      spread,
      spreadPercent,
      sourceCount,
      updatedAt: lastUpdate,
    });
  }

  function applyStreamOrderbookIfFresh(sources: string[], pair: string): boolean {
    if (Date.now() > streamFreshUntil) return false;
    const bidSizes = new Map<number, number>();
    const askSizes = new Map<number, number>();
    const bidOwners = new Map<number, Set<string>>();
    const askOwners = new Map<number, Set<string>>();
    let found = 0;

    for (const sourceHubId of sources) {
      const snapshot = streamSnapshots.get(streamKey(sourceHubId, pair));
      if (!snapshot) continue;
      found += 1;
      for (const level of snapshot.bids || []) {
        const price = Number(level.price || 0);
        const size = Number(level.size || 0);
        if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
        bidSizes.set(price, (bidSizes.get(price) || 0) + size);
      }
      for (const level of snapshot.asks || []) {
        const price = Number(level.price || 0);
        const size = Number(level.size || 0);
        if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
        askSizes.set(price, (askSizes.get(price) || 0) + size);
      }
    }

    if (found === 0) return false;
    const nextBids = buildOrderLevels(bidSizes, bidOwners, 'bid');
    const nextAsks = buildOrderLevels(askSizes, askOwners, 'ask');
    updateView(nextBids, nextAsks, pair, sources);
    return true;
  }

  function extractOrderbook() {
    const sources = uniqueSourceHubIds();
    const pair = canonicalPairId();

    if (sources.length === 0) {
      updateView([], [], pair, []);
      return;
    }

    if (applyStreamOrderbookIfFresh(sources, pair)) {
      return;
    }

    const env = $envStore;
    if (!env) return;
    const bidSizes = new Map<number, number>();
    const askSizes = new Map<number, number>();
    const bidOwners = new Map<number, Set<string>>();
    const askOwners = new Map<number, Set<string>>();

    for (const sourceHubId of sources) {
      const hubReplica = findHubReplica(env, sourceHubId);
      const books = hubReplica?.state?.orderbookExt?.books;
      if (!(books instanceof Map)) continue;
      const book = books.get(pair);
      if (!book) continue;
      accumulateBookSide(book, 'bid', bidSizes, bidOwners);
      accumulateBookSide(book, 'ask', askSizes, askOwners);
    }

    const nextBids = buildOrderLevels(bidSizes, bidOwners, 'bid');
    const nextAsks = buildOrderLevels(askSizes, askOwners, 'ask');
    updateView(nextBids, nextAsks, pair, sources);
  }

  function findPrevLevel(bitmap: Uint32Array | number[], start: number): number {
    for (let i = start; i >= 0; i--) {
      const w = Math.floor(i / 32);
      const b = i & 31;
      if (bitmap[w] && (bitmap[w] & (1 << b))) return i;
    }
    return -1;
  }

  function findNextLevel(bitmap: Uint32Array | number[], levels: number, start: number): number {
    for (let i = start; i < levels; i++) {
      const w = Math.floor(i / 32);
      const b = i & 31;
      if (bitmap[w] && (bitmap[w] & (1 << b))) return i;
    }
    return -1;
  }

  function formatPrice(price: number): string {
    return price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function formatSize(size: number): string {
    if (size >= 1_000_000) return (size / 1_000_000).toFixed(2) + 'M';
    if (size >= 1_000) return (size / 1_000).toFixed(2) + 'K';
    return size.toString();
  }

  function emitLevelClick(side: BookSide, level: OrderLevel) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size)) return;
    dispatch('levelclick', {
      side,
      price: level.price,
      size: level.size,
    });
  }

  function sendMarketSubscribe(replace: boolean) {
    if (!marketWs || marketWs.readyState !== 1) return;
    const sources = uniqueSourceHubIds();
    const pair = canonicalPairId();
    if (sources.length === 0 || !normalizePairId(pair)) return;
    marketWs.send(JSON.stringify({
      type: 'market_subscribe',
      id: wsMessageId('market_sub'),
      replace,
      hubEntityIds: sources,
      pairs: [pair],
      depth,
    }));
    marketSubKey = `${pair}|${depth}|${sources.join(',')}`;
  }

  function connectMarketStream() {
    const url = relayWsUrl();
    if (!url) return;
    if (marketWs && (marketWs.readyState === 0 || marketWs.readyState === 1)) return;

    marketWsClosing = false;
    marketWs = new WebSocket(url);
    marketWs.onopen = () => {
      sendMarketSubscribe(true);
      marketWs?.send(JSON.stringify({ type: 'market_snapshot_request', id: wsMessageId('market_req') }));
    };
    marketWs.onmessage = (event: MessageEvent) => {
      let msg: MarketWsMessage;
      try {
        msg = JSON.parse(String(event.data || '{}')) as MarketWsMessage;
      } catch {
        return;
      }
      if (msg?.type !== 'market_snapshot') return;
      const payload = msg?.payload as MarketSnapshotPayload | undefined;
      const hubEntityId = payload?.hubEntityId ? String(payload.hubEntityId).toLowerCase() : '';
      const streamPairId = normalizePairId(String(payload?.pairId || ''));
      if (!hubEntityId || !streamPairId || !payload) return;
      streamSnapshots.set(streamKey(hubEntityId, streamPairId), {
        ...payload,
        hubEntityId,
        pairId: streamPairId,
      });
      streamFreshUntil = Date.now() + STREAM_STALE_MS;
      extractOrderbook();
    };
    marketWs.onclose = () => {
      marketWs = null;
      marketSubKey = '';
      streamFreshUntil = 0;
      if (marketWsClosing) return;
      if (marketRetryTimer) clearTimeout(marketRetryTimer);
      marketRetryTimer = setTimeout(() => {
        marketRetryTimer = null;
        connectMarketStream();
      }, STREAM_RETRY_MS);
    };
  }

  function disconnectMarketStream() {
    if (marketRetryTimer) {
      clearTimeout(marketRetryTimer);
      marketRetryTimer = null;
    }
    streamFreshUntil = 0;
    marketSubKey = '';
    streamSnapshots.clear();
    if (!marketWs) return;
    marketWsClosing = true;
    try {
      if (marketWs.readyState === 1) {
        marketWs.send(JSON.stringify({ type: 'market_unsubscribe', id: wsMessageId('market_unsub') }));
      }
      marketWs.close();
    } catch {
      // ignore
    }
    marketWs = null;
  }

  $: {
    const sources = uniqueSourceHubIds();
    const pair = canonicalPairId();
    const nextKey = `${pair}|${depth}|${sources.join(',')}`;
    if (typeof window !== 'undefined' && marketWs && marketWs.readyState === 1 && nextKey !== marketSubKey) {
      sendMarketSubscribe(true);
    }
  }

  // Max size for bar scaling
  $: maxBidSize = Math.max(...bids.map(b => b.size), 1);
  $: maxAskSize = Math.max(...asks.map(a => a.size), 1);
  $: maxSize = Math.max(maxBidSize, maxAskSize);

  onMount(() => {
    extractOrderbook();
    connectMarketStream();
    pollInterval = setInterval(extractOrderbook, POLL_MS) as unknown as number;
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
    disconnectMarketStream();
  });

  // React to hubId/pairId changes
  $: if (hubId || hubIds.length || pairId) extractOrderbook();
</script>

<div class="orderbook-panel">
  <div class="header">
    <span class="title">Order Book</span>
    <span class="pair">{pairId.replace('/', ' / ')}</span>
  </div>

  <div class="spread-row">
    <span class="spread-label">Spread</span>
    <span class="spread-value">{spread !== null ? formatPrice(spread) : '-'}</span>
    <span class="spread-percent">({spreadPercent}%)</span>
  </div>

  <div class="book-container">
    <!-- Asks (sells) - shown in reverse order, lowest ask at bottom -->
    <div class="asks-section">
      {#each [...asks].reverse() as ask, i}
        <div
          class="row ask-row clickable"
          role="button"
          tabindex="0"
          on:click={() => emitLevelClick('ask', ask)}
          on:keydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              emitLevelClick('ask', ask);
            }
          }}
        >
          <div class="bar ask-bar" style="width: {(ask.size / maxSize) * 100}%"></div>
          <span class="price ask-price">{formatPrice(ask.price)}</span>
          <span class="size">{formatSize(ask.size)}</span>
          <span class="total">{formatSize(ask.total)}</span>
          {#if showOwners && ask.owners}
            <span class="owners">{ask.owners.join(',')}</span>
          {/if}
        </div>
      {:else}
        <div class="empty-side">No asks</div>
      {/each}
    </div>

    <!-- Spread indicator -->
    <div class="spread-indicator">
      {#if spread !== null}
        <span class="mid-price">{formatPrice((bids[0]?.price || 0) + (spread / 2))}</span>
      {/if}
    </div>

    <!-- Bids (buys) -->
    <div class="bids-section">
      {#each bids as bid, i}
        <div
          class="row bid-row clickable"
          role="button"
          tabindex="0"
          on:click={() => emitLevelClick('bid', bid)}
          on:keydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              emitLevelClick('bid', bid);
            }
          }}
        >
          <div class="bar bid-bar" style="width: {(bid.size / maxSize) * 100}%"></div>
          <span class="price bid-price">{formatPrice(bid.price)}</span>
          <span class="size">{formatSize(bid.size)}</span>
          <span class="total">{formatSize(bid.total)}</span>
          {#if showOwners && bid.owners}
            <span class="owners">{bid.owners.join(',')}</span>
          {/if}
        </div>
      {:else}
        <div class="empty-side">No bids</div>
      {/each}
    </div>
  </div>

  <div class="footer">
    <span class="hub-label">{sourceLabel}</span>
    <span class="update-time">Updated: {new Date(lastUpdate).toLocaleTimeString()}</span>
  </div>
</div>

<style>
  .orderbook-panel {
    background: var(--bg-secondary, #1a1a2e);
    border: 1px solid var(--border-color, #333);
    border-radius: 8px;
    padding: 12px;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
    min-width: 280px;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border-color, #333);
  }

  .title {
    font-weight: 600;
    color: var(--text-primary, #fff);
  }

  .pair {
    color: var(--text-secondary, #888);
    font-size: 11px;
  }

  .spread-row {
    display: flex;
    justify-content: center;
    gap: 8px;
    padding: 4px 0;
    color: var(--text-secondary, #888);
    font-size: 11px;
  }

  .spread-value {
    color: var(--text-primary, #fff);
  }

  .book-container {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .asks-section, .bids-section {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .spread-indicator {
    display: flex;
    justify-content: center;
    padding: 6px 0;
    border-top: 1px solid var(--border-color, #333);
    border-bottom: 1px solid var(--border-color, #333);
    margin: 4px 0;
  }

  .mid-price {
    color: var(--text-primary, #fff);
    font-weight: 600;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 60px 50px;
    gap: 8px;
    padding: 3px 6px;
    position: relative;
    align-items: center;
  }

  .row.clickable {
    cursor: pointer;
    border-radius: 4px;
  }

  .row.clickable:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .row.clickable:focus-visible {
    outline: 1px solid rgba(251, 191, 36, 0.85);
    outline-offset: 1px;
    background: rgba(251, 191, 36, 0.08);
  }

  .bar {
    position: absolute;
    top: 0;
    bottom: 0;
    opacity: 0.15;
    pointer-events: none;
  }

  .bid-bar {
    background: #22c55e;
    right: 0;
  }

  .ask-bar {
    background: #ef4444;
    right: 0;
  }

  .price {
    font-weight: 500;
    z-index: 1;
  }

  .bid-price {
    color: #22c55e;
  }

  .ask-price {
    color: #ef4444;
  }

  .size, .total {
    text-align: right;
    color: var(--text-secondary, #888);
    z-index: 1;
  }

  .owners {
    font-size: 10px;
    color: var(--text-tertiary, #555);
  }

  .empty-side {
    text-align: center;
    color: var(--text-tertiary, #555);
    padding: 12px;
    font-style: italic;
  }

  .footer {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border-color, #333);
    font-size: 10px;
    color: var(--text-tertiary, #555);
  }
</style>
