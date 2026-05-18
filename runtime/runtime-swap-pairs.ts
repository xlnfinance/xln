import {
  getDefaultSwapTradingPairs,
  getSwapPairOrientation,
} from './account-utils';

type RuntimeSwapTradingPairsState = {
  swapTradingPairs?: Array<{ baseTokenId: number; quoteTokenId: number; pairId?: string }>;
};

export function normalizeEntitySwapTradingPairs(state: RuntimeSwapTradingPairsState): void {
  const inputPairs = Array.isArray(state.swapTradingPairs) ? state.swapTradingPairs : [];
  const normalized: Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }> = [];
  const defaultPairs = getDefaultSwapTradingPairs();
  const allowedKeys = new Set(defaultPairs.map((pair) => `${pair.baseTokenId}/${pair.quoteTokenId}`));
  const seen = new Set<string>();

  for (const pair of inputPairs) {
    const left = Number(pair?.baseTokenId);
    const right = Number(pair?.quoteTokenId);
    if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0 || left === right) continue;
    const oriented = getSwapPairOrientation(left, right);
    const key = `${oriented.baseTokenId}/${oriented.quoteTokenId}`;
    if (!allowedKeys.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      baseTokenId: oriented.baseTokenId,
      quoteTokenId: oriented.quoteTokenId,
      pairId: oriented.pairId,
    });
  }

  const primary = getSwapPairOrientation(1, 2); // WETH/USDC
  const primaryKey = `${primary.baseTokenId}/${primary.quoteTokenId}`;
  const basePairs = normalized.length > 0 ? [...normalized] : [...defaultPairs];
  for (const pair of defaultPairs) {
    const key = `${pair.baseTokenId}/${pair.quoteTokenId}`;
    if (basePairs.some((candidate) => `${candidate.baseTokenId}/${candidate.quoteTokenId}` === key)) continue;
    basePairs.push(pair);
  }

  const ordered = basePairs.sort((a, b) => {
    const aKey = `${a.baseTokenId}/${a.quoteTokenId}`;
    const bKey = `${b.baseTokenId}/${b.quoteTokenId}`;
    if (aKey === primaryKey && bKey !== primaryKey) return -1;
    if (bKey === primaryKey && aKey !== primaryKey) return 1;
    if (a.quoteTokenId !== b.quoteTokenId) return a.quoteTokenId - b.quoteTokenId;
    return a.baseTokenId - b.baseTokenId;
  });

  state.swapTradingPairs = ordered;
}
