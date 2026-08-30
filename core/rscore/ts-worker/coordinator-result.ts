import { parseWorkerPhaseResult, type WorkerRequestResult } from './coordinator-client';
import { getPerfMs } from '../../support/time';
import { TsAccountCanonicalRoot, tsAccountWorkerForShard } from './sharding';
import type {
  TsAccountWorkerBatchResult,
  TsAccountWorkerCheckpointChanges,
  TsAccountWorkerEffect,
  TsAccountWorkerPhaseMetrics,
  TsAccountWorkerSubroot,
} from './protocol';

type AggregateOptions = Readonly<{
  responses: readonly Readonly<{
    workerIndex: number;
    response: WorkerRequestResult;
  }>[];
  logicalShardToWorker: readonly number[];
  checkpointDue: boolean;
  includePostAccounts: boolean;
  expectedEffects: number;
  rootTree: TsAccountCanonicalRoot;
  dispatchMs: number;
  joinMs: number;
}>;

export const aggregateWorkerPhaseResults = (
  options: AggregateOptions,
): TsAccountWorkerBatchResult => {
  const effects: TsAccountWorkerEffect[] = [];
  const subroots = new Map<number, TsAccountWorkerSubroot>();
  const metrics: TsAccountWorkerPhaseMetrics[] = [];
  const checkpointAccounts = new Map<string, Record<string, unknown>>();
  const postAccounts = new Map<string, Readonly<{ account: Record<string, unknown>; entityAccountLeaf: string }>>();
  for (const { workerIndex, response } of options.responses) {
    const result = parseWorkerPhaseResult(response.value, workerIndex);
    effects.push(...result.effects);
    for (const subroot of result.subroots) {
      if (tsAccountWorkerForShard(subroot.shardId, options.logicalShardToWorker) !== workerIndex) {
        throw new Error(`TS_ACCOUNT_WORKER_PHASE_SUBROOT_OWNER:${workerIndex}:${subroot.shardId}`);
      }
      if (subroots.has(subroot.shardId)) {
        throw new Error(`TS_ACCOUNT_WORKER_PHASE_SUBROOT_DUPLICATE:${subroot.shardId}`);
      }
      subroots.set(subroot.shardId, subroot);
    }
    if (options.checkpointDue !== (result.checkpointChanges !== undefined)) {
      throw new Error(`TS_ACCOUNT_WORKER_CHECKPOINT_RESPONSE_MISMATCH:${workerIndex}`);
    }
    if (options.includePostAccounts !== (result.postAccounts !== undefined)) {
      throw new Error(`TS_ACCOUNT_WORKER_POST_ACCOUNTS_RESPONSE_MISMATCH:${workerIndex}`);
    }
    if (result.postAccounts) {
      for (const change of result.postAccounts) {
        if (postAccounts.has(change.accountId)) {
          throw new Error(`TS_ACCOUNT_WORKER_POST_ACCOUNT_DUPLICATE:${change.accountId}`);
        }
        postAccounts.set(change.accountId, {
          account: change.account,
          entityAccountLeaf: change.entityAccountLeaf,
        });
      }
    }
    if (result.checkpointChanges) {
      for (const change of result.checkpointChanges.accounts) {
        if (checkpointAccounts.has(change.accountId)) {
          throw new Error(`TS_ACCOUNT_WORKER_CHECKPOINT_ACCOUNT_DUPLICATE:${change.accountId}`);
        }
        checkpointAccounts.set(change.accountId, change.account);
      }
    }
    const workMs = result.elapsedUs / 1_000;
    const roundTripMs = response.roundTripMs;
    metrics.push({
      workerIndex,
      operations: result.operations,
      elapsedUs: result.elapsedUs,
      heapUsedBytes: result.heapUsedBytes,
      requestBytes: response.requestBytes,
      responseBytes: response.responseBytes,
      encodeMs: response.encodeMs,
      decodeMs: response.decodeMs,
      roundTripMs,
      workMs,
      waitMs: Math.max(0, roundTripMs - workMs),
      transitionMs: result.timings.transitionUs / 1_000,
      proposalMs: result.timings.proposalUs / 1_000,
      rootMs: result.timings.rootUs / 1_000,
      checkpointMs: result.timings.checkpointUs / 1_000,
      workerEncodeMs: response.workerEncodeMs,
      threadCpuUserMs: result.threadCpuUserUs / 1_000,
      threadCpuSystemMs: result.threadCpuSystemUs / 1_000,
    });
  }
  if (effects.length !== options.expectedEffects) {
    throw new Error(`TS_ACCOUNT_WORKER_EFFECT_COUNT:${effects.length}:${options.expectedEffects}`);
  }
  const foldStart = getPerfMs();
  const changedSubroots: TsAccountWorkerSubroot[] = [...subroots.values()]
    .sort((left, right) => left.shardId - right.shardId);
  options.rootTree.update(changedSubroots);
  const checkpointChanges: TsAccountWorkerCheckpointChanges | undefined = options.checkpointDue
    ? {
        accounts: [...checkpointAccounts]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([accountId, account]) => ({ accountId, account })),
      }
    : undefined;
  return {
    accountsRoot: options.rootTree.root,
    effects: effects.sort((left, right) => left.order - right.order),
    changedSubroots,
    ...(options.includePostAccounts
      ? {
          postAccounts: [...postAccounts]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([accountId, value]) => ({ accountId, ...value })),
        }
      : {}),
    ...(checkpointChanges ? { checkpointChanges } : {}),
    workers: metrics.sort((left, right) => left.workerIndex - right.workerIndex),
    ipc: {
      requestBytes: metrics.reduce((sum, metric) => sum + metric.requestBytes, 0),
      responseBytes: metrics.reduce((sum, metric) => sum + metric.responseBytes, 0),
    },
    timings: {
      encodeMs: metrics.reduce((sum, metric) => sum + metric.encodeMs, 0),
      decodeMs: metrics.reduce((sum, metric) => sum + metric.decodeMs, 0),
      foldMs: getPerfMs() - foldStart,
      dispatchMs: options.dispatchMs,
      joinMs: options.joinMs,
    },
  };
};
