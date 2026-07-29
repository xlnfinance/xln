/**
 * Jurisdiction-derived rebalance policy defaults.
 *
 * Both sides of an account must seed the same local rebalance policy. The
 * opening side seeds it from its openAccount handler; the side that first sees
 * the account through an inbound genesis frame seeds it here. Without this the
 * receiving side keeps an empty policy map forever, and checkAutoRebalance
 * returns early, so that side can never auto-request collateral.
 *
 * Values come only from consensus-visible entity config, so every replica of an
 * entity derives byte-identical policies.
 */

import type { JurisdictionConfig } from '../protocol/jurisdiction-config';
import { getTokenInfo } from './utils';
import { scaleWholeTokenAmount } from '../types/rebalance';
import { getDefaultRebalancePolicyForToken } from './rebalance-defaults';

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
