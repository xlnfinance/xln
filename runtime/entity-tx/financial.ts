/** Asset balance in smallest unit (wei, cents, shares) */
interface AssetBalance {
  amount: bigint;
}

// Financial helpers: formatAssetAmount, addToReserves, subtractFromReserves
// Use unified financial utilities with ethers.js
export { formatAssetAmount } from '../financial-utils';

export const addToReserves = (
  reserves: Map<string, AssetBalance>,
  symbol: string,
  amount: bigint,
  _decimals: number,
  _contractAddress?: string,
): void => {
  const existing = reserves.get(symbol);
  if (existing) {
    existing.amount += amount;
  } else {
    reserves.set(symbol, { amount });
  }
};

export const subtractFromReserves = (reserves: Map<string, AssetBalance>, symbol: string, amount: bigint): boolean => {
  const existing = reserves.get(symbol);
  if (!existing || existing.amount < amount) {
    return false; // Insufficient balance
  }
  existing.amount -= amount;
  if (existing.amount === 0n) {
    reserves.delete(symbol);
  }
  return true;
};
