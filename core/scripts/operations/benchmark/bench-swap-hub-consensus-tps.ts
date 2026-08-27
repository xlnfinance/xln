import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { applyAccountInput, proposeAccountFrame } from '../../../account/consensus/index';
import {
  accountInputFailureMessage,
  isProposedAccountFrame,
  proposeAccountFrameMessage,
} from '../../../account/consensus/result';
import { isLeftEntity } from '../../../account/utils';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
} from '../../../extensions/cross-j/index';
import { generateLazyEntityId } from '../../../entity/factory';
import { MAX_ACCOUNT_FRAME_TXS } from '../../../account/consensus/frame/hash';
import { getStaticSwapTokenDimensions, ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from '../../../orderbook';
import { createEmptyEnv } from '../../../runtime';
import type { AccountReplica, AccountTx, Delta, SwapOffer } from '../../../types/account';
import type { ConsensusConfig, EntityReplica, EntityState, JurisdictionConfig } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import { getPerfMs } from '../../../support/time';
import { createDefaultDelta } from '../../../account/state/delta';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import {
  PersistentAccountStateMap,
  requirePersistentAccountStateMap,
} from '../../../account/state/persistent-state-map';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { attachAccountDraftHankosAsEntity } from '../../../qa/account/draft';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { safeStringify } from '../../../protocol/serialization';
import {
  encodeHubConsensusWorkerResult,
  extractHubConsensusWorkerResult,
  HUB_CONSENSUS_PHASES,
  type HubConsensusBenchmarkResult,
  type HubConsensusPhaseMetrics,
} from './swap-hub-consensus-result';

type Cli = {
  swaps: number;
  warmup: number;
  minAggregateAccountConsensusTps: number;
  concurrency: number;
  batchSize: number;
  independentHubCohorts: number;
  users: number;
  includeCross: boolean;
};

type BenchAccountCase = {
  kind: 'same' | 'cross';
  proposerEnv: RuntimeReplica;
  receiverEnv: RuntimeReplica;
  proposer: AccountReplica;
  receiver: AccountReplica;
  txs: AccountTx[];
  swapCount: number;
};

const DEFAULT_BENCH_BATCH_SIZE = 10;
const DEFAULT_INDEPENDENT_HUB_COHORTS = 1;
const DEFAULT_MIN_AGGREGATE_ACCOUNT_CONSENSUS_TPS = 2_000;
const CLI_FLAGS = new Set([
  '--swaps',
  '--warmup',
  '--min-aggregate-account-consensus-tps',
  '--concurrency',
  '--batch-size',
  '--independent-hub-cohorts',
  '--users',
  '--include-cross',
]);

export const assertKnownSwapHubConsensusArgs = (args: string[]): void => {
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !CLI_FLAGS.has(flag)) throw new Error(`UNKNOWN_ARG:${flag ?? ''}`);
    if (!value || value.startsWith('--')) throw new Error(`MISSING_ARG_VALUE:${flag}`);
  }
};

export const partitionConsensusLoad = (
  total: number,
  partitions: number,
  index: number,
): number => {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('CONSENSUS_LOAD_TOTAL_INVALID');
  if (!Number.isSafeInteger(partitions) || partitions <= 0) {
    throw new Error('CONSENSUS_LOAD_PARTITIONS_INVALID');
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= partitions) {
    throw new Error('CONSENSUS_LOAD_INDEX_INVALID');
  }
  return Math.floor(total / partitions) + (index < total % partitions ? 1 : 0);
};

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

const benchmarkSeed = (label: string): string => {
  const worker = globalThis.process.env['XLN_SWAP_CONSENSUS_WORKER'];
  return worker === undefined ? label : `${label}-worker-${worker}`;
};

const parseCli = (args: string[]): Cli => {
  assertKnownSwapHubConsensusArgs(args);
  const swaps = positiveInt(args, '--swaps', 1_000);
  // Keep direct invocation identical to the release gate. MAX_ACCOUNT_FRAME_TXS
  // is an admission bound, not a promise that every heterogeneous payload of
  // that count fits the contract's encoded dispute-proof byte limit.
  const batchSize = Math.min(
    positiveInt(args, '--batch-size', DEFAULT_BENCH_BATCH_SIZE),
    MAX_ACCOUNT_FRAME_TXS,
  );
  return {
    swaps,
    warmup: nonNegativeInt(args, '--warmup', 100),
    minAggregateAccountConsensusTps: positiveInt(
      args,
      '--min-aggregate-account-consensus-tps',
      DEFAULT_MIN_AGGREGATE_ACCOUNT_CONSENSUS_TPS,
    ),
    concurrency: positiveInt(args, '--concurrency', 128),
    batchSize,
    independentHubCohorts: positiveInt(
      args,
      '--independent-hub-cohorts',
      DEFAULT_INDEPENDENT_HUB_COHORTS,
    ),
    users: positiveInt(args, '--users', Math.max(1, Math.ceil(swaps / batchSize))),
    includeCross: nonNegativeInt(args, '--include-cross', 1) !== 0,
  };
};

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
  entityEncryptionPublicKey: `0x${'11'.repeat(32)}`,
  height: 1,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: makeConfig(signerId, jurisdiction),
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
  lastFinalizedJHeight: 0,
  profile: { name: 'bench', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
  crossJurisdictionSwaps: new Map(),
  swapTradingPairs: [],
});

const addReplica = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
  jurisdiction: JurisdictionConfig,
): void => {
  env.state.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    mempool: [],
    isProposer: true,
    state: makeEntityState(entityId, signerId, jurisdiction),
  } as EntityReplica);
};

const registerBenchEntity = (
  env: RuntimeReplica,
  jurisdiction: JurisdictionConfig,
  seed: string,
  slot: string,
): { entityId: string; signerId: string } => {
  const identity = registerBenchIdentity(seed, slot);
  registerSignerKey(env, identity.signerId, deriveSignerKeySync(seed, slot));
  addReplica(env, identity.entityId, identity.signerId, jurisdiction);
  return identity;
};

const registerBenchIdentity = (
  seed: string,
  slot: string,
): { entityId: string; signerId: string } => {
  const signerId = deriveSignerAddressSync(seed, slot);
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  return { entityId, signerId };
};

const installJurisdiction = (env: RuntimeReplica, jurisdiction: JurisdictionConfig): void => {
  env.activeJurisdiction = jurisdiction.name;
  const deltaTransformer = addr('dd');
  env.state.jReplicas.set(jurisdiction.name, {
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
  } as never);
};

const installDelta = (account: AccountReplica, tokenId: number, credit = 10n ** 30n): Delta => {
  const delta = createDefaultDelta(tokenId);
  delta.leftCreditLimit = credit;
  delta.rightCreditLimit = credit;
  account.state.deltas = requirePersistentAccountStateMap(account.state.deltas, 'deltas')
    .updated(tokenId, delta);
  return delta;
};

const makeAccount = (selfId: string, counterpartyId: string): AccountReplica => {
  const [leftEntity, rightEntity] = selfId.toLowerCase() < counterpartyId.toLowerCase()
    ? [selfId, counterpartyId]
    : [counterpartyId, selfId];
  return {
    state: {
      leftEntity,
      rightEntity,
      domain: { chainId: 999_001, depositoryAddress: addr('de') },
      watchSeed: `0x${'a2'.repeat(32)}`,
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
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      stateHash: '',
    },
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: selfId, toEntity: counterpartyId, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: { rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    } },
  };
};

const mirrorAccount = (
  source: AccountReplica,
  selfId: string,
  counterpartyId: string,
): AccountReplica => {
  // Benchmark replicas are independent bounded shells over the same immutable
  // Patricia roots. structuredClone would erase the tree prototypes and test
  // a representation that production explicitly forbids.
  const mirror = forkAccountReplicaShell(source);
  mirror.proofHeader = { fromEntity: selfId, toEntity: counterpartyId, nextProofNonce: 0 };
  return mirror;
};

const makeSameCase = (
  hubEnv: RuntimeReplica,
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
  const makerIsLeft = isLeftEntity(userId, hubId);
  const totalGiveAmount = giveAmount * BigInt(count);
  if (makerIsLeft) giveDelta.leftHold = totalGiveAmount;
  else giveDelta.rightHold = totalGiveAmount;
  base.state.deltas = requirePersistentAccountStateMap(base.state.deltas, 'deltas')
    .updated(2, giveDelta);
  const txs: AccountTx[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    const offerId = `same-${index}`;
    const offer: SwapOffer = {
      offerId,
      giveTokenId: 2,
      ...getStaticSwapTokenDimensions(2, 1),
      giveAmount,
      wantTokenId: 1,
      wantAmount,
      maxFee: 0n,
      minNetReceive: wantAmount,
      priceTicks: 3_000n * ORDERBOOK_PRICE_SCALE,
      timeInForce: 0,
      makerIsLeft,
      createdHeight: 0,
      quantizedGive: giveAmount,
      quantizedWant: wantAmount,
    };
    base.state.swapOffers = requirePersistentAccountStateMap(base.state.swapOffers, 'swapOffers')
      .updated(offerId, offer);
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
  hubEnv: RuntimeReplica,
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
  const makerIsLeft = isLeftEntity(sourceUser, hubId);
  const totalSourceAmount = sourceAmount * BigInt(count);
  if (makerIsLeft) sourceDelta.leftHold = totalSourceAmount;
  else sourceDelta.rightHold = totalSourceAmount;
  base.state.deltas = requirePersistentAccountStateMap(base.state.deltas, 'deltas')
    .updated(1, sourceDelta);
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
      sourceDisputeConfig: { ...base.state.disputeConfig },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
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
    }, { runtimeSeed: 'swap-hub-consensus-bench', now: 1_000 });
    const admittedRoute: CrossJurisdictionSwapRoute = {
      ...route,
      status: 'resting',
    };
    base.state.pulls = requirePersistentAccountStateMap(base.state.pulls!, 'pulls')
      .updated(admittedRoute.sourcePull!.pullId, {
      pullId: admittedRoute.sourcePull!.pullId,
      tokenId: admittedRoute.sourcePull!.tokenId,
      amount: admittedRoute.sourcePull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      fullHash: admittedRoute.sourcePull!.fullHash,
      partialRoot: admittedRoute.sourcePull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(admittedRoute, 'source'),
      createdHeight: 0,
      createdTimestamp: 1_000,
    });
    const offer: SwapOffer = {
      offerId,
      giveTokenId: admittedRoute.source.tokenId,
      ...getStaticSwapTokenDimensions(admittedRoute.source.tokenId, admittedRoute.target.tokenId),
      giveAmount: admittedRoute.source.amount,
      wantTokenId: admittedRoute.target.tokenId,
      wantAmount: admittedRoute.target.amount,
      maxFee: 0n,
      minNetReceive: admittedRoute.target.amount,
      priceTicks: 2n * ORDERBOOK_PRICE_SCALE,
      timeInForce: 0,
      makerIsLeft,
      createdHeight: 0,
      quantizedGive: admittedRoute.source.amount,
      quantizedWant: admittedRoute.target.amount,
      crossJurisdiction: admittedRoute,
    };
    base.state.swapOffers = requirePersistentAccountStateMap(base.state.swapOffers, 'swapOffers')
      .updated(offerId, offer);
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

const emptyPhaseMetrics = (): Record<keyof HubConsensusPhaseMetrics, number> => ({
  propose: 0,
  proposalHanko: 0,
  receive: 0,
  ackHanko: 0,
  commit: 0,
});

const runConsensusRoundTrip = async (
  benchCase: BenchAccountCase,
): Promise<HubConsensusPhaseMetrics> => {
  const phases = emptyPhaseMetrics();
  let phaseStartedAt = getPerfMs();
  benchCase.proposer.mempool.push(...benchCase.txs);
  const proposerContext = createAccountConsensusContext(benchCase.proposerEnv);
  const receiverContext = createAccountConsensusContext(benchCase.receiverEnv);
  const proposed = await proposeAccountFrame(
    proposerContext,
    benchCase.proposer,
    benchCase.proposerEnv.state.timestamp,
  );
  if (!isProposedAccountFrame(proposed)) {
    throw new Error(`${benchCase.kind}:propose_failed:${proposeAccountFrameMessage(proposed)}`);
  }
  phases.propose = getPerfMs() - phaseStartedAt;
  const proposerEntity = benchCase.proposer.proofHeader.fromEntity;
  const proposerSigner = benchCase.proposerEnv.state.eReplicas.values().next().value?.signerId;
  if (!proposerSigner) throw new Error(`${benchCase.kind}:proposer_signer_missing`);
  phaseStartedAt = getPerfMs();
  const hankoAttachedProposal = await attachAccountDraftHankosAsEntity(
    benchCase.proposerEnv,
    proposerEntity,
    proposerSigner,
    proposed,
  );
  phases.proposalHanko = getPerfMs() - phaseStartedAt;
  phaseStartedAt = getPerfMs();
  const received = await applyAccountInput(
    receiverContext,
    benchCase.receiver,
    hankoAttachedProposal,
  );
  if (!received.ok) throw new Error(`${benchCase.kind}:receive_failed:${accountInputFailureMessage(received)}`);
  if (!received.response || !received.hashesToSign?.length) {
    throw new Error(`${benchCase.kind}:receive_draft_missing`);
  }
  phases.receive = getPerfMs() - phaseStartedAt;
  const receiverSigner = benchCase.receiverEnv.state.eReplicas.values().next().value?.signerId;
  if (!receiverSigner) throw new Error(`${benchCase.kind}:receiver_signer_missing`);
  phaseStartedAt = getPerfMs();
  const hankoAttachedAck = await attachAccountDraftHankosAsEntity(
    benchCase.receiverEnv,
    benchCase.receiver.proofHeader.fromEntity,
    receiverSigner,
    {
      accountInput: received.response,
      hashesToSign: received.hashesToSign,
    },
  );
  phases.ackHanko = getPerfMs() - phaseStartedAt;
  phaseStartedAt = getPerfMs();
  const committed = await applyAccountInput(
    proposerContext,
    benchCase.proposer,
    hankoAttachedAck,
  );
  if (!committed.ok) throw new Error(`${benchCase.kind}:commit_failed:${accountInputFailureMessage(committed)}`);
  if (benchCase.proposer.currentHeight !== 1 || benchCase.receiver.currentHeight !== 1) {
    throw new Error(
      `${benchCase.kind}:height_mismatch:${benchCase.proposer.currentHeight}/${benchCase.receiver.currentHeight}`,
    );
  }
  if (benchCase.proposer.pendingFrame || benchCase.proposer.mempool.length > 0) {
    throw new Error(`${benchCase.kind}:proposer_not_drained`);
  }
  if (benchCase.proposer.state.swapOffers.size !== 0 || benchCase.receiver.state.swapOffers.size !== 0) {
    throw new Error(`${benchCase.kind}:offer_not_closed`);
  }
  phases.commit = getPerfMs() - phaseStartedAt;
  return phases;
};

const makeParticipantEnv = (seed: string, jurisdiction: JurisdictionConfig): RuntimeReplica => {
  // Each benchmark Account represents an Entity, not a separate production
  // Runtime. Avoid prewarming 20 unused BrainVault keys per synthetic peer;
  // the exact peer signer is registered immediately below by the caller.
  const env = createEmptyEnv(null);
  env.runtimeSeed = seed;
  env.state.timestamp = 1_000;
  env.quietRuntimeLogs = true;
  installJurisdiction(env, jurisdiction);
  return env;
};

const makeEnv = (seed: string): { env: RuntimeReplica; jurisdiction: JurisdictionConfig; hubId: string } => {
  const env = createEmptyEnv(seed);
  env.runtimeSeed = seed;
  env.state.timestamp = 1_000;
  env.quietRuntimeLogs = true;
  const jurisdiction = makeJurisdiction();
  installJurisdiction(env, jurisdiction);
  const hubId = registerBenchEntity(env, jurisdiction, `${seed}-hub`, 'hub').entityId;
  return { env, jurisdiction, hubId };
};

const buildCases = (
  env: RuntimeReplica,
  jurisdiction: JurisdictionConfig,
  hubId: string,
  swaps: number,
  batchSize: number,
  users: number,
  includeCross: boolean,
): { same: BenchAccountCase[]; cross: BenchAccountCase[] } => {
  const same: BenchAccountCase[] = [];
  const cross: BenchAccountCase[] = [];
  const activeUsers = Math.max(1, Math.min(users, swaps));
  const baseSwapsPerUser = Math.floor(swaps / activeUsers);
  const remainder = swaps % activeUsers;
  let startIndex = 0;
  for (let userIndex = 0; userIndex < activeUsers; userIndex += 1) {
    const count = baseSwapsPerUser + (userIndex < remainder ? 1 : 0);
    if (count <= 0) continue;
    if (count > batchSize) {
      throw new Error(`USER_BATCH_OVERFLOW:user=${userIndex}:count=${count}:batchSize=${batchSize}`);
    }
    same.push(makeSameCase(env, jurisdiction, hubId, startIndex, count));
    if (includeCross) cross.push(makeCrossCase(env, jurisdiction, hubId, startIndex, count));
    startIndex += count;
  }
  return { same, cross };
};

const runMeasuredCases = async (
  cases: BenchAccountCase[],
  concurrency: number,
): Promise<{ elapsedMs: number; swaps: number; phaseTotals: HubConsensusPhaseMetrics }> => {
  const startedAt = getPerfMs();
  let swaps = 0;
  const phaseTotals = emptyPhaseMetrics();
  const width = Math.max(1, Math.floor(concurrency));
  for (let index = 0; index < cases.length; index += width) {
    const group = cases.slice(index, index + width);
    const measured = await Promise.all(group.map(runConsensusRoundTrip));
    for (const phases of measured) {
      for (const phase of HUB_CONSENSUS_PHASES) phaseTotals[phase] += phases[phase];
    }
    swaps += group.reduce((sum, benchCase) => sum + benchCase.swapCount, 0);
  }
  return { elapsedMs: getPerfMs() - startedAt, swaps, phaseTotals };
};

const addPhaseMetrics = (
  left: HubConsensusPhaseMetrics,
  right: HubConsensusPhaseMetrics,
): HubConsensusPhaseMetrics => Object.fromEntries(
  HUB_CONSENSUS_PHASES.map(phase => [phase, left[phase] + right[phase]]),
) as HubConsensusPhaseMetrics;

const meanPhaseMetrics = (
  totals: HubConsensusPhaseMetrics,
  frames: number,
): HubConsensusPhaseMetrics => Object.fromEntries(
  HUB_CONSENSUS_PHASES.map(phase => [phase, Number((totals[phase] / frames).toFixed(3))]),
) as HubConsensusPhaseMetrics;

const runPass = async (
  swaps: number,
  seed: string,
  concurrency: number,
  batchSize: number,
  users: number,
  includeCross: boolean,
): Promise<{
  sameElapsedMs: number;
  crossElapsedMs: number;
  sameSwaps: number;
  crossSwaps: number;
  elapsedMs: number;
  frames: number;
  sameUsers: number;
  crossUsers: number;
  phaseTotals: HubConsensusPhaseMetrics;
}> => {
  const { env, jurisdiction, hubId } = makeEnv(seed);
  const { same, cross } = buildCases(env, jurisdiction, hubId, swaps, batchSize, users, includeCross);
  const startedAt = getPerfMs();
  const sameResult = await runMeasuredCases(same, concurrency);
  const crossResult = await runMeasuredCases(cross, concurrency);
  return {
    sameElapsedMs: sameResult.elapsedMs,
    crossElapsedMs: crossResult.elapsedMs,
    sameSwaps: sameResult.swaps,
    crossSwaps: crossResult.swaps,
    elapsedMs: getPerfMs() - startedAt,
    frames: same.length + cross.length,
    sameUsers: same.length,
    crossUsers: cross.length,
    phaseTotals: addPhaseMetrics(sameResult.phaseTotals, crossResult.phaseTotals),
  };
};

const scriptPath = (): string => fileURLToPath(import.meta.url);

const runWorkerProcess = (
  cli: Cli,
  workerIndex: number,
  workerCount: number,
): Promise<HubConsensusBenchmarkResult> => new Promise((resolve, reject) => {
  const workerSwaps = partitionConsensusLoad(cli.swaps, workerCount, workerIndex);
  const workerWarmup = partitionConsensusLoad(cli.warmup, workerCount, workerIndex);
  const workerUsers = partitionConsensusLoad(cli.users, workerCount, workerIndex);
  const child = spawn(process.execPath, [
    scriptPath(),
    '--swaps', String(workerSwaps),
    '--warmup', String(workerWarmup),
    '--min-aggregate-account-consensus-tps', '1',
    '--concurrency', String(cli.concurrency),
    '--batch-size', String(cli.batchSize),
    '--users', String(workerUsers),
    '--independent-hub-cohorts', '1',
    '--include-cross', cli.includeCross ? '1' : '0',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      XLN_SWAP_CONSENSUS_WORKER: String(workerIndex),
      XLN_ACCOUNT_PROPOSAL_SLOW_MS: '1000000000',
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
      resolve(extractHubConsensusWorkerResult(stdout));
    } catch (error) {
      const tail = `${stdout}\n${stderr}`.split(/\r?\n/).slice(-20).join('\n');
      reject(new Error(`SWAP_CONSENSUS_WORKER_BAD_RESULT:${workerIndex}:${(error as Error).message}\n${tail}`));
    }
  });
});

const runDistributedWorkers = async (cli: Cli): Promise<HubConsensusBenchmarkResult> => {
  const workerCount = Math.min(cli.independentHubCohorts, cli.swaps, cli.users);
  const workers = await Promise.all(
    Array.from({ length: workerCount }, (_, index) => runWorkerProcess(cli, index, workerCount)),
  );
  const sameSwaps = workers.reduce((sum, worker) => sum + worker.sameSwaps, 0);
  const crossSwaps = workers.reduce((sum, worker) => sum + worker.crossSwaps, 0);
  const committedSwaps = workers.reduce((sum, worker) => sum + worker.committedSwaps, 0);
  const committedFrames = workers.reduce((sum, worker) => sum + worker.committedFrames, 0);
  const sameUsers = workers.reduce((sum, worker) => sum + worker.sameUsers, 0);
  const crossUsers = workers.reduce((sum, worker) => sum + worker.crossUsers, 0);
  const uniqueUserAccounts = workers.reduce((sum, worker) => sum + worker.uniqueUserAccounts, 0);
  const phaseTotals = workers.reduce<HubConsensusPhaseMetrics>(
    (totals, worker) => addPhaseMetrics(
      totals,
      Object.fromEntries(HUB_CONSENSUS_PHASES.map(phase => [
        phase,
        worker.meanPhaseMsPerAccountFrame[phase] * worker.committedFrames,
      ])) as HubConsensusPhaseMetrics,
    ),
    emptyPhaseMetrics(),
  );
  const elapsedMs = Math.max(...workers.map((worker) => worker.elapsedMs), 0.001);
  const sameElapsedMs = Math.max(...workers.map((worker) =>
    worker.aggregateSameAccountConsensusTps > 0
      ? (worker.sameSwaps / worker.aggregateSameAccountConsensusTps) * 1000
      : worker.elapsedMs,
  ), 0.001);
  const crossElapsedMs = Math.max(...workers.map((worker) =>
    worker.aggregateCrossAccountConsensusTps > 0
      ? (worker.crossSwaps / worker.aggregateCrossAccountConsensusTps) * 1000
      : worker.elapsedMs,
  ), 0.001);
  const totalSwaps = sameSwaps + crossSwaps;
  const aggregateAccountConsensusTps = totalSwaps / Math.max(elapsedMs / 1000, 0.001);
  const output: HubConsensusBenchmarkResult = {
    benchmark: 'swap-hub-account-consensus',
    sameSwaps,
    crossSwaps,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    aggregateAccountConsensusTps: Number(aggregateAccountConsensusTps.toFixed(2)),
    minAggregateAccountConsensusTps: cli.minAggregateAccountConsensusTps,
    passed: aggregateAccountConsensusTps >= cli.minAggregateAccountConsensusTps,
    aggregateSameAccountConsensusTps: Number(
      (sameSwaps / Math.max(sameElapsedMs / 1000, 0.001)).toFixed(2),
    ),
    aggregateCrossAccountConsensusTps: Number(
      (crossSwaps / Math.max(crossElapsedMs / 1000, 0.001)).toFixed(2),
    ),
    committedFrames,
    batchSize: cli.batchSize,
    users: cli.users,
    sameUsers,
    crossUsers,
    uniqueUserAccounts,
    committedSwaps,
    concurrency: cli.concurrency,
    independentHubCohorts: workerCount,
    meanPhaseMsPerAccountFrame: meanPhaseMetrics(phaseTotals, committedFrames),
    scope: `aggregate Account-consensus throughput across ${workerCount} independent hub cohorts and ${uniqueUserAccounts} user accounts; each process owns a distinct hub, and no Runtime writer, Entity frame, WAL flush, storage, or network delivery is measured`,
  };
  return output;
};

export const makeHubConsensusEnv = makeEnv;
export const buildHubConsensusCases = buildCases;
export const runHubConsensusMeasuredCases = runMeasuredCases;

export const runSwapHubConsensusBenchmark = async (cli: Cli): Promise<HubConsensusBenchmarkResult> => {
  if (cli.independentHubCohorts > 1) return runDistributedWorkers(cli);
  if (cli.warmup > 0) {
    await runPass(
      cli.warmup,
      benchmarkSeed('swap-hub-consensus-warmup'),
      cli.concurrency,
      cli.batchSize,
      Math.min(cli.warmup, Math.max(cli.users, Math.ceil(cli.warmup / cli.batchSize))),
      cli.includeCross,
    );
  }
  const {
    sameElapsedMs,
    crossElapsedMs,
    sameSwaps,
    crossSwaps,
    elapsedMs,
    frames,
    sameUsers,
    crossUsers,
    phaseTotals,
  } = await runPass(
    cli.swaps,
    benchmarkSeed('swap-hub-consensus-measured'),
    cli.concurrency,
    cli.batchSize,
    cli.users,
    cli.includeCross,
  );
  const totalSwaps = sameSwaps + crossSwaps;
  const elapsedSeconds = Math.max(elapsedMs / 1000, 0.001);
  const aggregateSameAccountConsensusTps = sameSwaps / Math.max(sameElapsedMs / 1000, 0.001);
  const aggregateCrossAccountConsensusTps = crossSwaps / Math.max(crossElapsedMs / 1000, 0.001);
  const aggregateAccountConsensusTps = totalSwaps / elapsedSeconds;
  const output: HubConsensusBenchmarkResult = {
    benchmark: 'swap-hub-account-consensus',
    sameSwaps,
    crossSwaps,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    aggregateAccountConsensusTps: Number(aggregateAccountConsensusTps.toFixed(2)),
    minAggregateAccountConsensusTps: cli.minAggregateAccountConsensusTps,
    passed: aggregateAccountConsensusTps >= cli.minAggregateAccountConsensusTps,
    aggregateSameAccountConsensusTps: Number(aggregateSameAccountConsensusTps.toFixed(2)),
    aggregateCrossAccountConsensusTps: Number(aggregateCrossAccountConsensusTps.toFixed(2)),
    committedFrames: frames,
    batchSize: cli.batchSize,
    users: cli.users,
    sameUsers,
    crossUsers,
    uniqueUserAccounts: sameUsers + crossUsers,
    committedSwaps: totalSwaps,
    concurrency: cli.concurrency,
    independentHubCohorts: 1,
    meanPhaseMsPerAccountFrame: meanPhaseMetrics(phaseTotals, frames),
    scope: `single-hub-cohort Account-consensus throughput across ${sameUsers + crossUsers} user accounts: hub propose/commit + user ACK; includes Hanko sign/verify and dispute proof, but excludes the Runtime writer, Entity frame, WAL flush, storage, and network delivery`,
  };
  return output;
};

if (import.meta.main) {
  const output = await runSwapHubConsensusBenchmark(parseCli(globalThis.process.argv.slice(2)));
  console.log(process.env['XLN_SWAP_CONSENSUS_WORKER'] === undefined
    ? safeStringify(output, 2)
    : encodeHubConsensusWorkerResult(output));
  // Let Bun flush CPU/heap profiles and buffered evidence before exit.
  globalThis.process.exitCode = output.passed ? 0 : 1;
}
