<!--
  OrderbookPanel.svelte

  Displays a real-time orderbook from hub snapshots served via relay/aggregator.
  Falls back to local env.eReplicas only when a fresh relay snapshot is not available.

  Usage:
    <OrderbookPanel hubId="0x..." pairId="1/2" />
    <OrderbookPanel hubIds={["0x...", "0x..."]} pairId="1/2" />
-->
<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import type { Readable } from 'svelte/store';
  import { xlnEnvironment } from '$lib/stores/xlnStore';
  import { formatEntityId } from '$lib/utils/format';
  import type { BookState, EntityReplica, Env, EnvSnapshot } from '@xln/runtime/xln-api';

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
  export let disablePriceAggregation: boolean = false;
  export let showPriceStepControl: boolean = true;
  type RuntimeEnv = Env | EnvSnapshot;
  export let envStore: Readable<RuntimeEnv | null> = xlnEnvironment;

  type BookSide = 'bid' | 'ask';
  type LevelClickDetail = { side: BookSide; priceTicks: string; displayPrice: string; size: number; accountIds: string[] };
  type SnapshotDetail = {
    pairId: string;
    bids: Array<{ price: bigint; size: number; total: number }>;
    asks: Array<{ price: bigint; size: number; total: number }>;
    spread: bigint | null;
    spreadPercent: string;
    sourceCount: number;
    updatedAt: number;
  };
  type MarketSnapshotPayload = {
    hubEntityId: string;
    pairId: string;
    depth: number;
    bids: Array<{ price: bigint | string; size: number; total: number }>;
    asks: Array<{ price: bigint | string; size: number; total: number }>;
    spread: bigint | string | null;
    spreadPercent: string;
    hubUpdatedAt?: number;
    updatedAt: number;
  };
  type MarketWsMessage = {
    type?: string;
    payload?: MarketSnapshotPayload;
  };
  const dispatch = createEventDispatcher<{ levelclick: LevelClickDetail; snapshot: SnapshotDetail }>();
  interface OrderLevel {
    price: bigint;
    size: number;
    total: number;
    owners?: string[];
    accountIds?: string[];
  }
  interface RawSourceLevel {
    price: bigint;
    size: number;
    sourceId: string;
    owners?: string[];
  }

  let bids: OrderLevel[] = [];
  let asks: OrderLevel[] = [];
  let spread: bigint | null = null;
  let spreadPercent: string = '-';
  let lastUpdate = 0;
  let sourceCount = 0;
  let sourceLabel = 'None';

  // Cumulative hover: index of hovered row (-1 = none).
  // For asks (reversed display): hovering row i highlights rows [i..last] (toward center).
  // For bids: hovering row i highlights rows [0..i] (from center down).
  let hoverAskDisplayIdx = -1;
  let hoverBidIdx = -1;

  let pollInterval: number | null = null;
  const POLL_MS = 1000;

  let marketWs: WebSocket | null = null;
  let marketRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let marketWsClosing = false;
  let marketSubKey = '';
  let streamFreshUntil = 0;
  const STREAM_STALE_MS = 3000;
  const STREAM_RETRY_MS = 2000;
  const UI_BOOK_DEPTH = 10;
  const streamSnapshots = new Map<string, MarketSnapshotPayload>();
  const NUMERIC_PRICE_STEP_OPTIONS = ['0.0001', '0.001', '0.01', '0.1', '1', '10', '50', '100'] as const;
  const PRICE_STEP_OPTIONS = ['auto', ...NUMERIC_PRICE_STEP_OPTIONS] as const;
  const PRICE_STEP_STORAGE_KEY = 'xln.orderbook.price-step-overrides.v1';
  export let selectedPriceStep: (typeof PRICE_STEP_OPTIONS)[number] = 'auto';
  export let autoResolvedPriceStep: (typeof NUMERIC_PRICE_STEP_OPTIONS)[number] = '1';
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

  function visibleDepth(): number {
    return Math.max(1, Math.min(depth, UI_BOOK_DEPTH));
  }

  function relayWsUrl(): string | null {
    if (typeof window === 'undefined') return null;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/relay`;
  }

  function toPriceTicks(value: unknown): bigint | null {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
      return BigInt(value);
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      return BigInt(value.trim());
    }
    return null;
  }

  function readBookTickValue(value: unknown, fallback: bigint): bigint {
    const parsed = toPriceTicks(value);
    return parsed && parsed > 0n ? parsed : fallback;
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

  function findHubReplica(env: RuntimeEnv, sourceHubId: string): EntityReplica | null {
    for (const [key, replica] of env.eReplicas || []) {
      if (String(key || '').toLowerCase().startsWith(sourceHubId + ':')) {
        return replica;
      }
    }
    return null;
  }

  function accumulateBookSide(
    book: BookState,
    sourceHubId: string,
    side: 'bid' | 'ask',
    sideSizes: Map<bigint, number>,
    sideOwners: Map<bigint, Set<string>>,
    sideSources: Map<bigint, Set<string>>,
    rawLevels?: RawSourceLevel[],
  ) {
    const { orderQtyLots, orderOwnerIdx, orderNext, orderActive, owners, params } = book;
    const pmin = params.pmin;
    const tick = params.tick;
    const levelHead = side === 'bid' ? book.levelHeadBid : book.levelHeadAsk;
    const bitmap = side === 'bid' ? book.bitmapBid : book.bitmapAsk;
    const levels = book.levels;

    let idx = side === 'bid' ? Number(book.bestBidIdx ?? -1) : Number(book.bestAskIdx ?? -1);
    let visitedLevels = 0;
    const effectiveDepth = visibleDepth();
    const maxLevelsPerBook = Math.max(effectiveDepth * 6, effectiveDepth);

    while (idx !== -1 && visitedLevels < maxLevelsPerBook) {
      visitedLevels += 1;
      let headIdx = Number(levelHead[idx] ?? -1);
      let levelSize = 0;
      const levelOwnerSet = new Set<string>();

      while (headIdx !== -1) {
        if (Boolean(orderActive[headIdx])) {
          levelSize += Number(orderQtyLots[headIdx] || 0);
          if (showOwners) {
            levelOwnerSet.add(String(owners[orderOwnerIdx[headIdx]] || '?').slice(-4));
          }
        }
        headIdx = Number(orderNext[headIdx] ?? -1);
      }

      if (levelSize > 0) {
        const price = pmin + (BigInt(idx) * tick);
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
          ...(showOwners ? { owners: Array.from(levelOwnerSet) } : {}),
        });
      }

      idx = side === 'bid'
        ? findPrevLevel(bitmap, idx - 1)
        : findNextLevel(bitmap, levels, idx + 1);
    }
  }

  function buildOrderLevels(
    sideSizes: Map<bigint, number>,
    sideOwners: Map<bigint, Set<string>>,
    sideSources: Map<bigint, Set<string>>,
    side: 'bid' | 'ask'
  ): OrderLevel[] {
    const sorted = Array.from(sideSizes.entries())
      .sort((a, b) => {
        if (a[0] === b[0]) return 0;
        if (side === 'bid') return a[0] > b[0] ? -1 : 1;
        return a[0] < b[0] ? -1 : 1;
      })
      .slice(0, visibleDepth());

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
          if (b.price !== a.price) return b.price > a.price ? 1 : -1;
        } else if (a.price !== b.price) {
          return a.price < b.price ? -1 : 1;
        }
        return a.sourceId.localeCompare(b.sourceId);
      })
      .slice(0, visibleDepth());

    let cumulative = 0;
    return sorted.map((level) => {
      cumulative += level.size;
      return {
        price: level.price,
        size: level.size,
        total: cumulative,
        ...(level.owners ? { owners: level.owners } : {}),
        accountIds: [level.sourceId],
      };
    });
  }

  function getSelectedPriceStepTicks(): bigint {
    const scale = Number.isFinite(priceScale) && priceScale > 0 ? priceScale : 1;
    const resolvedStep = selectedPriceStep === 'auto' ? autoResolvedPriceStep : selectedPriceStep;
    const selected = Number(resolvedStep);
    const stepDisplay = Number.isFinite(selected) && selected > 0 ? selected : 1;
    return BigInt(Math.max(1, Math.round(stepDisplay * scale)));
  }

  function getBestPrice(sideSizes: Map<bigint, number>, side: 'bid' | 'ask'): bigint | null {
    let best: bigint | null = null;
    for (const [price, size] of sideSizes.entries()) {
      if (!Number.isFinite(size) || size <= 0) continue;
      if (best === null) best = price;
      else if (side === 'bid') best = best > price ? best : price;
      else best = best < price ? best : price;
    }
    return best;
  }

  function computeSmartStep(rawBestBid: bigint | null, rawBestAsk: bigint | null): string {
    const numericSteps = NUMERIC_PRICE_STEP_OPTIONS.map(Number);
    if (canonicalPairId() === '1/3') {
      return '0.0001';
    }
    if (rawBestBid === null || rawBestAsk === null || rawBestAsk <= rawBestBid) {
      return '1';
    }
    const scale = Number.isFinite(priceScale) && priceScale > 0 ? priceScale : 1;
    const spreadDisplay = Number(rawBestAsk - rawBestBid) / scale;
    const midDisplay = Number(rawBestAsk + rawBestBid) / 2 / scale;

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
    return NUMERIC_PRICE_STEP_OPTIONS.includes(fallback as (typeof NUMERIC_PRICE_STEP_OPTIONS)[number]) ? fallback : '1';
  }

  function applySmartOrSavedStep(rawBestBid: bigint | null, rawBestAsk: bigint | null): void {
    const pair = canonicalPairId();
    const saved = priceStepOverrides[pair];
    autoResolvedPriceStep = computeSmartStep(rawBestBid, rawBestAsk) as (typeof NUMERIC_PRICE_STEP_OPTIONS)[number];
    const next = saved && NUMERIC_PRICE_STEP_OPTIONS.includes(saved as (typeof NUMERIC_PRICE_STEP_OPTIONS)[number])
      ? (saved as (typeof NUMERIC_PRICE_STEP_OPTIONS)[number])
      : 'auto';
    if (selectedPriceStep !== next) {
      selectedPriceStep = next;
    }
  }

  function aggregateSideLevels(
    sideSizes: Map<bigint, number>,
    sideOwners: Map<bigint, Set<string>>,
    sideSources: Map<bigint, Set<string>>,
    side: 'bid' | 'ask',
  ): { sizes: Map<bigint, number>; owners: Map<bigint, Set<string>>; sources: Map<bigint, Set<string>> } {
    if (disablePriceAggregation) {
      return { sizes: sideSizes, owners: sideOwners, sources: sideSources };
    }
    const stepTicks = getSelectedPriceStepTicks();
    if (stepTicks <= 1) {
      return { sizes: sideSizes, owners: sideOwners, sources: sideSources };
    }

    const aggregatedSizes = new Map<bigint, number>();
    const aggregatedOwners = new Map<bigint, Set<string>>();
    const aggregatedSources = new Map<bigint, Set<string>>();

    for (const [price, size] of sideSizes.entries()) {
      const bucketPrice = side === 'bid'
        ? (price / stepTicks) * stepTicks
        : (((price + stepTicks - 1n) / stepTicks) * stepTicks);
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
      spreadPercent = formatPercent3(spread, bestAsk.price);
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

  function formatPercent3(numerator: bigint, denominator: bigint): string {
    if (numerator <= 0n || denominator <= 0n) return '0.000';
    const scaled = (numerator * 100_000n) / denominator;
    const whole = scaled / 1_000n;
    const frac = (scaled % 1_000n).toString().padStart(3, '0');
    return `${whole.toString()}.${frac}`;
  }

  function applyStreamOrderbookIfFresh(sources: string[], pair: string): boolean {
    if (Date.now() > streamFreshUntil) return false;
    const bidSizes = new Map<bigint, number>();
    const askSizes = new Map<bigint, number>();
    const bidOwners = new Map<bigint, Set<string>>();
    const askOwners = new Map<bigint, Set<string>>();
    const bidSources = new Map<bigint, Set<string>>();
    const askSources = new Map<bigint, Set<string>>();
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
        const price = toPriceTicks(level.price);
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
        const price = toPriceTicks(level.price);
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
    const bidSizes = new Map<bigint, number>();
    const askSizes = new Map<bigint, number>();
    const bidOwners = new Map<bigint, Set<string>>();
    const askOwners = new Map<bigint, Set<string>>();
    const bidSources = new Map<bigint, Set<string>>();
    const askSources = new Map<bigint, Set<string>>();
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

  function priceDisplayDecimals(): number {
    const scale = Number.isFinite(priceScale) && priceScale > 0 ? Math.trunc(priceScale) : 1;
    const text = String(scale);
    if (!/^10*$/.test(text)) return 4;
    return Math.max(0, text.length - 1);
  }

  function formatPrice(price: bigint): string {
    const decimals = priceDisplayDecimals();
    const scale = 10n ** BigInt(decimals);
    const whole = price / scale;
    const frac = price % scale;
    if (frac === 0n) return whole.toString();
    return `${whole.toString()}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
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
    if (!Number.isFinite(level.size)) return;
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
      depth: visibleDepth(),
    }));
    marketSubKey = `${pair}|${visibleDepth()}|${sources.join(',')}`;
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
    lastUpdate = Date.now();
  }

  function handlePriceStepChange(): void {
    const pair = canonicalPairId();
    if (normalizePairId(pair)) {
      if (selectedPriceStep === 'auto') {
        delete priceStepOverrides[pair];
      } else {
        priceStepOverrides[pair] = selectedPriceStep;
      }
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
    const nextKey = `${pair}|${visibleDepth()}|${sources.join(',')}`;
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
  {#if !compactHeader}
    <div class="header">
      <span class="title">Order Book</span>
      <div class="header-controls">
        <span class="pair">{pairLabel || pairId.replace('/', ' / ')}</span>
        {#if showPriceStepControl}
          <label class="price-step">
            <span class="price-step-label">Step</span>
            <select bind:value={selectedPriceStep} on:change={handlePriceStepChange} disabled={disablePriceAggregation}>
              {#each PRICE_STEP_OPTIONS as step}
                <option value={step}>{step === 'auto' ? `Auto · ${autoResolvedPriceStep}` : step}</option>
              {/each}
            </select>
          </label>
        {/if}
      </div>
    </div>
  {/if}

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
    <div class="asks-section" data-testid="orderbook-asks">
      {#each [...asks].reverse() as ask, i}
        <div
          class="row ask-row clickable"
          data-testid="orderbook-ask-row"
          data-price={ask.price.toString()}
          data-size={String(ask.size)}
          class:with-sources={showSources}
          class:cumulative-highlight={hoverAskDisplayIdx >= 0 && i >= hoverAskDisplayIdx}
          class:cumulative-first={hoverAskDisplayIdx >= 0 && i === hoverAskDisplayIdx}
          class:cumulative-last={hoverAskDisplayIdx >= 0 && i >= hoverAskDisplayIdx && i === asks.length - 1}
          role="button"
          tabindex="0"
          on:mouseenter={() => { hoverAskDisplayIdx = i; }}
          on:mouseleave={() => { hoverAskDisplayIdx = -1; }}
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
      data-testid="orderbook-mid-row"
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
        <span class="mid-price">{formatPrice((preferredClickSide === 'bid' ? bids[0]?.price : asks[0]?.price) || 0n)}</span>
      {/if}
    </div>

    <!-- Bids (buys) -->
    <div class="bids-section" data-testid="orderbook-bids">
      {#each bids as bid, i}
        <div
          class="row bid-row clickable"
          data-testid="orderbook-bid-row"
          data-price={bid.price.toString()}
          data-size={String(bid.size)}
          class:with-sources={showSources}
          class:cumulative-highlight={hoverBidIdx >= 0 && i <= hoverBidIdx}
          class:cumulative-first={hoverBidIdx >= 0 && i === 0}
          class:cumulative-last={hoverBidIdx >= 0 && i === hoverBidIdx}
          role="button"
          tabindex="0"
          on:mouseenter={() => { hoverBidIdx = i; }}
          on:mouseleave={() => { hoverBidIdx = -1; }}
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

  <div class="footer" class:compact-footer={compactHeader}>
    {#if compactHeader && showPriceStepControl}
      <label class="price-step compact-step">
        <select bind:value={selectedPriceStep} on:change={handlePriceStepChange} aria-label="Orderbook aggregation step" disabled={disablePriceAggregation}>
          {#each PRICE_STEP_OPTIONS as step}
            <option value={step}>{step === 'auto' ? `Auto · ${autoResolvedPriceStep}` : step}</option>
          {/each}
        </select>
      </label>
    {/if}
    <span
      class="update-label"
      on:click={refreshOrderbookNow}
      on:keydown={(e) => e.key === 'Enter' && refreshOrderbookNow()}
      role="button"
      tabindex="0"
      title="Click to refresh orderbook"
    >Updated: {formatUpdatedAt(lastUpdate)}</span>
  </div>
</div>

<style>
  .orderbook-panel {
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 11px;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
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
    display: grid;
    grid-auto-flow: column;
    align-items: center;
    gap: 8px;
    margin-left: auto;
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
    min-width: 110px;
    height: 28px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: #111217;
    color: #e5e7eb;
    font-family: inherit;
    font-size: 12px;
    padding: 0 8px;
    outline: none;
    color-scheme: dark;
    box-sizing: border-box;
  }

  .price-step select:focus-visible {
    border-color: rgba(251, 191, 36, 0.85);
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.15);
  }

  .spread-row {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 10px;
    padding: 6px 0 8px;
    color: var(--text-secondary, #888);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }

  .spread-label {
    justify-self: start;
  }

  .spread-value {
    color: var(--text-primary, #fff);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: none;
    justify-self: center;
  }

  .spread-percent {
    justify-self: end;
    color: var(--text-primary, #fff);
    letter-spacing: 0.02em;
    text-transform: none;
  }

  .book-container {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .columns-row {
    display: grid;
    grid-template-columns: 1fr 80px 80px;
    gap: 6px;
    padding: 2px 6px 3px;
    color: var(--text-tertiary, #666);
    font-size: 9px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    margin-bottom: 1px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .columns-row.with-sources {
    grid-template-columns: 32px 1fr 80px 80px;
  }

  .head-label:nth-last-child(2),
  .head-label:nth-last-child(1) {
    text-align: right;
  }

  .asks-section, .bids-section {
    display: flex;
    flex-direction: column;
    gap: 1px;
    position: relative;
  }

  .spread-indicator {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    margin: 4px 0;
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
    padding: 0 8px;
  }

  .spread-indicator::before,
  .spread-indicator::after {
    content: '';
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.12));
  }

  .spread-indicator::after {
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.12), transparent);
  }

  .price-step select option {
    background: #0f1117;
    color: #f3f4f6;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 80px 80px;
    gap: 6px;
    padding: 1px 6px;
    position: relative;
    align-items: center;
    min-height: 18px;
    font-size: 11px;
  }

  .row.with-sources {
    grid-template-columns: 32px 1fr 80px 80px;
  }

  .sources-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    z-index: 1;
  }

  .source-icon {
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
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
    background: rgba(255, 255, 255, 0.06);
  }

  .row.cumulative-highlight {
    background: rgba(255, 255, 255, 0.03);
    border-left: 1px dashed rgba(255, 255, 255, 0.12);
    border-right: 1px dashed rgba(255, 255, 255, 0.12);
    border-top: none;
    border-bottom: none;
    border-radius: 0;
  }

  .row.cumulative-highlight.cumulative-first {
    border-top: 1px dashed rgba(255, 255, 255, 0.12);
    border-top-left-radius: 3px;
    border-top-right-radius: 3px;
  }

  .row.cumulative-highlight.cumulative-last {
    border-bottom: 1px dashed rgba(255, 255, 255, 0.12);
    border-bottom-left-radius: 3px;
    border-bottom-right-radius: 3px;
  }

  .row.cumulative-highlight:hover {
    background: rgba(255, 255, 255, 0.06);
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
    justify-content: flex-end;
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--border-color, #333);
    font-size: 10px;
    color: var(--text-tertiary, #555);
  }

  .footer.compact-footer {
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }

  .compact-step {
    margin-right: auto;
  }

  .update-label {
    cursor: pointer;
    color: var(--text-tertiary, #555);
  }

  .update-label:hover {
    color: var(--text-secondary, #aaa);
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
      grid-auto-flow: row;
      align-items: flex-end;
      gap: 4px;
    }

    .price-step select {
      min-width: 100px;
      height: 28px;
    }

    .spread-row {
      grid-template-columns: auto auto auto;
      gap: 6px;
      font-size: 9px;
    }
  }
</style>
