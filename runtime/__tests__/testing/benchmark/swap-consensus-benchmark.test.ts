import { describe, expect, test } from 'bun:test';

import { partitionConsensusLoad } from '../../../scripts/operations/benchmark/bench-swap-hub-consensus-tps';
import {
  decodeHubConsensusBenchmarkResult,
  encodeHubConsensusWorkerResult,
  extractHubConsensusWorkerResult,
} from '../../../scripts/operations/benchmark/swap-hub-consensus-result';

const workerResult = (): Record<string, unknown> => ({
  benchmark: 'swap-hub-account-consensus',
  sameSwaps: 10,
  crossSwaps: 10,
  elapsedMs: 5,
  tps: 4_000,
  minTps: 1,
  passed: true,
  sameTps: 2_000,
  crossTps: 2_000,
  committedFrames: 2,
  batchSize: 10,
  users: 1,
  sameUsers: 1,
  crossUsers: 1,
  uniqueUserAccounts: 2,
  committedSwaps: 20,
  concurrency: 1,
  processes: 1,
  scope: 'test worker',
});

describe('swap consensus benchmark workload', () => {
  test('partitions requested swaps exactly instead of multiplying them per worker', () => {
    const partitions = Array.from({ length: 4 }, (_, index) =>
      partitionConsensusLoad(10_003, 4, index));

    expect(partitions).toEqual([2_501, 2_501, 2_501, 2_500]);
    expect(partitions.reduce((sum, count) => sum + count, 0)).toBe(10_003);
  });

  test('rejects invalid partition coordinates', () => {
    expect(() => partitionConsensusLoad(-1, 1, 0)).toThrow('CONSENSUS_LOAD_TOTAL_INVALID');
    expect(() => partitionConsensusLoad(1, 0, 0)).toThrow('CONSENSUS_LOAD_PARTITIONS_INVALID');
    expect(() => partitionConsensusLoad(1, 1, 1)).toThrow('CONSENSUS_LOAD_INDEX_INVALID');
  });

  test('rejects malformed child-process metrics before aggregation', () => {
    expect(decodeHubConsensusBenchmarkResult(workerResult()).committedSwaps).toBe(20);
    expect(() => decodeHubConsensusBenchmarkResult({ ...workerResult(), tps: '4000' }))
      .toThrow('SWAP_CONSENSUS_WORKER_RESULT_INVALID:tps');
    expect(() => decodeHubConsensusBenchmarkResult({ ...workerResult(), injected: true }))
      .toThrow('SWAP_CONSENSUS_WORKER_RESULT_INVALID');
  });

  test('extracts one framed result without parsing diagnostic log lines as JSON', () => {
    const decoded = decodeHubConsensusBenchmarkResult(workerResult());
    const stdout = `[INFO] slow profile\n${encodeHubConsensusWorkerResult(decoded)}\n`;
    expect(extractHubConsensusWorkerResult(stdout).committedSwaps).toBe(20);
    expect(() => extractHubConsensusWorkerResult(`${stdout}${encodeHubConsensusWorkerResult(decoded)}\n`))
      .toThrow('SWAP_CONSENSUS_WORKER_RESULT_COUNT:2');
  });
});
