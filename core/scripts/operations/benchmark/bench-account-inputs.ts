/**
 * Account inputs per second in the TypeScript account machine, measured on the
 * same scenario the Rust engine's `bench_consensus` runs: one payment per
 * account per round, proposer signs a frame, receiver verifies it and signs an
 * ack, proposer verifies the ack. Two signed account inputs cross per payment.
 *
 * The point is a like-for-like number against the Rust engine, so the phases
 * are the same and nothing is stubbed: real Hankos, real verification, real
 * commit.
 *
 * Usage: bun core/scripts/operations/benchmark/bench-account-inputs.ts \
 *          [accounts=200] [rounds=5]
 */
import { applyAccountInput, proposeAccountFrame } from '../../../account/consensus/index';
import {
  accountInputFailureMessage,
  isProposedAccountFrame,
  proposeAccountFrameMessage,
} from '../../../account/consensus/result';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { createDefaultDelta } from '../../../account/state/delta';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { generateLazyEntityId } from '../../../entity/factory';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import {
  PersistentAccountStateMap,
  requirePersistentAccountStateMap,
} from '../../../account/state/persistent-state-map';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import { attachAccountDraftHankosAsEntity } from '../../../qa/account/draft';
import { createEmptyEnv } from '../../../runtime';
import { getPerfMs } from '../../../support/time';
import type { AccountReplica, AccountTx } from '../../../types/account';
import type { ConsensusConfig, EntityReplica, EntityState, JurisdictionConfig } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';

const accounts = Number(process.argv[2] ?? '200');
const rounds = Number(process.argv[3] ?? '5');

const addr = (byte: string): string => `0x${byte.repeat(20)}`;

const jurisdiction: JurisdictionConfig = {
  name: 'BenchJ',
  address: 'rpc://bench',
  chainId: 999_001,
  blockTimeMs: 1_000,
  depositoryAddress: addr('de'),
  entityProviderAddress: addr('ef'),
};

const config = (signerId: string): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction,
});

const entityState = (entityId: string, signerId: string): EntityState => ({
  entityId,
  entityEncryptionPublicKey: `0x${'11'.repeat(32)}`,
  height: 1,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: config(signerId),
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
  lastFinalizedJHeight: 0,
  profile: { name: 'bench', isHub: false, avatar: '', bio: '', website: '' },
  paybook: { entries: new Map(), feesEarned: 0n },
  crossJurisdictionSwaps: new Map(),
  swapTradingPairs: [],
} as EntityState);

const installJurisdiction = (env: RuntimeReplica): void => {
  env.activeJurisdiction = jurisdiction.name;
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
      deltaTransformer: addr('dd'),
    },
    blockTimeMs: jurisdiction.blockTimeMs,
  } as never);
};

const makeEnv = (seed: string): RuntimeReplica => {
  const env = createEmptyEnv(seed);
  env.runtimeSeed = seed;
  env.state.timestamp = 1_000;
  env.quietRuntimeLogs = true;
  installJurisdiction(env);
  return env;
};

const registerEntity = (env: RuntimeReplica, seed: string, slot: string): { entityId: string; signerId: string } => {
  const signerId = deriveSignerAddressSync(seed, slot);
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, slot));
  env.state.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    mempool: [],
    isProposer: true,
    state: entityState(entityId, signerId),
  } as EntityReplica);
  return { entityId, signerId };
};

const makeAccount = (selfId: string, counterpartyId: string): AccountReplica => {
  const [leftEntity, rightEntity] = selfId.toLowerCase() < counterpartyId.toLowerCase()
    ? [selfId, counterpartyId]
    : [counterpartyId, selfId];
  return {
    state: {
      leftEntity,
      rightEntity,
      domain: { chainId: jurisdiction.chainId, depositoryAddress: jurisdiction.depositoryAddress },
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
      deltas: [],
      byLeft: true,
    },
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: selfId, toEntity: counterpartyId, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: { rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    } },
  } as AccountReplica;
};

const installCredit = (account: AccountReplica, tokenId: number): void => {
  const delta = createDefaultDelta(tokenId);
  delta.leftCreditLimit = 10n ** 24n;
  delta.rightCreditLimit = 10n ** 24n;
  account.state.deltas = requirePersistentAccountStateMap(account.state.deltas, 'deltas')
    .updated(tokenId, delta);
};

type Pair = {
  payerEnv: RuntimeReplica;
  payeeEnv: RuntimeReplica;
  payer: AccountReplica;
  payee: AccountReplica;
  payerEntity: string;
  payerSigner: string;
  payeeEntity: string;
  payeeSigner: string;
};

const buildPairs = (): Pair[] => {
  const pairs: Pair[] = [];
  for (let index = 0; index < accounts; index += 1) {
    const payerEnv = makeEnv(`bench-payer-${index}`);
    const payeeEnv = makeEnv(`bench-payee-${index}`);
    const payer = registerEntity(payerEnv, `bench-payer-${index}`, 'user');
    const payee = registerEntity(payeeEnv, `bench-payee-${index}`, 'hub');
    const base = makeAccount(payer.entityId, payee.entityId);
    installCredit(base, 1);
    const mirror = forkAccountReplicaShell(base);
    mirror.proofHeader = { fromEntity: payee.entityId, toEntity: payer.entityId, nextProofNonce: 0 };
    pairs.push({
      payerEnv,
      payeeEnv,
      payer: base,
      payee: mirror,
      payerEntity: payer.entityId,
      payerSigner: payer.signerId,
      payeeEntity: payee.entityId,
      payeeSigner: payee.signerId,
    });
  }
  return pairs;
};

const payment = (pair: Pair): AccountTx => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount: 5n,
    route: [pair.payeeEntity],
    fromEntityId: pair.payerEntity,
    toEntityId: pair.payeeEntity,
    deliveryMode: 'direct',
  },
});

/** One payment through the full bilateral round trip: two signed inputs. */
const roundTrip = async (pair: Pair, timestamp: number): Promise<void> => {
  pair.payerEnv.state.timestamp = timestamp;
  pair.payeeEnv.state.timestamp = timestamp;
  pair.payer.mempool.push(payment(pair));
  const payerContext = createAccountConsensusContext(pair.payerEnv);
  const payeeContext = createAccountConsensusContext(pair.payeeEnv);
  const proposed = await proposeAccountFrame(payerContext, pair.payer, timestamp);
  if (!isProposedAccountFrame(proposed)) {
    throw new Error(`propose_failed:${proposeAccountFrameMessage(proposed)}`);
  }
  const signedProposal = await attachAccountDraftHankosAsEntity(
    pair.payerEnv,
    pair.payerEntity,
    pair.payerSigner,
    proposed,
  );
  const received = await applyAccountInput(payeeContext, pair.payee, signedProposal);
  if (!received.ok) throw new Error(`receive_failed:${accountInputFailureMessage(received)}`);
  if (!received.response || !received.hashesToSign?.length) throw new Error('receive_draft_missing');
  const signedAck = await attachAccountDraftHankosAsEntity(
    pair.payeeEnv,
    pair.payeeEntity,
    pair.payeeSigner,
    { accountInput: received.response, hashesToSign: received.hashesToSign },
  );
  const committed = await applyAccountInput(payerContext, pair.payer, signedAck);
  if (!committed.ok) throw new Error(`commit_failed:${accountInputFailureMessage(committed)}`);
};

const main = async (): Promise<void> => {
  const pairs = buildPairs();
  // One untimed round so lazily built caches and JIT tiers are warm, the same
  // courtesy the Rust engine gets from its first round.
  await Promise.all(pairs.map((pair) => roundTrip(pair, 1_000)));

  const startedAt = getPerfMs();
  for (let round = 0; round < rounds; round += 1) {
    const timestamp = 2_000 + round;
    // The account machine is single-threaded; awaiting the whole cohort at
    // once is how the runtime drives it, and it never leaves one core.
    await Promise.all(pairs.map((pair) => roundTrip(pair, timestamp)));
  }
  const elapsedMs = getPerfMs() - startedAt;
  const payments = accounts * rounds;
  const inputs = payments * 2;
  const rss = process.memoryUsage().rss;
  console.log(
    `accounts=${accounts} rounds=${rounds} payments=${payments} accountInputs=${inputs} ` +
      `totalMs=${elapsedMs.toFixed(0)} accountInputsPerSec=${(inputs / (elapsedMs / 1000)).toFixed(0)} ` +
      `paymentsPerSec=${(payments / (elapsedMs / 1000)).toFixed(0)} rssMb=${(rss / 1024 / 1024).toFixed(0)}`,
  );
};

await main();
