import { getAssetUsdPrice } from '$lib/utils/assetPricing';
import { getAssetValueUsd } from '$lib/components/Entity/assets/entity-asset-values';
import { getTokenMeta } from '../format';

/**
 * USD valuation for the visceral scale. Same static reference table the
 * SvelteKit frontend renders with; one source, two shells.
 */
export function usdOf(tokenId: number, amount: bigint): number {
	const meta = getTokenMeta(tokenId);
	if (meta.symbol === '?' || getAssetUsdPrice(meta.symbol) <= 0) return 0;
	return getAssetValueUsd(amount, meta);
}

export function hasUsdPrice(tokenId: number): boolean {
	const meta = getTokenMeta(tokenId);
	return meta.symbol !== '?' && getAssetUsdPrice(meta.symbol) > 0;
}

export function isUsdStable(tokenId: number): boolean {
	return hasUsdPrice(tokenId) && getAssetUsdPrice(getTokenMeta(tokenId).symbol) === 1;
}
