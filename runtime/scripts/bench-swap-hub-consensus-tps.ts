import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { handleAccountInput, proposeAccountFrame } from '../account-consensus';
import { isLeft } from '../account-utils';
import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
} from '../cross-jurisdiction';
import { buildCrossJurisdictionBookAdmissionReceipt } from '../cross-jurisdiction-orderbook';
import { generateLazyEntityId } from '../entity-factory';
import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from '../orderbook';
import { setDeltaTransformerAddress } from '../proof-builder';
import { createEmptyEnv } from '../runtime';
import type {
  AccountInput,
  AccountMachine,
  AccountTx,
  ConsensusConfig,
  CrossJurisdictionSwapRoute,
  Delta,
  EntityReplica,
  EntityState,
  Env,
  JurisdictionConfig,
} from '../types';
import { getPerfMs } from '../utils';
import { createDefaultDelta } from '../validation-utils';

type Cli = {
  swaps: number;
  warmup: number;
  minTps: number;
};

type BenchAccountCase = {
  kind: 'same' | 'cross';
  proposer: AccountMachine;
  receiver: AccountMachine;
  tx: AccountTx;
};

type HubConsensusBenchmarkResult = {
  benchmark: 'swap-hub-account-consensus';
  sameSwaps: number;
  crossSwaps: number;
  elapsedMs: number;
  tps: number;
  minTps: number;
  passed: boolean;
  sameTps: number;
  crossTps: number;
  committedFrames: number;
  scope: string;
};

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
  swaps: positiveInt(args, '--swaps', 1_000),
  warmup: nonNegativeInt(args, '--warmup', 100),
  minTps: positiveInt(args, '--min-tps', 10_000),
});

const makeJurisdiction = (): JurisdictionConfig => ({
  name: 'BenchJ',
  address: 'rpc://bench',
  chainId: 999_001,
  blockTimeMs: 1_000,
  depositoryAddress: addr('de'),
  entityProviderAddress: addr('ef'),
});

const makeConfig = (signerId: string, jurisdiction: JurisdictionConfig): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction,
});

const makeEntityState = (
  entityId: string,
  signerId: string,
  jurisdiction: JurisdictionConfig,
): EntityState => ({
  entityId,
  height: 1,
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: makeConfig(signerId, jurisdiction),
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  jBlockObservations: [],
  jBlockChain: [],
  entityEncPubKey: `0x${'aa'.repeat(32)}`,
  entityEncPrivKey: `0x${'bb'.repeat(32)}`,
  profile: { name: 'bench', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  crossJurisdictionSwaps: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
});

const addReplica = (
  env: Env,
  entityId: string,
  signerId: string,
  jurisdiction: JurisdictionConfig,
): void => {
  env.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    mempool: [],
    isProposer: true,
    state: makeEntityState(entityId, signerId, jurisdiction),
  } as EntityReplica);
};

const registerBenchEntity = (
  env: Env,
  jurisdiction: JurisdictionConfig,
  seed: string,
  slot: string,
): { entityId: string; signerId: string } => {
  const signerId = deriveSignerAddressSync(seed, slot);
  registerSignerKey(signerId, deriveSignerKeySync(seed, slot));
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  addReplica(env, entityId, signerId, jurisdiction);
  return { entityId, signerId };
};

const installJurisdiction = (env: Env, jurisdiction: JurisdictionConfig): void => {
  env.activeJurisdiction = jurisdiction.name;
  const deltaTransformer = addr('dd');
  setDeltaTransformerAddress(deltaTransformer);
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    chainId: jurisdiction.chainId,
    rpcs: [jurisdiction.address],
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      account: addr('ac'),
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      deltaTransformer,
    },
    blockTimeMs: jurisdiction.blockTimeMs,
    defaultDisputeDelayBlocks: 5,
  } as never);
};

const installDelta = (account: AccountMachine, tokenId: number, credit = 10n ** 30n): Delta => {
  const delta = createDefaultDelta(tokenId);
  delta.leftCreditLimit = credit;
  delta.rightCreditLimit = credit;
  account.deltas.set(tokenId, delta);
  return delta;
};

const makeAccount = (selfId: string, counterpartyId: string): AccountMachine => {
  const [leftEntity, rightEntity] = selfId.toLowerCase() < counterpartyId.toLowerCase()
    ? [selfId, counterpartyId]
    : [counterpartyId, selfId];
  return {
    leftEntity,
    rightEntity,
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
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
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    proofHeader: { fromEntity: selfId, toEntity: counterpartyId, nonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    onChainSettlementNonce: 0,
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    rebalancePolicy: new Map(),
  };
};

const mirrorAccount = (
  source: AccountMachine,
  selfId: string,
  counterpartyId: string,
): AccountMachine => {
  const mirror = structuredClone(source) as AccountMachine;
  mirror.proofHeader = { fromEntity: selfId, toEntity: counterpartyId, nonce: 0 };
  return mirror;
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

const makeSameCase = (
  env: Env,
  jurisdiction: JurisdictionConfig,
  hubId: string,
  index: number,
): BenchAccountCase => {
  const userId = registerBenchEntity(env, jurisdiction, `hub-consensus-same-${index}`, 'user').entityId;
  const base = makeAccount(userId, hubId);
  const giveDelta = installDelta(base, 2);
  installDelta(base, 1);
  const giveAmount = SWAP_LOT_SCALE;
  const wantAmount = 3_000n * SWAP_LOT_SCALE;
  const makerIsLeft = isLeft(userId, hubId);
  if (makerIsLeft) giveDelta.leftHold = giveAmount;
  else giveDelta.rightHold = giveAmount;
  base.swapOffers.set(`same-${index}`, {
    offerId: `same-${index}`,
    giveTokenId: 2,
    giveAmount,
    wantTokenId: 1,
    wantAmount,
    priceTicks: 3_000n * ORDERBOOK_PRICE_SCALE,
    timeInForce: 0,
    minFillRatio: 0,
    makerIsLeft,
    createdHeight: 0,
    quantizedGive: giveAmount,
    quantizedWant: wantAmount,
  });
  const user = mirrorAccount(base, userId, hubId);
  const hub = mirrorAccount(base, hubId, userId);
  return {
    kind: 'same',
    proposer: hub,
    receiver: user,
    tx: {
      type: 'swap_resolve',
      data: {
        offerId: `same-${index}`,
        fillRatio: 65_535,
        fillNumerator: 1n,
        fillDenominator: 1n,
        cancelRemainder: true,
        executionGiveAmount: giveAmount,
        executionWantAmount: wantAmount,
      },
    },
  };
};

const makeCrossCase = (
  env: Env,
  jurisdiction: JurisdictionConfig,
  hubId: string,
  index: number,
): BenchAccountCase => {
  const sourceUser = registerBenchEntity(env, jurisdiction, `hub-consensus-cross-source-${index}`, 'user').entityId;
  const targetUser = registerBenchEntity(env, jurisdiction, `hub-consensus-cross-target-${index}`, 'user').entityId;
  const targetHub = registerBenchEntity(env, jurisdiction, `hub-consensus-cross-target-hub-${index}`, 'hub').entityId;
  const sourceAmount = SWAP_LOT_SCALE;
  const targetAmount = 2n * SWAP_LOT_SCALE;
  const route = buildPreparedCrossJurisdictionRoute({
    orderId: `cross-${index}`,
    makerEntityId: sourceUser,
    hubEntityId: hubId,
    bookOwnerEntityId: hubId,
    venueId: 'cross:bench-source:1/bench-target:1',
    source: {
      jurisdiction: `stack:1:${addr('11')}`,
      entityId: sourceUser,
      counterpartyEntityId: hubId,
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
  }, { runtimeSeed: 'swap-hub-consensus-bench', sourceDisputeDelayMs: 5_000, now: 1_000 });
  const admittedRoute: CrossJurisdictionSwapRoute = {
    ...route,
    status: 'resting',
  };
  admittedRoute.targetReceipt = targetReceiptFor(admittedRoute);

  const base = makeAccount(sourceUser, hubId);
  const sourceDelta = installDelta(base, 1);
  const makerIsLeft = isLeft(sourceUser, hubId);
  if (makerIsLeft) sourceDelta.leftHold = sourceAmount;
  else sourceDelta.rightHold = sourceAmount;
  base.pulls!.set(admittedRoute.sourcePull!.pullId, {
    pullId: admittedRoute.sourcePull!.pullId,
    tokenId: admittedRoute.sourcePull!.tokenId,
    amount: admittedRoute.sourcePull!.signedAmount,
    claimedRatio: 0,
    claimedAmount: 0n,
    revealedUntilTimestamp: admittedRoute.sourcePull!.revealedUntilTimestamp,
    fullHash: admittedRoute.sourcePull!.fullHash,
    partialRoot: admittedRoute.sourcePull!.partialRoot,
    crossJurisdiction: buildCrossJurisdictionPullBinding(admittedRoute, 'source'),
    createdHeight: 0,
    createdTimestamp: 1_000,
  });
  base.swapOffers.set(`cross-${index}`, {
    offerId: `cross-${index}`,
    giveTokenId: admittedRoute.source.tokenId,
    giveAmount: admittedRoute.source.amount,
    wantTokenId: admittedRoute.target.tokenId,
    wantAmount: admittedRoute.target.amount,
    priceTicks: 2n * ORDERBOOK_PRICE_SCALE,
    timeInForce: 0,
    minFillRatio: 0,
    makerIsLeft,
    createdHeight: 0,
    quantizedGive: admittedRoute.source.amount,
    quantizedWant: admittedRoute.target.amount,
    crossJurisdiction: admittedRoute,
  });
  const user = mirrorAccount(base, sourceUser, hubId);
  const hub = mirrorAccount(base, hubId, sourceUser);
  return {
    kind: 'cross',
    proposer: hub,
    receiver: user,
    tx: {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: `cross-${index}`,
        fillSeq: 1,
        incrementalSourceAmount: sourceAmount,
        incrementalTargetAmount: targetAmount,
        cumulativeSourceAmount: sourceAmount,
        cumulativeTargetAmount: targetAmount,
        cumulativeFillRatio: 65_535,
        fillNumerator: 1n,
        fillDenominator: 1n,
        executionSourceAmount: sourceAmount - 1n,
        executionTargetAmount: targetAmount,
        priceImprovementMode: 'source_savings',
        priceImprovementAmount: 1n,
        priceImprovementTokenId: 1,
        cancelRemainder: true,
        pairId: 'cross:bench-source:1/bench-target:1',
      },
    },
  };
};

const expectInput = (input: AccountInput | undefined, context: string): AccountInput => {
  if (!input) throw new Error(`${context}:missing_account_input`);
  return input;
};

const runConsensusRoundTrip = async (env: Env, benchCase: BenchAccountCase): Promise<void> => {
  benchCase.proposer.mempool.push(benchCase.tx);
  const proposed = await proposeAccountFrame(env, benchCase.proposer);
  if (!proposed.success) throw new Error(`${benchCase.kind}:propose_failed:${proposed.error}`);
  const received = await handleAccountInput(env, benchCase.receiver, expectInput(proposed.accountInput, benchCase.kind));
  if (!received.success) throw new Error(`${benchCase.kind}:receive_failed:${received.error}`);
  const committed = await handleAccountInput(env, benchCase.proposer, expectInput(received.response, benchCase.kind));
  if (!committed.success) throw new Error(`${benchCase.kind}:commit_failed:${committed.error}`);
  if (benchCase.proposer.currentHeight !== 1 || benchCase.receiver.currentHeight !== 1) {
    throw new Error(
      `${benchCase.kind}:height_mismatch:${benchCase.proposer.currentHeight}/${benchCase.receiver.currentHeight}`,
    );
  }
  if (benchCase.proposer.pendingFrame || benchCase.proposer.mempool.length > 0) {
    throw new Error(`${benchCase.kind}:proposer_not_drained`);
  }
  if (benchCase.proposer.swapOffers.size !== 0 || benchCase.receiver.swapOffers.size !== 0) {
    throw new Error(`${benchCase.kind}:offer_not_closed`);
  }
};

const makeEnv = (seed: string): { env: Env; jurisdiction: JurisdictionConfig; hubId: string } => {
  const env = createEmptyEnv(seed);
  env.runtimeSeed = seed;
  env.quietRuntimeLogs = true;
  const jurisdiction = makeJurisdiction();
  installJurisdiction(env, jurisdiction);
  const hubId = registerBenchEntity(env, jurisdiction, `${seed}-hub`, 'hub').entityId;
  return { env, jurisdiction, hubId };
};

const buildCases = (
  env: Env,
  jurisdiction: JurisdictionConfig,
  hubId: string,
  swaps: number,
): { same: BenchAccountCase[]; cross: BenchAccountCase[] } => {
  const same: BenchAccountCase[] = [];
  const cross: BenchAccountCase[] = [];
  for (let index = 0; index < swaps; index += 1) {
    same.push(makeSameCase(env, jurisdiction, hubId, index));
    cross.push(makeCrossCase(env, jurisdiction, hubId, index));
  }
  return { same, cross };
};

const runMeasuredCases = async (
  env: Env,
  cases: BenchAccountCase[],
): Promise<number> => {
  const startedAt = getPerfMs();
  for (const benchCase of cases) {
    await runConsensusRoundTrip(env, benchCase);
  }
  return getPerfMs() - startedAt;
};

const runPass = async (
  swaps: number,
  seed: string,
): Promise<{ sameElapsedMs: number; crossElapsedMs: number; elapsedMs: number }> => {
  const { env, jurisdiction, hubId } = makeEnv(seed);
  const { same, cross } = buildCases(env, jurisdiction, hubId, swaps);
  const startedAt = getPerfMs();
  const sameElapsedMs = await runMeasuredCases(env, same);
  const crossElapsedMs = await runMeasuredCases(env, cross);
  return { sameElapsedMs, crossElapsedMs, elapsedMs: getPerfMs() - startedAt };
};

export const runSwapHubConsensusBenchmark = async (cli: Cli): Promise<HubConsensusBenchmarkResult> => {
  if (cli.warmup > 0) await runPass(cli.warmup, 'swap-hub-consensus-warmup');
  const { sameElapsedMs, crossElapsedMs, elapsedMs } = await runPass(cli.swaps, 'swap-hub-consensus-measured');
  const totalSwaps = cli.swaps * 2;
  const elapsedSeconds = Math.max(elapsedMs / 1000, 0.001);
  const sameTps = cli.swaps / Math.max(sameElapsedMs / 1000, 0.001);
  const crossTps = cli.swaps / Math.max(crossElapsedMs / 1000, 0.001);
  const tps = totalSwaps / elapsedSeconds;
  const output: HubConsensusBenchmarkResult = {
    benchmark: 'swap-hub-account-consensus',
    sameSwaps: cli.swaps,
    crossSwaps: cli.swaps,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    tps: Number(tps.toFixed(2)),
    minTps: cli.minTps,
    passed: tps >= cli.minTps,
    sameTps: Number(sameTps.toFixed(2)),
    crossTps: Number(crossTps.toFixed(2)),
    committedFrames: totalSwaps,
    scope: 'proposeAccountFrame + hanko sign/verify + dispute proof + ACK commit; excludes entity frame and storage flush',
  };
  return output;
};

if (import.meta.main) {
  const output = await runSwapHubConsensusBenchmark(parseCli(globalThis.process.argv.slice(2)));
  console.log(JSON.stringify(output, null, 2));
  globalThis.process.exit(output.passed ? 0 : 1);
}
