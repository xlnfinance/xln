/**
 * Pure aggregation for production swap-load evidence.
 * Counters are cumulative and monotonic, so retries or replay cannot inflate
 * completed economic swaps without being detected as malformed evidence.
 */

import {
  PRODUCTION_SWAP_LOAD_LATENCY_BUCKETS_MS,
  type ProductionSwapLoadConfig,
  type ProductionSwapLoadObservation,
} from './schema';

export type ProductionSwapLoadStepResult = Readonly<{
  offeredRate: number;
  completedTps: number;
  offered: number;
  completed: number;
  rejected: number;
  duplicates: number;
  lost: number;
  latencyMs: Readonly<{ p50: number; p95: number; p99: number }>;
  queueSlopePerSecond: number;
  rssGrowthBytesPerSecond: number;
  averageCpuCores: number;
  peakRssBytes: number;
  peakRamBps: number;
  diskGrowthBytes: number;
  startHeight: number;
  endHeight: number;
  startRoot: string;
  endRoot: string;
  stagesMs: Readonly<Record<string, number>>;
  status: 'green' | 'warning' | 'hard-stop';
}>;

const delta = (end: number, start: number, code: string): number => {
  const value = end - start;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${code}:${start}:${end}`);
  return value;
};

const mergeLatencyHistograms = (
  observations: readonly ProductionSwapLoadObservation[],
): number[] => observations.reduce<number[]>(
  (totals, observation) =>
    totals.map((count, index) => count + observation.latencyHistogram[index]!),
  Array.from({ length: PRODUCTION_SWAP_LOAD_LATENCY_BUCKETS_MS.length }, () => 0),
);

const histogramPercentile = (histogram: readonly number[], ratio: number): number => {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  const target = Math.ceil(total * ratio);
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index]!;
    if (cumulative >= target) return PRODUCTION_SWAP_LOAD_LATENCY_BUCKETS_MS[index]!;
  }
  throw new Error('PRODUCTION_SWAP_LOAD_LATENCY_HISTOGRAM_INVALID');
};

const perSecond = (change: number, elapsedMs: number): number =>
  Math.round(((change / elapsedMs) * 1000) * 1_000) / 1_000;

const mergeStages = (observations: readonly ProductionSwapLoadObservation[]): Readonly<Record<string, number>> => {
  const totals: Record<string, number> = {};
  for (const observation of observations) {
    for (const [stage, elapsedMs] of Object.entries(observation.stagesMs)) {
      totals[stage] = (totals[stage] ?? 0) + elapsedMs;
    }
  }
  return totals;
};

const assertMonotonic = (observations: readonly ProductionSwapLoadObservation[]): void => {
  const fields = [
    'atMs', 'offeredTotal', 'completedTotal', 'rejectedTotal', 'duplicateTotal',
    'lostTotal', 'runtimeHeight', 'cpuUserMicros', 'cpuSystemMicros',
  ] as const;
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]!;
    const current = observations[index]!;
    for (const field of fields) {
      if (current[field] < previous[field]) throw new Error(`PRODUCTION_SWAP_LOAD_COUNTER_REGRESSION:${field}:index=${index}`);
    }
  }
};

export const summarizeProductionSwapLoadStep = (
  config: ProductionSwapLoadConfig,
  offeredRate: number,
  totalRamBytes: number,
  observations: readonly ProductionSwapLoadObservation[],
): ProductionSwapLoadStepResult => {
  if (observations.length < 2) throw new Error('PRODUCTION_SWAP_LOAD_OBSERVATIONS_INSUFFICIENT');
  if (!Number.isSafeInteger(totalRamBytes) || totalRamBytes <= 0) throw new Error('PRODUCTION_SWAP_LOAD_TOTAL_RAM_INVALID');
  assertMonotonic(observations);
  const first = observations[0]!;
  const last = observations.at(-1)!;
  const elapsedMs = last.atMs - first.atMs;
  if (elapsedMs <= 0) throw new Error('PRODUCTION_SWAP_LOAD_ELAPSED_INVALID');
  const offered = delta(last.offeredTotal, first.offeredTotal, 'PRODUCTION_SWAP_LOAD_OFFERED_REGRESSION');
  const completed = delta(last.completedTotal, first.completedTotal, 'PRODUCTION_SWAP_LOAD_COMPLETED_REGRESSION');
  const rejected = delta(last.rejectedTotal, first.rejectedTotal, 'PRODUCTION_SWAP_LOAD_REJECTED_REGRESSION');
  const duplicates = delta(last.duplicateTotal, first.duplicateTotal, 'PRODUCTION_SWAP_LOAD_DUPLICATE_REGRESSION');
  const lost = delta(last.lostTotal, first.lostTotal, 'PRODUCTION_SWAP_LOAD_LOST_REGRESSION');
  const diskGrowthBytes = delta(last.diskBytes, first.diskBytes, 'PRODUCTION_SWAP_LOAD_DISK_REGRESSION');
  const cpuMicros = delta(
    last.cpuUserMicros + last.cpuSystemMicros,
    first.cpuUserMicros + first.cpuSystemMicros,
    'PRODUCTION_SWAP_LOAD_CPU_REGRESSION',
  );
  const peakRssBytes = Math.max(...observations.map(observation => observation.rssBytes));
  const peakRamBps = Math.ceil((peakRssBytes * 10_000) / totalRamBytes);
  const status = peakRamBps >= config.hardRamBps || duplicates > 0 || lost > 0
    ? 'hard-stop'
    : peakRamBps >= config.warningRamBps || rejected > 0
      ? 'warning'
      : 'green';
  const latencyHistogram = mergeLatencyHistograms(observations);
  return {
    offeredRate,
    completedTps: perSecond(completed, elapsedMs),
    offered,
    completed,
    rejected,
    duplicates,
    lost,
    latencyMs: {
      p50: histogramPercentile(latencyHistogram, 0.5),
      p95: histogramPercentile(latencyHistogram, 0.95),
      p99: histogramPercentile(latencyHistogram, 0.99),
    },
    queueSlopePerSecond: perSecond(last.queueDepth - first.queueDepth, elapsedMs),
    rssGrowthBytesPerSecond: perSecond(last.rssBytes - first.rssBytes, elapsedMs),
    averageCpuCores: Math.round((cpuMicros / (elapsedMs * 1_000)) * 1_000) / 1_000,
    peakRssBytes,
    peakRamBps,
    diskGrowthBytes,
    startHeight: first.runtimeHeight,
    endHeight: last.runtimeHeight,
    startRoot: first.canonicalStateHash,
    endRoot: last.canonicalStateHash,
    stagesMs: mergeStages(observations),
    status,
  };
};

export const assertExactCrashRecovery = (
  before: Pick<ProductionSwapLoadObservation, 'runtimeHeight' | 'canonicalStateHash'>,
  after: Pick<ProductionSwapLoadObservation, 'runtimeHeight' | 'canonicalStateHash'>,
): void => {
  if (before.runtimeHeight !== after.runtimeHeight || before.canonicalStateHash !== after.canonicalStateHash) {
    throw new Error(
      `PRODUCTION_SWAP_LOAD_CRASH_ROOT_MISMATCH:` +
      `before=${before.runtimeHeight}:${before.canonicalStateHash}:` +
      `after=${after.runtimeHeight}:${after.canonicalStateHash}`,
    );
  }
};
