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
  export let pairLabel: string = '';
  export let depth: number = 10;
  export let showOwners: boolean = false;
  export let showSources: boolean = false;
  export let sourceLabels: Record<string, string> = {};
  export let sourceAvatars: Record<string, string> = {};
  export let compactHeader: boolean = false;
  export let priceScale: number = 1;
  export let sizeDisplayScale: number = 1;
  export let preferredClickSide: BookSide = 'ask';
  export let envStore: Readable<any> = xlnEnvironment;

  type BookSide = 'bid' | 'ask';
  type LevelClickDetail = { side: BookSide; priceTicks: string; displayPrice: string; size: number; accountIds: string[] };
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
    hubUpdatedAt?: number;
    updatedAt: number;
  };
  type MarketWsMessage = {
    type?: string;
    payload?: MarketSnapshotPayload;
  };
  const dispatch = createEventDispatcher<{ levelclick: LevelClickDetail; snapshot: SnapshotDetail }>();
  const MAX_SAFE_TICKS = Number.MAX_SAFE_INTEGER;

  interface OrderLevel {
    // Price is in integer ticks and intentionally stored as JS number.
    // Assumption: price ticks stay within MAX_SAFE_TICKS (2^53 - 1).
    price: number;
    size: number;
    total: number;
    owners?: string[];
    accountIds?: string[];
  }
  interface RawSourceLevel {
    price: number;
    size: number;
    sourceId: string;
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
  const POLL_MS = 1000;

  let marketWs: WebSocket | null = null;
  let marketRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let marketWsClosing = false;
  let marketSubKey = '';
  let streamFreshUntil = 0;
  const STREAM_STALE_MS = 3000;
  const STREAM_RETRY_MS = 2000;
  const streamSnapshots = new Map<string, MarketSnapshotPayload>();
  const PRICE_STEP_OPTIONS = ['0.0001', '0.001', '0.01', '0.1', '1', '10', '50', '100'] as const;
  const PRICE_STEP_STORAGE_KEY = 'xln.orderbook.price-step-overrides.v1';
  let selectedPriceStep = '1';
  let priceStepOverrides: Record<string, string> = {};

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

  function loadPriceStepOverrides(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(PRICE_STEP_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return;
      const next: Record<string, string> = {};
      for (const [pair, step] of Object.entries(parsed)) {
        if (!normalizePairId(pair)) continue;
        const stepStr = String(step || '');
        if (PRICE_STEP_OPTIONS.includes(stepStr as (typeof PRICE_STEP_OPTIONS)[number])) {
          next[pair] = stepStr;
        }
      }
      priceStepOverrides = next;
    } catch {
      priceStepOverrides = {};
    }
  }

  function savePriceStepOverrides(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PRICE_STEP_STORAGE_KEY, JSON.stringify(priceStepOverrides));
    } catch {
      // ignore storage errors
    }
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

  function toSafePriceTicks(value: unknown): number | null {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (!Number.isInteger(n)) return null;
    if (Math.abs(n) > MAX_SAFE_TICKS) return null;
    return n;
  }

  function wsMessageId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  }

  function formatUpdatedAt(timestampMs: number): string {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '--:--:--.---';
    const d = new Date(timestampMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const mss = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${mss}`;
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
    sourceHubId: string,
    side: 'bid' | 'ask',
    sideSizes: Map<number, number>,
    sideOwners: Map<number, Set<string>>,
    sideSources: Map<number, Set<string>>,
    rawLevels?: RawSourceLevel[],
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
        const price = toSafePriceTicks(Number(pmin) + idx * Number(tick));
        if (price === null) {
          continue;
        }
        sideSizes.set(price, (sideSizes.get(price) || 0) + levelSize);
        if (showOwners) {
          const ownersSet = sideOwners.get(price) || new Set<string>();
          for (const owner of levelOwnerSet) ownersSet.add(owner);
          sideOwners.set(price, ownersSet);
        }
        const sourcesSet = sideSources.get(price) || new Set<string>();
        sourcesSet.add(sourceHubId);
        sideSources.set(price, sourcesSet);
        rawLevels?.push({
          price,
          size: levelSize,
          sourceId: sourceHubId,
          owners: showOwners ? Array.from(levelOwnerSet) : undefined,
        });
      }

      idx = side === 'bid'
        ? findPrevLevel(bitmap, idx - 1)
        : findNextLevel(bitmap, levels, idx + 1);
    }
  }

  function buildOrderLevels(
    sideSizes: Map<number, number>,
    sideOwners: Map<number, Set<string>>,
    sideSources: Map<number, Set<string>>,
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
      entry.accountIds = Array.from(sideSources.get(price) || []);
      return entry;
    });
  }

  function buildSourceSpecificLevels(levels: RawSourceLevel[], side: 'bid' | 'ask'): OrderLevel[] {
    const sorted = [...levels]
      .sort((a, b) => {
        if (side === 'bid') {
          if (b.price !== a.price) return b.price - a.price;
        } else if (a.price !== b.price) {
          return a.price - b.price;
        }
        return a.sourceId.localeCompare(b.sourceId);
      })
      .slice(0, depth);

    let cumulative = 0;
    return sorted.map((level) => {
      cumulative += level.size;
      return {
        price: level.price,
        size: level.size,
        total: cumulative,
        owners: level.owners,
        accountIds: [level.sourceId],
      };
    });
  }

  function getSelectedPriceStepTicks(): number {
    const scale = Number.isFinite(priceScale) && priceScale > 0 ? priceScale : 1;
    const selected = Number(selectedPriceStep);
    const stepDisplay = Number.isFinite(selected) && selected > 0 ? selected : 1;
    return Math.max(1, Math.round(stepDisplay * scale));
  }

  function getBestPrice(sideSizes: Map<number, number>, side: 'bid' | 'ask'): number | null {
    let best: number | null = null;
    for (const [price, size] of sideSizes.entries()) {
      if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
      if (best === null) best = price;
      else if (side === 'bid') best = Math.max(best, price);
      else best = Math.min(best, price);
    }
    return best;
  }

  function computeSmartStep(rawBestBid: number | null, rawBestAsk: number | null): string {
    const numericSteps = PRICE_STEP_OPTIONS.map(Number);
    if (canonicalPairId() === '1/3') {
      return '0.0001';
    }
    if (!Number.isFinite(rawBestBid || NaN) || !Number.isFinite(rawBestAsk || NaN) || !rawBestBid || !rawBestAsk || rawBestAsk <= rawBestBid) {
      return '1';
    }
    const scale = Number.isFinite(priceScale) && priceScale > 0 ? priceScale : 1;
    const spreadDisplay = (rawBestAsk - rawBestBid) / scale;
    const midDisplay = ((rawBestAsk + rawBestBid) / 2) / scale;

    let smart = midDisplay >= 1000 ? 1 : midDisplay >= 100 ? 0.1 : 0.01;
    smart = Math.max(numericSteps[0] || 0.01, smart);

    // Keep visible spread density roughly in a readable range.
    let ratio = spreadDisplay / smart;
    while (ratio < 3) {
      const lower = numericSteps.filter(v => v < smart).pop();
      if (!lower) break;
      smart = lower;
      ratio = spreadDisplay / smart;
    }
    while (ratio > 100) {
      const higher = numericSteps.find(v => v > smart);
      if (!higher) break;
      smart = higher;
      ratio = spreadDisplay / smart;
    }

    const fallback = String(smart);
    return PRICE_STEP_OPTIONS.includes(fallback as (typeof PRICE_STEP_OPTIONS)[number]) ? fallback : '1';
  }

  function applySmartOrSavedStep(rawBestBid: number | null, rawBestAsk: number | null): void {
    const pair = canonicalPairId();
    const saved = priceStepOverrides[pair];
    const next = saved && PRICE_STEP_OPTIONS.includes(saved as (typeof PRICE_STEP_OPTIONS)[number])
      ? saved
      : computeSmartStep(rawBestBid, rawBestAsk);
    if (selectedPriceStep !== next) {
      selectedPriceStep = next;
    }
  }

  function aggregateSideLevels(
    sideSizes: Map<number, number>,
    sideOwners: Map<number, Set<string>>,
    sideSources: Map<number, Set<string>>,
    side: 'bid' | 'ask',
  ): { sizes: Map<number, number>; owners: Map<number, Set<string>>; sources: Map<number, Set<string>> } {
    const stepTicks = getSelectedPriceStepTicks();
    if (stepTicks <= 1) {
      return { sizes: sideSizes, owners: sideOwners, sources: sideSources };
    }

    const aggregatedSizes = new Map<number, number>();
    const aggregatedOwners = new Map<number, Set<string>>();
    const aggregatedSources = new Map<number, Set<string>>();

    for (const [price, size] of sideSizes.entries()) {
      const bucketPrice = side === 'bid'
        ? Math.floor(price / stepTicks) * stepTicks
        : Math.ceil(price / stepTicks) * stepTicks;
      aggregatedSizes.set(bucketPrice, (aggregatedSizes.get(bucketPrice) || 0) + size);
      if (showOwners) {
        const srcOwners = sideOwners.get(price);
        if (srcOwners && srcOwners.size > 0) {
          const dstOwners = aggregatedOwners.get(bucketPrice) || new Set<string>();
          for (const owner of srcOwners) dstOwners.add(owner);
          aggregatedOwners.set(bucketPrice, dstOwners);
        }
      }
      const srcSources = sideSources.get(price);
      if (srcSources && srcSources.size > 0) {
        const dstSources = aggregatedSources.get(bucketPrice) || new Set<string>();
        for (const source of srcSources) dstSources.add(source);
        aggregatedSources.set(bucketPrice, dstSources);
      }
    }

    return { sizes: aggregatedSizes, owners: aggregatedOwners, sources: aggregatedSources };
  }

  function updateView(
    nextBids: OrderLevel[],
    nextAsks: OrderLevel[],
    pair: string,
    sources: string[],
    updatedAtOverride?: number,
  ) {
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
    const preferredTimestamp = Number(updatedAtOverride || 0);
    lastUpdate = Number.isFinite(preferredTimestamp) && preferredTimestamp > 0
      ? preferredTimestamp
      : Date.now();
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
    const bidSources = new Map<number, Set<string>>();
    const askSources = new Map<number, Set<string>>();
    const rawBidLevels: RawSourceLevel[] = [];
    const rawAskLevels: RawSourceLevel[] = [];
    let found = 0;
    let hasAnyLevel = false;
    let newestHubUpdate = 0;

    for (const sourceHubId of sources) {
      const snapshot = streamSnapshots.get(streamKey(sourceHubId, pair));
      if (!snapshot) continue;
      found += 1;
      const hubUpdatedAt = Number(snapshot.hubUpdatedAt || snapshot.updatedAt || 0);
      if (Number.isFinite(hubUpdatedAt) && hubUpdatedAt > newestHubUpdate) {
        newestHubUpdate = hubUpdatedAt;
      }
      for (const level of snapshot.bids || []) {
        const price = toSafePriceTicks(level.price);
        const size = Number(level.size || 0);
        if (price === null || !Number.isFinite(size) || size <= 0) continue;
        hasAnyLevel = true;
        rawBidLevels.push({ price, size, sourceId: sourceHubId });
        bidSizes.set(price, (bidSizes.get(price) || 0) + size);
        const sourcesSet = bidSources.get(price) || new Set<string>();
        sourcesSet.add(sourceHubId);
        bidSources.set(price, sourcesSet);
      }
      for (const level of snapshot.asks || []) {
        const price = toSafePriceTicks(level.price);
        const size = Number(level.size || 0);
        if (price === null || !Number.isFinite(size) || size <= 0) continue;
        hasAnyLevel = true;
        rawAskLevels.push({ price, size, sourceId: sourceHubId });
        askSizes.set(price, (askSizes.get(price) || 0) + size);
        const sourcesSet = askSources.get(price) || new Set<string>();
        sourcesSet.add(sourceHubId);
        askSources.set(price, sourcesSet);
      }
    }

    if (found === 0) return false;
    if (!hasAnyLevel) return false;
    applySmartOrSavedStep(getBestPrice(bidSizes, 'bid'), getBestPrice(askSizes, 'ask'));
    const aggregatedBids = aggregateSideLevels(bidSizes, bidOwners, bidSources, 'bid');
    const aggregatedAsks = aggregateSideLevels(askSizes, askOwners, askSources, 'ask');
    const useSourceSpecificRows = showSources;
    const nextBids = useSourceSpecificRows
      ? buildSourceSpecificLevels(rawBidLevels, 'bid')
      : buildOrderLevels(aggregatedBids.sizes, aggregatedBids.owners, aggregatedBids.sources, 'bid');
    const nextAsks = useSourceSpecificRows
      ? buildSourceSpecificLevels(rawAskLevels, 'ask')
      : buildOrderLevels(aggregatedAsks.sizes, aggregatedAsks.owners, aggregatedAsks.sources, 'ask');
    updateView(nextBids, nextAsks, pair, sources, newestHubUpdate);
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
    const bidSources = new Map<number, Set<string>>();
    const askSources = new Map<number, Set<string>>();
    const rawBidLevels: RawSourceLevel[] = [];
    const rawAskLevels: RawSourceLevel[] = [];
    let newestHubUpdate = 0;

    for (const sourceHubId of sources) {
      const hubReplica = findHubReplica(env, sourceHubId);
      const books = hubReplica?.state?.orderbookExt?.books;
      if (!(books instanceof Map)) continue;
      const book = books.get(pair);
      if (!book) continue;
      const hubUpdatedAt = Number(hubReplica?.state?.timestamp || 0);
      if (Number.isFinite(hubUpdatedAt) && hubUpdatedAt > newestHubUpdate) {
        newestHubUpdate = hubUpdatedAt;
      }
      accumulateBookSide(book, sourceHubId, 'bid', bidSizes, bidOwners, bidSources, rawBidLevels);
      accumulateBookSide(book, sourceHubId, 'ask', askSizes, askOwners, askSources, rawAskLevels);
    }

    applySmartOrSavedStep(getBestPrice(bidSizes, 'bid'), getBestPrice(askSizes, 'ask'));
    const useSourceSpecificRows = showSources;
    const aggregatedBids = aggregateSideLevels(bidSizes, bidOwners, bidSources, 'bid');
    const aggregatedAsks = aggregateSideLevels(askSizes, askOwners, askSources, 'ask');
    const nextBids = useSourceSpecificRows
      ? buildSourceSpecificLevels(rawBidLevels, 'bid')
      : buildOrderLevels(aggregatedBids.sizes, aggregatedBids.owners, aggregatedBids.sources, 'bid');
    const nextAsks = useSourceSpecificRows
      ? buildSourceSpecificLevels(rawAskLevels, 'ask')
      : buildOrderLevels(aggregatedAsks.sizes, aggregatedAsks.owners, aggregatedAsks.sources, 'ask');
    updateView(nextBids, nextAsks, pair, sources, newestHubUpdate);
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

  function scaledPrice(price: number): number {
    const scale = Number.isFinite(priceScale) && priceScale > 0 ? priceScale : 1;
    return price / scale;
  }

  function priceDisplayDecimals(): number {
    const scale = Number.isFinite(priceScale) && priceScale > 0 ? Math.trunc(priceScale) : 1;
    const text = String(scale);
    if (!/^10*$/.test(text)) return 4;
    return Math.max(0, text.length - 1);
  }

  function formatPrice(price: number): string {
    const value = scaledPrice(price);
    if (!Number.isFinite(value)) return '-';
    const decimals = priceDisplayDecimals();
    const fixed = value.toFixed(decimals);
    return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  }

  function scaledSize(size: number): number {
    const scale = Number.isFinite(sizeDisplayScale) && sizeDisplayScale > 0 ? sizeDisplayScale : 1;
    return size / scale;
  }

  function formatSize(size: number): string {
    const displaySize = scaledSize(size);
    if (displaySize >= 1_000_000) return (displaySize / 1_000_000).toFixed(2) + 'M';
    if (displaySize >= 1_000) return (displaySize / 1_000).toFixed(2) + 'K';
    return displaySize.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 });
  }

  function emitLevelClick(side: BookSide, level: OrderLevel) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size)) return;
    dispatch('levelclick', {
      side,
      priceTicks: String(level.price),
      displayPrice: formatPrice(level.price),
      size: level.size,
      accountIds: Array.isArray(level.accountIds) ? level.accountIds : [],
    });
  }

  function emitMidPriceClick() {
    const preferredLevel = preferredClickSide === 'bid' ? bids[0] : asks[0];
    if (!preferredLevel) return;
    dispatch('levelclick', {
      side: preferredClickSide === 'bid' ? 'bid' : 'ask',
      priceTicks: String(preferredLevel.price),
      displayPrice: formatPrice(preferredLevel.price),
      size: preferredLevel.size,
      accountIds: Array.isArray(preferredLevel.accountIds) ? preferredLevel.accountIds : [],
    });
  }

  function labelForSource(sourceId: string): string {
    return sourceLabels[sourceId] || formatEntityId(sourceId || '');
  }

  function avatarForSource(sourceId: string): string {
    return sourceAvatars[sourceId] || '';
  }

  function initialsForSource(sourceId: string): string {
    const label = labelForSource(sourceId).trim();
    return label ? label.slice(0, 1).toUpperCase() : '?';
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

  function requestMarketSnapshot(): void {
    if (!marketWs || marketWs.readyState !== 1) return;
    marketWs.send(JSON.stringify({ type: 'market_snapshot_request', id: wsMessageId('market_req_manual') }));
  }

  function refreshOrderbookNow(): void {
    // Force bypass stale stream cache and refresh from current hub state/snapshot.
    streamFreshUntil = 0;
    requestMarketSnapshot();
    extractOrderbook();
  }

  function handlePriceStepChange(): void {
    const pair = canonicalPairId();
    if (normalizePairId(pair)) {
      priceStepOverrides[pair] = selectedPriceStep;
      savePriceStepOverrides();
    }
    extractOrderbook();
  }

  function resetPriceStepAuto(): void {
    const pair = canonicalPairId();
    if (priceStepOverrides[pair]) {
      delete priceStepOverrides[pair];
      savePriceStepOverrides();
    }
    extractOrderbook();
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
      streamFreshUntil = 0;
      streamSnapshots.clear();
      sendMarketSubscribe(true);
      requestMarketSnapshot();
    }
  }

  // Max size for bar scaling
  $: maxBidSize = Math.max(...bids.map(b => b.size), 1);
  $: maxAskSize = Math.max(...asks.map(a => a.size), 1);
  $: maxSize = Math.max(maxBidSize, maxAskSize);
  $: bidVisibleSize = bids.reduce((acc, level) => acc + level.size, 0);
  $: askVisibleSize = asks.reduce((acc, level) => acc + level.size, 0);
  $: visibleSizeTotal = bidVisibleSize + askVisibleSize;
  $: buyRatioPct = visibleSizeTotal > 0 ? (bidVisibleSize / visibleSizeTotal) * 100 : 0;
  $: sellRatioPct = visibleSizeTotal > 0 ? 100 - buyRatioPct : 0;

  onMount(() => {
    loadPriceStepOverrides();
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

<div class="orderbook-panel" class:compact-header={compactHeader}>
  <div class="header">
    {#if !compactHeader}
      <span class="title">Order Book</span>
    {/if}
    <div class="header-controls">
      {#if !compactHeader}
        <span class="pair">{pairLabel || pairId.replace('/', ' / ')}</span>
      {/if}
      <label class="price-step">
        {#if !compactHeader}
          <span class="price-step-label">Step</span>
        {/if}
        <select bind:value={selectedPriceStep} on:change={handlePriceStepChange}>
          {#each PRICE_STEP_OPTIONS as step}
            <option value={step}>{step}</option>
          {/each}
        </select>
        <button
          type="button"
          class="step-auto-btn"
          class:active={!priceStepOverrides[canonicalPairId()]}
          on:click={resetPriceStepAuto}
          title="Use smart auto step for current pair"
        >
          Auto
        </button>
      </label>
    </div>
  </div>

  <div class="spread-row">
    <span class="spread-label">Spread</span>
    <span class="spread-value">{spread !== null ? formatPrice(spread) : '-'}</span>
    <span class="spread-percent">({spreadPercent}%)</span>
  </div>

  <div class="book-container">
    <div class="columns-row" class:with-sources={showSources}>
      {#if showSources}
        <span class="head-label">Acct</span>
      {/if}
      <span class="head-label">Price</span>
      <span class="head-label">Amount</span>
      <span class="head-label">Total</span>
    </div>

    <!-- Asks (sells) - shown in reverse order, lowest ask at bottom -->
    <div class="asks-section">
      {#each [...asks].reverse() as ask, i}
        <div
          class="row ask-row clickable"
          class:with-sources={showSources}
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
          {#if showSources}
            <span class="sources-cell">
              {#each ask.accountIds || [] as sourceId (sourceId)}
                <span
                  class="source-icon"
                  title={labelForSource(sourceId)}
                  data-source-id={sourceId}
                  data-testid="orderbook-source-icon"
                >
                  {#if avatarForSource(sourceId)}
                    <img src={avatarForSource(sourceId)} alt="" class="source-avatar" />
                  {:else}
                    <span class="source-avatar-fallback">{initialsForSource(sourceId)}</span>
                  {/if}
                </span>
              {/each}
            </span>
          {/if}
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
    <div
      class="spread-indicator"
      class:clickable={Boolean((preferredClickSide === 'bid' ? bids[0] : asks[0]))}
      role="button"
      tabindex="0"
      on:click={emitMidPriceClick}
      on:keydown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          emitMidPriceClick();
        }
      }}
    >
      {#if spread !== null}
        <span class="mid-price">{formatPrice((preferredClickSide === 'bid' ? bids[0]?.price : asks[0]?.price) || 0)}</span>
      {/if}
    </div>

    <!-- Bids (buys) -->
    <div class="bids-section">
      {#each bids as bid, i}
        <div
          class="row bid-row clickable"
          class:with-sources={showSources}
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
          {#if showSources}
            <span class="sources-cell">
              {#each bid.accountIds || [] as sourceId (sourceId)}
                <span
                  class="source-icon"
                  title={labelForSource(sourceId)}
                  data-source-id={sourceId}
                  data-testid="orderbook-source-icon"
                >
                  {#if avatarForSource(sourceId)}
                    <img src={avatarForSource(sourceId)} alt="" class="source-avatar" />
                  {:else}
                    <span class="source-avatar-fallback">{initialsForSource(sourceId)}</span>
                  {/if}
                </span>
              {/each}
            </span>
          {/if}
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

  <div class="ratio-row">
    <span class="ratio-buy-label">B {buyRatioPct.toFixed(2)}%</span>
    <div class="ratio-track">
      <div class="ratio-buy" style="width: {buyRatioPct.toFixed(2)}%"></div>
      <div class="ratio-sell" style="width: {sellRatioPct.toFixed(2)}%"></div>
    </div>
    <span class="ratio-sell-label">{sellRatioPct.toFixed(2)}% S</span>
  </div>

  <div class="footer">
    <span class="hub-label">{sourceLabel}</span>
    <button
      class="update-time refresh-link"
      type="button"
      on:click={refreshOrderbookNow}
      title="Request fresh orderbook snapshot"
      aria-label="Refresh orderbook"
    >
      Updated: {formatUpdatedAt(lastUpdate)}
    </button>
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

  .header-controls {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }

  .orderbook-panel.compact-header .header {
    margin-bottom: 6px;
    padding-bottom: 6px;
  }

  .price-step {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-secondary, #888);
    font-size: 10px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .price-step-label {
    color: var(--text-tertiary, #666);
  }

  .price-step select {
    min-width: 72px;
    height: 28px;
    border-radius: 8px;
    border: 1px solid rgba(251, 191, 36, 0.35);
    background: rgba(15, 15, 21, 0.92);
    color: var(--text-primary, #fff);
    font-family: inherit;
    font-size: 12px;
    padding: 0 8px;
    outline: none;
  }

  .price-step select:focus-visible {
    border-color: rgba(251, 191, 36, 0.85);
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.15);
  }

  .step-auto-btn {
    height: 28px;
    border-radius: 8px;
    border: 1px solid rgba(148, 163, 184, 0.35);
    background: rgba(15, 15, 21, 0.92);
    color: #a1a1aa;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    padding: 0 8px;
    cursor: pointer;
  }

  .step-auto-btn.active {
    border-color: rgba(251, 191, 36, 0.75);
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
  }

  .step-auto-btn:focus-visible {
    outline: 1px solid rgba(251, 191, 36, 0.8);
    outline-offset: 2px;
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

  .columns-row {
    display: grid;
    grid-template-columns: 1fr 90px 110px;
    gap: 8px;
    padding: 2px 6px 5px;
    color: var(--text-tertiary, #666);
    font-size: 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    margin-bottom: 2px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .columns-row.with-sources {
    grid-template-columns: 52px 1fr 90px 110px;
  }

  .head-label:nth-last-child(2),
  .head-label:nth-last-child(1) {
    text-align: right;
  }

  .asks-section, .bids-section {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .spread-indicator {
    display: flex;
    justify-content: center;
    padding: 5px 0;
    border-top: 1px solid var(--border-color, #333);
    border-bottom: 1px solid var(--border-color, #333);
    margin: 3px 0;
  }

  .spread-indicator.clickable {
    cursor: pointer;
  }

  .spread-indicator.clickable:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .mid-price {
    color: var(--text-primary, #fff);
    font-weight: 600;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 90px 110px;
    gap: 8px;
    padding: 2px 6px;
    position: relative;
    align-items: center;
    min-height: 26px;
  }

  .row.with-sources {
    grid-template-columns: 52px 1fr 90px 110px;
  }

  .sources-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    z-index: 1;
  }

  .source-icon {
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    border: 1px solid rgba(251, 191, 36, 0.16);
    background: rgba(251, 191, 36, 0.06);
    overflow: hidden;
  }

  .source-avatar {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
  }

  .source-avatar-fallback {
    color: #f3d27a;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
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

  .refresh-link {
    border: none;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
  }

  .refresh-link:hover {
    color: var(--text-secondary, #aaa);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .refresh-link:focus-visible {
    outline: 1px solid rgba(251, 191, 36, 0.8);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .ratio-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    font-size: 11px;
  }

  .ratio-track {
    display: flex;
    height: 6px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.08);
  }

  .ratio-buy {
    background: linear-gradient(90deg, rgba(16, 185, 129, 0.7), rgba(16, 185, 129, 1));
  }

  .ratio-sell {
    background: linear-gradient(90deg, rgba(244, 63, 94, 1), rgba(244, 63, 94, 0.7));
  }

  .ratio-buy-label {
    color: #34d399;
    font-weight: 600;
  }

  .ratio-sell-label {
    color: #fb7185;
    font-weight: 600;
  }

  @media (max-width: 640px) {
    .header {
      align-items: flex-start;
    }

    .header-controls {
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
    }

    .price-step select {
      min-width: 64px;
      height: 26px;
    }

    .step-auto-btn {
      height: 26px;
    }
  }
</style>
