import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';

export type HubConsensusBenchmarkResult = {
  benchmark: 'swap-hub-account-consensus';
  sameSwaps: number;
  crossSwaps: number;
  elapsedMs: number;
  aggregateAccountConsensusTps: number;
  minAggregateAccountConsensusTps: number;
  passed: boolean;
  aggregateSameAccountConsensusTps: number;
  aggregateCrossAccountConsensusTps: number;
  committedFrames: number;
  batchSize: number;
  users: number;
  sameUsers: number;
  crossUsers: number;
  uniqueUserAccounts: number;
  committedSwaps: number;
  concurrency: number;
  independentHubCohorts: number;
  meanPhaseMsPerAccountFrame: HubConsensusPhaseMetrics;
  scope: string;
};

export const HUB_CONSENSUS_PHASES = [
  'propose', 'proposalHanko', 'receive', 'ackHanko', 'commit',
] as const;
export type HubConsensusPhase = (typeof HUB_CONSENSUS_PHASES)[number];
export type HubConsensusPhaseMetrics = Readonly<Record<HubConsensusPhase, number>>;

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

export const decodeHubConsensusBenchmarkResult = (value: unknown): HubConsensusBenchmarkResult => {
  const code = 'SWAP_CONSENSUS_WORKER_RESULT_INVALID';
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, [
    'benchmark', 'sameSwaps', 'crossSwaps', 'elapsedMs', 'aggregateAccountConsensusTps',
    'minAggregateAccountConsensusTps', 'passed', 'aggregateSameAccountConsensusTps',
    'aggregateCrossAccountConsensusTps', 'committedFrames', 'batchSize', 'users', 'sameUsers',
    'crossUsers', 'uniqueUserAccounts', 'committedSwaps', 'concurrency',
    'independentHubCohorts', 'meanPhaseMsPerAccountFrame', 'scope',
  ], [], code);
  if (record['benchmark'] !== 'swap-hub-account-consensus' || typeof record['passed'] !== 'boolean') {
    throw new Error(code);
  }
  if (typeof record['scope'] !== 'string' || record['scope'].length === 0) throw new Error(code);
  const phases = requireBoundaryRecord(
    record['meanPhaseMsPerAccountFrame'], `${code}:meanPhaseMsPerAccountFrame`,
  );
  requireExactBoundaryKeys(phases, HUB_CONSENSUS_PHASES, [], `${code}:meanPhaseMsPerAccountFrame`);
  return {
    benchmark: 'swap-hub-account-consensus',
    sameSwaps: requireBoundaryInteger(record['sameSwaps'], `${code}:sameSwaps`),
    crossSwaps: requireBoundaryInteger(record['crossSwaps'], `${code}:crossSwaps`),
    elapsedMs: requireMetric(record['elapsedMs'], `${code}:elapsedMs`),
    aggregateAccountConsensusTps: requireMetric(
      record['aggregateAccountConsensusTps'], `${code}:aggregateAccountConsensusTps`,
    ),
    minAggregateAccountConsensusTps: requireMetric(
      record['minAggregateAccountConsensusTps'], `${code}:minAggregateAccountConsensusTps`,
    ),
    passed: record['passed'],
    aggregateSameAccountConsensusTps: requireMetric(
      record['aggregateSameAccountConsensusTps'], `${code}:aggregateSameAccountConsensusTps`,
    ),
    aggregateCrossAccountConsensusTps: requireMetric(
      record['aggregateCrossAccountConsensusTps'], `${code}:aggregateCrossAccountConsensusTps`,
    ),
    committedFrames: requireBoundaryInteger(record['committedFrames'], `${code}:committedFrames`),
    batchSize: requireBoundaryInteger(record['batchSize'], `${code}:batchSize`, 1),
    users: requireBoundaryInteger(record['users'], `${code}:users`, 1),
    sameUsers: requireBoundaryInteger(record['sameUsers'], `${code}:sameUsers`),
    crossUsers: requireBoundaryInteger(record['crossUsers'], `${code}:crossUsers`),
    uniqueUserAccounts: requireBoundaryInteger(record['uniqueUserAccounts'], `${code}:uniqueUserAccounts`),
    committedSwaps: requireBoundaryInteger(record['committedSwaps'], `${code}:committedSwaps`),
    concurrency: requireBoundaryInteger(record['concurrency'], `${code}:concurrency`, 1),
    independentHubCohorts: requireBoundaryInteger(
      record['independentHubCohorts'], `${code}:independentHubCohorts`, 1,
    ),
    meanPhaseMsPerAccountFrame: Object.fromEntries(HUB_CONSENSUS_PHASES.map(phase => [
      phase,
      requireMetric(phases[phase], `${code}:meanPhaseMsPerAccountFrame:${phase}`),
    ])) as HubConsensusPhaseMetrics,
    scope: record['scope'],
  };
};
