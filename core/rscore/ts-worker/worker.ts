/** Bun Worker entry for the resident TypeScript Account-shard prototype. */

import { applyAccountInput, proposeAccountFrame } from '../../account/consensus';
import { applyAccountEnvelopeUpdate } from '../../account/envelope/entity-update';
import type { AccountConsensusContext } from '../../account/consensus/context';
import type { HandleAccountInputResult } from '../../account/consensus/types';
import { forkAccountReplicaShell } from '../../account/state/account-replica-shell';
import type { AccountReplica } from '../../types/account';
import { getPerfMs } from '../../support/time';
import { diffOpCounters, snapshotOpCounters } from '../../support/performance/op-counters';
import { safeStringify } from '../../protocol/serialization';
import {
  createWorkerJClaimAttempt,
  pruneWorkerJClaimNodes,
  type WorkerJClaimAttempt,
} from './worker-j-claim-attempt';
import { TsAccountWorkerTransferDecoder, TsAccountWorkerTransferEncoder } from './codec';
import { tsAccountLogicalShard } from './sharding';
import { decodeWorkerInitPayload, decodeWorkerPhasePayload } from './worker-boundary';
import {
  collectWorkerPostAccounts,
  projectWorkerPostAccounts,
  computeWorkerShardCommitment,
  createWorkerConsensusContext,
  initializeWorkerState,
  installWorkerCommittedHankos,
  hydrateWorkerGenesisAccount,
  prepareWorkerAttempt,
  workerHeapUsedBytes,
  type TsAccountWorkerState,
} from './worker-state';
import { processBookSlots } from './worker-books';
import type {
  TsAccountWorkerEffect,
  TsAccountWorkerInboundPayload,
  TsAccountWorkerOutboundPayload,
  TsAccountWorkerPhaseResult,
  TsAccountWorkerPhasePayload,
  TsAccountWorkerRequestEnvelope,
  TsAccountWorkerResponseEnvelope,
  TsAccountWorkerSubroot,
} from './protocol';
import { accountHasProposableMempoolForEntity } from '../../entity/consensus/account/mempool-eligibility';

type WorkerScope = {
  postMessage(value: unknown, transfer?: Transferable[]): void;
  close(): void;
  onmessage: ((event: MessageEvent<TsAccountWorkerRequestEnvelope>) => void) | null;
};

type PhaseWorkspace = Readonly<{
  working: Map<string, AccountReplica>;
  touched: Set<string>;
  forRead(accountId: string): AccountReplica;
  forWrite(accountId: string): AccountReplica;
}>;

const scope: WorkerScope = self;
let state: TsAccountWorkerState | null = null;
let busy = false;
const requestDecoder = new TsAccountWorkerTransferDecoder();
const responseEncoder = new TsAccountWorkerTransferEncoder();

type ThreadCpuUsage = Readonly<{ user: number; system: number }>;
type ThreadCpuProcess = Readonly<{
  threadCpuUsage(previous?: ThreadCpuUsage): ThreadCpuUsage;
}>;

const readThreadCpuUsage = (previous?: ThreadCpuUsage): ThreadCpuUsage => {
  const candidate = Reflect.get(globalThis, 'process') as Partial<ThreadCpuProcess> | undefined;
  if (!candidate || typeof candidate.threadCpuUsage !== 'function') {
    return { user: 0, system: 0 };
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
    forRead(accountId): AccountReplica {
      return working.get(accountId)
        ?? worker.accounts.get(accountId)
        ?? (() => { throw new Error(`TS_ACCOUNT_WORKER_ACCOUNT_MISSING:${accountId}`); })();
    },
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

const assertIncreasingOrders = (rows: readonly Readonly<{ order: number }>[], label: string): void => {
  let previous = -1;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.order) || row.order <= previous) {
      throw new Error(`${label}:${previous}:${row.order}`);
    }
    previous = row.order;
  }
};

const phaseCertifiedBoards = (
  input: TsAccountWorkerPhasePayload,
): ReadonlyMap<string, NonNullable<typeof input.localBoardAuthority>> => {
  const boards = new Map<string, NonNullable<typeof input.localBoardAuthority>>();
  const add = (board: typeof input.localBoardAuthority): void => {
    if (!board) return;
    const previous = boards.get(board.entityId);
    if (previous && safeStringify(previous) !== safeStringify(board)) {
      throw new Error(`TS_ACCOUNT_WORKER_CERTIFIED_BOARD_CONFLICT:${board.entityId}`);
    }
    boards.set(board.entityId, board);
  };
  add(input.localBoardAuthority);
  const rows = input.phase === 'inbound'
    ? input.inputs
    : [...input.txs, ...input.proposals];
  for (const row of rows) add(row.counterpartyBoardAuthority);
  return boards;
};

const applyInbound = async (
  worker: TsAccountWorkerState,
  input: TsAccountWorkerInboundPayload,
  workspace: PhaseWorkspace,
  certifiedBoards: ReturnType<typeof phaseCertifiedBoards>,
  jClaims: WorkerJClaimAttempt,
): Promise<TsAccountWorkerEffect[]> => {
  const context = createWorkerConsensusContext(
    worker,
    input.entityTimestamp,
    input.finalizedJHeight,
    jClaims.store,
    certifiedBoards,
  );
  assertIncreasingOrders(input.inputs, 'TS_ACCOUNT_WORKER_INBOUND_ORDER');
  const effects: TsAccountWorkerEffect[] = [];
  for (const item of input.inputs) {
    const result = await applyAccountInput(context, workspace.forWrite(item.accountId), item.input, {
      entityTimestamp: input.entityTimestamp,
      finalizedJHeight: input.finalizedJHeight,
      owningEntityIsHub: input.owningEntityIsHub,
      verifyHanko: context.verifyHanko,
      ...(item.counterpartyBoardAuthority
        ? {
            counterpartyCertifiedBoard: {
              boardHash: item.counterpartyBoardAuthority.boardHash,
              activatedAtJHeight: item.counterpartyBoardAuthority.activatedAtJHeight,
              logIndex: item.counterpartyBoardAuthority.logIndex,
            },
          }
        : {}),
    });
    if (result.ok) jClaims.absorb(result.accountJClaimNodeChanges);
    effects.push({ phase: 'inbound', order: item.order, accountId: item.accountId, result });
  }
  return effects;
};

const applyOutboundTxs = async (
  context: AccountConsensusContext,
  input: TsAccountWorkerOutboundPayload,
  workspace: PhaseWorkspace,
  jClaims: WorkerJClaimAttempt,
): Promise<TsAccountWorkerEffect[]> => {
  const effects: TsAccountWorkerEffect[] = [];
  assertIncreasingOrders(input.txs, 'TS_ACCOUNT_WORKER_OUTBOUND_TX_ORDER');
  for (const item of input.txs) {
    const result: HandleAccountInputResult = await applyAccountInput(
      context,
      workspace.forWrite(item.accountId),
      { kind: 'enqueue', txs: [...item.txs] },
    );
    if (result.ok) jClaims.absorb(result.accountJClaimNodeChanges);
    effects.push({ phase: 'outbound-enqueue', order: item.order, accountId: item.accountId, result });
  }
  return effects;
};

const applyOutboundEnvelopeUpdates = (
  input: TsAccountWorkerOutboundPayload,
  workspace: PhaseWorkspace,
): void => {
  for (const item of input.envelopeUpdates) {
    applyAccountEnvelopeUpdate(workspace.forWrite(item.accountId), item.update);
  }
};

const applyOutboundProposals = async (
  ownerEntityId: string,
  context: AccountConsensusContext,
  input: TsAccountWorkerOutboundPayload,
  workspace: PhaseWorkspace,
): Promise<Readonly<{
  effects: TsAccountWorkerEffect[];
  skippedProposals: Array<Readonly<{ order: number; accountId: string }>>;
}>> => {
  const effects: TsAccountWorkerEffect[] = [];
  const skippedProposals: Array<Readonly<{ order: number; accountId: string }>> = [];
  assertIncreasingOrders(input.proposals, 'TS_ACCOUNT_WORKER_OUTBOUND_PROPOSAL_ORDER');
  for (const item of input.proposals) {
    if (!accountHasProposableMempoolForEntity(workspace.forRead(item.accountId), ownerEntityId)) {
      skippedProposals.push({ order: item.order, accountId: item.accountId });
      continue;
    }
    const result = await proposeAccountFrame(
      context,
      workspace.forWrite(item.accountId),
      input.timestamp,
      input.jHeight,
    );
    effects.push({ phase: 'outbound-proposal', order: item.order, accountId: item.accountId, result });
  }
  return { effects, skippedProposals };
};

const publishWorkspace = (
  worker: TsAccountWorkerState,
  workspace: PhaseWorkspace,
  needShardRoot: boolean,
): TsAccountWorkerSubroot[] => {
  const mutations: Array<Readonly<{ kind: 'put'; key: string; value: AccountReplica }>> = [];
  for (const accountId of [...workspace.touched].sort()) {
    const account = workspace.working.get(accountId);
    if (account === undefined) {
      throw new Error(`TS_ACCOUNT_WORKER_TOUCHED_ACCOUNT_MISSING:${accountId}`);
    }
    mutations.push({ kind: 'put', key: accountId, value: account });
    worker.frameTouchedAccountIds.add(accountId);
  }
  worker.accounts = worker.accounts.foldDirty(mutations);
  if (!needShardRoot) return [];
  // Inbound deliberately defers sealing. The final Account visit therefore
  // seals the union of every Account touched anywhere in this Entity frame,
  // including shards with no Stage-3 transaction or proposal of their own.
  return [...new Set([...worker.frameTouchedAccountIds].map(tsAccountLogicalShard))]
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
    : new Map(input.txs.flatMap(row => row.initialAccount === undefined
      ? []
      : [[row.accountId, row.initialAccount] as const]));
  const workspace = createWorkspace(worker, initialAccounts);
  const jClaims = createWorkerJClaimAttempt(worker.jClaimNodes);
  const certifiedBoards = phaseCertifiedBoards(input);
  let transitionUs = 0;
  let proposalUs = 0;
  let effects: TsAccountWorkerEffect[];
  let skippedProposals: Array<Readonly<{ order: number; accountId: string }>> = [];
  if (input.phase === 'inbound') {
    prepareWorkerAttempt(worker, input.restorePrevious);
    const transitionStartedAt = getPerfMs();
    effects = await applyInbound(worker, input, workspace, certifiedBoards, jClaims);
    transitionUs = Math.round((getPerfMs() - transitionStartedAt) * 1_000);
  } else {
    if (input.prepareAttempt) prepareWorkerAttempt(worker, false);
    const transitionStartedAt = getPerfMs();
    applyOutboundEnvelopeUpdates(input, workspace);
    const admissions = await applyOutboundTxs(
      createWorkerConsensusContext(
        worker, input.timestamp, input.jHeight, jClaims.store, certifiedBoards,
      ),
      input,
      workspace,
      jClaims,
    );
    transitionUs = Math.round((getPerfMs() - transitionStartedAt) * 1_000);
    const proposalStartedAt = getPerfMs();
    const proposals = await applyOutboundProposals(
      worker.ownerEntityId,
      createWorkerConsensusContext(
        worker, input.timestamp, input.jHeight, jClaims.store, certifiedBoards,
      ),
      input,
      workspace,
    );
    proposalUs = Math.round((getPerfMs() - proposalStartedAt) * 1_000);
    effects = [...admissions, ...proposals.effects];
    skippedProposals = proposals.skippedProposals;
  }
  // Publish only after this worker completed every canonical transition. If a
  // sibling fails, the coordinator becomes permanently fatal and kills all isolates.
  const rootStartedAt = getPerfMs();
  const subroots = publishWorkspace(worker, workspace, input.needShardRoot);
  if (jClaims.publish()) {
    pruneWorkerJClaimNodes(worker.jClaimNodes, [
      worker.accounts.values(),
      ...(worker.candidateBaseAccounts ? [worker.candidateBaseAccounts.values()] : []),
    ]);
  }
  const rootUs = Math.round((getPerfMs() - rootStartedAt) * 1_000);
  const materializeStartedAt = getPerfMs();
  // Stage 2 Entity followups consume the exact Account state committed by
  // Stage 1.  Returning only outbound rows left those followups reading the
  // stale coordinator-side replica even though this worker had committed the
  // inbound frame already.  Export only the worker's touched Account IDs; the
  // Account root remains unsealed until the final outbound phase.
  const postAccounts = input.phase === 'inbound'
    ? projectWorkerPostAccounts(worker)
    : collectWorkerPostAccounts(worker);
  const materializeUs = Math.round((getPerfMs() - materializeStartedAt) * 1_000);
  const cpu = readThreadCpuUsage(cpuStartedAt);
  const shardRows = new Map<number, number>();
  const operationAccountIds = input.phase === 'inbound'
    ? input.inputs.map(row => row.accountId)
    : [...input.txs.map(row => row.accountId), ...input.proposals.map(row => row.accountId)];
  if (input.phase === 'outbound') {
    operationAccountIds.unshift(...input.envelopeUpdates.map(row => row.accountId));
  }
  for (const accountId of operationAccountIds) {
    const shardId = tsAccountLogicalShard(accountId);
    shardRows.set(shardId, (shardRows.get(shardId) ?? 0) + 1);
  }
  return {
    workerIndex: worker.workerIndex,
    effects,
    skippedProposals,
    subroots,
    ...(postAccounts ? { postAccounts } : {}),
    operations: effects.length + (input.phase === 'outbound' ? input.envelopeUpdates.length : 0),
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
  // A fatal response poisons the coordinator. Closing after enqueueing it
  // gives the owner a second deterministic rejection signal if Bun loses the
  // final cross-thread message under contention.
  scope.close();
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
      } else if (request.kind === 'books') {
        if (state === null) throw new Error('TS_ACCOUNT_WORKER_NOT_INITIALIZED');
        postResult(request.requestId, processBookSlots(
          state.workerIndex,
          decoded as import('./protocol').TsBookWorkerPayload,
        ));
      } else if (request.kind === 'install_hankos') {
        if (state === null) throw new Error('TS_ACCOUNT_WORKER_NOT_INITIALIZED');
        postResult(
          request.requestId,
          installWorkerCommittedHankos(
            state,
            decoded as import('./protocol').TsAccountWorkerInstallHankosPayload,
          ),
        );
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
