import type { AccountMachine } from '$lib/types/ui';
import { amountToUsd } from '$lib/utils/assetPricing';
import type { SwapBookEntry } from '@xln/runtime/xln-api';
import { toBigIntSafe } from './swap-formatting';

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
  const decimals = Number(info?.decimals ?? 18);
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

export function collectOfferLifecyclesFrom(
  accountMachines: Array<{ accountId: string; account: AccountMachine }>,
  selectSource: (account: AccountMachine) => Map<string, unknown> | undefined,
  computeSwapPriceTicks: ComputeSwapPriceTicks,
): OfferLifecycle[] {
  const lifecycles: OfferLifecycle[] = [];
  for (const { accountId, account } of accountMachines) {
    const source = selectSource(account);
    if (!(source instanceof Map)) continue;
    for (const [offerId, rawEntry] of source.entries()) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const entry = rawEntry as {
        giveTokenId?: unknown;
        wantTokenId?: unknown;
        giveAmount?: unknown;
        wantAmount?: unknown;
        priceTicks?: unknown;
        createdHeight?: unknown;
        cancelRequested?: unknown;
        resolves?: unknown;
      };
      const giveTokenId = Number(entry.giveTokenId || 0);
      const wantTokenId = Number(entry.wantTokenId || 0);
      const giveAmount = toBigIntSafe(entry.giveAmount) ?? 0n;
      const wantAmount = toBigIntSafe(entry.wantAmount) ?? 0n;
      if (!Number.isFinite(giveTokenId) || !Number.isFinite(wantTokenId) || giveTokenId <= 0 || wantTokenId <= 0) continue;
      if (giveAmount <= 0n || wantAmount <= 0n) continue;
      const priceTicks = toBigIntSafe(entry.priceTicks) ?? computeSwapPriceTicks(giveTokenId, wantTokenId, giveAmount, wantAmount);
      const resolves = Array.isArray(entry.resolves)
        ? entry.resolves.map((resolve) => {
            const rawResolve = resolve as {
              fillRatio?: unknown;
              cancelRemainder?: unknown;
              height?: unknown;
              executionGiveAmount?: unknown;
              executionWantAmount?: unknown;
              feeTokenId?: unknown;
              feeAmount?: unknown;
              comment?: unknown;
            };
            const feeTokenId = Number(rawResolve.feeTokenId);
            return {
              fillRatio: Number.isFinite(Number(rawResolve.fillRatio)) ? Number(rawResolve.fillRatio) : 0,
              cancelRemainder: Boolean(rawResolve.cancelRemainder),
              height: Number.isFinite(Number(rawResolve.height)) ? Number(rawResolve.height) : 0,
              executionGiveAmount: toBigIntSafe(rawResolve.executionGiveAmount),
              executionWantAmount: toBigIntSafe(rawResolve.executionWantAmount),
              feeTokenId: Number.isFinite(feeTokenId) ? feeTokenId : null,
              feeAmount: toBigIntSafe(rawResolve.feeAmount),
              comment: typeof rawResolve.comment === 'string' ? rawResolve.comment : '',
            } satisfies ResolveRecord;
          })
        : [];
      lifecycles.push({
        key: offerLifecycleKey(accountId, String(offerId || '')),
        offerId: String(offerId || ''),
        accountId,
        giveTokenId,
        wantTokenId,
        giveAmount,
        wantAmount,
        priceTicks,
        createdAt: Number(entry.createdHeight || 0),
        resolves,
        cancelRequested: Boolean(entry.cancelRequested),
      });
    }
  }
  return lifecycles;
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
      const resolves = Array.isArray(offer.resolves) ? offer.resolves : [];
      const latestResolveTs = resolves.length > 0 ? resolves[resolves.length - 1]!.height : offer.createdAt;
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
