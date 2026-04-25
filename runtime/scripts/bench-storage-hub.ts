import { mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { generateLazyEntityId } from '../entity-factory';
import { converge } from '../scenarios/helpers';
import { serializeTaggedJson } from '../serialization-utils';
import { buildAccountMerkleFromState } from '../storage';
import { inspectStorageDb, loadEntityStateFromStorageDb } from '../runtime';
import {
  applyRuntimeInput,
  closeRuntimeDb,
  createEmptyEnv,
  process as processRuntime,
  saveEnvToDB,
} from '../runtime';
import type { AccountMachine, EntityReplica, EntityState, Env } from '../types';
import { getPerfMs } from '../utils';
import { buildRuntimeCheckpointSnapshot } from '../wal/snapshot';

type Participant = {
  entityId: string;
  name: string;
  signerId: string;
  slot: string;
};

type DocStats = {
  avg: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  total: number;
};

const args = globalThis.process.argv.slice(2);

const getArg = (name: string, fallback?: string): string | undefined => {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
};

const hasFlag = (name: string): boolean => args.includes(name);

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseBigIntArg = (value: string | undefined, fallback: bigint): bigint => {
  try {
    if (!value) return fallback;
    return BigInt(value);
  } catch {
    return fallback;
  }
};

const formatBytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

const percentile = (values: number[], ratio: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index] ?? 0;
};

const summarizeBytes = (values: number[]): DocStats => {
  if (values.length === 0) {
    return { avg: 0, max: 0, p50: 0, p95: 0, p99: 0, total: 0 };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  const avg = Math.round(total / values.length);
  const max = Math.max(...values);
  return {
    avg,
    max,
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    total,
  };
};

const encodedSize = (value: unknown): number => Buffer.byteLength(serializeTaggedJson(value));

const compareAccountDocs = (
  liveAccounts: ReadonlyMap<string, AccountMachine>,
  loadedAccounts: ReadonlyMap<string, AccountMachine>,
): {
  mismatches: number;
  firstMismatchKey: string | null;
  firstMismatchFields: string[];
  firstMismatchLiveJson: string | null;
  firstMismatchLoadedJson: string | null;
} => {
  let mismatches = 0;
  let firstMismatchKey: string | null = null;
  let firstMismatchFields: string[] = [];
  let firstMismatchLiveJson: string | null = null;
  let firstMismatchLoadedJson: string | null = null;
  const keys = new Set<string>([...liveAccounts.keys(), ...loadedAccounts.keys()]);
  for (const key of keys) {
    const live = liveAccounts.get(key);
    const loaded = loadedAccounts.get(key);
    const liveDoc = live ? projectAccountDoc(live) : null;
    const loadedDoc = loaded ? projectAccountDoc(loaded) : null;
    const liveEncoded = liveDoc ? serializeTaggedJson(liveDoc) : null;
    const loadedEncoded = loadedDoc ? serializeTaggedJson(loadedDoc) : null;
    if (liveEncoded !== loadedEncoded) {
      mismatches += 1;
      if (!firstMismatchKey) {
        firstMismatchKey = key;
        const propKeys = new Set<string>([
          ...Object.keys(liveDoc ?? {}),
          ...Object.keys(loadedDoc ?? {}),
        ]);
        firstMismatchFields = Array.from(propKeys)
          .filter((propKey) => serializeTaggedJson((liveDoc as Record<string, unknown> | null)?.[propKey]) !== serializeTaggedJson((loadedDoc as Record<string, unknown> | null)?.[propKey]))
          .sort();
        firstMismatchLiveJson = serializeTaggedJson(
          Object.fromEntries(firstMismatchFields.map((propKey) => [propKey, (liveDoc as Record<string, unknown> | null)?.[propKey]])),
        );
        firstMismatchLoadedJson = serializeTaggedJson(
          Object.fromEntries(firstMismatchFields.map((propKey) => [propKey, (loadedDoc as Record<string, unknown> | null)?.[propKey]])),
        );
      }
    }
  }
  return { mismatches, firstMismatchKey, firstMismatchFields, firstMismatchLiveJson, firstMismatchLoadedJson };
};

const runQuiet = async <T>(enabled: boolean, fn: () => Promise<T>): Promise<T> => {
  if (!enabled) return fn();
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalDebug = console.debug;
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.debug = originalDebug;
  }
};

const findReplica = (env: Env, participant: Participant): EntityReplica => {
  const replica = env.eReplicas.get(`${participant.entityId}:${participant.signerId}`);
  if (!replica) {
    throw new Error(`REPLICA_NOT_FOUND: ${participant.name}`);
  }
  return replica;
};

const projectEntityCoreDoc = (state: EntityState): Record<string, unknown> => ({
  entityId: state.entityId,
  height: state.height,
  timestamp: state.timestamp,
  nonces: state.nonces,
  proposals: state.proposals,
  config: state.config,
  prevFrameHash: state.prevFrameHash,
  reserves: state.reserves,
  deferredAccountProposals: state.deferredAccountProposals,
  lastFinalizedJHeight: state.lastFinalizedJHeight,
  crontabState: state.crontabState,
  jBatchState: state.jBatchState,
  entityEncPubKey: state.entityEncPubKey,
  entityEncPrivKey: state.entityEncPrivKey,
  profile: state.profile,
  htlcRoutes: state.htlcRoutes,
  htlcFeesEarned: state.htlcFeesEarned,
  htlcNotes: state.htlcNotes,
  outDebtsByToken: state.outDebtsByToken,
  inDebtsByToken: state.inDebtsByToken,
  orderbookExt: state.orderbookExt,
  lockBook: state.lockBook,
  swapTradingPairs: state.swapTradingPairs,
  pendingSwapFillRatios: state.pendingSwapFillRatios,
  hubRebalanceConfig: state.hubRebalanceConfig,
});

const projectAccountDoc = (account: AccountMachine): Record<string, unknown> => ({
  leftEntity: account.leftEntity,
  rightEntity: account.rightEntity,
  status: account.status,
  mempool: account.mempool,
  currentFrame: account.currentFrame,
  deltas: account.deltas,
  locks: account.locks,
  swapOffers: account.swapOffers,
  globalCreditLimits: account.globalCreditLimits,
  currentHeight: account.currentHeight,
  pendingFrame: account.pendingFrame,
  pendingSignatures: account.pendingSignatures,
  pendingAccountInput: account.pendingAccountInput,
  rollbackCount: account.rollbackCount,
  lastRollbackFrameHash: account.lastRollbackFrameHash,
  lastFinalizedJHeight: account.lastFinalizedJHeight,
  proofHeader: account.proofHeader,
  proofBody: account.proofBody,
  abiProofBody: account.abiProofBody,
  disputeConfig: account.disputeConfig,
  currentFrameHanko: account.currentFrameHanko,
  counterpartyFrameHanko: account.counterpartyFrameHanko,
  currentDisputeProofHanko: account.currentDisputeProofHanko,
  currentDisputeProofNonce: account.currentDisputeProofNonce,
  currentDisputeProofBodyHash: account.currentDisputeProofBodyHash,
  currentDisputeHash: account.currentDisputeHash,
  counterpartyDisputeProofHanko: account.counterpartyDisputeProofHanko,
  counterpartyDisputeProofNonce: account.counterpartyDisputeProofNonce,
  counterpartyDisputeProofBodyHash: account.counterpartyDisputeProofBodyHash,
  counterpartyDisputeHash: account.counterpartyDisputeHash,
  counterpartySettlementHanko: account.counterpartySettlementHanko,
  disputeProofNoncesByHash: account.disputeProofNoncesByHash,
  disputeProofBodiesByHash: account.disputeProofBodiesByHash,
  onChainSettlementNonce: account.onChainSettlementNonce,
  settlementWorkspace: account.settlementWorkspace,
  activeDispute: account.activeDispute,
  pendingWithdrawals: account.pendingWithdrawals,
  requestedRebalance: account.requestedRebalance,
  requestedRebalanceFeeState: account.requestedRebalanceFeeState,
  counterpartyRebalanceFeePolicy: account.counterpartyRebalanceFeePolicy,
  rebalancePolicy: account.rebalancePolicy,
  activeRebalanceQuote: account.activeRebalanceQuote,
  pendingRebalanceRequest: account.pendingRebalanceRequest,
});

const getDirSize = (path: string): number => {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    let total = 0;
    for (const entry of readdirSync(path)) {
      total += getDirSize(join(path, entry));
    }
    return total;
  } catch {
    return 0;
  }
};

const makeParticipant = (seed: string, slotNumber: number, name: string): Participant => {
  const slot = String(slotNumber);
  const signerId = deriveSignerAddressSync(seed, slot).toLowerCase();
  const signerKey = deriveSignerKeySync(seed, slot);
  registerSignerKey(signerId, signerKey);
  return {
    slot,
    signerId,
    entityId: generateLazyEntityId([signerId], 1n).toLowerCase(),
    name,
  };
};

const importParticipants = async (
  env: Env,
  participants: Participant[],
  importBatch: number,
  jurisdiction: { name: string; depositoryAddress: string; entityProviderAddress: string; chainId: number },
): Promise<void> => {
  for (let offset = 0; offset < participants.length; offset += importBatch) {
    const slice = participants.slice(offset, offset + importBatch);
    const runtimeInput = {
      runtimeTxs: slice.map((participant) => ({
        type: 'importReplica' as const,
        entityId: participant.entityId,
        signerId: participant.signerId,
        data: {
          isProposer: true,
          position: { x: 0, y: 0, z: 0 },
          config: {
            mode: 'proposer-based' as const,
            threshold: 1n,
            validators: [participant.signerId],
            shares: { [participant.signerId]: 1n },
            jurisdiction,
          },
        },
      })),
      entityInputs: [],
    } as unknown as Env['runtimeInput'];
    await applyRuntimeInput(env, runtimeInput);
    if (env.runtimeConfig?.storage?.enabled === true || env.runtimeState?.persistencePaused !== true) {
      await saveEnvToDB(env, runtimeInput);
    }
  }
};

const logStats = (label: string, stats: DocStats): void => {
  console.log(
    `${label}: total=${formatBytes(stats.total)} avg=${formatBytes(stats.avg)} ` +
      `p50=${formatBytes(stats.p50)} p95=${formatBytes(stats.p95)} p99=${formatBytes(stats.p99)} max=${formatBytes(stats.max)}`,
  );
};

async function main() {
  const accounts = parsePositiveInt(getArg('--accounts', '1024'), 1024);
  const importBatch = parsePositiveInt(getArg('--import-batch', '512'), 512);
  const openBatch = parsePositiveInt(getArg('--open-batch', '64'), 64);
  const paymentBatch = parsePositiveInt(getArg('--payment-batch', '64'), 64);
  const payments = parseNonNegativeInt(getArg('--payments', '0'), 0);
  const tokenId = parsePositiveInt(getArg('--token-id', '1'), 1);
  const persist = hasFlag('--persist');
  const storageEnabled = hasFlag('--storage');
  const storagePackPeriod = parsePositiveInt(getArg('--storage-pack', '64'), 64);
  const storageSnapshotPeriod = parsePositiveInt(getArg('--storage-snapshot', '256'), 256);
  const storageEpochMb = parsePositiveInt(getArg('--storage-epoch-mb', '256'), 256);
  const accountMerkleRadix = getArg('--account-merkle-radix', '16') === '256' ? 256 : 16;
  const recoveryBudgetMs = parsePositiveInt(getArg('--recovery-budget-ms', '10000'), 10000);
  const recoveryScanStep = parsePositiveInt(getArg('--recovery-scan-step', '1'), 1);
  const snapshotInterval = parsePositiveInt(
    getArg('--snapshot-interval', persist ? '100000' : String(Number.MAX_SAFE_INTEGER)),
    persist ? 100000 : Number.MAX_SAFE_INTEGER,
  );
  const creditAmount = parseBigIntArg(getArg('--credit', '1000000000000000000'), 10n ** 18n);
  const paymentAmount = parseBigIntArg(getArg('--amount', '1'), 1n);
  const maxConverge = parsePositiveInt(getArg('--max-converge', '200'), 200);
  const verbose = hasFlag('--verbose');
  const seed = getArg('--seed', 'bench-storage-hub alpha beta gamma delta epsilon')!;
  const dbRoot = getArg('--db-root', 'db-tmp/runtime-bench')!;

  const runtimeId = deriveSignerAddressSync(seed, '900000').toLowerCase();
  const dbPath = join(dbRoot, runtimeId);

  if (persist) {
    rmSync(dbPath, { recursive: true, force: true });
    mkdirSync(dbRoot, { recursive: true });
  }

  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.quietRuntimeLogs = true;
  env.scenarioMode = true;
  env.timestamp = 1;
  env.gossip.announce = () => {};
  env.gossip.getProfiles = () => [];
  env.gossip.getHubs = () => [];
  env.runtimeConfig = {
    ...(env.runtimeConfig || {}),
    snapshotIntervalFrames: snapshotInterval,
    ...(storageEnabled
      ? {
          storage: {
            enabled: true,
            packPeriodFrames: storagePackPeriod,
            snapshotPeriodFrames: storageSnapshotPeriod,
            retainSnapshots: 3,
            epochMaxBytes: storageEpochMb * 1024 * 1024,
            accountMerkleRadix,
          },
        }
      : {}),
  };
  if (!env.runtimeState) {
    env.runtimeState = {} as NonNullable<Env['runtimeState']>;
  }
  env.runtimeState.persistencePaused = !persist && !storageEnabled;
  const jurisdiction = {
    name: 'bench',
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
    chainId: 31337,
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    chainId: jurisdiction.chainId,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
    },
  } as any);

  const hub = makeParticipant(seed, 1, 'hub');
  const users: Participant[] = [];
  for (let index = 0; index < accounts; index += 1) {
    users.push(makeParticipant(seed, index + 2, `user-${index + 1}`));
  }

  console.log(`Benchmark config: accounts=${accounts} payments=${payments} persist=${persist ? 1 : 0}`);
  console.log(`Batches: import=${importBatch} open=${openBatch} payment=${paymentBatch} converge=${maxConverge}`);

  const importStartedAt = getPerfMs();
  await runQuiet(!verbose, () => importParticipants(env, [hub, ...users], importBatch, jurisdiction));
  const importMs = getPerfMs() - importStartedAt;
  console.log(`Imported replicas: ${env.eReplicas.size} in ${importMs.toFixed(2)}ms`);

  const openStartedAt = getPerfMs();
  for (let offset = 0; offset < users.length; offset += openBatch) {
    const slice = users.slice(offset, offset + openBatch);
    await runQuiet(!verbose, () =>
      processRuntime(
        env,
        [
          ...slice.map((user) => ({
            entityId: user.entityId,
            signerId: user.signerId,
            entityTxs: [
              {
                type: 'openAccount',
                data: {
                  targetEntityId: hub.entityId,
                  tokenId,
                  creditAmount,
                },
              },
            ],
          })),
          {
            entityId: hub.entityId,
            signerId: hub.signerId,
            entityTxs: slice.map((user) => ({
              type: 'openAccount' as const,
              data: {
                targetEntityId: user.entityId,
                tokenId,
                creditAmount,
              },
            })),
          },
        ] as any,
      ));

    await runQuiet(!verbose, () => converge(env, maxConverge));
    const expected = offset + slice.length;
    const actual = findReplica(env, hub).state.accounts.size;
    if (actual < expected) {
      throw new Error(`OPEN_BATCH_INCOMPLETE: expected=${expected} actual=${actual}`);
    }

    if ((offset / openBatch) % 8 === 0) {
      console.log(`Open progress: ${expected}/${users.length}`);
    }
  }
  await converge(env, maxConverge);
  const openMs = getPerfMs() - openStartedAt;

  const hubReplica = findReplica(env, hub);
  if (hubReplica.state.accounts.size !== users.length) {
    throw new Error(`ACCOUNT_COUNT_MISMATCH: expected=${users.length} actual=${hubReplica.state.accounts.size}`);
  }

  const currentSnapshotBytes = encodedSize(buildRuntimeCheckpointSnapshot(env));
  const hubEntityBytes = encodedSize(hubReplica.state);
  const hubCoreProjectedBytes = encodedSize(projectEntityCoreDoc(hubReplica.state));
  const userEntityProjectedBytes: number[] = [];
  const accountDocProjectedBytes: number[] = [];
  const accountDocCurrentBytes: number[] = [];

  for (const user of users) {
    const userReplica = findReplica(env, user);
    const hubSideAccount = hubReplica.state.accounts.get(user.entityId);
    if (!hubSideAccount) {
      throw new Error(`HUB_ACCOUNT_MISSING: ${user.name}`);
    }
    accountDocCurrentBytes.push(encodedSize(hubSideAccount));
    accountDocProjectedBytes.push(encodedSize(projectAccountDoc(hubSideAccount)));
    userEntityProjectedBytes.push(encodedSize(projectEntityCoreDoc(userReplica.state)));
  }

  const accountCurrentStats = summarizeBytes(accountDocCurrentBytes);
  const accountProjectedStats = summarizeBytes(accountDocProjectedBytes);
  const userCoreStats = summarizeBytes(userEntityProjectedBytes);

  let sampleDiffBytes = 0;
  let paymentMs = 0;
  let processedPayments = 0;

  if (users.length > 0) {
    const sampleUser = users[0]!;
    const sampleUserReplicaBefore = findReplica(env, sampleUser);
    const sampleHubAccountBefore = hubReplica.state.accounts.get(sampleUser.entityId);
    const sampleUserAccountBefore = sampleUserReplicaBefore.state.accounts.get(hub.entityId);
    if (!sampleHubAccountBefore || !sampleUserAccountBefore) {
      throw new Error('SAMPLE_ACCOUNT_MISSING');
    }

    await runQuiet(!verbose, () =>
      processRuntime(env, [
        {
          entityId: sampleUser.entityId,
          signerId: sampleUser.signerId,
          entityTxs: [
            {
              type: 'directPayment',
              data: {
                targetEntityId: hub.entityId,
                tokenId,
                amount: paymentAmount,
                description: 'sample-payment',
              },
            },
          ],
        },
      ] as any));
    await runQuiet(!verbose, () => converge(env, maxConverge));
    processedPayments += 1;

    const sampleUserReplicaAfter = findReplica(env, sampleUser);
    const sampleHubReplicaAfter = findReplica(env, hub);
    const sampleHubAccountAfter = sampleHubReplicaAfter.state.accounts.get(sampleUser.entityId);
    const sampleUserAccountAfter = sampleUserReplicaAfter.state.accounts.get(hub.entityId);
    if (!sampleHubAccountAfter || !sampleUserAccountAfter) {
      throw new Error('SAMPLE_ACCOUNT_AFTER_MISSING');
    }

    sampleDiffBytes =
      encodedSize(projectEntityCoreDoc(sampleHubReplicaAfter.state)) +
      encodedSize(projectEntityCoreDoc(sampleUserReplicaAfter.state)) +
      encodedSize(projectAccountDoc(sampleHubAccountAfter)) +
      encodedSize(projectAccountDoc(sampleUserAccountAfter));
  }

  if (payments > processedPayments) {
    const paymentUsers = users.slice(0, Math.min(users.length, payments - processedPayments));
    const paymentStartedAt = getPerfMs();
    for (let offset = 0; offset < paymentUsers.length; offset += paymentBatch) {
      const slice = paymentUsers.slice(offset, offset + paymentBatch);
      await runQuiet(!verbose, () =>
        processRuntime(
          env,
          slice.map((user, index) => ({
            entityId: user.entityId,
            signerId: user.signerId,
            entityTxs: [
              {
                type: 'directPayment',
                data: {
                  targetEntityId: hub.entityId,
                  tokenId,
                  amount: paymentAmount,
                  description: `burst-${offset + index + 1}`,
                },
              },
            ],
          })) as any,
        ));
      await runQuiet(!verbose, () => converge(env, maxConverge));
      processedPayments += slice.length;
      if ((offset / paymentBatch) % 8 === 0) {
        console.log(`Payment progress: ${processedPayments}/${payments}`);
      }
    }
    paymentMs = getPerfMs() - paymentStartedAt;
  }

  const dbBytes = persist || storageEnabled ? getDirSize(dbPath) : 0;
  let storageLoadedAccountCount: number | null = null;
  let storageHistoricalHeight: number | null = null;
  let storageHistoricalAccountCount: number | null = null;
  let storageLatestLoadMs: number | null = null;
  let storageHistoricalLoadMs: number | null = null;
  let storageWorstLoadMs: number | null = null;
  let storageWorstLoadHeight: number | null = null;
  let storageRecoverySamples = 0;
  let storageFirstPresentHeight: number | null = null;
  let storageLiveMerkleRoot: string | null = null;
  let storageLoadedMerkleRoot: string | null = null;
  let storageHistoricalMerkleRoot: string | null = null;
  let storageMerkleBuildMs: number | null = null;
  let storageLatestAccountMismatches: number | null = null;
  let storageLatestFirstMismatchKey: string | null = null;
  let storageLatestFirstMismatchFields: string[] = [];
  let storageLatestFirstMismatchLiveJson: string | null = null;
  let storageLatestFirstMismatchLoadedJson: string | null = null;
  let storageStats: Awaited<ReturnType<typeof inspectStorageDb>> | null = null;
  if (storageEnabled) {
    const liveHubReplica = findReplica(env, hub);
    const liveMerkleStartedAt = getPerfMs();
    storageLiveMerkleRoot = buildAccountMerkleFromState(liveHubReplica.state.accounts, accountMerkleRadix).root;
    const latestLoadStartedAt = getPerfMs();
    const loaded = await loadEntityStateFromStorageDb(env, hub.entityId);
    storageLatestLoadMs = getPerfMs() - latestLoadStartedAt;
    storageLoadedAccountCount = loaded?.accounts.size ?? null;
    storageLoadedMerkleRoot = loaded ? buildAccountMerkleFromState(loaded.accounts, accountMerkleRadix).root : null;
    if (loaded) {
      const comparison = compareAccountDocs(liveHubReplica.state.accounts, loaded.accounts);
      storageLatestAccountMismatches = comparison.mismatches;
      storageLatestFirstMismatchKey = comparison.firstMismatchKey;
      storageLatestFirstMismatchFields = comparison.firstMismatchFields;
      storageLatestFirstMismatchLiveJson = comparison.firstMismatchLiveJson;
      storageLatestFirstMismatchLoadedJson = comparison.firstMismatchLoadedJson;
    }
    storageHistoricalHeight = Math.max(1, Math.min(env.height - 1, storageSnapshotPeriod));
    const historicalLoadStartedAt = getPerfMs();
    const historical = await loadEntityStateFromStorageDb(env, hub.entityId, storageHistoricalHeight);
    storageHistoricalLoadMs = getPerfMs() - historicalLoadStartedAt;
    storageHistoricalAccountCount = historical?.accounts.size ?? null;
    storageHistoricalMerkleRoot = historical ? buildAccountMerkleFromState(historical.accounts, accountMerkleRadix).root : null;
    storageMerkleBuildMs = getPerfMs() - liveMerkleStartedAt;
    for (let height = 1; height <= env.height; height += recoveryScanStep) {
      const recoveryStartedAt = getPerfMs();
      const recovered = await loadEntityStateFromStorageDb(env, hub.entityId, height);
      const recoveryMs = getPerfMs() - recoveryStartedAt;
      if (!recovered) {
        if (storageFirstPresentHeight === null) continue;
        throw new Error(`RECOVERY_LOAD_FAILED: height=${height}`);
      }
      if (storageFirstPresentHeight === null) storageFirstPresentHeight = height;
      storageRecoverySamples += 1;
      if (storageWorstLoadMs === null || recoveryMs > storageWorstLoadMs) {
        storageWorstLoadMs = recoveryMs;
        storageWorstLoadHeight = height;
      }
    }
    if ((storageWorstLoadMs ?? 0) > recoveryBudgetMs) {
      throw new Error(
        `RECOVERY_BUDGET_EXCEEDED: worst=${storageWorstLoadMs?.toFixed(2)}ms ` +
          `height=${storageWorstLoadHeight} budget=${recoveryBudgetMs}ms`,
      );
    }
    storageStats = await inspectStorageDb(env);
  }
  await closeRuntimeDb(env);

  console.log('');
  console.log(`Open account phase: ${openMs.toFixed(2)}ms total, ${(openMs / Math.max(1, users.length)).toFixed(3)}ms/account`);
  if (processedPayments > 0) {
    const effectivePaymentMs = Math.max(1, paymentMs);
    console.log(
      `Payment burst: count=${processedPayments} elapsed=${effectivePaymentMs.toFixed(2)}ms ` +
        `throughput=${(processedPayments / (effectivePaymentMs / 1000)).toFixed(2)} pay/s`,
    );
  }
  console.log(`Current full runtime snapshot: ${formatBytes(currentSnapshotBytes)}`);
  console.log(`Current hub entity blob: ${formatBytes(hubEntityBytes)}`);
  console.log(`Projected hub core doc: ${formatBytes(hubCoreProjectedBytes)}`);
  logStats('Projected user core docs', userCoreStats);
  logStats('Current account docs', accountCurrentStats);
  logStats('Projected account docs', accountProjectedStats);
  if (sampleDiffBytes > 0) {
    console.log(`Projected dirty-doc payload for one direct payment: ${formatBytes(sampleDiffBytes)}`);
  }
  if (persist) {
    console.log(`Persisted LevelDB bytes: ${formatBytes(dbBytes)}`);
  }
  if (storageEnabled) {
    console.log(`Storage load check: hub accounts=${storageLoadedAccountCount ?? 'null'}`);
    console.log(
      `Storage historical check: height=${storageHistoricalHeight ?? 'null'} ` +
        `hub accounts=${storageHistoricalAccountCount ?? 'null'}`,
    );
    console.log(
      `Storage loads: latest=${storageLatestLoadMs?.toFixed(2) ?? 'null'}ms ` +
        `historical=${storageHistoricalLoadMs?.toFixed(2) ?? 'null'}ms`,
    );
    console.log(
      `Storage recovery budget: worst=${storageWorstLoadMs?.toFixed(2) ?? 'null'}ms ` +
        `height=${storageWorstLoadHeight ?? 'null'} firstPresent=${storageFirstPresentHeight ?? 'null'} ` +
        `samples=${storageRecoverySamples} ` +
        `budget=${recoveryBudgetMs}ms`,
    );
    console.log(
      `Storage account merkle: radix=${accountMerkleRadix} build=${storageMerkleBuildMs?.toFixed(2) ?? 'null'}ms ` +
        `live=${storageLiveMerkleRoot ?? 'null'} latest=${storageLoadedMerkleRoot ?? 'null'} ` +
        `historical=${storageHistoricalMerkleRoot ?? 'null'}`,
    );
    console.log(
      `Storage latest doc parity: mismatches=${storageLatestAccountMismatches ?? 'null'} ` +
        `first=${storageLatestFirstMismatchKey ?? 'null'} ` +
        `fields=${storageLatestFirstMismatchFields.join(',') || 'none'}`,
    );
    if (storageLatestFirstMismatchKey) {
      console.log(
        `Storage first mismatch live=${storageLatestFirstMismatchLiveJson} ` +
          `loaded=${storageLatestFirstMismatchLoadedJson}`,
      );
    }
    if (storageStats) {
      const epochRows = Array.isArray((storageStats as { epochDbs?: unknown }).epochDbs)
        ? ((storageStats as {
            epochDbs?: Array<{
              role: string;
              latestHeight: number;
              frameCount: number;
              diffCount: number;
              packCount: number;
              snapshotCount: number;
              totalBytes: number;
            }>;
          }).epochDbs ?? [])
        : [];
      console.log(
        `Storage head: latest=${storageStats.head?.latestHeight ?? 'null'} ` +
          `packPeriod=${storageStats.head?.packPeriodFrames ?? 'null'} ` +
          `snapshotPeriod=${storageStats.head?.snapshotPeriodFrames ?? 'null'} ` +
          `latestPack=${storageStats.head?.latestPackHeight ?? 'null'} ` +
          `latestSnapshot=${storageStats.head?.latestSnapshotHeight ?? 'null'} ` +
          `epochMaxMb=${Math.round((storageStats.head?.epochMaxBytes ?? 0) / (1024 * 1024))}`,
      );
      console.log(
        `Storage totals: epochs=${epochRows.length} rFrames=${storageStats.frameCount} ` +
          `diffs=${storageStats.diffCount} packs=${storageStats.packCount} snapshots=${storageStats.snapshotHeights.length}`,
      );
      console.log(
        `Storage counts: frames=${storageStats.frameCount} diffs=${storageStats.diffCount} ` +
          `packs=${storageStats.packCount} snapshots=${storageStats.snapshotHeights.join(',') || 'none'} ` +
          `liveEntities=${storageStats.liveEntityCount} liveAccounts=${storageStats.liveAccountCount} liveBooks=${storageStats.liveBookCount}`,
      );
      console.log(
        `Storage bytes: live=${formatBytes(storageStats.liveBytes)} history=${formatBytes(storageStats.historyBytes)} ` +
          `frames=${formatBytes(storageStats.frameBytes)} diffs=${formatBytes(storageStats.diffBytes)} ` +
          `packs=${formatBytes(storageStats.packBytes)} snapshots=${formatBytes(storageStats.snapshotBytes)} ` +
          `total=${formatBytes(storageStats.totalBytes)}`,
      );
      console.log(
        `Storage max values: frame=${formatBytes(storageStats.maxFrameBytes)} ` +
          `diff=${formatBytes(storageStats.maxDiffBytes)} pack=${formatBytes(storageStats.maxPackBytes)} ` +
          `snapshot=${formatBytes(storageStats.maxSnapshotBytes)}`,
      );
      if (epochRows.length > 0) {
        console.log('Storage epochs:');
        console.log('+----------+--------+------+------+------+----------+');
        console.log('| role     | latest |  r   |  d   |  s   | total    |');
        console.log('+----------+--------+------+------+------+----------+');
        for (const row of epochRows) {
          console.log(
            `| ${row.role.padEnd(8)} | ${String(row.latestHeight).padStart(6)} | ` +
              `${String(row.frameCount).padStart(4)} | ${String(row.diffCount).padStart(4)} | ` +
              `${String(row.snapshotCount).padStart(4)} | ${formatBytes(row.totalBytes).padStart(8)} |`,
          );
        }
        console.log('+----------+--------+------+------+------+----------+');
      }
    }
  }

  console.log('');
  console.log(
    JSON.stringify(
      {
        runtimeId,
        accounts,
        paymentsRequested: payments,
        paymentsProcessed: processedPayments,
        persist,
        storageEnabled,
        storagePackPeriod,
        storageSnapshotPeriod,
        snapshotInterval,
        importBatch,
        openBatch,
        paymentBatch,
        envHeight: env.height,
        currentSnapshotBytes,
        hubEntityBytes,
        hubCoreProjectedBytes,
        accountCurrentStats,
        accountProjectedStats,
        userCoreStats,
        sampleDiffBytes,
        dbBytes,
        storageLoadedAccountCount,
        storageHistoricalHeight,
        storageHistoricalAccountCount,
        storageLatestLoadMs,
        storageHistoricalLoadMs,
        storageWorstLoadMs,
        storageWorstLoadHeight,
        storageRecoverySamples,
        storageFirstPresentHeight,
        storageLiveMerkleRoot,
        storageLoadedMerkleRoot,
        storageHistoricalMerkleRoot,
        storageMerkleBuildMs,
        storageLatestAccountMismatches,
        storageLatestFirstMismatchKey,
        storageLatestFirstMismatchFields,
        storageLatestFirstMismatchLiveJson,
        storageLatestFirstMismatchLoadedJson,
        storageStats,
        openMs,
        paymentMs,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('bench-storage-hub failed:', error);
    process.exit(1);
  });
