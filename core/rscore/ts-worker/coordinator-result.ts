import { parseWorkerPhaseResult, type WorkerRequestResult } from './coordinator-client';
import { getPerfMs } from '../../support/time';
import { TsAccountShardRootTree, tsAccountWorkerForShard } from './sharding';
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
  expectedEffects: number;
  rootTree: TsAccountShardRootTree;
}>;

export const aggregateWorkerPhaseResults = (
  options: AggregateOptions,
): TsAccountWorkerBatchResult => {
  const effects: TsAccountWorkerEffect[] = [];
  const subroots = new Map<number, string>();
  const metrics: TsAccountWorkerPhaseMetrics[] = [];
  const checkpointAccounts = new Map<string, Record<string, unknown>>();
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
      subroots.set(subroot.shardId, subroot.root);
    }
    if (options.checkpointDue !== (result.checkpointChanges !== undefined)) {
      throw new Error(`TS_ACCOUNT_WORKER_CHECKPOINT_RESPONSE_MISMATCH:${workerIndex}`);
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
    });
  }
  if (effects.length !== options.expectedEffects) {
    throw new Error(`TS_ACCOUNT_WORKER_EFFECT_COUNT:${effects.length}:${options.expectedEffects}`);
  }
  const foldStart = getPerfMs();
  const changedSubroots: TsAccountWorkerSubroot[] = [...subroots]
    .sort(([left], [right]) => left - right)
    .map(([shardId, root]) => ({ shardId, root }));
  options.rootTree.update(changedSubroots);
  const checkpointChanges: TsAccountWorkerCheckpointChanges | undefined = options.checkpointDue
    ? {
        accounts: [...checkpointAccounts]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([accountId, account]) => ({ accountId, account })),
      }
    : undefined;
  return {
    shadowAccountsRoot: options.rootTree.root,
    effects: effects.sort((left, right) => left.order - right.order),
    changedSubroots,
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
      dispatchMs: metrics.reduce((max, metric) => Math.max(max, metric.roundTripMs), 0),
    },
  };
};
