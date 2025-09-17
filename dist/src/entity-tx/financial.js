// Financial helpers: formatAssetAmount, addToReserves, subtractFromReserves
export const formatAssetAmount = (balance) => {
    const divisor = BigInt(10) ** BigInt(balance.decimals);
    const wholePart = balance.amount / divisor;
    const fractionalPart = balance.amount % divisor;
    if (fractionalPart === 0n) {
        return `${wholePart} ${balance.symbol}`;
    }
    const fractionalStr = fractionalPart.toString().padStart(balance.decimals, '0');
    return `${wholePart}.${fractionalStr} ${balance.symbol}`;
};
export const addToReserves = (reserves, symbol, amount, decimals, contractAddress) => {
    const existing = reserves.get(symbol);
    if (existing) {
        existing.amount += amount;
    }
    else {
        reserves.set(symbol, { symbol, amount, decimals, contractAddress });
    }
};
export const subtractFromReserves = (reserves, symbol, amount) => {
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
