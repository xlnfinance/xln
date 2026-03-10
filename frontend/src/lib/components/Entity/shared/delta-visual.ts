import type { DeltaParts, DeltaVisualScale } from './delta-types';
import { amountToUsd, getAssetUsdPrice } from '$lib/utils/assetPricing';

function fitComponentsToCapacity(
  componentsUsd: readonly number[],
  capacityUsd: number,
): number[] {
  const totalUsd = componentsUsd.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(capacityUsd) || capacityUsd <= 0 || totalUsd <= 0) {
    return componentsUsd.map(() => 0);
  }
  if (capacityUsd >= totalUsd) {
    return [...componentsUsd];
  }
  const ratio = capacityUsd / totalUsd;
  return componentsUsd.map((value) => value * ratio);
}

export function buildTokenVisualScale(
  symbol: string,
  decimals: number,
  derived: DeltaParts,
): DeltaVisualScale | null {
  if (getAssetUsdPrice(symbol) <= 0) return null;

  const outCapacityUsd = amountToUsd(derived.outCapacity, decimals, symbol);
  const inCapacityUsd = amountToUsd(derived.inCapacity, decimals, symbol);
  const outComponentsUsd = fitComponentsToCapacity(
    [
      amountToUsd(derived.outOwnCredit, decimals, symbol),
      amountToUsd(derived.outCollateral, decimals, symbol),
      amountToUsd(derived.outPeerCredit, decimals, symbol),
    ],
    outCapacityUsd,
  );
  const inComponentsUsd = fitComponentsToCapacity(
    [
      amountToUsd(derived.inOwnCredit, decimals, symbol),
      amountToUsd(derived.inCollateral, decimals, symbol),
      amountToUsd(derived.inPeerCredit, decimals, symbol),
    ],
    inCapacityUsd,
  );
  const outOwnCreditUsd = outComponentsUsd[0] ?? 0;
  const outCollateralUsd = outComponentsUsd[1] ?? 0;
  const outPeerCreditUsd = outComponentsUsd[2] ?? 0;
  const inOwnCreditUsd = inComponentsUsd[0] ?? 0;
  const inCollateralUsd = inComponentsUsd[1] ?? 0;
  const inPeerCreditUsd = inComponentsUsd[2] ?? 0;

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
