import type { BookState } from '@xln/runtime/xln-api';
import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
} from '@xln/runtime/xln-api';

export type BookSide = 'bid' | 'ask';

export type SnapshotLevel = { price: bigint; size: number; total: number };

export type OrderbookSnapshot = {
  pairId: string;
  hubIds: string[];
  bids: SnapshotLevel[];
  asks: SnapshotLevel[];
  spread: bigint | null;
  spreadPercent: string;
  sourceCount: number;
  sourceStatus: 'ready' | 'syncing' | 'empty' | 'no-market' | 'error';
  updatedAt: number;
};

export type PairOrientation = {
  baseTokenId: number;
  quoteTokenId: number;
  pairId: string;
};

export type CrossTargetLike = {
  targetHubEntityId: string;
  targetJurisdiction: string;
  targetJurisdictionRef: string;
};

export type RoutedSwapHop = {
  id: string;
  label: string;
  fromLabel: string;
  toLabel: string;
  fromTokenId: number;
  toTokenId: number;
  pairId: string;
  bookHubId: string;
  sourceHubId: string;
  targetHubId: string;
  sourceJurisdictionRef: string;
  targetJurisdictionRef: string;
  baseTokenId: number;
  quoteTokenId: number;
  kind: 'same' | 'cross';
  sourceIsBase: boolean;
};

export type RouteQuote = {
  inputAmount: bigint;
  outputAmount: bigint;
  priceTicks: bigint | null;
  hasLiquidity: boolean;
  reason: string;
};

export type RoutedSwapRouteCandidate = {
  id: string;
  label: string;
  summary: string;
  bridgeTokenId: number | null;
  hops: RoutedSwapHop[];
  inputAmount: bigint;
  score: number;
  liveHopCount: number;
  totalHopCount: number;
  estimatedOutAmount: bigint | null;
  estimatedOutLabel: string;
  liquidityLabel: string;
  reason: string;
  warnings: string[];
};

export type RoutedExecutionStatus = 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'canceled';

export type RoutedExecutionStepStatus = 'queued' | 'active' | 'paused' | 'done' | 'failed' | 'skipped';

export type RoutedExecutionStep = {
  id: string;
  hopId: string;
  index: number;
  status: RoutedExecutionStepStatus;
  progressPpm: number;
  label: string;
  pairLabel: string;
  fromLabel: string;
  toLabel: string;
  amountInLabel: string;
  amountOutLabel: string;
  message: string;
};

export type RoutedExecutionParticipant = {
  entityId: string;
  signerId: string;
  hubEntityId: string;
  jurisdictionRef: string;
};

export type RoutedExecutionCheckpoint = {
  entityId: string;
  signerId: string;
  counterpartyEntityId: string;
  tokenId: number;
  label: string;
};

export type RoutedHopExecutionIntent = {
  index: number;
  hop: RoutedSwapHop;
  executorEntityId: string;
  executorSignerId: string;
  counterpartyEntityId: string;
  checkpoint: RoutedExecutionCheckpoint;
};

export type RoutedExecutionIntentPlan = {
  intents: RoutedHopExecutionIntent[];
  error: string;
};

export type RoutedHopExecutionDraft = {
  index: number;
  hopId: string;
  txType: 'placeSwapOffer' | 'requestCrossJurisdictionSwap';
  offerId: string;
  executorEntityId: string;
  executorSignerId: string;
  counterpartyEntityId: string;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  priceTicks: bigint;
  minFillRatio: number;
  checkpoint: RoutedExecutionCheckpoint;
};

export type RoutedHopExecutionDraftResult = {
  draft: RoutedHopExecutionDraft | null;
  error: string;
};

type CrossMarketView = {
  venueId: string;
  sourceIsBase: boolean;
};

const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();

const tokenNetworkLabel = (
  tokenId: number,
  jurisdiction: string,
  tokenSymbol: (tokenIdValue: number) => string,
): string => {
  const network = String(jurisdiction || '').trim();
  return network ? `${tokenSymbol(tokenId)} (${network})` : tokenSymbol(tokenId);
};

const routePathLabel = (hops: RoutedSwapHop[]): string => {
  if (hops.length === 0) return '';
  return [hops[0]!.fromLabel, ...hops.map((hop) => hop.toLabel)].join(' -> ');
};

function stableIdHash(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(36).padStart(13, '0');
}

export function buildDeterministicSwapOfferId(input: {
  logicalTimestamp: number;
  logicalHeight: number;
  sourceEntityId: string;
  counterpartyEntityId: string;
  sellToken: number;
  buyToken: number;
  sellAmount: bigint;
  buyAmount: bigint;
  priceTicks: bigint;
  routeValue: string;
}): string {
  const logicalTimestamp = Math.max(0, Math.floor(Number(input.logicalTimestamp) || 0));
  const logicalHeight = Math.max(0, Math.floor(Number(input.logicalHeight) || 0));
  const seed = [
    logicalTimestamp,
    logicalHeight,
    input.sourceEntityId,
    input.counterpartyEntityId,
    input.sellToken,
    input.buyToken,
    input.sellAmount.toString(),
    input.buyAmount.toString(),
    input.priceTicks.toString(),
    input.routeValue,
  ].join('|');
  return `swap-${logicalTimestamp.toString(36)}-${logicalHeight.toString(36)}-${stableIdHash(seed)}`;
}

export function orderbookSnapshotCacheKey(hubEntityId: string, pairIdValue: string): string {
  return `${normalizeEntityId(hubEntityId)}::${String(pairIdValue || '').trim()}`;
}

export function orderbookSnapshotSignature(snapshot: OrderbookSnapshot): string {
  const levelsSignature = (levels: SnapshotLevel[]) => (levels || [])
    .slice(0, 10)
    .map((level) => `${level.price.toString()}:${level.size}:${level.total}`)
    .join(',');
  return [
    snapshot.sourceStatus,
    snapshot.sourceCount,
    levelsSignature(snapshot.bids),
    levelsSignature(snapshot.asks),
  ].join('|');
}

export function readSnapshotBestPrice(snapshot: OrderbookSnapshot, side: BookSide): bigint | null {
  const level = side === 'bid' ? snapshot.bids?.[0] : snapshot.asks?.[0];
  const price = level?.price ?? 0n;
  return price > 0n ? price : null;
}

export function buildSameJurisdictionHop(input: {
  id: string;
  label: string;
  jurisdiction: string;
  jurisdictionRef: string;
  hubId: string;
  fromToken: number;
  toToken: number;
  resolvePairOrientation: (tokenA: number, tokenB: number) => PairOrientation;
  tokenSymbol: (tokenId: number) => string;
}): RoutedSwapHop | null {
  const hubId = String(input.hubId || '').trim().toLowerCase();
  if (!hubId || input.fromToken === input.toToken || input.fromToken <= 0 || input.toToken <= 0) return null;
  const pair = input.resolvePairOrientation(input.fromToken, input.toToken);
  return {
    id: input.id,
    label: input.label,
    fromLabel: tokenNetworkLabel(input.fromToken, input.jurisdiction, input.tokenSymbol),
    toLabel: tokenNetworkLabel(input.toToken, input.jurisdiction, input.tokenSymbol),
    fromTokenId: input.fromToken,
    toTokenId: input.toToken,
    pairId: pair.pairId,
    bookHubId: hubId,
    sourceHubId: hubId,
    targetHubId: hubId,
    sourceJurisdictionRef: input.jurisdictionRef,
    targetJurisdictionRef: input.jurisdictionRef,
    baseTokenId: pair.baseTokenId,
    quoteTokenId: pair.quoteTokenId,
    kind: 'same',
    sourceIsBase: input.fromToken === pair.baseTokenId,
  };
}

export function buildCrossJurisdictionHop(input: {
  id: string;
  label: string;
  sourceJurisdictionRef: string;
  sourceJurisdiction: string;
  sourceHubId: string;
  targetJurisdictionRef: string;
  targetJurisdiction: string;
  targetHubId: string;
  tokenId: number;
  tokenSymbol: (tokenId: number) => string;
}): RoutedSwapHop | null {
  const sourceHubId = String(input.sourceHubId || '').trim().toLowerCase();
  const targetHubId = String(input.targetHubId || '').trim().toLowerCase();
  if (!input.sourceJurisdictionRef || !input.targetJurisdictionRef || !sourceHubId || !targetHubId || input.tokenId <= 0) {
    return null;
  }
  const market = deriveCanonicalCrossJurisdictionMarketForLegs(
    input.sourceJurisdictionRef,
    input.tokenId,
    input.targetJurisdictionRef,
    input.tokenId,
  ) as CrossMarketView;
  const bookHubId = deriveCanonicalCrossJurisdictionBookOwnerForLegs(
    input.sourceJurisdictionRef,
    input.tokenId,
    sourceHubId,
    input.targetJurisdictionRef,
    input.tokenId,
    targetHubId,
  );
  return {
    id: input.id,
    label: input.label,
    fromLabel: tokenNetworkLabel(input.tokenId, input.sourceJurisdiction, input.tokenSymbol),
    toLabel: tokenNetworkLabel(input.tokenId, input.targetJurisdiction, input.tokenSymbol),
    fromTokenId: input.tokenId,
    toTokenId: input.tokenId,
    pairId: market.venueId,
    bookHubId,
    sourceHubId,
    targetHubId,
    sourceJurisdictionRef: input.sourceJurisdictionRef,
    targetJurisdictionRef: input.targetJurisdictionRef,
    baseTokenId: input.tokenId,
    quoteTokenId: input.tokenId,
    kind: 'cross',
    sourceIsBase: market.sourceIsBase,
  };
}

export function estimateRoutedHopOutput(input: {
  hop: RoutedSwapHop;
  inputAmount: bigint;
  readCachedOrderbookSnapshot: (hubEntityId: string, pairIdValue: string) => OrderbookSnapshot | null;
  readPairBook: (hubEntityId: string, pairIdValue: string) => BookState | null;
  getBestBid: (book: BookState) => bigint | null;
  getBestAsk: (book: BookState) => bigint | null;
  quoteFromBase: (baseAmount: bigint, priceTicks: bigint, baseDecimals: number, quoteDecimals: number) => bigint;
  baseFromQuote: (quoteAmount: bigint, priceTicks: bigint, baseDecimals: number, quoteDecimals: number) => bigint;
  getTokenDecimals: (tokenId: number) => number;
  tokenSymbol: (tokenId: number) => string;
  accountLabel: (entityId: string) => string;
}): RouteQuote {
  const { hop, inputAmount } = input;
  if (inputAmount <= 0n) {
    return { inputAmount, outputAmount: 0n, priceTicks: null, hasLiquidity: false, reason: 'Enter amount to quote this hop.' };
  }
  const side: BookSide = hop.sourceIsBase ? 'bid' : 'ask';
  const snapshot = input.readCachedOrderbookSnapshot(hop.bookHubId, hop.pairId);
  const book = snapshot ? null : input.readPairBook(hop.bookHubId, hop.pairId);
  if (!snapshot && !book) {
    return {
      inputAmount,
      outputAmount: 0n,
      priceTicks: null,
      hasLiquidity: false,
      reason: `No live ${input.tokenSymbol(hop.fromTokenId)} -> ${input.tokenSymbol(hop.toTokenId)} liquidity on ${input.accountLabel(hop.bookHubId)}.`,
    };
  }
  const priceTicks = snapshot
    ? readSnapshotBestPrice(snapshot, side)
    : (side === 'bid' ? input.getBestBid(book!) : input.getBestAsk(book!));
  if (!priceTicks || priceTicks <= 0n) {
    const marketReason = snapshot?.sourceStatus === 'no-market'
      ? 'No market is published'
      : 'No live liquidity';
    return {
      inputAmount,
      outputAmount: 0n,
      priceTicks: null,
      hasLiquidity: false,
      reason: `${marketReason} for ${input.tokenSymbol(hop.fromTokenId)} -> ${input.tokenSymbol(hop.toTokenId)} on ${input.accountLabel(hop.bookHubId)}.`,
    };
  }
  const outputAmount = hop.sourceIsBase
    ? input.quoteFromBase(inputAmount, priceTicks, input.getTokenDecimals(hop.baseTokenId), input.getTokenDecimals(hop.quoteTokenId))
    : input.baseFromQuote(inputAmount, priceTicks, input.getTokenDecimals(hop.baseTokenId), input.getTokenDecimals(hop.quoteTokenId));
  if (outputAmount <= 0n) {
    return {
      inputAmount,
      outputAmount: 0n,
      priceTicks,
      hasLiquidity: false,
      reason: `Quoted ${input.tokenSymbol(hop.fromTokenId)} size is below ${input.tokenSymbol(hop.toTokenId)} lot precision.`,
    };
  }
  return { inputAmount, outputAmount, priceTicks, hasLiquidity: true, reason: '' };
}

function hubHasTradingPair(
  hubId: string,
  tokenA: number,
  tokenB: number,
  resolvePairOrientation: (tokenAValue: number, tokenBValue: number) => PairOrientation,
  tradingPairsForHub: (hubIdValue: string) => PairOrientation[],
): boolean {
  if (!hubId || tokenA <= 0 || tokenB <= 0 || tokenA === tokenB) return false;
  const oriented = resolvePairOrientation(tokenA, tokenB);
  return tradingPairsForHub(hubId).some((pair) =>
    pair.baseTokenId === oriented.baseTokenId && pair.quoteTokenId === oriented.quoteTokenId,
  );
}

function candidateBridgeTokens(input: {
  sourceHubId: string;
  targetHubId: string;
  sourceToken: number;
  targetToken: number;
  allowedSwapTokenIds: Iterable<number>;
  resolvePairOrientation: (tokenA: number, tokenB: number) => PairOrientation;
  tradingPairsForHub: (hubId: string) => PairOrientation[];
  isLiquidToken: (tokenId: number) => boolean;
  tokenSymbol: (tokenId: number) => string;
  compareStableText: (a: string, b: string) => number;
}): number[] {
  const tokens = new Set<number>([input.sourceToken, input.targetToken]);
  for (const tokenId of input.allowedSwapTokenIds) tokens.add(tokenId);
  for (const pair of input.tradingPairsForHub(input.sourceHubId)) {
    tokens.add(pair.baseTokenId);
    tokens.add(pair.quoteTokenId);
  }
  for (const pair of input.tradingPairsForHub(input.targetHubId)) {
    tokens.add(pair.baseTokenId);
    tokens.add(pair.quoteTokenId);
  }

  return Array.from(tokens)
    .filter((tokenId) => Number.isFinite(tokenId) && tokenId > 0)
    .filter((tokenId) => {
      const sourceReachable = tokenId === input.sourceToken || hubHasTradingPair(
        input.sourceHubId,
        input.sourceToken,
        tokenId,
        input.resolvePairOrientation,
        input.tradingPairsForHub,
      );
      const targetReachable = tokenId === input.targetToken || hubHasTradingPair(
        input.targetHubId,
        tokenId,
        input.targetToken,
        input.resolvePairOrientation,
        input.tradingPairsForHub,
      );
      return sourceReachable && targetReachable;
    })
    .sort((a, b) => {
      const aDirect = (a === input.sourceToken ? 1 : 0) + (a === input.targetToken ? 1 : 0);
      const bDirect = (b === input.sourceToken ? 1 : 0) + (b === input.targetToken ? 1 : 0);
      if (aDirect !== bDirect) return bDirect - aDirect;
      const aLiquid = input.isLiquidToken(a) ? 1 : 0;
      const bLiquid = input.isLiquidToken(b) ? 1 : 0;
      if (aLiquid !== bLiquid) return bLiquid - aLiquid;
      return input.compareStableText(input.tokenSymbol(a), input.tokenSymbol(b));
    });
}

export function evaluateRoutedCandidate(input: {
  id: string;
  label: string;
  summary: string;
  bridgeTokenId: number | null;
  hops: RoutedSwapHop[];
  targetToken: number;
  targetLabel?: string;
  inputAmount: bigint;
  estimateHopOutput: (hop: RoutedSwapHop, inputAmount: bigint) => RouteQuote;
  formatAmount: (amount: bigint, tokenId: number) => string;
  tokenSymbol: (tokenId: number) => string;
  isLiquidToken: (tokenId: number) => boolean;
}): RoutedSwapRouteCandidate {
  let amount = input.inputAmount;
  let liveHopCount = 0;
  const warnings: string[] = [];
  for (const hop of input.hops) {
    const quote = input.estimateHopOutput(hop, amount);
    if (!quote.hasLiquidity) {
      warnings.push(quote.reason);
      break;
    }
    liveHopCount += 1;
    amount = quote.outputAmount;
  }
  const fullyQuoted = input.hops.length > 0 && liveHopCount === input.hops.length && amount > 0n;
  const targetDisplayLabel = String(input.targetLabel || '').trim() || input.tokenSymbol(input.targetToken);
  const estimatedOutAmount = fullyQuoted ? amount : null;
  const estimatedOutLabel = estimatedOutAmount
    ? `${input.formatAmount(estimatedOutAmount, input.targetToken)} ${targetDisplayLabel}`
    : (input.inputAmount > 0n ? 'Needs live quotes' : 'Enter amount');
  const liquidityLabel = fullyQuoted ? '' : `Needs quotes ${liveHopCount}/${input.hops.length}`;
  const score = (liveHopCount * 10_000)
    - (input.hops.length * 250)
    + (estimatedOutAmount ? 100 : 0)
    + (input.bridgeTokenId && input.isLiquidToken(input.bridgeTokenId) ? 25 : 0);
  return {
    id: input.id,
    label: input.label,
    summary: input.summary,
    bridgeTokenId: input.bridgeTokenId,
    hops: input.hops,
    inputAmount: input.inputAmount,
    score,
    liveHopCount,
    totalHopCount: input.hops.length,
    estimatedOutAmount,
    estimatedOutLabel,
    liquidityLabel,
    reason: warnings[0] || '',
    warnings,
  };
}

export function compareRouteCandidates(
  a: RoutedSwapRouteCandidate,
  b: RoutedSwapRouteCandidate,
  compareStableText: (left: string, right: string) => number,
): number {
  if (a.estimatedOutAmount !== null && b.estimatedOutAmount !== null && a.estimatedOutAmount !== b.estimatedOutAmount) {
    return a.estimatedOutAmount > b.estimatedOutAmount ? -1 : 1;
  }
  if ((a.estimatedOutAmount !== null) !== (b.estimatedOutAmount !== null)) return a.estimatedOutAmount !== null ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
  return compareStableText(a.label, b.label);
}

function normalizeParticipant(participant: RoutedExecutionParticipant | null | undefined): RoutedExecutionParticipant | null {
  const entityId = normalizeEntityId(participant?.entityId);
  const signerId = normalizeEntityId(participant?.signerId);
  const hubEntityId = normalizeEntityId(participant?.hubEntityId);
  const jurisdictionRef = String(participant?.jurisdictionRef || '').trim();
  if (!entityId || !signerId || !hubEntityId || !jurisdictionRef) return null;
  return { entityId, signerId, hubEntityId, jurisdictionRef };
}

export function buildRoutedExecutionIntents(input: {
  route: RoutedSwapRouteCandidate | null;
  source: RoutedExecutionParticipant | null;
  target: RoutedExecutionParticipant | null;
}): RoutedExecutionIntentPlan {
  const route = input.route;
  if (!route || route.hops.length === 0) return { intents: [], error: 'No routed exchange path is selected.' };
  const source = normalizeParticipant(input.source);
  if (!source) return { intents: [], error: 'Source signer, hub, or jurisdiction is missing.' };
  const target = normalizeParticipant(input.target);
  const intents: RoutedHopExecutionIntent[] = [];

  for (let index = 0; index < route.hops.length; index += 1) {
    const hop = route.hops[index]!;
    const hopHubId = normalizeEntityId(hop.sourceHubId || hop.bookHubId);
    const sourceLocal = hopHubId === source.hubEntityId && hop.sourceJurisdictionRef === source.jurisdictionRef;
    const targetLocal = Boolean(target && hopHubId === target.hubEntityId && hop.sourceJurisdictionRef === target.jurisdictionRef);

    if (hop.kind === 'cross') {
      if (!target) {
        return { intents: [], error: 'Target signer, hub, or jurisdiction is missing for routed cross-chain execution.' };
      }
      intents.push({
        index,
        hop,
        executorEntityId: source.entityId,
        executorSignerId: source.signerId,
        counterpartyEntityId: normalizeEntityId(hop.sourceHubId),
        checkpoint: {
          entityId: target.entityId,
          signerId: target.signerId,
          counterpartyEntityId: normalizeEntityId(hop.targetHubId),
          tokenId: hop.toTokenId,
          label: 'Wait for target-side bridge receipt',
        },
      });
      continue;
    }

    if (sourceLocal) {
      intents.push({
        index,
        hop,
        executorEntityId: source.entityId,
        executorSignerId: source.signerId,
        counterpartyEntityId: normalizeEntityId(hop.sourceHubId),
        checkpoint: {
          entityId: source.entityId,
          signerId: source.signerId,
          counterpartyEntityId: normalizeEntityId(hop.targetHubId),
          tokenId: hop.toTokenId,
          label: 'Wait for source-side local swap receipt',
        },
      });
      continue;
    }

    if (target && targetLocal) {
      intents.push({
        index,
        hop,
        executorEntityId: target.entityId,
        executorSignerId: target.signerId,
        counterpartyEntityId: normalizeEntityId(hop.sourceHubId),
        checkpoint: {
          entityId: target.entityId,
          signerId: target.signerId,
          counterpartyEntityId: normalizeEntityId(hop.targetHubId),
          tokenId: hop.toTokenId,
          label: 'Wait for target-side local swap receipt',
        },
      });
      continue;
    }

    return {
      intents: [],
      error: `No controlled signer can execute hop ${index + 1} on hub ${hop.sourceHubId || hop.bookHubId}.`,
    };
  }

  return { intents, error: '' };
}

export function buildRoutedHopExecutionDraft(input: {
  intent: RoutedHopExecutionIntent;
  quote: RouteQuote;
  offerId: string;
  minFillRatio?: number;
}): RoutedHopExecutionDraftResult {
  const { intent, quote } = input;
  const offerId = String(input.offerId || '').trim();
  if (!offerId) return { draft: null, error: 'Routed hop offer id is missing.' };
  if (!quote.hasLiquidity || quote.outputAmount <= 0n || !quote.priceTicks || quote.priceTicks <= 0n) {
    return { draft: null, error: quote.reason || `No executable quote for hop ${intent.index + 1}.` };
  }
  if (quote.inputAmount <= 0n) {
    return { draft: null, error: `Input amount is missing for hop ${intent.index + 1}.` };
  }
  const minFillRatio = Math.max(0, Math.min(65535, Math.floor(Number(input.minFillRatio ?? 65535))));
  return {
    error: '',
    draft: {
      index: intent.index,
      hopId: intent.hop.id,
      txType: intent.hop.kind === 'cross' ? 'requestCrossJurisdictionSwap' : 'placeSwapOffer',
      offerId,
      executorEntityId: intent.executorEntityId,
      executorSignerId: intent.executorSignerId,
      counterpartyEntityId: intent.counterpartyEntityId,
      giveTokenId: intent.hop.fromTokenId,
      giveAmount: quote.inputAmount,
      wantTokenId: intent.hop.toTokenId,
      wantAmount: quote.outputAmount,
      priceTicks: quote.priceTicks,
      minFillRatio,
      checkpoint: intent.checkpoint,
    },
  };
}

export function buildRoutedRouteCandidates(input: {
  mode: 'same' | 'cross';
  target: CrossTargetLike | null;
  sourceHubId: string;
  sourceJurisdictionRef: string;
  sourceJurisdiction: string;
  sourceToken: number;
  targetToken: number;
  quoteInputAmount: bigint;
  allowedSwapTokenIds: Iterable<number>;
  resolvePairOrientation: (tokenA: number, tokenB: number) => PairOrientation;
  tradingPairsForHub: (hubId: string) => PairOrientation[];
  isLiquidToken: (tokenId: number) => boolean;
  tokenSymbol: (tokenId: number) => string;
  compareStableText: (left: string, right: string) => number;
  formatAmount: (amount: bigint, tokenId: number) => string;
  estimateHopOutput: (hop: RoutedSwapHop, inputAmount: bigint) => RouteQuote;
}): RoutedSwapRouteCandidate[] {
  if (input.mode !== 'cross' || !input.target) return [];
  const target = input.target;
  const sourceHubId = String(input.sourceHubId || '').trim().toLowerCase();
  const targetHubId = String(target.targetHubEntityId || '').trim().toLowerCase();
  if (!sourceHubId || !targetHubId || !input.sourceJurisdictionRef || !target.targetJurisdictionRef) return [];
  if (!Number.isFinite(input.sourceToken) || !Number.isFinite(input.targetToken) || input.sourceToken <= 0 || input.targetToken <= 0) {
    return [];
  }
  const candidates: RoutedSwapRouteCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (bridgeTokenId: number | null, hops: RoutedSwapHop[], label: string, summary: string) => {
    if (hops.length === 0) return;
    const key = hops.map((hop) => `${hop.kind}:${hop.pairId}:${hop.bookHubId}:${hop.fromTokenId}:${hop.toTokenId}`).join('|');
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(evaluateRoutedCandidate({
      id: bridgeTokenId === null ? 'direct-cross' : `bridge-${bridgeTokenId}`,
      label,
      summary,
      bridgeTokenId,
      hops,
      targetToken: input.targetToken,
      targetLabel: tokenNetworkLabel(input.targetToken, target.targetJurisdiction, input.tokenSymbol),
      inputAmount: input.quoteInputAmount,
      estimateHopOutput: input.estimateHopOutput,
      formatAmount: input.formatAmount,
      tokenSymbol: input.tokenSymbol,
      isLiquidToken: input.isLiquidToken,
    }));
  };

  if (input.sourceToken === input.targetToken) {
    const directHop = buildCrossJurisdictionHop({
      id: 'direct-cross',
      label: 'Bridge',
      sourceJurisdictionRef: input.sourceJurisdictionRef,
      sourceJurisdiction: input.sourceJurisdiction,
      sourceHubId,
      targetJurisdictionRef: target.targetJurisdictionRef,
      targetJurisdiction: target.targetJurisdiction,
      targetHubId,
      tokenId: input.sourceToken,
      tokenSymbol: input.tokenSymbol,
    });
    if (directHop) {
      addCandidate(null, [directHop], routePathLabel([directHop]), `${input.sourceJurisdiction} -> ${target.targetJurisdiction}`);
    }
  }

  for (const bridgeToken of candidateBridgeTokens({
    sourceHubId,
    targetHubId,
    sourceToken: input.sourceToken,
    targetToken: input.targetToken,
    allowedSwapTokenIds: input.allowedSwapTokenIds,
    resolvePairOrientation: input.resolvePairOrientation,
    tradingPairsForHub: input.tradingPairsForHub,
    isLiquidToken: input.isLiquidToken,
    tokenSymbol: input.tokenSymbol,
    compareStableText: input.compareStableText,
  })) {
    const hops: RoutedSwapHop[] = [];
    if (bridgeToken !== input.sourceToken) {
      const sourceHop = buildSameJurisdictionHop({
        id: 'source-local',
        label: 'Source',
        jurisdiction: input.sourceJurisdiction,
        jurisdictionRef: input.sourceJurisdictionRef,
        hubId: sourceHubId,
        fromToken: input.sourceToken,
        toToken: bridgeToken,
        resolvePairOrientation: input.resolvePairOrientation,
        tokenSymbol: input.tokenSymbol,
      });
      if (!sourceHop) continue;
      hops.push(sourceHop);
    }
    const crossHop = buildCrossJurisdictionHop({
      id: 'bridge-cross',
      label: 'Bridge',
      sourceJurisdictionRef: input.sourceJurisdictionRef,
      sourceJurisdiction: input.sourceJurisdiction,
      sourceHubId,
      targetJurisdictionRef: target.targetJurisdictionRef,
      targetJurisdiction: target.targetJurisdiction,
      targetHubId,
      tokenId: bridgeToken,
      tokenSymbol: input.tokenSymbol,
    });
    if (!crossHop) continue;
    hops.push(crossHop);
    if (bridgeToken !== input.targetToken) {
      const targetHop = buildSameJurisdictionHop({
        id: 'target-local',
        label: 'Target',
        jurisdiction: target.targetJurisdiction,
        jurisdictionRef: target.targetJurisdictionRef,
        hubId: targetHubId,
        fromToken: bridgeToken,
        toToken: input.targetToken,
        resolvePairOrientation: input.resolvePairOrientation,
        tokenSymbol: input.tokenSymbol,
      });
      if (!targetHop) continue;
      hops.push(targetHop);
    }
    addCandidate(
      bridgeToken,
      hops,
      routePathLabel(hops),
      `${input.sourceJurisdiction} -> ${input.tokenSymbol(bridgeToken)} bridge -> ${target.targetJurisdiction}`,
    );
  }

  return candidates
    .sort((a, b) => compareRouteCandidates(a, b, input.compareStableText))
    .slice(0, 4);
}
