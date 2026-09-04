import { applyAccountTx } from '../../../account/tx/apply';
import {
  accountTransitionView,
  beginAccountTransition,
  discardAccountTransition,
  publishAccountTransition,
} from '../../../account/state/candidate-overlay';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { getStaticSwapTokenDimensions, ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from '../../../orderbook';
import type { AccountReplica, AccountTx, Delta, SwapOffer } from '../../../types/account';
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
  elapsedMs: number;
  tps: number;
  minTps: number;
  passed: boolean;
  sameTps: number;
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


const applyAccountFrame = async (
  account: AccountReplica,
  txs: readonly AccountTx[],
  timestamp: number,
  jHeight: number,
): Promise<void> => {
  const owner = beginAccountTransition(account);
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
): Promise<{ same: AccountReplica; elapsedMs: number }> => {
  const same = seedSameSwapAccount(swaps);
  let elapsedMs = 0;
  for (let index = 0; index < swaps; index += txsPerFrame) {
    const txs = Array.from(
      { length: Math.min(txsPerFrame, swaps - index) },
      (_, offset) => sameResolveTx(index + offset),
    );
    const startedAt = getPerfMs();
    await applyAccountFrame(same, txs, 2_000 + index, 2 + index);
    elapsedMs += getPerfMs() - startedAt;
  }
  return { same, elapsedMs };
};

export const runSwapRuntimeBenchmark = async (cli: Cli): Promise<RuntimeSwapBenchmarkResult> => {
  if (cli.txsPerFrame > 5) throw new Error(`SWAP_RUNTIME_BENCH_FRAME_TOO_LARGE:${cli.txsPerFrame}:5`);
  if (cli.warmup > 0) await runPass(cli.warmup, cli.txsPerFrame);
  const { same, elapsedMs } = await runPass(cli.swaps, cli.txsPerFrame);
  if (same.state.swapOffers.size !== 0) throw new Error(`SAME_OFFERS_LEFT:${same.state.swapOffers.size}`);
  const elapsedSeconds = Math.max(elapsedMs / 1000, 0.001);
  const tps = cli.swaps / elapsedSeconds;
  const output: RuntimeSwapBenchmarkResult = {
    benchmark: 'swap-account-runtime',
    sameSwaps: cli.swaps,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    tps: Number(tps.toFixed(2)),
    minTps: cli.minTps,
    passed: tps >= cli.minTps,
    sameTps: Number(tps.toFixed(2)),
    sameOffdelta: String(same.state.deltas.get(2)?.offdelta ?? 0n),
    txsPerFrame: cli.txsPerFrame,
    accountFrames: Math.ceil(cli.swaps / cli.txsPerFrame),
  };
  if (!output.passed) {
    throw new Error(`SWAP_RUNTIME_TPS_BELOW_TARGET:same=${tps.toFixed(2)}<${cli.minTps}`);
  }
  return output;
};

if (import.meta.main) {
  console.log(JSON.stringify(await runSwapRuntimeBenchmark(parseCli(globalThis.process.argv.slice(2))), null, 2));
}
