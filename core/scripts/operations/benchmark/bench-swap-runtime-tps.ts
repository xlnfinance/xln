import { applyAccountTx } from '../../../account/tx/apply';
import {
  accountTransitionView,
  beginAccountTransition,
  discardAccountTransition,
  publishAccountTransition,
} from '../../../account/state/candidate-overlay';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
} from '../../../extensions/cross-j/index';
import { getStaticSwapTokenDimensions, ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from '../../../orderbook';
import type { AccountReplica, AccountTx, Delta, SwapOffer } from '../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import { getPerfMs } from '../../../support/time';
import { createDefaultDelta } from '../../../account/state/delta';
import {
  PersistentAccountStateMap,
  requirePersistentAccountStateMap,
} from '../../../account/state/persistent-state-map';

type Cli = {
  swaps: number;
  warmup: number;
  minTps: number;
  txsPerFrame: number;
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
  txsPerFrame: number;
  accountFrames: number;
};

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const addr = (byte: string): string => `0x${byte.repeat(20)}`;

const argValue = (args: string[], name: string, defaultValue: string): string => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? defaultValue : defaultValue;
};

const positiveInt = (args: string[], name: string, defaultValue: number): number => {
  const value = Number.parseInt(argValue(args, name, String(defaultValue)), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`INVALID_ARG:${name}`);
  return value;
};

const nonNegativeInt = (args: string[], name: string, defaultValue: number): number => {
  const value = Number.parseInt(argValue(args, name, String(defaultValue)), 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`INVALID_ARG:${name}`);
  return value;
};

const parseCli = (args: string[]): Cli => ({
  swaps: positiveInt(args, '--swaps', 50_000),
  warmup: nonNegativeInt(args, '--warmup', 5_000),
  minTps: positiveInt(args, '--min-tps', 10_000),
  txsPerFrame: positiveInt(args, '--txs-per-frame', 5),
});

const makeAccount = (leftEntity: string, rightEntity: string): AccountReplica => ({
  state: {
    leftEntity,
    rightEntity,
    domain: { chainId: 31337, depositoryAddress: addr('de') },
    watchSeed: `0x${'a3'.repeat(32)}`,
    deltas: PersistentAccountStateMap.empty('deltas'),
    locks: PersistentAccountStateMap.empty('locks'),
    pulls: PersistentAccountStateMap.empty('pulls'),
    swapOffers: PersistentAccountStateMap.empty('swapOffers'),
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    jNonce: 0,
    requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
    requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
  },
  status: 'active',
  mempool: [],
  currentFrame: {
    height: 1,
    timestamp: 1_000,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: '',
    accountStateRoot: `0x${'00'.repeat(32)}`,
    stateHash: '',
    deltas: [],
    byLeft: true,
  },
  currentHeight: 1,
  rollbackCount: 0,
  proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nextProofNonce: 1 },
  pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
  shadow: { rebalance: {
    policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
    submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
  } },
});

const installDelta = (account: AccountReplica, tokenId: number, credit = 10n ** 30n): Delta => {
  const delta = createDefaultDelta(tokenId);
  delta.leftCreditLimit = credit;
  delta.rightCreditLimit = credit;
  delta.leftHold = 0n;
  delta.rightHold = 0n;
  account.state.deltas = requirePersistentAccountStateMap(
    account.state.deltas,
    'deltas',
  ).updated(tokenId, delta);
  return delta;
};

const seedSameSwapAccount = (swaps: number): AccountReplica => {
  const left = entity('11');
  const right = entity('22');
  const account = makeAccount(left, right);
  const giveDelta = installDelta(account, 2);
  installDelta(account, 1);
  const giveAmount = SWAP_LOT_SCALE;
  const wantAmount = 3_000n * SWAP_LOT_SCALE;
  giveDelta.leftHold = giveAmount * BigInt(swaps);
  account.state.deltas = requirePersistentAccountStateMap(account.state.deltas, 'deltas')
    .updated(2, giveDelta);
  for (let index = 0; index < swaps; index += 1) {
    const offer: SwapOffer = {
      offerId: `same-${index}`,
      giveTokenId: 2,
      ...getStaticSwapTokenDimensions(2, 1),
      giveAmount,
      wantTokenId: 1,
      wantAmount,
      maxFee: 0n,
      minNetReceive: wantAmount,
      priceTicks: 3_000n * ORDERBOOK_PRICE_SCALE,
      timeInForce: 0,
      makerIsLeft: true,
      createdHeight: index,
      quantizedGive: giveAmount,
      quantizedWant: wantAmount,
    };
    account.state.swapOffers = requirePersistentAccountStateMap(
      account.state.swapOffers,
      'swapOffers',
    ).updated(offer.offerId, offer);
  }
  return account;
};

const seedCrossSwapAccount = (swaps: number): AccountReplica => {
  const sourceUser = entity('33');
  const sourceHub = entity('44');
  const targetHub = entity('55');
  const targetUser = entity('66');
  const account = makeAccount(sourceUser, sourceHub);
  const sourceDelta = installDelta(account, 1);
  const sourceAmount = SWAP_LOT_SCALE;
  const targetAmount = 2n * SWAP_LOT_SCALE;
  sourceDelta.leftHold = sourceAmount * BigInt(swaps);
  account.state.deltas = requirePersistentAccountStateMap(account.state.deltas, 'deltas')
    .updated(1, sourceDelta);
  const template = buildPreparedCrossJurisdictionRoute({
    orderId: 'cross-template',
    makerEntityId: sourceUser,
    hubEntityId: sourceHub,
    bookOwnerEntityId: sourceHub,
    venueId: 'cross:bench-source:1/bench-target:1',
    sourceDisputeConfig: { ...account.state.disputeConfig },
    targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
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
  }, { runtimeSeed: 'swap-runtime-bench', now: 1_000 });
  let templateRoute: CrossJurisdictionSwapRoute = {
    ...template,
    status: 'resting' as const,
  };
  account.state.pulls = requirePersistentAccountStateMap(
    account.state.pulls!,
    'pulls',
  ).updated(templateRoute.sourcePull!.pullId, {
    pullId: templateRoute.sourcePull!.pullId,
    tokenId: templateRoute.sourcePull!.tokenId,
    amount: templateRoute.sourcePull!.signedAmount,
    claimedRatio: 0,
    claimedAmount: 0n,
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
      status: 'resting' as const,
    };
    const offer: SwapOffer = {
      offerId: orderId,
      giveTokenId: route.source.tokenId,
      ...getStaticSwapTokenDimensions(route.source.tokenId, route.target.tokenId),
      giveAmount: route.source.amount,
      wantTokenId: route.target.tokenId,
      wantAmount: route.target.amount,
      maxFee: 0n,
      minNetReceive: route.target.amount,
      priceTicks: 2n * ORDERBOOK_PRICE_SCALE,
      timeInForce: 0,
      makerIsLeft: true,
      createdHeight: index,
      quantizedGive: route.source.amount,
      quantizedWant: route.target.amount,
      crossJurisdiction: route,
    };
    account.state.swapOffers = requirePersistentAccountStateMap(
      account.state.swapOffers,
      'swapOffers',
    ).updated(orderId, offer);
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

const applyAccountFrame = async (
  account: AccountReplica,
  txs: readonly AccountTx[],
  timestamp: number,
  jHeight: number,
): Promise<void> => {
  const owner = beginAccountTransition(
    account,
    { purpose: 'benchmark-frame', txs },
  );
  try {
    const draft = accountTransitionView(owner);
    for (const tx of txs) {
      const result = await applyAccountTx(draft, tx, false, timestamp, jHeight);
      if (!result.ok) throw new Error(`SWAP_RUNTIME_BENCH_TX_REJECTED:${result.rejection.message}`);
    }
    publishAccountTransition(account, owner);
  } catch (error) {
    if (owner.lifecycle.status === 'active') discardAccountTransition(owner);
    throw error;
  }
};

const runPass = async (
  swaps: number,
  txsPerFrame: number,
): Promise<{ same: AccountReplica; cross: AccountReplica; elapsedMs: number; sameElapsedMs: number; crossElapsedMs: number }> => {
  const same = seedSameSwapAccount(swaps);
  const cross = seedCrossSwapAccount(swaps);
  let sameElapsedMs = 0;
  for (let index = 0; index < swaps; index += txsPerFrame) {
    const txs = Array.from(
      { length: Math.min(txsPerFrame, swaps - index) },
      (_, offset) => sameResolveTx(index + offset),
    );
    const startedAt = getPerfMs();
    await applyAccountFrame(same, txs, 2_000 + index, 2 + index);
    sameElapsedMs += getPerfMs() - startedAt;
  }
  let crossElapsedMs = 0;
  for (let index = 0; index < swaps; index += txsPerFrame) {
    const txs = Array.from(
      { length: Math.min(txsPerFrame, swaps - index) },
      (_, offset) => crossAckTx(index + offset),
    );
    const startedAt = getPerfMs();
    await applyAccountFrame(cross, txs, 2_000 + index, 2 + index);
    crossElapsedMs += getPerfMs() - startedAt;
  }
  return { same, cross, elapsedMs: sameElapsedMs + crossElapsedMs, sameElapsedMs, crossElapsedMs };
};

export const runSwapRuntimeBenchmark = async (cli: Cli): Promise<RuntimeSwapBenchmarkResult> => {
  if (cli.txsPerFrame > 5) throw new Error(`SWAP_RUNTIME_BENCH_FRAME_TOO_LARGE:${cli.txsPerFrame}:5`);
  if (cli.warmup > 0) await runPass(cli.warmup, cli.txsPerFrame);
  const { same, cross, elapsedMs, sameElapsedMs, crossElapsedMs } = await runPass(cli.swaps, cli.txsPerFrame);
  if (same.state.swapOffers.size !== 0) throw new Error(`SAME_OFFERS_LEFT:${same.state.swapOffers.size}`);
  if (cross.state.swapOffers.size !== 0) throw new Error(`CROSS_OFFERS_LEFT:${cross.state.swapOffers.size}`);
  const totalSwaps = cli.swaps * 2;
  const elapsedSeconds = Math.max(elapsedMs / 1000, 0.001);
  const tps = totalSwaps / elapsedSeconds;
  const sameTps = cli.swaps / Math.max(sameElapsedMs / 1000, 0.001);
  const crossTps = cli.swaps / Math.max(crossElapsedMs / 1000, 0.001);
  const passed = tps >= cli.minTps && sameTps >= cli.minTps && crossTps >= cli.minTps;
  const output: RuntimeSwapBenchmarkResult = {
    benchmark: 'swap-account-runtime',
    sameSwaps: cli.swaps,
    crossSwaps: cli.swaps,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    tps: Number(tps.toFixed(2)),
    minTps: cli.minTps,
    passed,
    sameTps: Number(sameTps.toFixed(2)),
    crossTps: Number(crossTps.toFixed(2)),
    sameOffdelta: String(same.state.deltas.get(2)?.offdelta ?? 0n),
    txsPerFrame: cli.txsPerFrame,
    accountFrames: Math.ceil(cli.swaps / cli.txsPerFrame) * 2,
  };
  if (!output.passed) {
    throw new Error(
      `SWAP_RUNTIME_TPS_BELOW_TARGET:` +
      `aggregate=${tps.toFixed(2)} same=${sameTps.toFixed(2)} cross=${crossTps.toFixed(2)}<${cli.minTps}`,
    );
  }
  return output;
};

if (import.meta.main) {
  console.log(JSON.stringify(await runSwapRuntimeBenchmark(parseCli(globalThis.process.argv.slice(2))), null, 2));
}
