import type { EntityReplica } from '$lib/types/ui';
import type { FrontendXlnFunctions } from '$lib/stores/xlnStore';
import { amountToUsd } from '$lib/utils/assetPricing';
import type { SwapAccountCapacityView, SwapInboundCapacityPlan } from '@xln/runtime/api/public/runtime-module';
import {
  defaultAccountDisputeConfigForRoleEvidence,
  type AccountRoleEvidence,
} from '@xln/runtime/account/config/dispute-config';
import { compareStableText } from './swap-formatting';
import { type PreparedSwapOrderLike } from './swap-order-math';
import './SwapPanel.css';

export type BookSide = 'bid' | 'ask';

export type ClickedOrderLevel = {
  side: BookSide;
  priceTicks: bigint;
  displayPrice: string;
  inputPriceTicks: bigint;
  baseTokenId: number;
  quoteTokenId: number;
  accountId: string;
  accountIds: string[];
};

export type CrossTargetOption = {
  value: string;
  label: string;
  targetEntityId: string;
  targetSignerId: string;
  targetHubEntityId: string;
  targetIsHub: boolean;
  targetHubIsHub: boolean;
  targetJurisdiction: string;
  targetJurisdictionRef: string;
  hasTargetAccount: boolean;
};

export type SourceEntityOption = {
  value: string;
  label: string;
  name: string;
  entityId: string;
  signerId: string;
  jurisdiction: string;
  replica: EntityReplica;
};

export type SwapRouteOption = {
  value: string;
  label: string;
  mode: 'same' | 'cross';
  sourceJurisdiction: string;
  targetJurisdiction: string;
  sourceEntityId: string;
  sourceHubEntityId: string;
  targetEntityId: string;
  targetHubEntityId: string;
  sourceJurisdictionRef: string;
  targetJurisdictionRef: string;
  targetLabel: string;
  disabled?: boolean;
  disabledReason?: string;
};

export type PairOption = {
  value: string;
  label: string;
  pairId: string;
  baseTokenId: number;
  quoteTokenId: number;
  liquidScore: number;
};

type SwapPanelCoreDeps = {
  getRuntime(): FrontendXlnFunctions | null | undefined;
  getCurrentReplica(): EntityReplica | null | undefined;
  tokenSymbol(tokenId: number): string;
  getTokenDecimals(tokenId: number): number;
};

/** Pure and read-only swap helpers shared by every ticket presentation. */
export const createSwapPanelCore = (deps: SwapPanelCoreDeps) => {
  const { tokenSymbol, getTokenDecimals } = deps;

  function readAccountCapacityForReplica(
    candidate: EntityReplica | null | undefined,
    ownerEntityId: string,
    counterpartyEntityId: string,
    tokenIdValue: number,
  ): SwapAccountCapacityView | null {
    const runtime = deps.getRuntime();
    if (!runtime?.readSwapAccountCapacity) return null;
    const owner = String(ownerEntityId || '')
      .trim()
      .toLowerCase();
    const counterparty = String(counterpartyEntityId || '')
      .trim()
      .toLowerCase();
    if (!candidate || !owner || !counterparty || !Number.isSafeInteger(tokenIdValue) || tokenIdValue <= 0) return null;
    const account = candidate.state?.accounts?.get?.(counterparty);
    return runtime.readSwapAccountCapacity({
      account: account?.state ?? null,
      ownerEntityId: owner,
      counterpartyEntityId: counterparty,
      tokenId: tokenIdValue,
    });
  }

  function hasTokenInReplicaAccount(
    candidate: EntityReplica | null | undefined,
    ownerEntityId: string,
    counterpartyEntityId: string,
    tokenIdValue: number,
  ): boolean {
    return (
      readAccountCapacityForReplica(candidate, ownerEntityId, counterpartyEntityId, tokenIdValue)?.tokenActive ?? false
    );
  }

  function readInCapacityForReplica(
    candidate: EntityReplica | null | undefined,
    ownerEntityId: string,
    counterpartyEntityId: string,
    tokenIdValue: number,
  ): bigint {
    return (
      readAccountCapacityForReplica(candidate, ownerEntityId, counterpartyEntityId, tokenIdValue)?.inCapacity ?? 0n
    );
  }

  function defaultTradingPairOrientations(): Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }> {
    const runtimeRequiredPairs = deps.getRuntime()?.getDefaultSwapTradingPairs?.() || [];
    const requiredPairs =
      runtimeRequiredPairs.length > 0
        ? runtimeRequiredPairs.map(pair => resolvePairOrientation(Number(pair.baseTokenId), Number(pair.quoteTokenId)))
        : [resolvePairOrientation(1, 2), resolvePairOrientation(2, 3), resolvePairOrientation(1, 3)];
    const seen = new Set<string>();
    return requiredPairs.filter(pair => {
      const key = `${pair.baseTokenId}/${pair.quoteTokenId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function resolvePairOrientation(
    tokenA: number,
    tokenB: number,
  ): { baseTokenId: number; quoteTokenId: number; pairId: string } {
    const runtimeResolver = deps.getRuntime()?.getSwapPairOrientation;
    if (runtimeResolver) return runtimeResolver(tokenA, tokenB);
    const left = Math.min(tokenA, tokenB);
    const right = Math.max(tokenA, tokenB);
    const pairId = `${left}/${right}`;
    const isLiquid = (id: number) => id === 1 || id === 3;
    if (isLiquid(tokenA) && !isLiquid(tokenB)) return { baseTokenId: tokenB, quoteTokenId: tokenA, pairId };
    if (!isLiquid(tokenA) && isLiquid(tokenB)) return { baseTokenId: tokenA, quoteTokenId: tokenB, pairId };
    return { baseTokenId: left, quoteTokenId: right, pairId };
  }

  function isLiquidToken(tokenIdValue: number): boolean {
    const runtimeChecker = deps.getRuntime()?.isLiquidSwapToken;
    if (runtimeChecker) return runtimeChecker(tokenIdValue);
    return tokenIdValue === 1 || tokenIdValue === 3;
  }

  function tokenIdsForJurisdiction(jurisdiction: string): number[] {
    const cleanJurisdiction = String(jurisdiction || '').trim();
    if (!cleanJurisdiction) return [];
    const resolver = deps.getRuntime()?.getTokenIdsForJurisdiction;
    if (!resolver) return [1, 2, 3];
    try {
      return resolver(cleanJurisdiction)
        .map(tokenId => Number(tokenId))
        .filter(tokenId => Number.isFinite(tokenId) && tokenId > 0);
    } catch {
      return [1, 2, 3];
    }
  }

  function buildPairOrientationsForTokenIds(
    tokenIds: number[],
  ): Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }> {
    const unique = Array.from(
      new Set(
        tokenIds
          .map(tokenId => Math.floor(Number(tokenId) || 0))
          .filter(tokenId => Number.isFinite(tokenId) && tokenId > 0),
      ),
    ).sort((a, b) => a - b);
    const pairs: Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }> = [];
    const seen = new Set<string>();
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const oriented = resolvePairOrientation(unique[i]!, unique[j]!);
        const key = `${oriented.baseTokenId}/${oriented.quoteTokenId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(oriented);
      }
    }
    return pairs;
  }

  function buildPairOptions(jurisdiction: string): PairOption[] {
    const runtimeRequiredPairs = deps.getRuntime()?.getDefaultSwapTradingPairs?.() || [];
    const jurisdictionPairs = buildPairOrientationsForTokenIds(tokenIdsForJurisdiction(jurisdiction));
    const requiredPairCandidates = [
      ...runtimeRequiredPairs.map(pair => resolvePairOrientation(Number(pair.baseTokenId), Number(pair.quoteTokenId))),
      ...jurisdictionPairs,
    ];
    const requiredPairs =
      requiredPairCandidates.length > 0
        ? requiredPairCandidates
        : [
            resolvePairOrientation(1, 2), // WETH/USDC
            resolvePairOrientation(2, 3), // WETH/USDT
            resolvePairOrientation(1, 3), // USDC/USDT
          ];
    const allowedPairKeys = new Set(requiredPairs.map(pair => `${pair.baseTokenId}/${pair.quoteTokenId}`));
    const replica = deps.getCurrentReplica();
    const configuredPairs = Array.isArray(replica?.state?.swapTradingPairs) ? replica.state.swapTradingPairs : [];
    const out: PairOption[] = [];
    const seen = new Set<string>();
    for (const pair of configuredPairs) {
      const rawBase = Number(pair?.baseTokenId);
      const rawQuote = Number(pair?.quoteTokenId);
      if (
        !Number.isFinite(rawBase) ||
        !Number.isFinite(rawQuote) ||
        rawBase <= 0 ||
        rawQuote <= 0 ||
        rawBase === rawQuote
      ) {
        continue;
      }
      const oriented = resolvePairOrientation(rawBase, rawQuote);
      const value = `${oriented.baseTokenId}/${oriented.quoteTokenId}`;
      if (!allowedPairKeys.has(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      const baseSymbol = tokenSymbol(oriented.baseTokenId);
      const quoteSymbol = tokenSymbol(oriented.quoteTokenId);
      const liquidScore = isLiquidToken(oriented.quoteTokenId) ? 1 : 0;
      out.push({
        value,
        label: `${baseSymbol}/${quoteSymbol}`,
        pairId: oriented.pairId,
        baseTokenId: oriented.baseTokenId,
        quoteTokenId: oriented.quoteTokenId,
        liquidScore,
      });
    }
    for (const pair of requiredPairs) {
      const value = `${pair.baseTokenId}/${pair.quoteTokenId}`;
      if (seen.has(value)) continue;
      const baseSymbol = tokenSymbol(pair.baseTokenId);
      const quoteSymbol = tokenSymbol(pair.quoteTokenId);
      const liquidScore = isLiquidToken(pair.quoteTokenId) ? 1 : 0;
      out.push({
        value,
        label: `${baseSymbol}/${quoteSymbol}`,
        pairId: pair.pairId,
        baseTokenId: pair.baseTokenId,
        quoteTokenId: pair.quoteTokenId,
        liquidScore,
      });
    }

    const primary = resolvePairOrientation(1, 2); // WETH/USDC
    const primaryKey = `${primary.baseTokenId}/${primary.quoteTokenId}`;

    return out.sort((a, b) => {
      const aKey = `${a.baseTokenId}/${a.quoteTokenId}`;
      const bKey = `${b.baseTokenId}/${b.quoteTokenId}`;
      if (aKey === primaryKey && bKey !== primaryKey) return -1;
      if (bKey === primaryKey && aKey !== primaryKey) return 1;
      if (a.liquidScore !== b.liquidScore) return b.liquidScore - a.liquidScore;
      return compareStableText(a.label, b.label);
    });
  }

  function planInboundCapacityForReplica(
    candidate: EntityReplica | null | undefined,
    ownerEntityId: string,
    counterpartyEntityId: string,
    tokenIdValue: number,
    desiredInboundAmount: bigint,
    allowOpenAccount: boolean,
    ownerRoleEvidence?: AccountRoleEvidence,
    counterpartyRoleEvidence?: AccountRoleEvidence,
    committedRoles?: ReadonlyMap<string, boolean>,
  ): SwapInboundCapacityPlan | null {
    const runtime = deps.getRuntime();
    if (!runtime?.planSwapInboundCapacity) return null;
    const owner = String(ownerEntityId || '')
      .trim()
      .toLowerCase();
    const counterparty = String(counterpartyEntityId || '')
      .trim()
      .toLowerCase();
    if (
      !owner ||
      !counterparty ||
      !Number.isSafeInteger(tokenIdValue) ||
      tokenIdValue <= 0 ||
      desiredInboundAmount <= 0n
    ) {
      return null;
    }
    const account = candidate?.state?.accounts?.get?.(counterparty) ?? null;
    // Partial Runtime projections expose Entity identity before their Account
    // page arrives. A read-only preview must report "unknown" instead of
    // interpreting that transient omission as an absent bilateral Account.
    // The submit path fetches a fresh detailed projection before it may plan
    // an openAccount command.
    if (!account && !allowOpenAccount) return null;
    if (
      !account &&
      allowOpenAccount &&
      (!ownerRoleEvidence || !counterpartyRoleEvidence)
    ) {
      throw new Error(`SWAP_INBOUND_DISPUTE_PARTY_ROLE_UNAVAILABLE:${owner}:${counterparty}`);
    }
    return runtime.planSwapInboundCapacity({
      account: account?.state ?? null,
      ownerEntityId: owner,
      counterpartyEntityId: counterparty,
      tokenId: tokenIdValue,
      requiredInboundAmount: desiredInboundAmount,
      allowOpenAccount,
      ...(!account
        ? {
            newAccountDisputeConfig: defaultAccountDisputeConfigForRoleEvidence(
              ownerRoleEvidence!,
              counterpartyRoleEvidence!,
              committedRoles,
            ),
          }
        : {}),
    });
  }

  function computeOrderNotionalUsd(
    mode: 'buy-base' | 'sell-base' | 'none',
    giveTokenValue: number,
    wantTokenValue: number,
    effectiveGiveAmount: bigint,
    effectiveWantAmount: bigint,
  ): number {
    if (mode === 'sell-base') {
      return amountToUsd(effectiveWantAmount, getTokenDecimals(wantTokenValue), tokenSymbol(wantTokenValue));
    }
    if (mode === 'buy-base') {
      return amountToUsd(effectiveGiveAmount, getTokenDecimals(giveTokenValue), tokenSymbol(giveTokenValue));
    }
    return 0;
  }

  function computeSwapPriceTicksSafe(
    giveTokenValue: number,
    wantTokenValue: number,
    giveAmountValue: bigint,
    wantAmountValue: bigint,
  ): bigint {
    const runtime = deps.getRuntime();
    return runtime?.computeSwapPriceTicks
      ? runtime.computeSwapPriceTicks(giveTokenValue, wantTokenValue, giveAmountValue, wantAmountValue)
      : 0n;
  }

  function requantizeAtLimitPrice(
    activeGiveTokenId: number,
    activeWantTokenId: number,
    remainingGiveAmount: bigint,
    priceTicks: bigint,
  ): PreparedSwapOrderLike | null {
    const runtime = deps.getRuntime();
    if (!runtime?.isReady) return null;
    const quantized = runtime.requantizeRemainingSwapAtPrice(
      activeGiveTokenId,
      activeWantTokenId,
      remainingGiveAmount,
      priceTicks,
    );
    return quantized
      ? {
          priceTicks,
          effectiveGive: quantized.effectiveGive,
          effectiveWant: quantized.effectiveWant,
          unspentGiveAmount: quantized.releasedGiveDust,
        }
      : null;
  }

  return {
    readAccountCapacityForReplica,
    hasTokenInReplicaAccount,
    readInCapacityForReplica,
    defaultTradingPairOrientations,
    resolvePairOrientation,
    isLiquidToken,
    tokenIdsForJurisdiction,
    buildPairOrientationsForTokenIds,
    buildPairOptions,
    planInboundCapacityForReplica,
    computeOrderNotionalUsd,
    computeSwapPriceTicksSafe,
    requantizeAtLimitPrice,
  };
};
