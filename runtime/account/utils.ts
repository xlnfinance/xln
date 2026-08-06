/**
 * Account utilities for calculating balances and derived states
 * Based on old_src/app/Channel.ts deriveDelta logic
 */

import type { Delta, DerivedDelta } from '../types/account';
import { PERFORMANCE } from '../config/constants';
import { validateDelta } from './delta-validation';
// Re-exported under its own name so callers that already reach for account
// utilities do not need a second import path for the LEFT tie-break.
export { isLeftEntity } from '../protocol/entity-id';
import { DEFAULT_TOKENS, TRON_ONLY_DEFAULT_TOKENS, defaultTokensForJurisdiction } from '../jurisdiction/machine/default-tokens';
import { logDebug } from '../infra/logger';

// CRITICAL: Default credit is 0 - credit must be explicitly extended via set_credit_limit
const BASE_CREDIT_LIMIT = 0n;
const nonNegative = (value: bigint): bigint => (value < 0n ? 0n : value);

type DeltaPerspective = Omit<DerivedDelta, 'delta' | 'collateral' | 'totalCapacity' | 'ascii'>;

type LeftDeltaDerivation = DeltaPerspective & {
  effectiveOwnCreditWindow: bigint;
  totalCapacity: bigint;
};

const deriveLeftPerspective = (delta: Delta, totalDelta: bigint, collateral: bigint): LeftDeltaDerivation => {
  const ownCreditLimit = delta.leftCreditLimit;
  const peerCreditLimit = delta.rightCreditLimit;
  const inCollateral = totalDelta > 0n ? nonNegative(collateral - totalDelta) : collateral;
  const outCollateral = totalDelta > 0n ? (totalDelta > collateral ? collateral : totalDelta) : 0n;
  // Drawn debt is historical exposure. A later limit reduction may block new
  // risk, but must never erase a signed receivable or repayment capacity.
  const inOwnCredit = nonNegative(-totalDelta);
  const outPeerCredit = nonNegative(totalDelta - collateral);
  const outOwnCredit = nonNegative(ownCreditLimit - inOwnCredit);
  const inPeerCredit = nonNegative(peerCreditLimit - outPeerCredit);
  const effectiveOwnCreditWindow = ownCreditLimit > inOwnCredit ? ownCreditLimit : inOwnCredit;
  const effectivePeerCreditWindow = peerCreditLimit > outPeerCredit ? peerCreditLimit : outPeerCredit;
  const leftHold = delta.leftHold;
  const rightHold = delta.rightHold;
  return {
    inCollateral,
    outCollateral,
    inOwnCredit,
    outPeerCredit,
    inAllowance: delta.rightAllowance,
    outAllowance: delta.leftAllowance,
    ownCreditLimit,
    peerCreditLimit,
    inCapacity: nonNegative(inOwnCredit + inCollateral + inPeerCredit - delta.rightAllowance - rightHold),
    outCapacity: nonNegative(outPeerCredit + outCollateral + outOwnCredit - delta.leftAllowance - leftHold),
    outOwnCredit,
    inPeerCredit,
    peerCreditUsed: inOwnCredit,
    ownCreditUsed: outPeerCredit,
    outTotalHold: leftHold,
    inTotalHold: rightHold,
    effectiveOwnCreditWindow,
    totalCapacity: collateral + effectiveOwnCreditWindow + effectivePeerCreditWindow,
  };
};

const flipDeltaPerspective = (left: DeltaPerspective): DeltaPerspective => ({
  inCollateral: left.outCollateral,
  outCollateral: left.inCollateral,
  inOwnCredit: left.outPeerCredit,
  outPeerCredit: left.inOwnCredit,
  inAllowance: left.outAllowance,
  outAllowance: left.inAllowance,
  ownCreditLimit: left.peerCreditLimit,
  peerCreditLimit: left.ownCreditLimit,
  inCapacity: left.outCapacity,
  outCapacity: left.inCapacity,
  outOwnCredit: left.inPeerCredit,
  inPeerCredit: left.outOwnCredit,
  peerCreditUsed: left.ownCreditUsed,
  ownCreditUsed: left.peerCreditUsed,
  outTotalHold: left.inTotalHold,
  inTotalHold: left.outTotalHold,
});

const formatDeltaAscii = (
  totalDelta: bigint,
  collateral: bigint,
  totalCapacity: bigint,
  effectiveOwnCreditWindow: bigint,
): string => {
  const totalWidth = Number(totalCapacity);
  const width = Number.isFinite(totalWidth) && totalWidth > 0 ? totalWidth : 1;
  const leftCreditWidth = Math.floor((Number(effectiveOwnCreditWindow) / width) * 50);
  const collateralWidth = Math.floor((Number(collateral) / width) * 50);
  const rightCreditWidth = 50 - leftCreditWidth - collateralWidth;
  const marker = Math.floor(((Number(totalDelta) + Number(effectiveOwnCreditWindow)) / width) * 50);
  const bar = '-'.repeat(leftCreditWidth) + '='.repeat(collateralWidth) + '-'.repeat(rightCreditWidth);
  const position = Math.max(0, Math.min(marker, bar.length));
  return `[${bar.substring(0, position)}|${bar.substring(position)}]`;
};

/**
 * Derive account balance information for a specific token
 *
 * [---.*∆--][FOUNDATIONAL-MEMORY]
 * deriveDelta() is the single source of truth for bilateral account math.
 * All runtime/business logic (rebalance, routing, UI, tests) must interpret
 * balances through this function instead of ad-hoc formulas.
 *
 * [---.*∆--][CORE-IDENTITY]
 * delta == ondelta + offdelta
 *
 * [---.*∆--][PERSPECTIVE-RULE]
 * This function computes values in LEFT perspective first, then flips to RIGHT
 * perspective when isLeft=false.
 *
 * [---.*∆--][CAPACITY-DECOMPOSITION]
 * outCapacity == outOwnCredit + outCollateral + outPeerCredit - outAllowance - outHolds
 * inCapacity  == inOwnCredit  + inCollateral  + inPeerCredit  - inAllowance  - inHolds
 *
 * [---.*∆--][INTUITION]
 * out* => what "we" can send now from current perspective
 * in*  => what "we" can receive now from current perspective
 *
 * [---.*∆--][NO-ALTERNATE-MATH]
 * If you need new semantics, add a helper that wraps deriveDelta fields.
 * Do not introduce parallel balance models.
 *
 * @param delta - The delta structure for this token
 * @param isLeft - Whether we are the left party in this account
 * @returns Derived balance information including capacities and credits
 */
export function deriveDelta(delta: Delta, isLeft: boolean): DerivedDelta {
  validateDelta(delta, 'deriveDelta');
  const totalDelta = delta.ondelta + delta.offdelta;
  const collateral = nonNegative(delta.collateral);
  const left = deriveLeftPerspective(delta, totalDelta, collateral);
  const { effectiveOwnCreditWindow, totalCapacity, ...leftPerspective } = left;
  const perspective = isLeft ? leftPerspective : flipDeltaPerspective(leftPerspective);
  const ascii = formatDeltaAscii(totalDelta, collateral, totalCapacity, effectiveOwnCreditWindow);

  if (PERFORMANCE.DEBUG_ACCOUNTS) {
    logDebug('ACCOUNT_STATE', 'deriveDelta.return', {
      isLeft,
      inCapacity: perspective.inCapacity,
      outCapacity: perspective.outCapacity,
      capacitySum: perspective.inCapacity + perspective.outCapacity,
    });
  }

  return {
    delta: totalDelta,
    collateral,
    ...perspective,
    totalCapacity,
    ascii,
  };
}

/**
 * Create a simple delta for demo purposes
 * @param tokenId - Token ID
 * @param collateral - Collateral amount
 * @param delta - Delta amount
 * @returns Delta object with reasonable defaults
 */
export function createDemoDelta(tokenId: number, collateral: bigint = 1000n, delta: bigint = 0n): Delta {
  const creditLimit = getDefaultCreditLimit(tokenId);

  const deltaData = {
    tokenId,
    collateral,
    ondelta: delta,
    offdelta: 0n,
    leftCreditLimit: creditLimit,
    rightCreditLimit: creditLimit,
    leftAllowance: 0n,
    rightAllowance: 0n,
  };

  // VALIDATE AT SOURCE: Guarantee type safety from this point forward
  return validateDelta(deltaData, 'createDemoDelta');
}

/**
 * Get token information for display
 * USDC is primary token (1), ETH is secondary (2)
 */
const TOKEN_COLORS = ['#2775ca', '#627eea', '#26a17b', '#ef0027', '#f59e0b'] as const;
export const TOKEN_REGISTRY: Record<number, { symbol: string; name: string; decimals: number; color: string }> =
  Object.fromEntries(
    [...DEFAULT_TOKENS, ...TRON_ONLY_DEFAULT_TOKENS].map((token, index) => [
      index + 1,
      { ...token, color: TOKEN_COLORS[index]! },
    ]),
  );

const TOKEN_ID_BY_SYMBOL = new Map(
  Object.entries(TOKEN_REGISTRY).map(([tokenId, info]) => [info.symbol.toUpperCase(), Number(tokenId)] as const),
);

export function getKnownTokenIds(): number[] {
  return Object.keys(TOKEN_REGISTRY)
    .map(tokenId => Number(tokenId))
    .filter(tokenId => Number.isFinite(tokenId) && tokenId > 0)
    .sort((a, b) => a - b);
}

export function getTokenIdsForJurisdiction(
  input?: { name?: string | null; chainId?: number | null } | string | null,
): number[] {
  return defaultTokensForJurisdiction(input)
    .map(token => TOKEN_ID_BY_SYMBOL.get(String(token.symbol || '').toUpperCase()) ?? 0)
    .filter(tokenId => Number.isFinite(tokenId) && tokenId > 0);
}

// Canonical USD reference stables used for quote-side orientation in swap pairs.
// Prices for volatile/non-reference assets are displayed and quoted as stable per 1 asset.
export const REFERENCE_STABLE_TOKEN_IDS = new Set<number>([1, 3]); // USDC, USDT
export const DEFAULT_ENTITY_SWAP_PAIR_TOKENS = [1, 2, 3] as const;
export type EntitySwapPairConfig = {
  baseTokenId: number;
  quoteTokenId: number;
  pairId: string;
};

export function getTokenInfo(tokenId: number) {
  const token = TOKEN_REGISTRY[tokenId];
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0 || !token) {
    throw new Error(`TOKEN_METADATA_UNAVAILABLE:${String(tokenId)}`);
  }
  return token;
}

export function isLiquidSwapToken(tokenId: number): boolean {
  return REFERENCE_STABLE_TOKEN_IDS.has(tokenId);
}

export function getSwapPairOrientation(
  tokenA: number,
  tokenB: number,
): { baseTokenId: number; quoteTokenId: number; pairId: string } {
  const left = Math.min(tokenA, tokenB);
  const right = Math.max(tokenA, tokenB);
  const pairId = `${left}/${right}`;

  const aLiquid = isLiquidSwapToken(tokenA);
  const bLiquid = isLiquidSwapToken(tokenB);

  if (aLiquid && !bLiquid) {
    return { baseTokenId: tokenB, quoteTokenId: tokenA, pairId };
  }
  if (!aLiquid && bLiquid) {
    return { baseTokenId: tokenA, quoteTokenId: tokenB, pairId };
  }

  return { baseTokenId: left, quoteTokenId: right, pairId };
}

export type SwapPairPolicy = {
  // Price step in ORDERBOOK_PRICE_SCALE ticks (ORDERBOOK_PRICE_SCALE=10_000 => 0.0001 precision).
  priceStepTicks: number;
  // Outer bucket width for orderbook indexing (exact prices still remain exact inside buckets).
  bookBucketWidthTicks: number;
  // MM mid price in ORDERBOOK_PRICE_SCALE ticks (quote per 1 base).
  mmMidPriceTicks: bigint;
};

const DEFAULT_SWAP_PAIR_POLICY: SwapPairPolicy = {
  priceStepTicks: 1, // 0.0001
  bookBucketWidthTicks: 10_000, // 1.0000
  mmMidPriceTicks: 10_000n, // 1.0000
};

const SWAP_PAIR_POLICY_BY_BASE_QUOTE: Record<string, SwapPairPolicy> = {
  // WETH/USDC
  '2/1': {
    priceStepTicks: 1, // 0.0001 USDC per WETH
    bookBucketWidthTicks: 10_000, // 1.0000
    mmMidPriceTicks: 25_000_000n, // 2500.0000
  },
  // WETH/USDT
  '2/3': {
    priceStepTicks: 1, // 0.0001 USDT per WETH
    bookBucketWidthTicks: 10_000, // 1.0000
    mmMidPriceTicks: 25_000_000n, // 2500.0000
  },
  // USDC/USDT
  '1/3': {
    priceStepTicks: 1, // 0.0001
    bookBucketWidthTicks: 10_000, // 1.0000
    mmMidPriceTicks: 10_000n, // 1.0000
  },
  // TRX/USDC
  '4/1': {
    priceStepTicks: 1, // 0.0001 USDC per TRX
    bookBucketWidthTicks: 100, // 0.0100
    mmMidPriceTicks: 1_200n, // 0.1200
  },
  // TRX/USDT
  '4/3': {
    priceStepTicks: 1, // 0.0001 USDT per TRX
    bookBucketWidthTicks: 100, // 0.0100
    mmMidPriceTicks: 1_200n, // 0.1200
  },
  // SUN/USDC
  '5/1': {
    priceStepTicks: 1, // 0.0001 USDC per SUN
    bookBucketWidthTicks: 10, // 0.0010
    mmMidPriceTicks: 200n, // 0.0200
  },
  // SUN/USDT
  '5/3': {
    priceStepTicks: 1, // 0.0001 USDT per SUN
    bookBucketWidthTicks: 10, // 0.0010
    mmMidPriceTicks: 200n, // 0.0200
  },
};

export function getSwapPairPolicy(tokenA: number, tokenB: number): SwapPairPolicy {
  const oriented = getSwapPairOrientation(tokenA, tokenB);
  return getSwapPairPolicyByBaseQuote(oriented.baseTokenId, oriented.quoteTokenId);
}

export function getSwapPairPolicyByBaseQuote(baseTokenId: number, quoteTokenId: number): SwapPairPolicy {
  const key = `${baseTokenId}/${quoteTokenId}`;
  return SWAP_PAIR_POLICY_BY_BASE_QUOTE[key] ?? DEFAULT_SWAP_PAIR_POLICY;
}

export function hasSwapPairPolicyByBaseQuote(baseTokenId: number, quoteTokenId: number): boolean {
  const key = `${baseTokenId}/${quoteTokenId}`;
  return Object.prototype.hasOwnProperty.call(SWAP_PAIR_POLICY_BY_BASE_QUOTE, key);
}

export function buildDefaultEntitySwapPairs(
  tokenIds: readonly number[] = DEFAULT_ENTITY_SWAP_PAIR_TOKENS,
): EntitySwapPairConfig[] {
  const pairs: EntitySwapPairConfig[] = [];
  const seen = new Set<string>();
  const uniqueTokenIds = Array.from(new Set(tokenIds.filter(id => Number.isFinite(id) && id > 0)));

  for (let i = 0; i < uniqueTokenIds.length; i++) {
    for (let j = i + 1; j < uniqueTokenIds.length; j++) {
      const left = uniqueTokenIds[i]!;
      const right = uniqueTokenIds[j]!;
      if (left === right) continue;
      const oriented = getSwapPairOrientation(left, right);
      const key = `${oriented.baseTokenId}/${oriented.quoteTokenId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        baseTokenId: oriented.baseTokenId,
        quoteTokenId: oriented.quoteTokenId,
        pairId: oriented.pairId,
      });
    }
  }

  const primaryPair = getSwapPairOrientation(1, 2); // WETH/USDC orientation key
  const primaryKey = `${primaryPair.baseTokenId}/${primaryPair.quoteTokenId}`;

  return pairs.sort((a, b) => {
    const aKey = `${a.baseTokenId}/${a.quoteTokenId}`;
    const bKey = `${b.baseTokenId}/${b.quoteTokenId}`;
    if (aKey === primaryKey && bKey !== primaryKey) return -1;
    if (bKey === primaryKey && aKey !== primaryKey) return 1;
    if (a.quoteTokenId !== b.quoteTokenId) return a.quoteTokenId - b.quoteTokenId;
    return a.baseTokenId - b.baseTokenId;
  });
}

export function getDefaultSwapTradingPairs(): EntitySwapPairConfig[] {
  return buildDefaultEntitySwapPairs(DEFAULT_ENTITY_SWAP_PAIR_TOKENS);
}

/**
 * Default per-token credit limit scaled to token decimals (matches old account behavior)
 */
export function getDefaultCreditLimit(tokenId: number): bigint {
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    throw new Error(`TOKEN_ID_INVALID:${String(tokenId)}`);
  }
  return BASE_CREDIT_LIMIT;
}
