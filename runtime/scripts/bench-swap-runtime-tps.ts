import { processAccountTx } from '../account-tx/apply';
import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
} from '../cross-jurisdiction';
import { buildCrossJurisdictionBookAdmissionReceipt } from '../cross-jurisdiction-orderbook';
import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from '../orderbook';
import type { AccountMachine, AccountTx, CrossJurisdictionSwapRoute, Delta } from '../types';
import { getPerfMs } from '../utils';
import { createDefaultDelta } from '../validation-utils';

type Cli = {
  swaps: number;
  warmup: number;
  minTps: number;
};

type RuntimeSwapBenchmarkResult = {
  benchmark: 'swap-account-runtime';
  sameSwaps: number;
  crossSwaps: number;
  elapsedMs: number;
  tps: number;
  minTps: number;
  passed: boolean;
  sameTps: number;
  crossTps: number;
  sameOffdelta: string;
  crossFilledSource: string;
};

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const addr = (byte: string): string => `0x${byte.repeat(20)}`;

const argValue = (args: string[], name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

const positiveInt = (args: string[], name: string, fallback: number): number => {
  const value = Number.parseInt(argValue(args, name, String(fallback)), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`INVALID_ARG:${name}`);
  return value;
};

const nonNegativeInt = (args: string[], name: string, fallback: number): number => {
  const value = Number.parseInt(argValue(args, name, String(fallback)), 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`INVALID_ARG:${name}`);
  return value;
};

const parseCli = (args: string[]): Cli => ({
  swaps: positiveInt(args, '--swaps', 50_000),
  warmup: nonNegativeInt(args, '--warmup', 5_000),
  minTps: positiveInt(args, '--min-tps', 10_000),
});

const makeAccount = (leftEntity: string, rightEntity: string): AccountMachine => ({
  leftEntity,
  rightEntity,
  watchSeed: `0x${'a3'.repeat(32)}`,
  status: 'active',
  mempool: [],
  currentFrame: {
    height: 1,
    timestamp: 1_000,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: '',
    stateHash: '',
    deltas: [],
    byLeft: true,
  },
  deltas: new Map(),
  locks: new Map(),
  pulls: new Map(),
  swapOffers: new Map(),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 1,
  pendingSignatures: [],
  rollbackCount: 0,
  leftJObservations: [],
  rightJObservations: [],
  jEventChain: [],
  lastFinalizedJHeight: 0,
  proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
  onChainSettlementNonce: 0,
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  rebalancePolicy: new Map(),
});

const installDelta = (account: AccountMachine, tokenId: number, credit = 10n ** 30n): Delta => {
  const delta = createDefaultDelta(tokenId);
  delta.leftCreditLimit = credit;
  delta.rightCreditLimit = credit;
  delta.leftHold = 0n;
  delta.rightHold = 0n;
  account.deltas.set(tokenId, delta);
  return delta;
};

const seedSameSwapAccount = (swaps: number): AccountMachine => {
  const left = entity('11');
  const right = entity('22');
  const account = makeAccount(left, right);
  const giveDelta = installDelta(account, 2);
  installDelta(account, 1);
  const giveAmount = SWAP_LOT_SCALE;
  const wantAmount = 3_000n * SWAP_LOT_SCALE;
  giveDelta.leftHold = giveAmount * BigInt(swaps);
  for (let index = 0; index < swaps; index += 1) {
    account.swapOffers.set(`same-${index}`, {
      offerId: `same-${index}`,
      giveTokenId: 2,
      giveAmount,
      wantTokenId: 1,
      wantAmount,
      priceTicks: 3_000n * ORDERBOOK_PRICE_SCALE,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: true,
      createdHeight: index,
      quantizedGive: giveAmount,
      quantizedWant: wantAmount,
    });
  }
  return account;
};

const targetReceiptFor = (route: CrossJurisdictionSwapRoute) =>
  buildCrossJurisdictionBookAdmissionReceipt(
    route,
    'target',
    {
      type: 'pull_lock',
      data: {
        pullId: route.targetPull!.pullId,
        tokenId: route.targetPull!.tokenId,
        amount: route.targetPull!.signedAmount,
        revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
        fullHash: route.targetPull!.fullHash,
        partialRoot: route.targetPull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
      },
    },
    route.target.entityId,
    route.target.counterpartyEntityId,
    1_000,
  );

const seedCrossSwapAccount = (swaps: number): AccountMachine => {
  const sourceUser = entity('33');
  const sourceHub = entity('44');
  const targetHub = entity('55');
  const targetUser = entity('66');
  const account = makeAccount(sourceUser, sourceHub);
  const sourceDelta = installDelta(account, 1);
  const sourceAmount = SWAP_LOT_SCALE;
  const targetAmount = 2n * SWAP_LOT_SCALE;
  sourceDelta.leftHold = sourceAmount * BigInt(swaps);
  const template = buildPreparedCrossJurisdictionRoute({
    orderId: 'cross-template',
    makerEntityId: sourceUser,
    hubEntityId: sourceHub,
    bookOwnerEntityId: sourceHub,
    venueId: 'cross:bench-source:1/bench-target:1',
    source: {
      jurisdiction: `stack:1:${addr('11')}`,
      entityId: sourceUser,
      counterpartyEntityId: sourceHub,
      tokenId: 1,
      amount: sourceAmount,
    },
    target: {
      jurisdiction: `stack:2:${addr('22')}`,
      entityId: targetHub,
      counterpartyEntityId: targetUser,
      tokenId: 1,
      amount: targetAmount,
    },
    priceImprovementMode: 'source_savings',
    status: 'intent',
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 61_000,
  }, { runtimeSeed: 'swap-runtime-bench', sourceDisputeDelayMs: 5_000, now: 1_000 });
  let templateRoute: CrossJurisdictionSwapRoute = {
    ...template,
    status: 'resting' as const,
  };
  templateRoute = { ...templateRoute, targetReceipt: targetReceiptFor(templateRoute) };
  account.pulls!.set(templateRoute.sourcePull!.pullId, {
    pullId: templateRoute.sourcePull!.pullId,
    tokenId: templateRoute.sourcePull!.tokenId,
    amount: templateRoute.sourcePull!.signedAmount,
    claimedRatio: 0,
    claimedAmount: 0n,
    revealedUntilTimestamp: templateRoute.sourcePull!.revealedUntilTimestamp,
    fullHash: templateRoute.sourcePull!.fullHash,
    partialRoot: templateRoute.sourcePull!.partialRoot,
    crossJurisdiction: buildCrossJurisdictionPullBinding(templateRoute, 'source'),
    createdHeight: 0,
    createdTimestamp: 1_000,
  });
  for (let index = 0; index < swaps; index += 1) {
    const orderId = `cross-${index}`;
    // This benchmark measures account handler throughput after admission.
    // Route-hash and receipt uniqueness are covered by security tests; repeating
    // one canonical route keeps setup out of the measured hot path.
    const route: CrossJurisdictionSwapRoute = {
      ...templateRoute,
      source: { ...templateRoute.source },
      target: { ...templateRoute.target },
      sourcePull: { ...templateRoute.sourcePull! },
      targetPull: { ...templateRoute.targetPull! },
      ...(templateRoute.targetReceipt ? { targetReceipt: { ...templateRoute.targetReceipt } } : {}),
      status: 'resting' as const,
    };
    account.swapOffers.set(orderId, {
      offerId: orderId,
      giveTokenId: route.source.tokenId,
      giveAmount: route.source.amount,
      wantTokenId: route.target.tokenId,
      wantAmount: route.target.amount,
      priceTicks: 2n * ORDERBOOK_PRICE_SCALE,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: true,
      createdHeight: index,
      quantizedGive: route.source.amount,
      quantizedWant: route.target.amount,
      crossJurisdiction: route,
    });
  }
  return account;
};

const sameResolveTx = (index: number): AccountTx => ({
  type: 'swap_resolve',
  data: {
    offerId: `same-${index}`,
    fillRatio: 65_535,
    fillNumerator: 1n,
    fillDenominator: 1n,
    cancelRemainder: true,
    executionGiveAmount: SWAP_LOT_SCALE,
    executionWantAmount: 3_000n * SWAP_LOT_SCALE,
  },
});

const crossAckTx = (index: number): AccountTx => ({
  type: 'cross_swap_fill_ack',
  data: {
    offerId: `cross-${index}`,
    fillSeq: 1,
    incrementalSourceAmount: SWAP_LOT_SCALE,
    incrementalTargetAmount: 2n * SWAP_LOT_SCALE,
    cumulativeSourceAmount: SWAP_LOT_SCALE,
    cumulativeTargetAmount: 2n * SWAP_LOT_SCALE,
    cumulativeFillRatio: 65_535,
    fillNumerator: 1n,
    fillDenominator: 1n,
    executionSourceAmount: SWAP_LOT_SCALE - 1n,
    executionTargetAmount: 2n * SWAP_LOT_SCALE,
    priceImprovementMode: 'source_savings',
    priceImprovementAmount: 1n,
    priceImprovementTokenId: 1,
    cancelRemainder: true,
    pairId: 'cross:bench-source:1/bench-target:1',
  },
});

const runPass = async (
  swaps: number,
): Promise<{ same: AccountMachine; cross: AccountMachine; elapsedMs: number; sameElapsedMs: number; crossElapsedMs: number }> => {
  const same = seedSameSwapAccount(swaps);
  const cross = seedCrossSwapAccount(swaps);
  const startedAt = getPerfMs();
  const sameStartedAt = getPerfMs();
  for (let index = 0; index < swaps; index += 1) {
    const result = await processAccountTx(same, sameResolveTx(index), false, 2_000 + index, 2 + index);
    if (!result.success) throw new Error(`SAME_SWAP_FAILED:${index}:${result.error}`);
  }
  const sameElapsedMs = getPerfMs() - sameStartedAt;
  const crossStartedAt = getPerfMs();
  for (let index = 0; index < swaps; index += 1) {
    const result = await processAccountTx(cross, crossAckTx(index), false, 2_000 + index, 2 + index);
    if (!result.success) throw new Error(`CROSS_SWAP_FAILED:${index}:${result.error}`);
  }
  const crossElapsedMs = getPerfMs() - crossStartedAt;
  return { same, cross, elapsedMs: getPerfMs() - startedAt, sameElapsedMs, crossElapsedMs };
};

export const runSwapRuntimeBenchmark = async (cli: Cli): Promise<RuntimeSwapBenchmarkResult> => {
  if (cli.warmup > 0) await runPass(cli.warmup);
  const { same, cross, elapsedMs, sameElapsedMs, crossElapsedMs } = await runPass(cli.swaps);
  if (same.swapOffers.size !== 0) throw new Error(`SAME_OFFERS_LEFT:${same.swapOffers.size}`);
  if (cross.swapOffers.size !== 0) throw new Error(`CROSS_OFFERS_LEFT:${cross.swapOffers.size}`);
  const totalSwaps = cli.swaps * 2;
  const elapsedSeconds = Math.max(elapsedMs / 1000, 0.001);
  const tps = totalSwaps / elapsedSeconds;
  const output: RuntimeSwapBenchmarkResult = {
    benchmark: 'swap-account-runtime',
    sameSwaps: cli.swaps,
    crossSwaps: cli.swaps,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    tps: Number(tps.toFixed(2)),
    minTps: cli.minTps,
    passed: tps >= cli.minTps,
    sameTps: Number((cli.swaps / Math.max(sameElapsedMs / 1000, 0.001)).toFixed(2)),
    crossTps: Number((cli.swaps / Math.max(crossElapsedMs / 1000, 0.001)).toFixed(2)),
    sameOffdelta: String(same.deltas.get(2)?.offdelta ?? 0n),
    crossFilledSource: String([...(cross.swapOrderHistory ?? new Map()).values()].reduce(
      (sum, entry) => sum + BigInt(entry.resolves.at(-1)?.executionGiveAmount ?? 0n),
      0n,
    )),
  };
  if (!output.passed) throw new Error(`SWAP_RUNTIME_TPS_BELOW_TARGET:${tps.toFixed(2)}<${cli.minTps}`);
  return output;
};

if (import.meta.main) {
  console.log(JSON.stringify(await runSwapRuntimeBenchmark(parseCli(globalThis.process.argv.slice(2))), null, 2));
}
