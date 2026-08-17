/**
 * Exact configuration and observation schema for full-stack swap load runs.
 * This module contains no workload shortcuts: every completion is reported by
 * a real Runtime worker only after bilateral state and its WAL frame are durable.
 */

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';

export const PRODUCTION_SWAP_LOAD_SCHEMA = 'xln-production-swap-load-v1' as const;
export const PRODUCTION_SWAP_LOAD_MODES = [
  'same',
  'cross',
  'hybrid',
  'crash',
  'dispute',
] as const;
export const PRODUCTION_SWAP_LOAD_LATENCY_BUCKETS_MS = [
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512,
  1_024, 2_048, 4_096, 8_192, 16_384, 32_768,
  65_536, 131_072, 262_144, 524_288, 1_048_576,
] as const;

export type ProductionSwapLoadMode = (typeof PRODUCTION_SWAP_LOAD_MODES)[number];

export type ProductionSwapLoadConfig = Readonly<{
  schema: typeof PRODUCTION_SWAP_LOAD_SCHEMA;
  mode: ProductionSwapLoadMode;
  offeredRates: readonly number[];
  warmupMs: number;
  stepDurationMs: number;
  accountsPerHub: number;
  warningRamBps: number;
  hardRamBps: number;
  disputePercentages: readonly number[];
}>;

export type ProductionSwapLoadObservation = Readonly<{
  completionAuthority: 'committed_orderbook_trade_count';
  atMs: number;
  offeredTotal: number;
  completedTotal: number;
  rejectedTotal: number;
  duplicateTotal: number;
  lostTotal: number;
  queueDepth: number;
  rssBytes: number;
  heapUsedBytes: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  diskBytes: number;
  runtimeHeight: number;
  canonicalStateHash: string;
  latencyHistogram: readonly number[];
  stagesMs: Readonly<Record<string, number>>;
}>;

const DEFAULT_RATES = Array.from({ length: 10 }, (_, index) => (index + 1) * 10_000);
const DEFAULT_DISPUTE_PERCENTAGES = [10, 50, 100] as const;
const HASH_32 = /^0x[0-9a-f]{64}$/;

const isMode = (value: unknown): value is ProductionSwapLoadMode =>
  typeof value === 'string' && PRODUCTION_SWAP_LOAD_MODES.some(mode => mode === value);

const requireIntegerArray = (
  value: unknown,
  code: string,
  minimum: number,
  maximum: number,
  allowEmpty = false,
): number[] => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(code);
  return value.map((entry, index) => {
    const integer = requireBoundaryInteger(entry, `${code}:index=${index}`, minimum);
    if (integer > maximum) throw new Error(`${code}:index=${index}:max=${maximum}`);
    return integer;
  });
};

const requireStrictAscending = (values: readonly number[], code: string): void => {
  if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) {
    throw new Error(code);
  }
};

export const defaultProductionSwapLoadConfig = (
  mode: ProductionSwapLoadMode = 'same',
): ProductionSwapLoadConfig => ({
  schema: PRODUCTION_SWAP_LOAD_SCHEMA,
  mode,
  offeredRates: DEFAULT_RATES,
  warmupMs: 30_000,
  stepDurationMs: 120_000,
  accountsPerHub: 1_000,
  warningRamBps: 5_000,
  hardRamBps: 7_000,
  disputePercentages: DEFAULT_DISPUTE_PERCENTAGES,
});

export const decodeProductionSwapLoadConfig = (value: unknown): ProductionSwapLoadConfig => {
  const record = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_CONFIG_INVALID');
  requireExactBoundaryKeys(record, [
    'schema', 'mode', 'offeredRates', 'warmupMs', 'stepDurationMs', 'accountsPerHub',
    'warningRamBps', 'hardRamBps', 'disputePercentages',
  ], [], 'PRODUCTION_SWAP_LOAD_CONFIG_FIELDS_INVALID');
  if (record['schema'] !== PRODUCTION_SWAP_LOAD_SCHEMA) throw new Error('PRODUCTION_SWAP_LOAD_SCHEMA_INVALID');
  if (!isMode(record['mode'])) throw new Error('PRODUCTION_SWAP_LOAD_MODE_INVALID');
  const offeredRates = requireIntegerArray(record['offeredRates'], 'PRODUCTION_SWAP_LOAD_RATES_INVALID', 1, 100_000);
  requireStrictAscending(offeredRates, 'PRODUCTION_SWAP_LOAD_RATES_NOT_ASCENDING');
  const disputePercentages = requireIntegerArray(
    record['disputePercentages'],
    'PRODUCTION_SWAP_LOAD_DISPUTE_PERCENTAGES_INVALID',
    1,
    100,
  );
  requireStrictAscending(disputePercentages, 'PRODUCTION_SWAP_LOAD_DISPUTE_PERCENTAGES_NOT_ASCENDING');
  const warningRamBps = requireBoundaryInteger(record['warningRamBps'], 'PRODUCTION_SWAP_LOAD_WARNING_RAM_INVALID', 1);
  const hardRamBps = requireBoundaryInteger(record['hardRamBps'], 'PRODUCTION_SWAP_LOAD_HARD_RAM_INVALID', 1);
  if (warningRamBps >= hardRamBps || hardRamBps > 10_000) throw new Error('PRODUCTION_SWAP_LOAD_RAM_THRESHOLDS_INVALID');
  const stepDurationMs = requireBoundaryInteger(record['stepDurationMs'], 'PRODUCTION_SWAP_LOAD_STEP_DURATION_INVALID', 1);
  if (stepDurationMs > 600_000) throw new Error('PRODUCTION_SWAP_LOAD_STEP_DURATION_EXCEEDS_TEN_MINUTES');
  const accountsPerHub = requireBoundaryInteger(record['accountsPerHub'], 'PRODUCTION_SWAP_LOAD_ACCOUNTS_INVALID', 1);
  return {
    schema: PRODUCTION_SWAP_LOAD_SCHEMA,
    mode: record['mode'],
    offeredRates,
    warmupMs: requireBoundaryInteger(record['warmupMs'], 'PRODUCTION_SWAP_LOAD_WARMUP_INVALID', 0),
    stepDurationMs,
    accountsPerHub,
    warningRamBps,
    hardRamBps,
    disputePercentages,
  };
};

const requireMetricRecord = (value: unknown): Readonly<Record<string, number>> => {
  const record = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_STAGES_INVALID');
  const decoded: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!key || !Number.isFinite(raw) || Number(raw) < 0) throw new Error(`PRODUCTION_SWAP_LOAD_STAGE_INVALID:${key}`);
    decoded[key] = Number(raw);
  }
  return decoded;
};

export const decodeProductionSwapLoadObservation = (value: unknown): ProductionSwapLoadObservation => {
  const record = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_OBSERVATION_INVALID');
  requireExactBoundaryKeys(record, [
    'completionAuthority', 'atMs', 'offeredTotal', 'completedTotal', 'rejectedTotal', 'duplicateTotal', 'lostTotal',
    'queueDepth', 'rssBytes', 'heapUsedBytes', 'cpuUserMicros', 'cpuSystemMicros',
    'diskBytes', 'runtimeHeight', 'canonicalStateHash',
    'latencyHistogram', 'stagesMs',
  ], [], 'PRODUCTION_SWAP_LOAD_OBSERVATION_FIELDS_INVALID');
  const canonicalStateHash = record['canonicalStateHash'];
  if (typeof canonicalStateHash !== 'string' || !HASH_32.test(canonicalStateHash)) {
    throw new Error('PRODUCTION_SWAP_LOAD_CANONICAL_ROOT_INVALID');
  }
  if (record['completionAuthority'] !== 'committed_orderbook_trade_count') {
    throw new Error('PRODUCTION_SWAP_LOAD_COMPLETION_AUTHORITY_INVALID');
  }
  return {
    completionAuthority: 'committed_orderbook_trade_count',
    atMs: requireBoundaryInteger(record['atMs'], 'PRODUCTION_SWAP_LOAD_AT_INVALID', 0),
    offeredTotal: requireBoundaryInteger(record['offeredTotal'], 'PRODUCTION_SWAP_LOAD_OFFERED_INVALID', 0),
    completedTotal: requireBoundaryInteger(record['completedTotal'], 'PRODUCTION_SWAP_LOAD_COMPLETED_INVALID', 0),
    rejectedTotal: requireBoundaryInteger(record['rejectedTotal'], 'PRODUCTION_SWAP_LOAD_REJECTED_INVALID', 0),
    duplicateTotal: requireBoundaryInteger(record['duplicateTotal'], 'PRODUCTION_SWAP_LOAD_DUPLICATE_INVALID', 0),
    lostTotal: requireBoundaryInteger(record['lostTotal'], 'PRODUCTION_SWAP_LOAD_LOST_INVALID', 0),
    queueDepth: requireBoundaryInteger(record['queueDepth'], 'PRODUCTION_SWAP_LOAD_QUEUE_INVALID', 0),
    rssBytes: requireBoundaryInteger(record['rssBytes'], 'PRODUCTION_SWAP_LOAD_RSS_INVALID', 0),
    heapUsedBytes: requireBoundaryInteger(record['heapUsedBytes'], 'PRODUCTION_SWAP_LOAD_HEAP_INVALID', 0),
    cpuUserMicros: requireBoundaryInteger(record['cpuUserMicros'], 'PRODUCTION_SWAP_LOAD_CPU_USER_INVALID', 0),
    cpuSystemMicros: requireBoundaryInteger(record['cpuSystemMicros'], 'PRODUCTION_SWAP_LOAD_CPU_SYSTEM_INVALID', 0),
    diskBytes: requireBoundaryInteger(record['diskBytes'], 'PRODUCTION_SWAP_LOAD_DISK_INVALID', 0),
    runtimeHeight: requireBoundaryInteger(record['runtimeHeight'], 'PRODUCTION_SWAP_LOAD_HEIGHT_INVALID', 0),
    canonicalStateHash,
    latencyHistogram: (() => {
      const histogram = requireIntegerArray(
        record['latencyHistogram'],
        'PRODUCTION_SWAP_LOAD_LATENCY_HISTOGRAM_INVALID',
        0,
        Number.MAX_SAFE_INTEGER,
        true,
      );
      if (histogram.length !== PRODUCTION_SWAP_LOAD_LATENCY_BUCKETS_MS.length) {
        throw new Error('PRODUCTION_SWAP_LOAD_LATENCY_HISTOGRAM_LENGTH_INVALID');
      }
      return histogram;
    })(),
    stagesMs: requireMetricRecord(record['stagesMs']),
  };
};
