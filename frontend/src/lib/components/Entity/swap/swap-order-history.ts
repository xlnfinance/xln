import { amountToUsd } from '$lib/utils/assetPricing';
import { requireTokenDecimals } from './../token-metadata';
import type { SwapBookEntry } from '@xln/core/api/public/runtime-module';
import { toBigIntSafe } from './../swap-formatting';

export type ClosedOrderStatus = 'filled' | 'partial' | 'canceled' | 'closed';

export type ResolveRecord = {
  fillRatio: number;
  cancelRemainder: boolean;
  height: number;
  executionGiveAmount: bigint | null;
  executionWantAmount: bigint | null;
  feeTokenId: number | null;
  feeAmount: bigint | null;
  comment: string;
};

export type OfferLifecycle = {
  key: string;
  offerId: string;
  accountId: string;
  giveTokenId: number;
  wantTokenId: number;
  giveAmount: bigint;
  wantAmount: bigint;
  priceTicks: bigint;
  createdAt: number;
  lastUpdatedAt: number;
  closed: boolean;
  resolves: ResolveRecord[];
  cancelRequested: boolean;
};

export type ClosedOrderView = {
  offerId: string;
  accountId: string;
  side: 'Ask' | 'Bid';
  pairLabel: string;
  priceTicks: bigint;
  giveTokenId: number;
  wantTokenId: number;
  giveAmount: bigint;
  wantAmount: bigint;
  filledGiveAmount: bigint;
  filledWantAmount: bigint;
  filledBaseAmount: bigint;
  targetBaseAmount: bigint;
  filledPercent: number;
  priceImprovementAmount: bigint;
  priceImprovementTokenId: number | null;
  feeAmount: bigint;
  feeTokenId: number | null;
  status: ClosedOrderStatus;
  closeComment: string;
  createdAt: number;
  closedAt: number;
};

export type SwapCompletionModal = {
  offerId: string;
  side: 'Ask' | 'Bid';
  pairLabel: string;
  filledGiveAmount: bigint;
  filledWantAmount: bigint;
  giveTokenId: number;
  wantTokenId: number;
  priceImprovementAmount: bigint;
  priceImprovementTokenId: number | null;
  feeAmount: bigint;
  feeTokenId: number | null;
};

export type OfferLike = {
  giveTokenId: number;
  wantTokenId: number;
  giveAmount?: bigint;
  wantAmount?: bigint;
  priceTicks?: bigint;
};

export type PairOrientation = {
  baseTokenId: number;
  quoteTokenId: number;
};

export type OrderHistoryDeps = {
  resolvePairOrientation: (tokenA: number, tokenB: number) => PairOrientation;
  getTokenDecimals: (tokenId: number) => number;
  quoteFromBase: (baseAmount: bigint, priceTicks: bigint, baseDecimals: number, quoteDecimals: number) => bigint;
};

export type ComputeSwapPriceTicks = (
  giveTokenId: number,
  wantTokenId: number,
  giveAmount: bigint,
  wantAmount: bigint,
) => bigint;

export type TokenInfoReader = (tokenId: number) => { decimals?: unknown; symbol?: unknown } | null | undefined;

/**
 * One certified Account-frame lifecycle, reconstructed by the Runtime adapter.
 * It is deliberately not a live AccountReplica field: frame history belongs to
 * its dedicated LevelDB log and is always read through the bounded page API.
 */
export type SwapHistoryLifecycle = Readonly<{
  offerId: string;
  giveTokenId: number;
  wantTokenId: number;
  originalGiveAmount: bigint;
  originalWantAmount: bigint;
  liveGiveAmount: bigint | null;
  liveWantAmount: bigint | null;
  priceTicks: bigint;
  createdHeight: number;
  lastUpdatedHeight: number;
  cancelRequested: boolean;
  closed: boolean;
  resolves: readonly ResolveRecord[];
}>;

export type SwapHistoryPage = Readonly<{
  entityId: string;
  accountId: string;
  latestHeight: number;
  items: readonly SwapHistoryLifecycle[];
  nextCursor: string | null;
}>;

type UnknownRecord = Record<string, unknown>;

const requireRecord = (value: unknown, code: string): UnknownRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as UnknownRecord;
};

const requireExactKeys = (value: UnknownRecord, keys: readonly string[], code: string): void => {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(code);
  }
};

const requireCanonicalId = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw new Error(code);
  return value;
};

const requireOfferId = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value) throw new Error(code);
  return value;
};

const requireHistoryCursor = (value: unknown, code: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new Error(code);
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(value));
  } catch {
    throw new Error(code);
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error(code);
  if (requireUint(decoded[0], code) < 1) throw new Error(code);
  requireOfferId(decoded[1], code);
  return value;
};

const requireUint = (value: unknown, code: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(code);
  return value;
};

const requireBigInt = (value: unknown, code: string): bigint => {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(code);
  return value;
};

const decodeResolveRecord = (value: unknown, index: number): ResolveRecord => {
  const record = requireRecord(value, `SWAP_HISTORY_RESOLVE_INVALID:${index}`);
  requireExactKeys(record, [
    'fillRatio', 'cancelRemainder', 'height', 'executionGiveAmount', 'executionWantAmount', 'feeTokenId', 'feeAmount', 'comment',
  ], `SWAP_HISTORY_RESOLVE_FIELDS_INVALID:${index}`);
  const executionGiveAmount = record['executionGiveAmount'];
  const executionWantAmount = record['executionWantAmount'];
  const feeTokenId = record['feeTokenId'];
  const feeAmount = record['feeAmount'];
  if (typeof record['cancelRemainder'] !== 'boolean' || typeof record['comment'] !== 'string') {
    throw new Error(`SWAP_HISTORY_RESOLVE_VALUE_INVALID:${index}`);
  }
  return {
    fillRatio: requireUint(record['fillRatio'], `SWAP_HISTORY_RESOLVE_RATIO_INVALID:${index}`, 65535),
    cancelRemainder: record['cancelRemainder'],
    height: requireUint(record['height'], `SWAP_HISTORY_RESOLVE_HEIGHT_INVALID:${index}`),
    executionGiveAmount: executionGiveAmount === null ? null : requireBigInt(executionGiveAmount, `SWAP_HISTORY_RESOLVE_GIVE_INVALID:${index}`),
    executionWantAmount: executionWantAmount === null ? null : requireBigInt(executionWantAmount, `SWAP_HISTORY_RESOLVE_WANT_INVALID:${index}`),
    feeTokenId: feeTokenId === null ? null : requireUint(feeTokenId, `SWAP_HISTORY_RESOLVE_FEE_TOKEN_INVALID:${index}`, 0xffffffff),
    feeAmount: feeAmount === null ? null : requireBigInt(feeAmount, `SWAP_HISTORY_RESOLVE_FEE_INVALID:${index}`),
    comment: record['comment'],
  };
};

const decodeLifecycle = (value: unknown, index: number): SwapHistoryLifecycle => {
  const record = requireRecord(value, `SWAP_HISTORY_ITEM_INVALID:${index}`);
  requireExactKeys(record, [
    'offerId', 'giveTokenId', 'wantTokenId', 'originalGiveAmount', 'originalWantAmount', 'liveGiveAmount', 'liveWantAmount',
    'priceTicks', 'createdHeight', 'lastUpdatedHeight', 'cancelRequested', 'closed', 'resolves',
  ], `SWAP_HISTORY_ITEM_FIELDS_INVALID:${index}`);
  if (typeof record['cancelRequested'] !== 'boolean' || typeof record['closed'] !== 'boolean' || !Array.isArray(record['resolves'])) {
    throw new Error(`SWAP_HISTORY_ITEM_VALUE_INVALID:${index}`);
  }
  return {
    offerId: requireOfferId(record['offerId'], `SWAP_HISTORY_OFFER_ID_INVALID:${index}`),
    giveTokenId: requireUint(record['giveTokenId'], `SWAP_HISTORY_GIVE_TOKEN_INVALID:${index}`, 0xffffffff),
    wantTokenId: requireUint(record['wantTokenId'], `SWAP_HISTORY_WANT_TOKEN_INVALID:${index}`, 0xffffffff),
    originalGiveAmount: requireBigInt(record['originalGiveAmount'], `SWAP_HISTORY_ORIGINAL_GIVE_INVALID:${index}`),
    originalWantAmount: requireBigInt(record['originalWantAmount'], `SWAP_HISTORY_ORIGINAL_WANT_INVALID:${index}`),
    liveGiveAmount: record['liveGiveAmount'] === null ? null : requireBigInt(record['liveGiveAmount'], `SWAP_HISTORY_LIVE_GIVE_INVALID:${index}`),
    liveWantAmount: record['liveWantAmount'] === null ? null : requireBigInt(record['liveWantAmount'], `SWAP_HISTORY_LIVE_WANT_INVALID:${index}`),
    priceTicks: requireBigInt(record['priceTicks'], `SWAP_HISTORY_PRICE_INVALID:${index}`),
    createdHeight: requireUint(record['createdHeight'], `SWAP_HISTORY_CREATED_HEIGHT_INVALID:${index}`),
    lastUpdatedHeight: requireUint(record['lastUpdatedHeight'], `SWAP_HISTORY_LAST_UPDATED_HEIGHT_INVALID:${index}`),
    cancelRequested: record['cancelRequested'],
    closed: record['closed'],
    resolves: record['resolves'].map((resolve, resolveIndex) => decodeResolveRecord(resolve, resolveIndex)),
  };
};

/** Exact browser boundary for the certified, paged Account-frame history API. */
export const decodeSwapHistoryPage = (value: unknown): SwapHistoryPage => {
  const page = requireRecord(value, 'SWAP_HISTORY_PAGE_INVALID');
  requireExactKeys(page, ['entityId', 'accountId', 'latestHeight', 'items', 'nextCursor'], 'SWAP_HISTORY_PAGE_FIELDS_INVALID');
  if (!Array.isArray(page['items'])) {
    throw new Error('SWAP_HISTORY_PAGE_VALUE_INVALID');
  }
  return {
    entityId: requireCanonicalId(page['entityId'], 'SWAP_HISTORY_ENTITY_ID_INVALID'),
    accountId: requireCanonicalId(page['accountId'], 'SWAP_HISTORY_ACCOUNT_ID_INVALID'),
    latestHeight: requireUint(page['latestHeight'], 'SWAP_HISTORY_LATEST_HEIGHT_INVALID'),
    items: page['items'].map((item, index) => decodeLifecycle(item, index)),
    nextCursor: requireHistoryCursor(page['nextCursor'], 'SWAP_HISTORY_PAGE_CURSOR_INVALID'),
  };
};

export function offerLifecycleKey(accountId: string, offerId: string): string {
  return `${String(accountId || '').trim()}:${String(offerId || '').trim()}`;
}

export function offerSideLabel(
  offer: OfferLike,
  resolvePairOrientation: OrderHistoryDeps['resolvePairOrientation'],
): 'Ask' | 'Bid' {
  const give = Number(offer.giveTokenId || 0);
  const want = Number(offer.wantTokenId || 0);
  const pair = resolvePairOrientation(give, want);
  return give === pair.baseTokenId ? 'Ask' : 'Bid';
}

export function offerPriceTicks(offer: OfferLike, computeSwapPriceTicks: ComputeSwapPriceTicks): bigint {
  const explicitPriceTicks = toBigIntSafe(offer.priceTicks);
  if (explicitPriceTicks && explicitPriceTicks > 0n) return explicitPriceTicks;
  const giveToken = Number(offer.giveTokenId || 0);
  const wantToken = Number(offer.wantTokenId || 0);
  const give = toBigIntSafe(offer.giveAmount) ?? 0n;
  const want = toBigIntSafe(offer.wantAmount) ?? 0n;
  if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken)) return 0n;
  if (giveToken <= 0 || wantToken <= 0) return 0n;
  if (give <= 0n || want <= 0n) return 0n;
  return computeSwapPriceTicks(giveToken, wantToken, give, want);
}

export function remainingOfferUsd(offer: SwapBookEntry, getTokenInfo: TokenInfoReader): number {
  const giveToken = Number(offer.giveTokenId || 0);
  const giveAmountValue = toBigIntSafe(offer.giveAmount) ?? 0n;
  if (!Number.isFinite(giveToken) || giveToken <= 0 || giveAmountValue <= 0n) return 0;
  const info = getTokenInfo(giveToken);
  const decimals = requireTokenDecimals(info?.decimals, `token:${giveToken}`);
  const symbol = String(info?.symbol || '');
  return amountToUsd(giveAmountValue, decimals, symbol);
}

export function isDustOpenOffer(
  offer: SwapBookEntry,
  minOrderNotionalUsd: number,
  getTokenInfo: TokenInfoReader,
): boolean {
  const remainingUsd = remainingOfferUsd(offer, getTokenInfo);
  return remainingUsd > 0 && remainingUsd < minOrderNotionalUsd;
}

export function computeFilledPpmFromRatios(resolves: ResolveRecord[]): bigint {
  let remainingPpm = 1_000_000n;
  for (const resolve of resolves) {
    const ratio = BigInt(Math.max(0, Math.min(65535, Math.round(resolve.fillRatio || 0))));
    const filledThisStep = (remainingPpm * ratio) / 65535n;
    remainingPpm = remainingPpm - filledThisStep;
    if (remainingPpm < 0n) remainingPpm = 0n;
    if (resolve.cancelRemainder) break;
  }
  return 1_000_000n - remainingPpm;
}

export function computeOfferExecutionSummary(
  lifecycle: OfferLifecycle,
  deps: OrderHistoryDeps,
): {
  filledGiveAmount: bigint;
  filledWantAmount: bigint;
  filledBaseAmount: bigint;
  targetBaseAmount: bigint;
  filledPpm: bigint;
  priceImprovementAmount: bigint;
  priceImprovementTokenId: number | null;
  feeAmount: bigint;
  feeTokenId: number | null;
} {
  const pair = deps.resolvePairOrientation(lifecycle.giveTokenId, lifecycle.wantTokenId);
  const isBuy = offerSideLabel(lifecycle, deps.resolvePairOrientation) === 'Bid';
  const baseDecimals = deps.getTokenDecimals(pair.baseTokenId);
  const quoteDecimals = deps.getTokenDecimals(pair.quoteTokenId);
  const targetBaseAmount = isBuy ? lifecycle.wantAmount : lifecycle.giveAmount;
  let filledGiveAmount = 0n;
  let filledWantAmount = 0n;
  let filledBaseAmount = 0n;
  let priceImprovementAmount = 0n;
  let feeAmount = 0n;
  let feeTokenId: number | null = null;
  let sawExactExecution = false;

  const resolves = Array.isArray(lifecycle.resolves) ? lifecycle.resolves : [];
  for (const resolve of resolves) {
    const executionGiveAmount = resolve.executionGiveAmount;
    const executionWantAmount = resolve.executionWantAmount;
    if (executionGiveAmount === null || executionWantAmount === null) continue;
    if (executionGiveAmount <= 0n || executionWantAmount <= 0n) continue;

    sawExactExecution = true;
    filledGiveAmount += executionGiveAmount;
    filledWantAmount += executionWantAmount;

    const filledBaseThisStep = isBuy ? executionWantAmount : executionGiveAmount;
    const actualQuoteThisStep = isBuy ? executionGiveAmount : executionWantAmount;
    filledBaseAmount += filledBaseThisStep;

    const limitQuoteThisStep = deps.quoteFromBase(
      filledBaseThisStep,
      lifecycle.priceTicks,
      baseDecimals,
      quoteDecimals,
    );
    if (isBuy) {
      const saved = limitQuoteThisStep - actualQuoteThisStep;
      if (saved > 0n) priceImprovementAmount += saved;
    } else {
      const gained = actualQuoteThisStep - limitQuoteThisStep;
      if (gained > 0n) priceImprovementAmount += gained;
    }

    if ((resolve.feeAmount ?? 0n) > 0n) {
      feeAmount += resolve.feeAmount ?? 0n;
      feeTokenId = resolve.feeTokenId ?? lifecycle.wantTokenId;
    }
  }

  if (!sawExactExecution) {
    const filledPpm = computeFilledPpmFromRatios(resolves);
    return {
      filledGiveAmount: (lifecycle.giveAmount * filledPpm) / 1_000_000n,
      filledWantAmount: (lifecycle.wantAmount * filledPpm) / 1_000_000n,
      filledBaseAmount: (targetBaseAmount * filledPpm) / 1_000_000n,
      targetBaseAmount,
      filledPpm,
      priceImprovementAmount: 0n,
      priceImprovementTokenId: null,
      feeAmount: 0n,
      feeTokenId: null,
    };
  }

  const boundedFilledBase = filledBaseAmount > targetBaseAmount ? targetBaseAmount : filledBaseAmount;
  const filledPpm = targetBaseAmount > 0n ? ((boundedFilledBase * 1_000_000n) / targetBaseAmount) : 0n;

  return {
    filledGiveAmount,
    filledWantAmount,
    filledBaseAmount: boundedFilledBase,
    targetBaseAmount,
    filledPpm: filledPpm > 1_000_000n ? 1_000_000n : filledPpm,
    priceImprovementAmount,
    priceImprovementTokenId: priceImprovementAmount > 0n ? pair.quoteTokenId : null,
    feeAmount,
    feeTokenId,
  };
}

export function historyPageToOfferLifecycles(page: SwapHistoryPage): OfferLifecycle[] {
  return page.items.map((item) => ({
    key: offerLifecycleKey(page.accountId, item.offerId),
    offerId: item.offerId,
    accountId: page.accountId,
    giveTokenId: item.giveTokenId,
    wantTokenId: item.wantTokenId,
    giveAmount: item.originalGiveAmount,
    wantAmount: item.originalWantAmount,
    priceTicks: item.priceTicks,
    createdAt: item.createdHeight,
    lastUpdatedAt: item.lastUpdatedHeight,
    closed: item.closed,
    resolves: [...item.resolves],
    cancelRequested: item.cancelRequested,
  }));
}

export function classifyClosedStatus(
  lifecycle: OfferLifecycle,
  deps: OrderHistoryDeps,
  filledDisplayPpmThreshold: bigint,
): ClosedOrderStatus {
  const summary = computeOfferExecutionSummary(lifecycle, deps);
  const filledPpm = summary.filledPpm;
  if (filledPpm >= filledDisplayPpmThreshold) return 'filled';
  const hasFill = summary.filledBaseAmount > 0n;
  const resolves = Array.isArray(lifecycle.resolves) ? lifecycle.resolves : [];
  const hasCancelResolve = resolves.some((resolve) => resolve.cancelRemainder);
  if (hasFill) return 'partial';
  if (hasCancelResolve || lifecycle.cancelRequested) return 'canceled';
  return 'closed';
}

export function latestResolveComment(lifecycle: OfferLifecycle): string {
  const resolves = Array.isArray(lifecycle.resolves) ? lifecycle.resolves : [];
  for (let i = resolves.length - 1; i >= 0; i -= 1) {
    const comment = String(resolves[i]?.comment || '').trim();
    if (comment) return comment;
  }
  return '';
}

export function extractStpBlockingOrderId(comment: string): string {
  return comment.startsWith('STP:') ? comment.slice(4).trim() : '';
}

export function formatCloseComment(comment: string): string {
  const blockingOrderId = extractStpBlockingOrderId(comment);
  if (!blockingOrderId) return comment;
  return `STP:${blockingOrderId.slice(-8)}`;
}

export function formatOrderTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  if (ms < 1_000_000_000_000) return `#${ms}`;
  return new Date(ms).toLocaleTimeString();
}

export function closedOrderStatusLabel(status: ClosedOrderStatus): string {
  if (status === 'filled') return 'Filled';
  if (status === 'partial') return 'Partial';
  if (status === 'canceled') return 'Canceled';
  return 'Closed';
}

export function closedOrderStatusTone(status: ClosedOrderStatus): 'bid' | 'ask' | 'neutral' {
  if (status === 'filled') return 'bid';
  if (status === 'partial') return 'ask';
  return 'neutral';
}

export function buildClosedOrderViews(
  closedOfferLifecycles: OfferLifecycle[],
  deps: OrderHistoryDeps & {
    tokenSymbol: (tokenId: number) => string;
    filledDisplayPpmThreshold: bigint;
  },
): ClosedOrderView[] {
  return (Array.isArray(closedOfferLifecycles) ? closedOfferLifecycles : [])
    .map((offer) => {
      const side = offerSideLabel(offer, deps.resolvePairOrientation);
      const pair = deps.resolvePairOrientation(offer.giveTokenId, offer.wantTokenId);
      const pairLabel = `${deps.tokenSymbol(pair.baseTokenId)}/${deps.tokenSymbol(pair.quoteTokenId)}`;
      const summary = computeOfferExecutionSummary(offer, deps);
      const filledPpm = summary.filledPpm;
      const filledPercent = filledPpm >= deps.filledDisplayPpmThreshold
        ? 100
        : Number((filledPpm * 10_000n) / 1_000_000n) / 100;
      const latestResolveTs = offer.lastUpdatedAt;
      const closeComment = latestResolveComment(offer);
      return {
        offerId: offer.offerId,
        accountId: offer.accountId,
        side,
        pairLabel,
        priceTicks: offer.priceTicks,
        giveTokenId: offer.giveTokenId,
        wantTokenId: offer.wantTokenId,
        giveAmount: offer.giveAmount,
        wantAmount: offer.wantAmount,
        filledGiveAmount: summary.filledGiveAmount,
        filledWantAmount: summary.filledWantAmount,
        filledBaseAmount: summary.filledBaseAmount,
        targetBaseAmount: summary.targetBaseAmount,
        filledPercent,
        priceImprovementAmount: summary.priceImprovementAmount,
        priceImprovementTokenId: summary.priceImprovementTokenId,
        feeAmount: summary.feeAmount,
        feeTokenId: summary.feeTokenId,
        status: classifyClosedStatus(offer, deps, deps.filledDisplayPpmThreshold),
        closeComment,
        createdAt: offer.createdAt,
        closedAt: latestResolveTs,
      } satisfies ClosedOrderView;
    })
    .sort((a, b) => b.closedAt - a.closedAt);
}

export function buildOfferPriceImprovementByKey(
  offerLifecycles: OfferLifecycle[],
  deps: OrderHistoryDeps,
): Map<string, { amount: bigint; tokenId: number | null }> {
  const map = new Map<string, { amount: bigint; tokenId: number | null }>();
  for (const lifecycle of offerLifecycles) {
    const summary = computeOfferExecutionSummary(lifecycle, deps);
    map.set(lifecycle.key, {
      amount: summary.priceImprovementAmount,
      tokenId: summary.priceImprovementTokenId,
    });
  }
  return map;
}

export function buildTotalPriceImprovementSummary(
  offerLifecycles: OfferLifecycle[],
  deps: OrderHistoryDeps & {
    formatAmount: (amount: bigint, tokenId: number) => string;
    tokenSymbol: (tokenId: number) => string;
  },
): string {
  const totals = new Map<number, bigint>();
  for (const lifecycle of offerLifecycles) {
    const summary = computeOfferExecutionSummary(lifecycle, deps);
    const tokenId = summary.priceImprovementTokenId;
    const amount = summary.priceImprovementAmount;
    if (!tokenId || amount <= 0n) continue;
    totals.set(tokenId, (totals.get(tokenId) ?? 0n) + amount);
  }
  const parts = Array.from(totals.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([tokenId, amount]) => `${deps.formatAmount(amount, tokenId)} ${deps.tokenSymbol(tokenId)}`);
  return parts.length > 0 ? parts.join(' · ') : '';
}
