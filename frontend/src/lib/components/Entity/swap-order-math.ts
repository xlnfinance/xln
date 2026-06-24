import {
  decimalPlacesFromScale,
  normalizeDisplayPriceForInput,
  parseDecimalAmountToBigInt,
} from './swap-formatting';

export const AGGREGATED_ORDERBOOK_DEPTH = 10;
export const SELECTED_ORDERBOOK_DEPTH = 10;
export const ORDERBOOK_PRICE_SCALE = 10_000n;
export const ORDERBOOK_LOT_SCALE = 10n ** 12n;
export const ORDERBOOK_SNAPSHOT_FRESH_MS = 10_000;
export const ORDERBOOK_PRICE_DECIMALS = decimalPlacesFromScale(ORDERBOOK_PRICE_SCALE);
export const MAX_PRICE_DEVIATION_BPS = 3000n;
export const MIN_ORDER_NOTIONAL_USD = 10;
export const FILLED_DISPLAY_PPM_THRESHOLD = 999_950n;

export type SwapOrderMode = 'buy-base' | 'sell-base' | 'none';
export type SwapTradeSide = 'buy-base' | 'sell-base';

export type PreparedSwapOrderLike = {
  side: 0 | 1;
  priceTicks: bigint;
  effectiveGive: bigint;
  effectiveWant: bigint;
  unspentGiveAmount: bigint;
};

export type SwapFormValidationInput = {
  isLive: boolean;
  entityId: string;
  counterpartyId: string;
  accountIds: string[];
  giveToken: number;
  wantToken: number;
  giveAmount: bigint;
  limitPriceTicks: bigint | null;
  wantAmount: bigint;
  wantTokenPresentInAccount: boolean;
  availableGiveCapacity: bigint;
  availableWantInCapacity: bigint;
  formattedAvailableGive: string;
  formattedAvailableWantIn: string;
  notionalUsd: number;
  referencePriceTicks: bigint | null;
};

export function formatSwapTokenAmount(amount: bigint, tokenDecimals: number): string {
  const decimals = BigInt(Math.max(0, Math.floor(tokenDecimals)));
  const one = 10n ** decimals;
  const whole = amount / one;
  const frac = amount % one;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(Number(decimals), '0').replace(/0+$/, '')}`;
}

export function formatSwapTokenAmountForInput(amount: bigint, tokenDecimals: number): string {
  const full = formatSwapTokenAmount(amount, tokenDecimals);
  const dotIndex = full.indexOf('.');
  if (dotIndex < 0) return full;
  const maxDecimals = Math.min(6, Math.max(0, Math.floor(tokenDecimals)));
  if (maxDecimals <= 0) return full.slice(0, dotIndex);
  const whole = full.slice(0, dotIndex);
  const frac = full.slice(dotIndex + 1, dotIndex + 1 + maxDecimals).replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

export function requantizeSwapOrderAtLimitPrice(input: {
  remainingGiveAmount: bigint;
  priceTicks: bigint;
  orderMode: SwapOrderMode;
  tradeSide: SwapTradeSide;
}): PreparedSwapOrderLike | null {
  if (input.remainingGiveAmount <= 0n || input.priceTicks <= 0n) return null;
  const activeMode = input.orderMode !== 'none' ? input.orderMode : input.tradeSide;
  const side = activeMode === 'sell-base' ? 1 : 0;
  if (side === 1) {
    const quantizedBaseAmount = (input.remainingGiveAmount / ORDERBOOK_LOT_SCALE) * ORDERBOOK_LOT_SCALE;
    if (quantizedBaseAmount <= 0n) return null;
    const quantizedQuoteAmount = (quantizedBaseAmount * input.priceTicks) / ORDERBOOK_PRICE_SCALE;
    if (quantizedQuoteAmount <= 0n) return null;
    return {
      side,
      priceTicks: input.priceTicks,
      effectiveGive: quantizedBaseAmount,
      effectiveWant: quantizedQuoteAmount,
      unspentGiveAmount: input.remainingGiveAmount - quantizedBaseAmount,
    };
  }
  const quantizedBaseAmount = ((input.remainingGiveAmount * ORDERBOOK_PRICE_SCALE) / input.priceTicks / ORDERBOOK_LOT_SCALE) * ORDERBOOK_LOT_SCALE;
  if (quantizedBaseAmount <= 0n) return null;
  const quantizedQuoteAmount = (quantizedBaseAmount * input.priceTicks) / ORDERBOOK_PRICE_SCALE;
  if (quantizedQuoteAmount <= 0n) return null;
  return {
    side,
    priceTicks: input.priceTicks,
    effectiveGive: quantizedQuoteAmount,
    effectiveWant: quantizedBaseAmount,
    unspentGiveAmount: input.remainingGiveAmount > quantizedQuoteAmount ? input.remainingGiveAmount - quantizedQuoteAmount : 0n,
  };
}

export function parseSwapDisplayPriceTicks(displayPrice: string, fallbackPriceTicks: bigint): bigint {
  const normalized = normalizeDisplayPriceForInput(displayPrice);
  const ticks = parseDecimalAmountToBigInt(normalized, ORDERBOOK_PRICE_DECIMALS);
  if (ticks <= 0n) return fallbackPriceTicks;
  return ticks > 0n ? ticks : fallbackPriceTicks;
}

export function computePriceDeviationBps(limitTicks: bigint, referenceTicks: bigint): bigint {
  if (limitTicks <= 0n || referenceTicks <= 0n) return 0n;
  const delta = limitTicks > referenceTicks ? limitTicks - referenceTicks : referenceTicks - limitTicks;
  return (delta * 10_000n) / referenceTicks;
}

export function validateSwapForm(input: SwapFormValidationInput): string {
  if (!input.isLive) return 'Switch to LIVE mode to place swap orders.';
  if (!input.entityId) return 'Entity is not selected.';
  if (!input.counterpartyId) return 'Select account (hub) first.';
  const hasCounterparty = input.accountIds.some(
    (id) => String(id || '').toLowerCase() === String(input.counterpartyId || '').toLowerCase(),
  );
  if (!hasCounterparty) return 'Selected account is not active.';
  if (!Number.isFinite(input.giveToken) || !Number.isFinite(input.wantToken) || input.giveToken <= 0 || input.wantToken <= 0) {
    return 'Select valid Sell and Buy tokens.';
  }
  if (input.giveToken === input.wantToken) return 'Sell token and Buy token must be different.';
  if (input.giveAmount <= 0n) return 'Enter amount to sell.';
  if (!input.limitPriceTicks || input.limitPriceTicks <= 0n) return 'Price is too small.';
  if (input.referencePriceTicks && input.referencePriceTicks > 0n) {
    const deviationBps = computePriceDeviationBps(input.limitPriceTicks, input.referencePriceTicks);
    if (deviationBps > MAX_PRICE_DEVIATION_BPS) {
      return 'Price must stay within 30% of the current orderbook.';
    }
  }
  if (input.wantAmount <= 0n) return 'Amount to receive is too small for selected price.';
  if (input.notionalUsd < MIN_ORDER_NOTIONAL_USD) {
    return `Minimum order size is ~$${MIN_ORDER_NOTIONAL_USD}.`;
  }
  if (!input.wantTokenPresentInAccount) {
    return 'Inbound token is not active in this account. Add token capacity first.';
  }
  if (input.giveAmount > input.availableGiveCapacity) {
    return `Insufficient outbound capacity (${input.formattedAvailableGive}).`;
  }
  if (input.wantAmount > input.availableWantInCapacity) {
    return `Insufficient inbound capacity (${input.formattedAvailableWantIn}).`;
  }
  return '';
}
