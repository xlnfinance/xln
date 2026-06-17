import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { handleAccountInput, proposeAccountFrame } from '../account-consensus';
import { isLeft } from '../account-utils';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
} from '../cross-jurisdiction';
import { buildCrossJurisdictionBookAdmissionReceipt } from '../cross-jurisdiction-orderbook';
import { generateLazyEntityId } from '../entity-factory';
import { MAX_ACCOUNT_FRAME_TXS } from '../account-consensus-frame';
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
  concurrency: number;
  batchSize: number;
  processes: number;
};

type BenchAccountCase = {
  kind: 'same' | 'cross';
  proposerEnv: Env;
  receiverEnv: Env;
  proposer: AccountMachine;
  receiver: AccountMachine;
  txs: AccountTx[];
  swapCount: number;
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
  batchSize: number;
  committedSwaps: number;
  concurrency: number;
  processes: number;
  scope: string;
  stageMs?: {
    propose: number;
    receive: number;
    commit: number;
  };
};

type StageTotals = {
  propose: number;
  receive: number;
  commit: number;
  count: number;
};

const createStageTotals = (): StageTotals => ({ propose: 0, receive: 0, commit: 0, count: 0 });

const averageStageMs = (stages: StageTotals): HubConsensusBenchmarkResult['stageMs'] | undefined => {
  if (stages.count === 0) return undefined;
  return {
    propose: Number((stages.propose / stages.count).toFixed(3)),
    receive: Number((stages.receive / stages.count).toFixed(3)),
    commit: Number((stages.commit / stages.count).toFixed(3)),
  };
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
  concurrency: positiveInt(args, '--concurrency', 128),
  batchSize: Math.min(positiveInt(args, '--batch-size', MAX_ACCOUNT_FRAME_TXS), MAX_ACCOUNT_FRAME_TXS),
  processes: positiveInt(args, '--processes', 1),
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
  const identity = registerBenchIdentity(seed, slot);
  addReplica(env, identity.entityId, identity.signerId, jurisdiction);
  return identity;
};

const registerBenchIdentity = (
  seed: string,
  slot: string,
): { entityId: string; signerId: string } => {
  const signerId = deriveSignerAddressSync(seed, slot);
  registerSignerKey(signerId, deriveSignerKeySync(seed, slot));
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
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
    watchSeed: `0x${'a2'.repeat(32)}`,
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
  hubEnv: Env,
  jurisdiction: JurisdictionConfig,
  hubId: string,
  startIndex: number,
  count: number,
): BenchAccountCase => {
  const receiverEnv = makeParticipantEnv(`hub-consensus-same-${startIndex}`, jurisdiction);
  const userId = registerBenchEntity(receiverEnv, jurisdiction, `hub-consensus-same-${startIndex}`, 'user').entityId;
  const base = makeAccount(userId, hubId);
  const giveDelta = installDelta(base, 2);
  installDelta(base, 1);
  const giveAmount = SWAP_LOT_SCALE;
  const wantAmount = 3_000n * SWAP_LOT_SCALE;
  const makerIsLeft = isLeft(userId, hubId);
  const totalGiveAmount = giveAmount * BigInt(count);
  if (makerIsLeft) giveDelta.leftHold = totalGiveAmount;
  else giveDelta.rightHold = totalGiveAmount;
  const txs: AccountTx[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    const offerId = `same-${index}`;
    base.swapOffers.set(offerId, {
      offerId,
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
    txs.push({
      type: 'swap_resolve',
      data: {
        offerId,
        fillRatio: 65_535,
        fillNumerator: 1n,
        fillDenominator: 1n,
        cancelRemainder: true,
        executionGiveAmount: giveAmount,
        executionWantAmount: wantAmount,
      },
    });
  }
  const user = mirrorAccount(base, userId, hubId);
  const hub = mirrorAccount(base, hubId, userId);
  return {
    kind: 'same',
    proposerEnv: hubEnv,
    receiverEnv,
    proposer: hub,
    receiver: user,
    txs,
    swapCount: count,
  };
};

const makeCrossCase = (
  hubEnv: Env,
  jurisdiction: JurisdictionConfig,
  hubId: string,
  startIndex: number,
  count: number,
): BenchAccountCase => {
  const receiverEnv = makeParticipantEnv(`hub-consensus-cross-source-${startIndex}`, jurisdiction);
  const sourceUser = registerBenchEntity(receiverEnv, jurisdiction, `hub-consensus-cross-source-${startIndex}`, 'user').entityId;
  const targetUser = registerBenchIdentity(`hub-consensus-cross-target-${startIndex}`, 'user').entityId;
  const targetHub = registerBenchIdentity(`hub-consensus-cross-target-hub-${startIndex}`, 'hub').entityId;
  const sourceAmount = SWAP_LOT_SCALE;
  const targetAmount = 2n * SWAP_LOT_SCALE;
  const base = makeAccount(sourceUser, hubId);
  const sourceDelta = installDelta(base, 1);
  const makerIsLeft = isLeft(sourceUser, hubId);
  const totalSourceAmount = sourceAmount * BigInt(count);
  if (makerIsLeft) sourceDelta.leftHold = totalSourceAmount;
  else sourceDelta.rightHold = totalSourceAmount;
  const txs: AccountTx[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    const offerId = `cross-${index}`;
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: offerId,
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
    base.swapOffers.set(offerId, {
      offerId,
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
    txs.push({
      type: 'cross_swap_fill_ack',
      data: {
        offerId,
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
    });
  }
  const user = mirrorAccount(base, sourceUser, hubId);
  const hub = mirrorAccount(base, hubId, sourceUser);
  return {
    kind: 'cross',
    proposerEnv: hubEnv,
    receiverEnv,
    proposer: hub,
    receiver: user,
    txs,
    swapCount: count,
  };
};

const expectInput = (input: AccountInput | undefined, context: string): AccountInput => {
  if (!input) throw new Error(`${context}:missing_account_input`);
  return input;
};

const runConsensusRoundTrip = async (benchCase: BenchAccountCase, stages?: StageTotals): Promise<void> => {
  benchCase.proposer.mempool.push(...benchCase.txs);
  const proposeStartedAt = getPerfMs();
  const proposed = await proposeAccountFrame(benchCase.proposerEnv, benchCase.proposer);
  const receiveStartedAt = getPerfMs();
  if (!proposed.success) throw new Error(`${benchCase.kind}:propose_failed:${proposed.error}`);
  const received = await handleAccountInput(benchCase.receiverEnv, benchCase.receiver, expectInput(proposed.accountInput, benchCase.kind));
  const commitStartedAt = getPerfMs();
  if (!received.success) throw new Error(`${benchCase.kind}:receive_failed:${received.error}`);
  const committed = await handleAccountInput(benchCase.proposerEnv, benchCase.proposer, expectInput(received.response, benchCase.kind));
  const committedAt = getPerfMs();
  if (stages) {
    stages.propose += receiveStartedAt - proposeStartedAt;
    stages.receive += commitStartedAt - receiveStartedAt;
    stages.commit += committedAt - commitStartedAt;
    stages.count += 1;
  }
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

const makeParticipantEnv = (seed: string, jurisdiction: JurisdictionConfig): Env => {
  const env = createEmptyEnv(seed);
  env.runtimeSeed = seed;
  env.quietRuntimeLogs = true;
  installJurisdiction(env, jurisdiction);
  return env;
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
  batchSize: number,
): { same: BenchAccountCase[]; cross: BenchAccountCase[] } => {
  const same: BenchAccountCase[] = [];
  const cross: BenchAccountCase[] = [];
  const width = Math.max(1, Math.min(batchSize, MAX_ACCOUNT_FRAME_TXS));
  for (let index = 0; index < swaps; index += width) {
    const count = Math.min(width, swaps - index);
    same.push(makeSameCase(env, jurisdiction, hubId, index, count));
    cross.push(makeCrossCase(env, jurisdiction, hubId, index, count));
  }
  return { same, cross };
};

const runMeasuredCases = async (
  cases: BenchAccountCase[],
  concurrency: number,
  stages?: StageTotals,
): Promise<{ elapsedMs: number; swaps: number }> => {
  const startedAt = getPerfMs();
  let swaps = 0;
  const width = Math.max(1, Math.floor(concurrency));
  for (let index = 0; index < cases.length; index += width) {
    const group = cases.slice(index, index + width);
    await Promise.all(group.map((benchCase) => runConsensusRoundTrip(benchCase, stages)));
    swaps += group.reduce((sum, benchCase) => sum + benchCase.swapCount, 0);
  }
  return { elapsedMs: getPerfMs() - startedAt, swaps };
};

const runPass = async (
  swaps: number,
  seed: string,
  concurrency: number,
  batchSize: number,
): Promise<{
  sameElapsedMs: number;
  crossElapsedMs: number;
  sameSwaps: number;
  crossSwaps: number;
  elapsedMs: number;
  stages: StageTotals;
  frames: number;
}> => {
  const { env, jurisdiction, hubId } = makeEnv(seed);
  const { same, cross } = buildCases(env, jurisdiction, hubId, swaps, batchSize);
  const stages = concurrency === 1 ? createStageTotals() : undefined;
  const startedAt = getPerfMs();
  const sameResult = await runMeasuredCases(same, concurrency, stages);
  const crossResult = await runMeasuredCases(cross, concurrency, stages);
  return {
    sameElapsedMs: sameResult.elapsedMs,
    crossElapsedMs: crossResult.elapsedMs,
    sameSwaps: sameResult.swaps,
    crossSwaps: crossResult.swaps,
    elapsedMs: getPerfMs() - startedAt,
    stages: stages ?? createStageTotals(),
    frames: same.length + cross.length,
  };
};

const scriptPath = (): string => fileURLToPath(import.meta.url);

const runWorkerProcess = (
  cli: Cli,
  workerIndex: number,
): Promise<HubConsensusBenchmarkResult> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    scriptPath(),
    '--swaps', String(cli.swaps),
    '--warmup', String(cli.warmup),
    '--min-tps', '1',
    '--concurrency', String(cli.concurrency),
    '--batch-size', String(cli.batchSize),
    '--processes', '1',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      XLN_SWAP_CONSENSUS_WORKER: String(workerIndex),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) {
      reject(new Error(`SWAP_CONSENSUS_WORKER_FAILED:${workerIndex}:code=${code}\n${stderr || stdout}`));
      return;
    }
    try {
      const parsed = JSON.parse(stdout.trim()) as HubConsensusBenchmarkResult;
      resolve(parsed);
    } catch (error) {
      reject(new Error(`SWAP_CONSENSUS_WORKER_BAD_JSON:${workerIndex}:${(error as Error).message}\n${stdout}\n${stderr}`));
    }
  });
});

const runDistributedWorkers = async (cli: Cli): Promise<HubConsensusBenchmarkResult> => {
  const workers = await Promise.all(
    Array.from({ length: cli.processes }, (_, index) => runWorkerProcess(cli, index)),
  );
  const sameSwaps = workers.reduce((sum, worker) => sum + worker.sameSwaps, 0);
  const crossSwaps = workers.reduce((sum, worker) => sum + worker.crossSwaps, 0);
  const committedSwaps = workers.reduce((sum, worker) => sum + worker.committedSwaps, 0);
  const committedFrames = workers.reduce((sum, worker) => sum + worker.committedFrames, 0);
  const elapsedMs = Math.max(...workers.map((worker) => worker.elapsedMs), 0.001);
  const sameElapsedMs = Math.max(...workers.map((worker) =>
    worker.sameTps > 0 ? (worker.sameSwaps / worker.sameTps) * 1000 : worker.elapsedMs,
  ), 0.001);
  const crossElapsedMs = Math.max(...workers.map((worker) =>
    worker.crossTps > 0 ? (worker.crossSwaps / worker.crossTps) * 1000 : worker.elapsedMs,
  ), 0.001);
  const totalSwaps = sameSwaps + crossSwaps;
  const tps = totalSwaps / Math.max(elapsedMs / 1000, 0.001);
  const output: HubConsensusBenchmarkResult = {
    benchmark: 'swap-hub-account-consensus',
    sameSwaps,
    crossSwaps,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    tps: Number(tps.toFixed(2)),
    minTps: cli.minTps,
    passed: tps >= cli.minTps,
    sameTps: Number((sameSwaps / Math.max(sameElapsedMs / 1000, 0.001)).toFixed(2)),
    crossTps: Number((crossSwaps / Math.max(crossElapsedMs / 1000, 0.001)).toFixed(2)),
    committedFrames,
    batchSize: cli.batchSize,
    committedSwaps,
    concurrency: cli.concurrency,
    processes: cli.processes,
    scope: 'batched distributed account consensus throughput aggregated across worker processes; each worker runs hub propose/commit + user ACK with hanko sign/verify and dispute proof',
  };
  return output;
};

export const runSwapHubConsensusBenchmark = async (cli: Cli): Promise<HubConsensusBenchmarkResult> => {
  if (cli.processes > 1) return runDistributedWorkers(cli);
  if (cli.warmup > 0) await runPass(cli.warmup, 'swap-hub-consensus-warmup', cli.concurrency, cli.batchSize);
  const { sameElapsedMs, crossElapsedMs, sameSwaps, crossSwaps, elapsedMs, stages, frames } = await runPass(
    cli.swaps,
    'swap-hub-consensus-measured',
    cli.concurrency,
    cli.batchSize,
  );
  const totalSwaps = sameSwaps + crossSwaps;
  const elapsedSeconds = Math.max(elapsedMs / 1000, 0.001);
  const sameTps = sameSwaps / Math.max(sameElapsedMs / 1000, 0.001);
  const crossTps = crossSwaps / Math.max(crossElapsedMs / 1000, 0.001);
  const tps = totalSwaps / elapsedSeconds;
  const stageMs = averageStageMs(stages);
  const output: HubConsensusBenchmarkResult = {
    benchmark: 'swap-hub-account-consensus',
    sameSwaps,
    crossSwaps,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    tps: Number(tps.toFixed(2)),
    minTps: cli.minTps,
    passed: tps >= cli.minTps,
    sameTps: Number(sameTps.toFixed(2)),
    crossTps: Number(crossTps.toFixed(2)),
    committedFrames: frames,
    batchSize: cli.batchSize,
    committedSwaps: totalSwaps,
    concurrency: cli.concurrency,
    processes: cli.processes,
    scope: 'batched distributed account consensus throughput: hub propose/commit + user ACK on independent accounts; up to 100 swap txs per account frame; includes hanko sign/verify and dispute proof, excludes entity frame and storage flush',
    ...(stageMs ? { stageMs } : {}),
  };
  return output;
};

if (import.meta.main) {
  const output = await runSwapHubConsensusBenchmark(parseCli(globalThis.process.argv.slice(2)));
  console.log(JSON.stringify(output, null, 2));
  globalThis.process.exit(output.passed ? 0 : 1);
}
