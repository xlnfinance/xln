import { amountToUsd, getAssetUsdPrice } from '$lib/utils/assetPricing';
import { getTokenMeta } from '../format';

/**
 * USD valuation for the visceral scale. Same static reference table the
 * SvelteKit frontend renders with; one source, two shells.
 */
export function usdOf(tokenId: number, amount: bigint): number {
	if (amount <= 0n) return 0;
	const meta = getTokenMeta(tokenId);
	if (meta.symbol === '?' || getAssetUsdPrice(meta.symbol) <= 0) return 0;
	return amountToUsd(amount, meta.decimals, meta.symbol);
}

export function hasUsdPrice(tokenId: number): boolean {
	const meta = getTokenMeta(tokenId);
	return meta.symbol !== '?' && getAssetUsdPrice(meta.symbol) > 0;
}

export function isUsdStable(tokenId: number): boolean {
	return hasUsdPrice(tokenId) && getAssetUsdPrice(getTokenMeta(tokenId).symbol) === 1;
}
