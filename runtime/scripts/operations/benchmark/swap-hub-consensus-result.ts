import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';

export type HubConsensusStageMetrics = {
  proposalBuild: number;
  proposalSeal: number;
  peerReplay: number;
  ackSeal: number;
  proposerCommit: number;
};

export type HubConsensusBenchmarkResult = {
  benchmark: 'swap-hub-account-consensus';
  sameSwaps: number;
  crossSwaps: number;
  elapsedMs: number;
  tps: number;
  minTps: number;
  passed: boolean;
  sameTps: number;
  crossTps: number;
  committedFrames: number;
  batchSize: number;
  users: number;
  sameUsers: number;
  crossUsers: number;
  uniqueUserAccounts: number;
  committedSwaps: number;
  concurrency: number;
  processes: number;
  scope: string;
  stageMs?: HubConsensusStageMetrics;
  stageMsByKind?: { same: HubConsensusStageMetrics; cross: HubConsensusStageMetrics };
};

const WORKER_RESULT_PREFIX = 'XLN_SWAP_CONSENSUS_RESULT=';

export const encodeHubConsensusWorkerResult = (result: HubConsensusBenchmarkResult): string =>
  `${WORKER_RESULT_PREFIX}${safeStringify(result)}`;

export const extractHubConsensusWorkerResult = (stdout: string): HubConsensusBenchmarkResult => {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(WORKER_RESULT_PREFIX));
  if (lines.length !== 1) throw new Error(`SWAP_CONSENSUS_WORKER_RESULT_COUNT:${lines.length}`);
  const payload = lines[0]?.slice(WORKER_RESULT_PREFIX.length);
  if (!payload) throw new Error('SWAP_CONSENSUS_WORKER_RESULT_EMPTY');
  const parsed: unknown = JSON.parse(payload);
  return decodeHubConsensusBenchmarkResult(parsed);
};

const requireMetric = (value: unknown, code: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
};

const decodeStageMetrics = (value: unknown, code: string): HubConsensusStageMetrics => {
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, [
    'proposalBuild', 'proposalSeal', 'peerReplay', 'ackSeal', 'proposerCommit',
  ], [], code);
  return {
    proposalBuild: requireMetric(record['proposalBuild'], code),
    proposalSeal: requireMetric(record['proposalSeal'], code),
    peerReplay: requireMetric(record['peerReplay'], code),
    ackSeal: requireMetric(record['ackSeal'], code),
    proposerCommit: requireMetric(record['proposerCommit'], code),
  };
};

const decodeStagesByKind = (
  value: unknown,
  code: string,
): HubConsensusBenchmarkResult['stageMsByKind'] => {
  if (value === undefined) return undefined;
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, ['same', 'cross'], [], code);
  return {
    same: decodeStageMetrics(record['same'], `${code}:same`),
    cross: decodeStageMetrics(record['cross'], `${code}:cross`),
  };
};

export const decodeHubConsensusBenchmarkResult = (value: unknown): HubConsensusBenchmarkResult => {
  const code = 'SWAP_CONSENSUS_WORKER_RESULT_INVALID';
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, [
    'benchmark', 'sameSwaps', 'crossSwaps', 'elapsedMs', 'tps', 'minTps', 'passed',
    'sameTps', 'crossTps', 'committedFrames', 'batchSize', 'users', 'sameUsers',
    'crossUsers', 'uniqueUserAccounts', 'committedSwaps', 'concurrency', 'processes', 'scope',
  ], ['stageMs', 'stageMsByKind'], code);
  if (record['benchmark'] !== 'swap-hub-account-consensus' || typeof record['passed'] !== 'boolean') {
    throw new Error(code);
  }
  if (typeof record['scope'] !== 'string' || record['scope'].length === 0) throw new Error(code);
  const stageMs = record['stageMs'] === undefined
    ? undefined
    : decodeStageMetrics(record['stageMs'], `${code}:stageMs`);
  const stageMsByKind = decodeStagesByKind(record['stageMsByKind'], `${code}:stageMsByKind`);
  return {
    benchmark: 'swap-hub-account-consensus',
    sameSwaps: requireBoundaryInteger(record['sameSwaps'], `${code}:sameSwaps`),
    crossSwaps: requireBoundaryInteger(record['crossSwaps'], `${code}:crossSwaps`),
    elapsedMs: requireMetric(record['elapsedMs'], `${code}:elapsedMs`),
    tps: requireMetric(record['tps'], `${code}:tps`),
    minTps: requireMetric(record['minTps'], `${code}:minTps`),
    passed: record['passed'],
    sameTps: requireMetric(record['sameTps'], `${code}:sameTps`),
    crossTps: requireMetric(record['crossTps'], `${code}:crossTps`),
    committedFrames: requireBoundaryInteger(record['committedFrames'], `${code}:committedFrames`),
    batchSize: requireBoundaryInteger(record['batchSize'], `${code}:batchSize`, 1),
    users: requireBoundaryInteger(record['users'], `${code}:users`, 1),
    sameUsers: requireBoundaryInteger(record['sameUsers'], `${code}:sameUsers`),
    crossUsers: requireBoundaryInteger(record['crossUsers'], `${code}:crossUsers`),
    uniqueUserAccounts: requireBoundaryInteger(record['uniqueUserAccounts'], `${code}:uniqueUserAccounts`),
    committedSwaps: requireBoundaryInteger(record['committedSwaps'], `${code}:committedSwaps`),
    concurrency: requireBoundaryInteger(record['concurrency'], `${code}:concurrency`, 1),
    processes: requireBoundaryInteger(record['processes'], `${code}:processes`, 1),
    scope: record['scope'],
    ...(stageMs === undefined ? {} : { stageMs }),
    ...(stageMsByKind === undefined ? {} : { stageMsByKind }),
  };
};
