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
const DEFAULT_ACCOUNTS = 10_000;
const DEFAULT_RUNTIME_FRAMES = 1_000;
const DEFAULT_TXS_PER_ACCOUNT = 12;
const MIN_ACCOUNT_ROWS_PER_ACTIVE_FRAME = 128;
const CHILD_TIMEOUT_MS = 10_000;

const BENCH_JURISDICTION: JReplica = {
  name: 'ts-worker-bench', blockNumber: 0n, stateRoot: null, mempool: [], blockDelayMs: 0,
  lastBlockTimestamp: 0, position: { x: 0, y: 0, z: 0 }, chainId: 31_337,
  contracts: {
    depository: `0x${'dd'.repeat(20)}`, entityProvider: `0x${'ee'.repeat(20)}`,
    account: `0x${'98'.repeat(20)}`, deltaTransformer: `0x${'99'.repeat(20)}`,
  },
};

type WorkerAggregate = {
  workerIndex: number; items: number; workMs: number; transitionMs: number; proposalMs: number;
  rootMs: number; packMs: number; threadCpuMs: number; requestBytes: number; responseBytes: number;
};

type BenchResult = Readonly<{
  workers: number; accounts: number; runtimeFrames: number; activeRuntimeFrames: number;
  accountTxs: number; accountInputs: number;
  accountInputKinds: Readonly<{ frame: number; ack: number; ackPropose: number }>;
  initMs: number; wallMs: number; accountsRoot: string; outputsDigest: string; cpuCores: number;
  accountInputsPerSecond: number; endToEndAccountInputsPerSecond: number;
  accountInputKindsPerSecond: Readonly<{ frame: number; ack: number; ackPropose: number }>;
  waves: Readonly<{ inboundMs: number; entityMs: number; proposalMs: number }>;
  coordinator: Readonly<{
    dispatchMs: number; joinMs: number; foldMs: number; encodeMs: number; decodeMs: number;
    outputDigestMs: number; requestBytes: number; responseBytes: number;
  }>;
  workerCriticalMs: number; workerComputeMs: number; rssBytes: number;
  shards: Readonly<{ touched: number; minRows: number; avgRows: number; maxRows: number }>;
  perWorker: readonly Readonly<WorkerAggregate & { utilization: number }>[];
}>;

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const positiveInteger = (value: string | undefined, defaultValue: number, code: string): number => {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${code}:${String(value)}`);
  return parsed;
};

const accountIdAt = (index: number): string => {
  const shard = index % 4_096;
  return `0x${shard.toString(16).padStart(3, '0')}${index.toString(16).padStart(61, '0')}`;
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
    tokenId: 1, amount: 1n, route: [accountId], fromEntityId: OWNER,
    toEntityId: accountId, deliveryMode: 'direct',
  },
});

const assertFrame = (
  effects: Awaited<ReturnType<TsAccountWorkerCoordinator['proposeAccountFrames']>>['effects'],
  rows: number,
  txsPerAccount: number,
): void => {
  if (effects.length !== rows * 2) throw new Error(`TS_ACCOUNT_WORKER_BENCH_EFFECTS:${effects.length}:${rows * 2}`);
  for (let index = 0; index < rows; index += 1) {
    const enqueue = effects[index];
    const proposal = effects[rows + index];
    if (enqueue?.phase !== 'outbound-enqueue' || !enqueue.result.ok
      || enqueue.result.admittedAccountTxCount !== txsPerAccount) {
      throw new Error(`TS_ACCOUNT_WORKER_BENCH_ENQUEUE:${index}:${safeStringify(enqueue)}`);
    }
    if (proposal?.phase !== 'outbound-proposal' || !proposal.result.ok
      || proposal.result.outcome !== 'proposed') {
      throw new Error(`TS_ACCOUNT_WORKER_BENCH_PROPOSAL:${index}:${safeStringify(proposal)}`);
    }
  }
};

const addWorkerMetrics = (
  totals: Map<number, WorkerAggregate>,
  metrics: Awaited<ReturnType<TsAccountWorkerCoordinator['proposeAccountFrames']>>['workers'],
): void => {
  for (const metric of metrics) {
    const total = totals.get(metric.workerIndex) ?? {
      workerIndex: metric.workerIndex, items: 0, workMs: 0, transitionMs: 0, proposalMs: 0,
      rootMs: 0, packMs: 0, threadCpuMs: 0, requestBytes: 0, responseBytes: 0,
    };
    total.items += metric.operations;
    total.workMs += metric.workMs;
    total.transitionMs += metric.transitionMs;
    total.proposalMs += metric.proposalMs;
    total.rootMs += metric.rootMs;
    total.packMs += metric.workerEncodeMs;
    total.threadCpuMs += metric.threadCpuUserMs + metric.threadCpuSystemMs;
    total.requestBytes += metric.requestBytes;
    total.responseBytes += metric.responseBytes;
    totals.set(metric.workerIndex, total);
  }
};

const rounded = (value: number): number => Math.round(value * 100) / 100;

const perSecond = (items: number, elapsedMs: number): number =>
  rounded(elapsedMs === 0 ? 0 : items * 1_000 / elapsedMs);

const runChild = async (): Promise<void> => {
  const workers = positiveInteger(argument('--workers'), 1, 'TS_ACCOUNT_WORKER_BENCH_WORKERS');
  const accounts = positiveInteger(argument('--accounts'), DEFAULT_ACCOUNTS, 'TS_ACCOUNT_WORKER_BENCH_ACCOUNTS');
  const runtimeFrames = positiveInteger(argument('--frames'), DEFAULT_RUNTIME_FRAMES, 'TS_ACCOUNT_WORKER_BENCH_FRAMES');
  const txsPerAccount = positiveInteger(argument('--txs'), DEFAULT_TXS_PER_ACCOUNT, 'TS_ACCOUNT_WORKER_BENCH_TXS');
  if (accounts < 10_000 || runtimeFrames < 1_000 || runtimeFrames > accounts) {
    throw new Error(`TS_ACCOUNT_WORKER_BENCH_CARDINALITY:${accounts}:${runtimeFrames}`);
  }
  const accountIds = Array.from({ length: accounts }, (_, index) => accountIdAt(index));
  const initStartedAt = performance.now();
  const coordinator = await TsAccountWorkerCoordinator.create({
    ownerEntityId: OWNER, workerCount: workers,
    logicalShardToWorker: Array.from({ length: 4_096 }, (_, shardId) => shardId % workers),
    accounts: new Map(accountIds.map(accountId => [accountId, benchmarkAccount(accountId)])),
    jReplicas: new Map([[BENCH_JURISDICTION.name, BENCH_JURISDICTION]]),
  });
  const initMs = performance.now() - initStartedAt;
  const workerTotals = new Map<number, WorkerAggregate>();
  const frameDigests: string[] = [];
  let inboundMs = 0; let entityMs = 0; let proposalMs = 0; let outputDigestMs = 0;
  let dispatchMs = 0; let joinMs = 0; let foldMs = 0; let encodeMs = 0; let decodeMs = 0;
  let requestBytes = 0; let responseBytes = 0; let workerCriticalMs = 0;
  const accountInputKinds = { frame: 0, ack: 0, ackPropose: 0 };
  const activeRuntimeFrames = Math.min(
    runtimeFrames,
    Math.ceil(accounts / MIN_ACCOUNT_ROWS_PER_ACTIVE_FRAME),
  );
  const wallStartedAt = performance.now();
  for (let frame = 0; frame < runtimeFrames; frame += 1) {
    const start = frame < activeRuntimeFrames
      ? Math.floor(frame * accounts / activeRuntimeFrames)
      : accounts;
    const end = frame < activeRuntimeFrames
      ? Math.floor((frame + 1) * accounts / activeRuntimeFrames)
      : accounts;
    const ids = accountIds.slice(start, end);
    const inboundStartedAt = performance.now();
    await coordinator.applyAccountInputs({
      frameId: `bench-frame-${frame}`, entityTimestamp: frame + 1, finalizedJHeight: 0, inputs: [],
    });
    inboundMs += performance.now() - inboundStartedAt;
    const entityStartedAt = performance.now();
    const txs = ids.map(accountId => ({
      accountId, txs: Array.from({ length: txsPerAccount }, () => payment(accountId)),
    }));
    entityMs += performance.now() - entityStartedAt;
    const proposalStartedAt = performance.now();
    const result = await coordinator.proposeAccountFrames({
      frameId: `bench-frame-${frame}`, timestamp: frame + 1, jHeight: 0,
      txs, proposalAccountIds: ids, checkpointDue: false,
    });
    proposalMs += performance.now() - proposalStartedAt;
    assertFrame(result.effects, ids.length, txsPerAccount);
    for (const effect of result.effects) {
      if (effect.phase !== 'outbound-proposal' || !effect.result.ok
        || effect.result.outcome !== 'proposed') continue;
      switch (effect.result.accountInput.kind) {
        case 'frame': accountInputKinds.frame += 1; break;
        case 'ack': accountInputKinds.ack += 1; break;
        case 'ack_frame': accountInputKinds.ackPropose += 1; break;
        default: throw new Error(`TS_ACCOUNT_WORKER_BENCH_INPUT_KIND:${effect.result.accountInput.kind}`);
      }
    }
    addWorkerMetrics(workerTotals, result.workers);
    workerCriticalMs += Math.max(0, ...result.workers.map(metric => metric.workMs));
    dispatchMs += result.timings.dispatchMs; joinMs += result.timings.joinMs;
    foldMs += result.timings.foldMs; encodeMs += result.timings.encodeMs; decodeMs += result.timings.decodeMs;
    requestBytes += result.ipc.requestBytes; responseBytes += result.ipc.responseBytes;
    const digestStartedAt = performance.now();
    frameDigests.push(computeIntegrityDigest(encodeCanonicalConsensusBytes(result.effects)));
    outputDigestMs += performance.now() - digestStartedAt;
  }
  const wallMs = performance.now() - wallStartedAt;
  const accountsRoot = coordinator.accountsRoot;
  coordinator.close();
  const outputsDigest = computeIntegrityDigest(encodeCanonicalConsensusBytes(frameDigests));
  const workerComputeMs = [...workerTotals.values()].reduce((sum, worker) => sum + worker.workMs, 0);
  const accountInputs = accountInputKinds.frame + accountInputKinds.ack + accountInputKinds.ackPropose;
  const rows = Array.from({ length: 4_096 }, (_, shard) => Math.floor((accounts + 4_095 - shard) / 4_096))
    .filter(count => count > 0);
  const perWorker = [...workerTotals.values()].sort((left, right) => left.workerIndex - right.workerIndex)
    .map(worker => ({ ...worker, utilization: proposalMs === 0 ? 0 : worker.threadCpuMs / proposalMs }));
  const result: BenchResult = {
    workers, accounts, runtimeFrames, activeRuntimeFrames,
    accountTxs: accounts * txsPerAccount, accountInputs, accountInputKinds,
    initMs: rounded(initMs), wallMs: rounded(wallMs), accountsRoot, outputsDigest,
    cpuCores: availableParallelism(),
    accountInputsPerSecond: perSecond(accountInputs, proposalMs),
    endToEndAccountInputsPerSecond: perSecond(accountInputs, wallMs),
    accountInputKindsPerSecond: {
      frame: perSecond(accountInputKinds.frame, proposalMs),
      ack: perSecond(accountInputKinds.ack, proposalMs),
      ackPropose: perSecond(accountInputKinds.ackPropose, proposalMs),
    },
    waves: { inboundMs: rounded(inboundMs), entityMs: rounded(entityMs), proposalMs: rounded(proposalMs) },
    coordinator: {
      dispatchMs: rounded(dispatchMs), joinMs: rounded(joinMs), foldMs: rounded(foldMs),
      encodeMs: rounded(encodeMs), decodeMs: rounded(decodeMs), outputDigestMs: rounded(outputDigestMs),
      requestBytes, responseBytes,
    },
    workerCriticalMs: rounded(workerCriticalMs), workerComputeMs: rounded(workerComputeMs),
    rssBytes: process.memoryUsage().rss,
    shards: {
      touched: rows.length, minRows: Math.min(...rows), avgRows: rounded(accounts / rows.length), maxRows: Math.max(...rows),
    },
    perWorker: perWorker.map(worker => ({ ...worker, utilization: rounded(worker.utilization) })),
  };
  console.log(`${RESULT_PREFIX}${safeStringify(result)}`);
};

const parseChildResult = (stdout: string): BenchResult => {
  const line = stdout.split(/\r?\n/).find(candidate => candidate.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`TS_ACCOUNT_WORKER_BENCH_RESULT_MISSING:${stdout.slice(-1_000)}`);
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as BenchResult;
};

const runIsolated = async (workers: number, accounts: number, frames: number, txs: number): Promise<BenchResult> => {
  const child = Bun.spawn([
    process.execPath, fileURLToPath(import.meta.url), '--child', '--workers', String(workers),
    '--accounts', String(accounts), '--frames', String(frames), '--txs', String(txs),
  ], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, XLN_CRYPTO_POOL_WORKERS: '0', XLN_CRYPTO_SIGN_WORKERS: '0' } });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timeoutId = setTimeout(() => resolve('timeout'), CHILD_TIMEOUT_MS); });
  const outcome = await Promise.race([child.exited, timeout]);
  clearTimeout(timeoutId);
  if (outcome === 'timeout') child.kill();
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (outcome === 'timeout') throw new Error(`TS_ACCOUNT_WORKER_BENCH_TIMEOUT:${workers}:${CHILD_TIMEOUT_MS}`);
  if (outcome !== 0) throw new Error(`TS_ACCOUNT_WORKER_BENCH_CHILD:${workers}:${outcome}:${stderr.slice(-2_000)}`);
  return parseChildResult(stdout);
};

const mib = (bytes: number): string => (bytes / 1_048_576).toFixed(1);

const runCoordinator = async (): Promise<void> => {
  const accounts = positiveInteger(process.env['XLN_TS_WORKER_BENCH_ACCOUNTS'], DEFAULT_ACCOUNTS, 'TS_ACCOUNT_WORKER_BENCH_ACCOUNTS');
  const frames = positiveInteger(process.env['XLN_TS_WORKER_BENCH_FRAMES'], DEFAULT_RUNTIME_FRAMES, 'TS_ACCOUNT_WORKER_BENCH_FRAMES');
  const txs = positiveInteger(process.env['XLN_TS_WORKER_BENCH_TXS'], DEFAULT_TXS_PER_ACCOUNT, 'TS_ACCOUNT_WORKER_BENCH_TXS');
  const workersList = (process.env['XLN_TS_WORKER_BENCH_WORKERS'] ?? '1,2,4,8').split(',')
    .map(value => positiveInteger(value, 1, 'TS_ACCOUNT_WORKER_BENCH_WORKERS'));
  const startedAt = performance.now();
  const results: BenchResult[] = [];
  for (const workers of workersList) results.push(await runIsolated(workers, accounts, frames, txs));
  const baseline = results[0];
  if (!baseline) throw new Error('TS_ACCOUNT_WORKER_BENCH_BASELINE_MISSING');
  if (results.some(result => result.accountsRoot !== baseline.accountsRoot || result.outputsDigest !== baseline.outputsDigest)) {
    throw new Error(`TS_ACCOUNT_WORKER_BENCH_PARITY_DIVERGENCE:${safeStringify(results)}`);
  }
  console.log('workers  AccountInputs/s  worker speedup  e2e speedup  wall  inbound  entity  proposal  dispatch  join  fold  IPC MiB');
  for (const result of results) {
    console.log(
      `${String(result.workers).padStart(7)}  ${result.accountInputsPerSecond.toFixed(2).padStart(15)}  `
      + `${(baseline.workerCriticalMs / result.workerCriticalMs).toFixed(2).padStart(13)}x  `
      + `${(baseline.wallMs / result.wallMs).toFixed(2).padStart(10)}x  ${result.wallMs.toFixed(2).padStart(7)}ms  `
      + `${result.waves.inboundMs.toFixed(2).padStart(7)}  ${result.waves.entityMs.toFixed(2).padStart(7)}  `
      + `${result.waves.proposalMs.toFixed(2).padStart(8)}  ${result.coordinator.dispatchMs.toFixed(2).padStart(8)}  `
      + `${result.coordinator.joinMs.toFixed(2).padStart(8)}  ${result.coordinator.foldMs.toFixed(2).padStart(6)}  `
      + `${mib(result.coordinator.requestBytes + result.coordinator.responseBytes).padStart(8)}`,
    );
    console.log(
      `  AccountInputs frame=${result.accountInputKinds.frame} (${result.accountInputKindsPerSecond.frame.toFixed(2)}/s)`
      + ` ack=${result.accountInputKinds.ack} (${result.accountInputKindsPerSecond.ack.toFixed(2)}/s)`
      + ` ackPropose=${result.accountInputKinds.ackPropose} (${result.accountInputKindsPerSecond.ackPropose.toFixed(2)}/s, protocol=ack_frame)`,
    );
    for (const worker of result.perWorker) {
      console.log(`  w${worker.workerIndex} items=${worker.items} cpu=${worker.threadCpuMs.toFixed(2)}ms util=${worker.utilization.toFixed(2)} transition=${worker.transitionMs.toFixed(2)}ms proposal=${worker.proposalMs.toFixed(2)}ms root=${worker.rootMs.toFixed(2)}ms pack=${worker.packMs.toFixed(2)}ms`);
    }
  }
  const totalMs = performance.now() - startedAt;
  if (totalMs > 30_000) throw new Error(`TS_ACCOUNT_WORKER_BENCH_TOTAL_TIMEOUT:${Math.round(totalMs)}`);
  console.log(`accounts=${accounts} runtimeFrames=${frames} activeRuntimeFrames=${baseline.activeRuntimeFrames} txsPerAccount=${txs} touchedShards=${baseline.shards.touched} rowsPerShard=${baseline.shards.minRows}/${baseline.shards.avgRows}/${baseline.shards.maxRows} totalMs=${totalMs.toFixed(2)} cpuCores=${baseline.cpuCores}`);
  console.log(`${RESULT_PREFIX}${safeStringify(results)}`);
};

if (process.argv.includes('--child')) await runChild();
else await runCoordinator();
