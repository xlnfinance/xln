import type { JurisdictionConfig } from '../../protocol/jurisdiction-config';
import {
  buildDefaultRebalanceBaseFee,
  buildDefaultRebalancePolicy,
  scaleWholeTokenAmount,
  type RebalancePolicy,
} from '../../types/rebalance';
import { getTokenInfo } from '../utils';

export const DEFAULT_ACCOUNT_TOKEN_IDS = [1, 3, 2] as const; // USDC, USDT, WETH

type TokenlessHubRawOverrides = {
  c2rWithdrawSoftLimit?: bigint;
  rebalanceBaseFee?: bigint;
  rebalanceGasFee?: bigint;
};

export const assertNoTokenlessHubRawOverrides = (config: TokenlessHubRawOverrides): void => {
  const forbidden = [
    config.rebalanceBaseFee !== undefined ? 'rebalanceBaseFee' : '',
    config.c2rWithdrawSoftLimit !== undefined ? 'c2rWithdrawSoftLimit' : '',
    config.rebalanceGasFee !== undefined ? 'rebalanceGasFee' : '',
  ].filter(Boolean);
  if (forbidden.length > 0) {
    throw new Error(`HUB_REBALANCE_TOKENLESS_RAW_OVERRIDE_FORBIDDEN:${forbidden.join(',')}`);
  }
};

const tokenDecimals = (tokenId: number): number => getTokenInfo(tokenId).decimals;

export const getDefaultRebalancePolicyForToken = (tokenId: number): RebalancePolicy =>
  buildDefaultRebalancePolicy(tokenDecimals(tokenId));

export const getDefaultRebalanceBaseFeeForToken = (tokenId: number): bigint =>
  buildDefaultRebalanceBaseFee(tokenDecimals(tokenId));

export type ResolvedRebalancePolicy = {
  r2cRequestSoftLimit: bigint;
  hardLimit: bigint;
  maxAcceptableFee: bigint;
};

const scaleWholePolicyAmount = (tokenId: number, value: number): bigint => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`REBALANCE_POLICY_USD_INVALID:token=${tokenId}:value=${String(value)}`);
  }
  return scaleWholeTokenAmount(BigInt(Math.floor(value)), getTokenInfo(tokenId).decimals);
};

/**
 * Both sides seed byte-identical Account rebalance policy from committed
 * jurisdiction config. No UI or ambient Runtime defaults enter this path.
 */
export const resolveJurisdictionRebalanceDefaults = (
  jurisdiction: JurisdictionConfig | undefined,
  tokenId: number,
): ResolvedRebalancePolicy => {
  const raw = jurisdiction?.rebalancePolicyUsd;
  if (!raw) return getDefaultRebalancePolicyForToken(tokenId);
  const r2cRequestSoftLimit = scaleWholePolicyAmount(tokenId, raw.r2cRequestSoftLimit);
  const hardLimit = scaleWholePolicyAmount(tokenId, raw.hardLimit);
  const maxAcceptableFee = scaleWholePolicyAmount(tokenId, raw.maxFee);
  if (r2cRequestSoftLimit <= 0n || hardLimit < r2cRequestSoftLimit) {
    throw new Error(`REBALANCE_POLICY_USD_INVALID:token=${tokenId}`);
  }
  return { r2cRequestSoftLimit, hardLimit, maxAcceptableFee };
};
