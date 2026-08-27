/** Bun Worker entry for the resident TypeScript Account-shard prototype. */

import { applyAccountInput, proposeAccountFrame } from '../../account/consensus';
import type { AccountConsensusContext } from '../../account/consensus/context';
import type { HandleAccountInputResult } from '../../account/consensus/types';
import { forkAccountReplicaShell } from '../../account/state/account-replica-shell';
import { computeEntityAccountValueHash } from '../../entity/consensus/state-root';
import type { AccountReplica } from '../../types/account';
import { getPerfMs } from '../../support/time';
import { decodeTsAccountWorkerTransfer, encodeTsAccountWorkerTransfer } from './codec';
import { tsAccountLogicalShard } from './sharding';
import { decodeWorkerInitPayload, decodeWorkerPhasePayload } from './worker-boundary';
import {
  collectWorkerCheckpoint,
  computeWorkerShardRoot,
  createWorkerConsensusContext,
  initializeWorkerState,
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

const createWorkspace = (worker: TsAccountWorkerState): PhaseWorkspace => {
  const working = new Map<string, AccountReplica>();
  const touched = new Set<string>();
  return {
    working,
    touched,
    forWrite(accountId): AccountReplica {
      const existing = working.get(accountId);
      if (existing) return existing;
      const committed = worker.accounts.get(accountId);
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
  const ordered = [...input.inputs].sort((left, right) =>
    left.accountId.localeCompare(right.accountId) || left.order - right.order);
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
  const ordered = [...input.txs].sort((left, right) =>
    left.accountId.localeCompare(right.accountId) || left.order - right.order);
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
  const ordered = [...input.proposals].sort((left, right) =>
    left.accountId.localeCompare(right.accountId) || left.order - right.order);
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

const applyOutbound = async (
  worker: TsAccountWorkerState,
  input: TsAccountWorkerOutboundPayload,
  workspace: PhaseWorkspace,
): Promise<TsAccountWorkerEffect[]> => {
  const context = createWorkerConsensusContext(worker, input.timestamp, input.jHeight, worker.jClaimNodes);
  return [
    ...await applyOutboundTxs(context, input, workspace),
    ...await applyOutboundProposals(context, input, workspace),
  ];
};

const publishWorkspace = (
  worker: TsAccountWorkerState,
  workspace: PhaseWorkspace,
): TsAccountWorkerSubroot[] => {
  const touchedShards = new Set<number>();
  for (const accountId of [...workspace.touched].sort()) {
    const account = workspace.working.get(accountId);
    if (account === undefined) {
      throw new Error(`TS_ACCOUNT_WORKER_TOUCHED_ACCOUNT_MISSING:${accountId}`);
    }
    const valueHash = computeEntityAccountValueHash(account);
    const shardId = tsAccountLogicalShard(accountId);
    worker.accounts.set(accountId, account);
    worker.leafHashes.set(accountId, valueHash);
    const leaves = worker.shardLeaves.get(shardId);
    if (!leaves) throw new Error(`TS_ACCOUNT_WORKER_SHARD_LEAVES_MISSING:${shardId}`);
    leaves.set(accountId, valueHash);
    touchedShards.add(shardId);
    worker.checkpointAccountIds.add(accountId);
  }
  return [...touchedShards]
    .sort((left, right) => left - right)
    .map(shardId => ({ shardId, root: computeWorkerShardRoot(worker, shardId) }));
};

const processPhase = async (value: unknown): Promise<TsAccountWorkerPhaseResult> => {
  const worker = state;
  if (!worker) throw new Error('TS_ACCOUNT_WORKER_NOT_INITIALIZED');
  const input = decodeWorkerPhasePayload(worker, value);
  const startedAt = getPerfMs();
  const workspace = createWorkspace(worker);
  const effects = input.phase === 'inbound'
    ? await applyInbound(worker, input, workspace)
    : await applyOutbound(worker, input, workspace);
  // Publish only after this worker completed every canonical transition. If a
  // sibling fails, the coordinator becomes permanently fatal and kills all isolates.
  const subroots = publishWorkspace(worker, workspace);
  const checkpointChanges = input.phase === 'outbound' && input.checkpointDue
    ? collectWorkerCheckpoint(worker)
    : undefined;
  return {
    workerIndex: worker.workerIndex,
    effects: effects.sort((left, right) => left.order - right.order),
    subroots,
    ...(checkpointChanges ? { checkpointChanges } : {}),
    operations: effects.length,
    elapsedUs: Math.round((getPerfMs() - startedAt) * 1_000),
    heapUsedBytes: workerHeapUsedBytes(),
  };
};

const postResult = (requestId: number, result: unknown): void => {
  const payload = encodeTsAccountWorkerTransfer(result);
  const response: TsAccountWorkerResponseEnvelope = { requestId, kind: 'result', payload };
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
      const decoded = decodeTsAccountWorkerTransfer(request.payload);
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
