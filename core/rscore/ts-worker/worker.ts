/** Bun Worker entry for the resident TypeScript Account-shard prototype. */

import { applyAccountInput, proposeAccountFrame } from '../../account/consensus';
import type { AccountConsensusContext } from '../../account/consensus/context';
import type { HandleAccountInputResult } from '../../account/consensus/types';
import { forkAccountReplicaShell } from '../../account/state/account-replica-shell';
import type { AccountReplica } from '../../types/account';
import { getPerfMs } from '../../support/time';
import { diffOpCounters, snapshotOpCounters } from '../../support/performance/op-counters';
import { TsAccountWorkerTransferDecoder, TsAccountWorkerTransferEncoder } from './codec';
import { tsAccountLogicalShard } from './sharding';
import { decodeWorkerInitPayload, decodeWorkerPhasePayload } from './worker-boundary';
import {
  collectWorkerPostAccounts,
  computeWorkerShardCommitment,
  createWorkerConsensusContext,
  initializeWorkerState,
  hydrateWorkerGenesisAccount,
  prepareWorkerAttempt,
  workerHeapUsedBytes,
  type TsAccountWorkerState,
} from './worker-state';
import type {
  TsAccountWorkerEffect,
  TsAccountWorkerInboundPayload,
  TsAccountWorkerOutboundPayload,
  TsAccountWorkerPhaseResult,
  TsAccountWorkerRequestEnvelope,
  TsAccountWorkerResponseEnvelope,
  TsAccountWorkerSubroot,
} from './protocol';

type WorkerScope = {
  postMessage(value: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<TsAccountWorkerRequestEnvelope>) => void) | null;
};

type PhaseWorkspace = Readonly<{
  working: Map<string, AccountReplica>;
  touched: Set<string>;
  forWrite(accountId: string): AccountReplica;
}>;

const scope: WorkerScope = self;
let state: TsAccountWorkerState | null = null;
let busy = false;
const requestDecoder = new TsAccountWorkerTransferDecoder();
const responseEncoder = new TsAccountWorkerTransferEncoder();

type ThreadCpuUsage = Readonly<{ user: number; system: number }>;
type BunThreadCpuProcess = typeof process & {
  threadCpuUsage(previous?: ThreadCpuUsage): ThreadCpuUsage;
};

const readThreadCpuUsage = (previous?: ThreadCpuUsage): ThreadCpuUsage => {
  const candidate = process as Partial<BunThreadCpuProcess>;
  if (typeof candidate.threadCpuUsage !== 'function') {
    throw new Error('TS_ACCOUNT_WORKER_THREAD_CPU_USAGE_UNAVAILABLE');
  }
  return candidate.threadCpuUsage(previous);
};

const createWorkspace = (
  worker: TsAccountWorkerState,
  initialAccounts: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): PhaseWorkspace => {
  const working = new Map<string, AccountReplica>();
  const touched = new Set<string>();
  return {
    working,
    touched,
    forWrite(accountId): AccountReplica {
      const existing = working.get(accountId);
      if (existing) return existing;
      const initial = initialAccounts.get(accountId);
      const committed = worker.accounts.get(accountId)
        ?? (initial !== undefined
          ? hydrateWorkerGenesisAccount(worker, accountId, initial)
          : undefined);
      if (!committed) throw new Error(`TS_ACCOUNT_WORKER_ACCOUNT_MISSING:${accountId}`);
      const fork = forkAccountReplicaShell(committed);
      working.set(accountId, fork);
      touched.add(accountId);
      return fork;
    },
  };
};

/**
 * J-claim nodes are content-addressed and may be reachable from Accounts owned by
 * different workers. A worker-local delete cannot prove global unreachability;
 * publishing that delta could erase a node still used by a sibling Account.
 */
const assertNoWorkerJClaimChanges = (result: HandleAccountInputResult): void => {
  if (result.ok && result.accountJClaimNodeChanges) {
    throw new Error('TS_ACCOUNT_WORKER_JCLAIM_NODE_CHANGES_UNSAFE');
  }
};

const applyInbound = async (
  worker: TsAccountWorkerState,
  input: TsAccountWorkerInboundPayload,
  workspace: PhaseWorkspace,
): Promise<TsAccountWorkerEffect[]> => {
  const context = createWorkerConsensusContext(
    worker,
    input.entityTimestamp,
    input.finalizedJHeight,
    worker.jClaimNodes,
  );
  const ordered = [...input.inputs].sort((left, right) => left.order - right.order);
  const effects: TsAccountWorkerEffect[] = [];
  for (const item of ordered) {
    const result = await applyAccountInput(context, workspace.forWrite(item.accountId), item.input, {
      entityTimestamp: input.entityTimestamp,
      finalizedJHeight: input.finalizedJHeight,
      owningEntityIsHub: false,
      verifyHanko: context.verifyHanko,
    });
    assertNoWorkerJClaimChanges(result);
    effects.push({ phase: 'inbound', order: item.order, accountId: item.accountId, result });
  }
  return effects;
};

const applyOutboundTxs = async (
  context: AccountConsensusContext,
  input: TsAccountWorkerOutboundPayload,
  workspace: PhaseWorkspace,
): Promise<TsAccountWorkerEffect[]> => {
  const effects: TsAccountWorkerEffect[] = [];
  const ordered = [...input.txs].sort((left, right) => left.order - right.order);
  for (const item of ordered) {
    const result: HandleAccountInputResult = await applyAccountInput(
      context,
      workspace.forWrite(item.accountId),
      { kind: 'enqueue', txs: [...item.txs] },
    );
    assertNoWorkerJClaimChanges(result);
    effects.push({ phase: 'outbound-enqueue', order: item.order, accountId: item.accountId, result });
  }
  return effects;
};

const applyOutboundProposals = async (
  context: AccountConsensusContext,
  input: TsAccountWorkerOutboundPayload,
  workspace: PhaseWorkspace,
): Promise<TsAccountWorkerEffect[]> => {
  const effects: TsAccountWorkerEffect[] = [];
  const ordered = [...input.proposals].sort((left, right) => left.order - right.order);
  for (const item of ordered) {
    const result = await proposeAccountFrame(
      context,
      workspace.forWrite(item.accountId),
      input.timestamp,
      input.jHeight,
    );
    effects.push({ phase: 'outbound-proposal', order: item.order, accountId: item.accountId, result });
  }
  return effects;
};

const publishWorkspace = (
  worker: TsAccountWorkerState,
  workspace: PhaseWorkspace,
): TsAccountWorkerSubroot[] => {
  const touchedShards = new Set<number>();
  const mutations: Array<Readonly<{ kind: 'put'; key: string; value: AccountReplica }>> = [];
  for (const accountId of [...workspace.touched].sort()) {
    const account = workspace.working.get(accountId);
    if (account === undefined) {
      throw new Error(`TS_ACCOUNT_WORKER_TOUCHED_ACCOUNT_MISSING:${accountId}`);
    }
    const shardId = tsAccountLogicalShard(accountId);
    mutations.push({ kind: 'put', key: accountId, value: account });
    touchedShards.add(shardId);
    worker.frameTouchedAccountIds.add(accountId);
  }
  worker.accounts = worker.accounts.foldDirty(mutations);
  return [...touchedShards]
    .sort((left, right) => left - right)
    .map(shardId => computeWorkerShardCommitment(worker, shardId));
};

const processPhase = async (value: unknown): Promise<TsAccountWorkerPhaseResult> => {
  const worker = state;
  if (!worker) throw new Error('TS_ACCOUNT_WORKER_NOT_INITIALIZED');
  const input = decodeWorkerPhasePayload(worker, value);
  const startedAt = getPerfMs();
  const operationsBefore = snapshotOpCounters();
  const cpuStartedAt = readThreadCpuUsage();
  const initialAccounts = input.phase === 'inbound'
    ? new Map(input.inputs.flatMap(row => row.initialAccount === undefined
      ? []
      : [[row.accountId, row.initialAccount] as const]))
    : new Map<string, Record<string, unknown>>();
  const workspace = createWorkspace(worker, initialAccounts);
  let transitionUs = 0;
  let proposalUs = 0;
  let effects: TsAccountWorkerEffect[];
  if (input.phase === 'inbound') {
    prepareWorkerAttempt(worker, input.restorePrevious);
    worker.inboundPrepared = true;
    const transitionStartedAt = getPerfMs();
    effects = await applyInbound(worker, input, workspace);
    transitionUs = Math.round((getPerfMs() - transitionStartedAt) * 1_000);
  } else {
    if (!worker.inboundPrepared) prepareWorkerAttempt(worker, input.restorePrevious);
    worker.inboundPrepared = false;
    const transitionStartedAt = getPerfMs();
    const admissions = await applyOutboundTxs(
      createWorkerConsensusContext(worker, input.timestamp, input.jHeight, worker.jClaimNodes),
      input,
      workspace,
    );
    transitionUs = Math.round((getPerfMs() - transitionStartedAt) * 1_000);
    const proposalStartedAt = getPerfMs();
    const proposals = await applyOutboundProposals(
      createWorkerConsensusContext(worker, input.timestamp, input.jHeight, worker.jClaimNodes),
      input,
      workspace,
    );
    proposalUs = Math.round((getPerfMs() - proposalStartedAt) * 1_000);
    effects = [...admissions, ...proposals];
  }
  // Publish only after this worker completed every canonical transition. If a
  // sibling fails, the coordinator becomes permanently fatal and kills all isolates.
  const rootStartedAt = getPerfMs();
  const subroots = publishWorkspace(worker, workspace);
  const rootUs = Math.round((getPerfMs() - rootStartedAt) * 1_000);
  const materializeStartedAt = getPerfMs();
  const postAccounts = input.phase === 'outbound'
    ? collectWorkerPostAccounts(worker)
    : undefined;
  const materializeUs = Math.round((getPerfMs() - materializeStartedAt) * 1_000);
  const cpu = readThreadCpuUsage(cpuStartedAt);
  const shardRows = new Map<number, number>();
  const operationAccountIds = input.phase === 'inbound'
    ? input.inputs.map(row => row.accountId)
    : [...input.txs.map(row => row.accountId), ...input.proposals.map(row => row.accountId)];
  for (const accountId of operationAccountIds) {
    const shardId = tsAccountLogicalShard(accountId);
    shardRows.set(shardId, (shardRows.get(shardId) ?? 0) + 1);
  }
  return {
    workerIndex: worker.workerIndex,
    effects: effects.sort((left, right) => left.order - right.order),
    subroots,
    ...(postAccounts ? { postAccounts } : {}),
    operations: effects.length,
    shardRows: [...shardRows].sort(([left], [right]) => left - right),
    operationsProfile: diffOpCounters(operationsBefore),
    elapsedUs: Math.round((getPerfMs() - startedAt) * 1_000),
    heapUsedBytes: workerHeapUsedBytes(),
    timings: { transitionUs, proposalUs, rootUs, materializeUs },
    threadCpuUserUs: cpu.user,
    threadCpuSystemUs: cpu.system,
  };
};

const postResult = (requestId: number, result: unknown): void => {
  const startedAt = getPerfMs();
  const payload = responseEncoder.encode(result);
  const encodeUs = Math.round((getPerfMs() - startedAt) * 1_000);
  const response: TsAccountWorkerResponseEnvelope = { requestId, kind: 'result', payload, encodeUs };
  scope.postMessage(response, [payload]);
};

const postFatal = (requestId: number, error: unknown): void => {
  const failure = error instanceof Error ? error : new Error(String(error));
  const response: TsAccountWorkerResponseEnvelope = {
    requestId,
    kind: 'fatal',
    error: failure.message,
    ...(failure.stack ? { stack: failure.stack } : {}),
  };
  scope.postMessage(response);
};

scope.onmessage = event => {
  const request = event.data;
  if (busy) {
    postFatal(request.requestId, new Error('TS_ACCOUNT_WORKER_CONCURRENT_REQUEST'));
    return;
  }
  busy = true;
  void (async () => {
    try {
      const decoded = requestDecoder.decode(request.payload);
      if (request.kind === 'init') {
        if (state !== null) throw new Error('TS_ACCOUNT_WORKER_ALREADY_INITIALIZED');
        const initialized = initializeWorkerState(decodeWorkerInitPayload(decoded));
        state = initialized.state;
        postResult(request.requestId, initialized.result);
      } else if (request.kind === 'phase') {
        postResult(request.requestId, await processPhase(decoded));
      } else {
        throw new Error(`TS_ACCOUNT_WORKER_REQUEST_UNKNOWN:${String(request.kind)}`);
      }
    } catch (error) {
      postFatal(request.requestId, error);
    } finally {
      busy = false;
    }
  })();
};
