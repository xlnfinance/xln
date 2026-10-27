import { asTokenId, type TokenId } from '../tx/units';
import type { JurisdictionConfig } from '../../protocol/config/jurisdiction-config';
import type { RebalancePolicy } from '../../types/finance/rebalance';
import {
  hasTokenUsdRate,
  usdMicrosToTokenAmount,
  wholeUsdToTokenAmount,
} from '../../jurisdiction/machine/config/usd-reference-rate';

export const DEFAULT_ACCOUNT_TOKEN_IDS = [asTokenId(1), asTokenId(3), asTokenId(2)] as const; // USDC, USDT, WETH

type TokenlessHubRawOverrides = {
  c2rWithdrawSoftLimit?: bigint;
  rebalanceBaseFee?: bigint;
  rebalanceGasFee?: bigint;
};

export const tokenlessHubRawOverrideFields = (config: TokenlessHubRawOverrides): string[] =>
  [
    config.rebalanceBaseFee !== undefined ? 'rebalanceBaseFee' : '',
    config.c2rWithdrawSoftLimit !== undefined ? 'c2rWithdrawSoftLimit' : '',
    config.rebalanceGasFee !== undefined ? 'rebalanceGasFee' : '',
  ].filter(Boolean);

export const assertNoTokenlessHubRawOverrides = (config: TokenlessHubRawOverrides): void => {
  const forbidden = tokenlessHubRawOverrideFields(config);
  if (forbidden.length > 0) {
    throw new Error(`HUB_REBALANCE_TOKENLESS_RAW_OVERRIDE_FORBIDDEN:${forbidden.join(',')}`);
  }
};

/**
 * Default rebalance policy and fees exist only for catalog tokens. Account
 * deltas may hold any u16 token id (genesis add_delta, on-chain tokens beyond
 * the catalog), so every hub rebalance path checks this before pricing one.
 */
export const hasRebalanceTokenMetadata = (tokenId: TokenId): boolean => hasTokenUsdRate(tokenId);

// Protocol USD amounts; each converts to raw token units through the one
// committed catalog rate (usd-reference-rate.ts). Rust twins:
// `entity-kernel` hub_rebalance/open_account/credit_request, runtime inbound_genesis.
const DEFAULT_REBALANCE_POLICY_USD = { r2cRequestSoftLimit: 500n, hardLimit: 10_000n, maxFee: 15n } as const;
const REBALANCE_BASE_FEE_USD_MICROS = 100_000n; // $0.10
const CREDIT_REQUEST_CAP_USD = 1_000n;

const policyFromWholeUsd = (
  tokenId: TokenId,
  usd: { r2cRequestSoftLimit: bigint; hardLimit: bigint; maxFee: bigint },
): RebalancePolicy => {
  const r2cRequestSoftLimit = wholeUsdToTokenAmount(tokenId, usd.r2cRequestSoftLimit);
  const hardLimit = wholeUsdToTokenAmount(tokenId, usd.hardLimit);
  const maxAcceptableFee = wholeUsdToTokenAmount(tokenId, usd.maxFee);
  if (r2cRequestSoftLimit <= 0n || hardLimit < r2cRequestSoftLimit) {
    throw new Error(`REBALANCE_POLICY_USD_INVALID:token=${tokenId}`);
  }
  return { r2cRequestSoftLimit, hardLimit, maxAcceptableFee };
};

export const getDefaultRebalancePolicyForToken = (tokenId: TokenId): RebalancePolicy =>
  policyFromWholeUsd(tokenId, DEFAULT_REBALANCE_POLICY_USD);

export const getDefaultRebalanceBaseFeeForToken = (tokenId: TokenId): bigint =>
  usdMicrosToTokenAmount(tokenId, REBALANCE_BASE_FEE_USD_MICROS);

/**
 * Largest credit line a hub grants in answer to one committed
 * `credit_request`: $1,000 at the committed reference rate. Deterministic
 * protocol constant shared with Rust (`entity-kernel/src/account/credit_request.rs`).
 * `undefined` for a token without a catalog rate: no automatic grant.
 */
export const getCreditRequestCapForToken = (tokenId: TokenId): bigint | undefined =>
  hasTokenUsdRate(tokenId) ? wholeUsdToTokenAmount(tokenId, CREDIT_REQUEST_CAP_USD) : undefined;

const wholeUsd = (tokenId: TokenId, value: number): bigint => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`REBALANCE_POLICY_USD_INVALID:token=${tokenId}:value=${String(value)}`);
  }
  return BigInt(Math.floor(value));
};

/**
 * Both sides seed byte-identical Account rebalance policy from committed
 * jurisdiction config. No UI or ambient Runtime defaults enter this path.
 */
export const resolveJurisdictionRebalanceDefaults = (
  jurisdiction: JurisdictionConfig | undefined,
  tokenId: TokenId,
): RebalancePolicy => {
  const raw = jurisdiction?.rebalancePolicyUsd;
  if (!raw) return getDefaultRebalancePolicyForToken(tokenId);
  return policyFromWholeUsd(tokenId, {
    r2cRequestSoftLimit: wholeUsd(tokenId, raw.r2cRequestSoftLimit),
    hardLimit: wholeUsd(tokenId, raw.hardLimit),
    maxFee: wholeUsd(tokenId, raw.maxFee),
  });
};
