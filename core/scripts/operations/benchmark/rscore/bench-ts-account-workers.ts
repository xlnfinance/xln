import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { computeAccountStateRoot } from '../../../../account/commitment/state-root';
import { TsAccountWorkerCoordinator } from '../../../../rscore/ts-worker';
import type { AccountReplica, AccountTx } from '../../../../types/account';
import type { JReplica } from '../../../../types/jurisdiction-runtime';
import { makeAccount } from '../../../../__tests__/helpers/cross-j';
import { safeStringify } from '../../../../protocol/serialization';
import { encodeCanonicalConsensusBytes } from '../../../../protocol/serialization/binary-codec';
import { computeIntegrityDigest } from '../../../../support/bytes/integrity-checksum';

const RESULT_PREFIX = 'TS_ACCOUNT_WORKER_BENCH_RESULT=';
const OWNER = `0x${'ff'.repeat(32)}`;
const BENCH_JURISDICTION: JReplica = {
  name: 'ts-worker-bench',
  blockNumber: 0n,
  stateRoot: null,
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  position: { x: 0, y: 0, z: 0 },
  chainId: 31_337,
  contracts: {
    depository: `0x${'dd'.repeat(20)}`,
    entityProvider: `0x${'ee'.repeat(20)}`,
    account: `0x${'98'.repeat(20)}`,
    deltaTransformer: `0x${'99'.repeat(20)}`,
  },
};
const DEFAULT_ACCOUNTS = 1_024;
const CHILD_TIMEOUT_MS = 6_000;

type BenchResult = Readonly<{
  workers: number;
  accounts: number;
  elapsedMs: number;
  workerCriticalMs: number;
  coordinatorOverheadMs: number;
  paymentProposalsPerSecond: number;
  shadowRoot: string;
  effectsDigest: string;
  rssBytes: number;
  maxRssBytes: number;
  workerHeapBytes: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuCores: number;
  cpuBusyRatio: number;
  initRequestBytes: number;
  normalRequestBytes: number;
  normalResponseBytes: number;
  checkpointResponseBytes: number;
  coordinatorTimings: Readonly<{ encodeMs: number; decodeMs: number; foldMs: number; dispatchMs: number }>;
  perWorker: readonly Readonly<{
    workerIndex: number;
    operations: number;
    workMs: number;
    waitMs: number;
    roundTripMs: number;
    requestBytes: number;
    responseBytes: number;
  }>[];
}>;

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const positiveInteger = (value: string | undefined, defaultValue: number, label: string): number => {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}:${String(value)}`);
  return parsed;
};

/** One deterministic Account in each selected three-nibble shard. */
const accountIdAt = (index: number): string => {
  const shard = index % 4_096;
  const prefix = shard.toString(16).padStart(3, '0');
  const suffix = index.toString(16).padStart(61, '0');
  return `0x${prefix}${suffix}`;
};

const benchmarkAccount = (accountId: string): AccountReplica => {
  const account = makeAccount(OWNER, accountId);
  account.proofHeader = { fromEntity: OWNER, toEntity: accountId, nextProofNonce: 1 };
  account.currentFrame.accountStateRoot = computeAccountStateRoot(account.state);
  return account;
};

const payment = (accountId: string): AccountTx => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount: 1n,
    route: [accountId],
    fromEntityId: OWNER,
    toEntityId: accountId,
    deliveryMode: 'direct',
  },
});

const assertCanonicalResults = (
  effects: Awaited<ReturnType<TsAccountWorkerCoordinator['proposeAccountFrames']>>['effects'],
  accounts: number,
): void => {
  if (effects.length !== accounts * 2) {
    throw new Error(`TS_ACCOUNT_WORKER_BENCH_EFFECTS:${effects.length}:${accounts * 2}`);
  }
  for (let index = 0; index < accounts; index += 1) {
    const enqueue = effects[index];
    if (
      enqueue?.phase !== 'outbound-enqueue'
      || !enqueue.result.ok
      || enqueue.result.admittedAccountTxCount !== 1
    ) {
      throw new Error(`TS_ACCOUNT_WORKER_BENCH_ENQUEUE:${index}:${safeStringify(enqueue)}`);
    }
    const proposal = effects[accounts + index];
    if (
      proposal?.phase !== 'outbound-proposal'
      || !proposal.result.ok
      || proposal.result.outcome !== 'proposed'
    ) {
      throw new Error(`TS_ACCOUNT_WORKER_BENCH_PROPOSAL:${index}:${safeStringify(proposal)}`);
    }
  }
};

const assertSparseDispatch = async (
  coordinator: TsAccountWorkerCoordinator,
  accountId: string,
): Promise<void> => {
  const inbound = await coordinator.applyAccountInputs({
    frameId: 'bench-frame-3',
    entityTimestamp: 3_000,
    finalizedJHeight: 0,
    inputs: [],
  });
  if (inbound.workers.length !== 0) throw new Error('TS_ACCOUNT_WORKER_BENCH_SPARSE_INBOUND');
  const outbound = await coordinator.proposeAccountFrames({
    frameId: 'bench-frame-3',
    timestamp: 3_000,
    jHeight: 0,
    txs: [{ accountId, txs: [payment(accountId)] }],
    proposalAccountIds: [],
    checkpointDue: false,
  });
  if (outbound.workers.length !== 1 || outbound.effects.length !== 1) {
    throw new Error(`TS_ACCOUNT_WORKER_BENCH_SPARSE_OUTBOUND:${safeStringify(outbound.workers)}`);
  }
  await coordinator.applyAccountInputs({
    frameId: 'bench-frame-4',
    entityTimestamp: 4_000,
    finalizedJHeight: 0,
    inputs: [],
  });
  const checkpoint = await coordinator.proposeAccountFrames({
    frameId: 'bench-frame-4',
    timestamp: 4_000,
    jHeight: 0,
    txs: [],
    proposalAccountIds: [],
    checkpointDue: true,
  });
  if (checkpoint.workers.length !== 1 || checkpoint.checkpointChanges?.accounts.length !== 1) {
    throw new Error(`TS_ACCOUNT_WORKER_BENCH_SPARSE_CHECKPOINT:${safeStringify(checkpoint.workers)}`);
  }
};

const runChild = async (): Promise<void> => {
  const workers = positiveInteger(argument('--workers'), 1, 'TS_ACCOUNT_WORKER_BENCH_WORKERS');
  const accountCount = positiveInteger(
    argument('--accounts') ?? process.env['XLN_TS_WORKER_BENCH_ACCOUNTS'],
    DEFAULT_ACCOUNTS,
    'TS_ACCOUNT_WORKER_BENCH_ACCOUNTS',
  );
  if (accountCount > 4_096) throw new Error(`TS_ACCOUNT_WORKER_BENCH_ACCOUNT_LIMIT:${accountCount}`);
  const accountIds = Array.from({ length: accountCount }, (_, index) => accountIdAt(index));
  const accounts = new Map(accountIds.map(accountId => [accountId, benchmarkAccount(accountId)]));
  const coordinator = await TsAccountWorkerCoordinator.create({
    ownerEntityId: OWNER,
    workerCount: workers,
    logicalShardToWorker: Array.from({ length: 4_096 }, (_, shardId) => shardId % workers),
    accounts,
    jReplicas: new Map([[BENCH_JURISDICTION.name, BENCH_JURISDICTION]]),
  });
  const emptyInbound = await coordinator.applyAccountInputs({
      frameId: 'bench-frame-1',
      entityTimestamp: 1_000,
      finalizedJHeight: 0,
      inputs: [],
    });
    if (emptyInbound.workers.length !== 0 || emptyInbound.ipc.requestBytes !== 0) {
      throw new Error(`TS_ACCOUNT_WORKER_BENCH_EMPTY_INBOUND_DISPATCH:${safeStringify(emptyInbound.workers)}`);
    }
    const cpuStart = process.cpuUsage();
    const startedAt = performance.now();
    const outbound = await coordinator.proposeAccountFrames({
      frameId: 'bench-frame-1',
      timestamp: 1_000,
      jHeight: 0,
      txs: accountIds.map(accountId => ({ accountId, txs: [payment(accountId)] })),
      proposalAccountIds: accountIds,
      checkpointDue: false,
    });
    const elapsedMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuStart);
    assertCanonicalResults(outbound.effects, accountCount);
    const effectsDigest = computeIntegrityDigest(encodeCanonicalConsensusBytes(outbound.effects));

    await coordinator.applyAccountInputs({
      frameId: 'bench-frame-2',
      entityTimestamp: 2_000,
      finalizedJHeight: 0,
      inputs: [],
    });
    const checkpoint = await coordinator.proposeAccountFrames({
      frameId: 'bench-frame-2',
      timestamp: 2_000,
      jHeight: 0,
      txs: [],
      proposalAccountIds: [],
      checkpointDue: true,
    });
    if (checkpoint.shadowAccountsRoot !== outbound.shadowAccountsRoot) {
      throw new Error(
        `TS_ACCOUNT_WORKER_BENCH_CHECKPOINT_ROOT:`
        + `${checkpoint.shadowAccountsRoot}:${outbound.shadowAccountsRoot}`,
      );
    }
    if (checkpoint.checkpointChanges?.accounts.length !== accountCount) {
      throw new Error(
        `TS_ACCOUNT_WORKER_BENCH_CHECKPOINT_ACCOUNTS:`
        + `${checkpoint.checkpointChanges?.accounts.length ?? -1}:${accountCount}`,
      );
    }
    if (checkpoint.workers.length !== workers) {
      throw new Error(`TS_ACCOUNT_WORKER_BENCH_CHECKPOINT_WORKERS:${checkpoint.workers.length}:${workers}`);
    }
    const firstAccountId = accountIds[0];
    if (firstAccountId === undefined) throw new Error('TS_ACCOUNT_WORKER_BENCH_ACCOUNT_MISSING');
    await assertSparseDispatch(coordinator, firstAccountId);
    const usage = process.memoryUsage();
    const maxRss = process.resourceUsage().maxRSS;
    const workerCriticalMs = Math.max(...outbound.workers.map(worker => worker.elapsedUs)) / 1_000;
    const result: BenchResult = {
      workers,
      accounts: accountCount,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      workerCriticalMs: Math.round(workerCriticalMs * 100) / 100,
      coordinatorOverheadMs: Math.round((elapsedMs - workerCriticalMs) * 100) / 100,
      paymentProposalsPerSecond: Math.round(accountCount * 100_000 / elapsedMs) / 100,
      shadowRoot: outbound.shadowAccountsRoot,
      effectsDigest,
      rssBytes: usage.rss,
      maxRssBytes: process.platform === 'darwin' ? maxRss : maxRss * 1_024,
      workerHeapBytes: Math.max(...outbound.workers.map(worker => worker.heapUsedBytes)),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      cpuCores: availableParallelism(),
      cpuBusyRatio: Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 100) / 100,
      initRequestBytes: coordinator.initialization.requestBytes,
      normalRequestBytes: outbound.ipc.requestBytes,
      normalResponseBytes: outbound.ipc.responseBytes,
      checkpointResponseBytes: checkpoint.ipc.responseBytes,
      coordinatorTimings: {
        encodeMs: Math.round(outbound.timings.encodeMs * 100) / 100,
        decodeMs: Math.round(outbound.timings.decodeMs * 100) / 100,
        foldMs: Math.round(outbound.timings.foldMs * 100) / 100,
        dispatchMs: Math.round(outbound.timings.dispatchMs * 100) / 100,
      },
      perWorker: outbound.workers.map(worker => ({
        workerIndex: worker.workerIndex,
        operations: worker.operations,
        workMs: Math.round(worker.workMs * 100) / 100,
        waitMs: Math.round(worker.waitMs * 100) / 100,
        roundTripMs: Math.round(worker.roundTripMs * 100) / 100,
        requestBytes: worker.requestBytes,
        responseBytes: worker.responseBytes,
      })),
    };
  console.log(`${RESULT_PREFIX}${safeStringify(result)}`);
};

const parseChildResult = (stdout: string): BenchResult => {
  const line = stdout.split(/\r?\n/).find(candidate => candidate.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`TS_ACCOUNT_WORKER_BENCH_RESULT_MISSING:${stdout.slice(-1_000)}`);
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as BenchResult;
};

const runIsolated = async (workers: number, accounts: number): Promise<BenchResult> => {
  const script = fileURLToPath(import.meta.url);
  const child = Bun.spawn([
    process.execPath,
    script,
    '--child',
    '--workers',
    String(workers),
    '--accounts',
    String(accounts),
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      XLN_CRYPTO_POOL_WORKERS: '0',
      XLN_CRYPTO_SIGN_WORKERS: '0',
    },
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout'; exitCode: -1 }>(resolve => {
    timeoutId = setTimeout(() => resolve({ kind: 'timeout', exitCode: -1 }), CHILD_TIMEOUT_MS);
  });
  const outcome = await Promise.race([
    child.exited.then(exitCode => ({ kind: 'exit' as const, exitCode })),
    timeout,
  ]);
  clearTimeout(timeoutId);
  if (outcome.kind === 'timeout') child.kill();
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (outcome.kind === 'timeout') {
    throw new Error(`TS_ACCOUNT_WORKER_BENCH_TIMEOUT:${workers}:${CHILD_TIMEOUT_MS}`);
  }
  if (outcome.exitCode !== 0) {
    throw new Error(`TS_ACCOUNT_WORKER_BENCH_CHILD:${workers}:${outcome.exitCode}:${stderr.slice(-2_000)}`);
  }
  return parseChildResult(stdout);
};

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

const runCoordinator = async (): Promise<void> => {
  const accounts = positiveInteger(
    process.env['XLN_TS_WORKER_BENCH_ACCOUNTS'],
    DEFAULT_ACCOUNTS,
    'TS_ACCOUNT_WORKER_BENCH_ACCOUNTS',
  );
  const startedAt = performance.now();
  const workersList = (process.env['XLN_TS_WORKER_BENCH_WORKERS'] ?? '1,2,4')
    .split(',')
    .map(value => positiveInteger(value, 1, 'TS_ACCOUNT_WORKER_BENCH_WORKERS'));
  const results: BenchResult[] = [];
  for (const workers of workersList) results.push(await runIsolated(workers, accounts));
  const baseline = results[0];
  if (baseline === undefined) throw new Error('TS_ACCOUNT_WORKER_BENCH_BASELINE_MISSING');
  if (results.some(result => (
    result.shadowRoot !== baseline.shadowRoot || result.effectsDigest !== baseline.effectsDigest
  ))) {
    throw new Error(`TS_ACCOUNT_WORKER_BENCH_PARITY_DIVERGENCE:${safeStringify(results)}`);
  }
  console.log('workers  payment proposals/s  speedup  worker  coord  RSS MiB  normal IPC MB  checkpoint MB  cpu_busy  encode  decode   fold  dispatch');
  for (const result of results) {
    const speedup = result.paymentProposalsPerSecond / baseline.paymentProposalsPerSecond;
    const normalIpc = result.normalRequestBytes + result.normalResponseBytes;
    console.log(
      `${String(result.workers).padStart(7)}  `
      + `${result.paymentProposalsPerSecond.toFixed(2).padStart(19)}  `
      + `${speedup.toFixed(2).padStart(7)}x  `
      + `${result.workerCriticalMs.toFixed(2).padStart(6)}ms  `
      + `${result.coordinatorOverheadMs.toFixed(2).padStart(5)}ms  `
      + `${mib(result.rssBytes).padStart(7)}  `
      + `${mib(normalIpc).padStart(13)}  `
      + `${mib(result.checkpointResponseBytes).padStart(13)}  `
      + `${String(result.cpuBusyRatio).padStart(8)}  `
      + `${result.coordinatorTimings.encodeMs.toFixed(2).padStart(6)}ms  `
      + `${result.coordinatorTimings.decodeMs.toFixed(2).padStart(6)}ms  `
      + `${result.coordinatorTimings.foldMs.toFixed(2).padStart(6)}ms  `
      + `${result.coordinatorTimings.dispatchMs.toFixed(2).padStart(7)}ms`,
    );
    for (const worker of result.perWorker) {
      console.log(
        `  w${String(worker.workerIndex).padStart(2)}  ops=${String(worker.operations).padStart(4)}  `
        + `work=${worker.workMs.toFixed(2).padStart(7)}ms  wait=${worker.waitMs.toFixed(2).padStart(7)}ms  `
        + `rt=${worker.roundTripMs.toFixed(2).padStart(7)}ms  `
        + `tx=${mib(worker.requestBytes + worker.responseBytes).padStart(6)}MB`,
      );
    }
  }
  const totalMs = performance.now() - startedAt;
  if (totalMs > 20_000) throw new Error(`TS_ACCOUNT_WORKER_BENCH_TOTAL_TIMEOUT:${Math.round(totalMs)}`);
  console.log(
    `shadowRoot=${baseline.shadowRoot} effects=${baseline.effectsDigest} `
    + `accounts=${accounts} totalMs=${totalMs.toFixed(2)} cpuCores=${String(baseline.cpuCores)}`,
  );
  console.log(`${RESULT_PREFIX}${safeStringify(results)}`);
};

if (process.argv.includes('--child')) {
  await runChild();
} else {
  await runCoordinator();
}
