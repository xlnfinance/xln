import type { DeltaParts, DeltaVisualScale } from './delta-types';
import { amountToUsd, getAssetUsdPrice } from '$lib/utils/assetPricing';

export function buildTokenVisualScale(
  symbol: string,
  decimals: number,
  derived: DeltaParts,
): DeltaVisualScale | null {
  if (getAssetUsdPrice(symbol) <= 0) return null;

  const outOwnCreditUsd = amountToUsd(derived.outOwnCredit, decimals, symbol);
  const outCollateralUsd = amountToUsd(derived.outCollateral, decimals, symbol);
  const outPeerCreditUsd = amountToUsd(derived.outPeerCredit, decimals, symbol);
  const inOwnCreditUsd = amountToUsd(derived.inOwnCredit, decimals, symbol);
  const inCollateralUsd = amountToUsd(derived.inCollateral, decimals, symbol);
  const inPeerCreditUsd = amountToUsd(derived.inPeerCredit, decimals, symbol);
  const outCapacityUsd = amountToUsd(derived.outCapacity, decimals, symbol);
  const inCapacityUsd = amountToUsd(derived.inCapacity, decimals, symbol);

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
