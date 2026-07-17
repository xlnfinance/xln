import { getTokenInfo } from './utils';
import {
  buildDefaultRebalanceBaseFee,
  buildDefaultRebalancePolicy,
  scaleRawTokenAmount,
  type RebalancePolicy,
} from '../types/rebalance';

const tokenDecimals = (tokenId: number): number => getTokenInfo(tokenId).decimals;

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

export const getDefaultRebalancePolicyForToken = (tokenId: number): RebalancePolicy =>
  buildDefaultRebalancePolicy(tokenDecimals(tokenId));

export const getDefaultRebalanceBaseFeeForToken = (tokenId: number): bigint =>
  buildDefaultRebalanceBaseFee(tokenDecimals(tokenId));

export const rescaleRawAmountBetweenTokens = (
  amount: bigint,
  sourceTokenId: number,
  targetTokenId: number,
): bigint => scaleRawTokenAmount(
  amount,
  tokenDecimals(sourceTokenId),
  tokenDecimals(targetTokenId),
);
