import type { DeltaParts, DeltaVisualScale } from './delta-types';

const VISUAL_USD_PRICES: Record<string, number> = {
  USDC: 1,
  USDT: 1,
  ETH: 3500,
  WETH: 3500,
};

function amountToUsd(amount: bigint, decimals: number, priceUsd: number): number {
  if (amount <= 0n || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0;
  const normalizedDecimals = Math.max(0, Math.min(18, Math.floor(decimals)));
  const scale = 10n ** BigInt(normalizedDecimals);
  const whole = amount / scale;
  const fraction = amount % scale;
  const wholeAsNumber = Number(whole);
  if (!Number.isFinite(wholeAsNumber)) return 0;
  const fractionMicros = Number((fraction * 1_000_000n) / scale) / 1_000_000;
  return (wholeAsNumber + fractionMicros) * priceUsd;
}

export function buildTokenVisualScale(
  symbol: string,
  decimals: number,
  derived: DeltaParts,
): DeltaVisualScale | null {
  const priceUsd = VISUAL_USD_PRICES[String(symbol || '').toUpperCase()];
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const outOwnCreditUsd = amountToUsd(derived.outOwnCredit, decimals, priceUsd);
  const outCollateralUsd = amountToUsd(derived.outCollateral, decimals, priceUsd);
  const outPeerCreditUsd = amountToUsd(derived.outPeerCredit, decimals, priceUsd);
  const inOwnCreditUsd = amountToUsd(derived.inOwnCredit, decimals, priceUsd);
  const inCollateralUsd = amountToUsd(derived.inCollateral, decimals, priceUsd);
  const inPeerCreditUsd = amountToUsd(derived.inPeerCredit, decimals, priceUsd);
  const outCapacityUsd = amountToUsd(derived.outCapacity, decimals, priceUsd);
  const inCapacityUsd = amountToUsd(derived.inCapacity, decimals, priceUsd);

  return {
    outCapacityUsd,
    inCapacityUsd,
    outOwnCreditUsd,
    outCollateralUsd,
    outPeerCreditUsd,
    inOwnCreditUsd,
    inCollateralUsd,
    inPeerCreditUsd,
    outTotalUsd: outOwnCreditUsd + outCollateralUsd + outPeerCreditUsd,
    inTotalUsd: inOwnCreditUsd + inCollateralUsd + inPeerCreditUsd,
  };
}

export function sumVisualScales(scales: Array<DeltaVisualScale | null | undefined>): DeltaVisualScale | null {
  let hasAny = false;
  let outCapacityUsd = 0;
  let inCapacityUsd = 0;
  let outOwnCreditUsd = 0;
  let outCollateralUsd = 0;
  let outPeerCreditUsd = 0;
  let inOwnCreditUsd = 0;
  let inCollateralUsd = 0;
  let inPeerCreditUsd = 0;

  for (const scale of scales) {
    if (!scale) continue;
    hasAny = true;
    outCapacityUsd += scale.outCapacityUsd;
    inCapacityUsd += scale.inCapacityUsd;
    outOwnCreditUsd += scale.outOwnCreditUsd;
    outCollateralUsd += scale.outCollateralUsd;
    outPeerCreditUsd += scale.outPeerCreditUsd;
    inOwnCreditUsd += scale.inOwnCreditUsd;
    inCollateralUsd += scale.inCollateralUsd;
    inPeerCreditUsd += scale.inPeerCreditUsd;
  }

  if (!hasAny) return null;

  return {
    outCapacityUsd,
    inCapacityUsd,
    outOwnCreditUsd,
    outCollateralUsd,
    outPeerCreditUsd,
    inOwnCreditUsd,
    inCollateralUsd,
    inPeerCreditUsd,
    outTotalUsd: outOwnCreditUsd + outCollateralUsd + outPeerCreditUsd,
    inTotalUsd: inOwnCreditUsd + inCollateralUsd + inPeerCreditUsd,
  };
}
