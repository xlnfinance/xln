import { getPerfMs } from '../time';
import { isRuntimePerfProfileEnabled } from './runtime-flags';

export type PerfMarks = Record<string, number>;
export type PerfPhase = Readonly<{ name: string; ms: number }>;

export const cumulativeMarksToDurations = (
  marks: PerfMarks,
  totalMs: number,
): PerfMarks => {
  const durations: PerfMarks = {};
  let previousMs = 0;

  for (const [label, rawCumulativeMs] of Object.entries(marks)) {
    if (!Number.isFinite(rawCumulativeMs)) continue;
    const cumulativeMs = Math.max(previousMs, Math.min(totalMs, rawCumulativeMs));
    durations[label] = Math.max(0, cumulativeMs - previousMs);
    previousMs = cumulativeMs;
  }

  durations['remainder'] = Math.max(0, totalMs - previousMs);
  return durations;
};

export const cumulativeMarksToPhases = (
  marks: PerfMarks,
  totalMs: number,
): PerfPhase[] => Object.entries(cumulativeMarksToDurations(marks, totalMs))
  .map(([name, ms]) => ({ name, ms }));

const DEFAULT_PERCENTILE_SAMPLE_LIMIT = 4_096;

export interface PerfMetricSummary {
  count: number;
  avgMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  totalMs: number;
}

export class BoundedPerfMetric {
  private readonly percentileSamples: number[] = [];
  private percentileSampleCursor = 0;
  private sumMs = 0;
  private minimumMs = Number.POSITIVE_INFINITY;
  private maximumMs = 0;
  private sampleCount = 0;
  // Snapshots run per Runtime frame; sorting every metric's 4k-sample window
  // three times per snapshot was measurable Hub CPU. One sort per new sample
  // set, memoized until the next observation.
  private summaryMemo: { sampleCount: number; summary: PerfMetricSummary } | null = null;

  constructor(private readonly percentileSampleLimit = DEFAULT_PERCENTILE_SAMPLE_LIMIT) {
    if (!Number.isSafeInteger(percentileSampleLimit) || percentileSampleLimit <= 0) {
      throw new Error(`PERF_PERCENTILE_SAMPLE_LIMIT_INVALID:${percentileSampleLimit}`);
    }
  }

  observe(rawDurationMs: number): void {
    if (!Number.isFinite(rawDurationMs) || rawDurationMs < 0) return;
    const durationMs = rawDurationMs;
    this.sampleCount += 1;
    this.sumMs += durationMs;
    this.minimumMs = Math.min(this.minimumMs, durationMs);
    this.maximumMs = Math.max(this.maximumMs, durationMs);
    if (this.percentileSamples.length < this.percentileSampleLimit) {
      this.percentileSamples.push(durationMs);
      return;
    }
    this.percentileSamples[this.percentileSampleCursor] = durationMs;
    this.percentileSampleCursor = (this.percentileSampleCursor + 1) % this.percentileSampleLimit;
  }

  summary(): PerfMetricSummary {
    if (this.sampleCount === 0) {
      return { count: 0, avgMs: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, totalMs: 0 };
    }
    if (this.summaryMemo?.sampleCount === this.sampleCount) return this.summaryMemo.summary;
    const sorted = [...this.percentileSamples].sort((left, right) => left - right);
    const percentile = (ratio: number): number => {
      const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
      return sorted[index] ?? this.maximumMs;
    };
    const summary: PerfMetricSummary = {
      count: this.sampleCount,
      avgMs: this.sumMs / this.sampleCount,
      minMs: this.minimumMs,
      p50Ms: percentile(0.50),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: this.maximumMs,
      totalMs: this.sumMs,
    };
    this.summaryMemo = { sampleCount: this.sampleCount, summary };
    return summary;
  }
}

const phaseMetrics = new Map<string, BoundedPerfMetric>();
const phaseCounts = new Map<string, number>();

const profilingLive = (): boolean => isRuntimePerfProfileEnabled(
  'XLN_ENTITY_FRAME_PROFILE',
  'XLN_RUNTIME_APPLY_PROFILE',
);

const observePerfPhase = (name: string, durationMs: number): void => {
  if (!profilingLive()) return;
  let metric = phaseMetrics.get(name);
  if (!metric) {
    metric = new BoundedPerfMetric();
    phaseMetrics.set(name, metric);
  }
  metric.observe(durationMs);
};

export const observePerfCount = (name: string, delta = 1): void => {
  if (!profilingLive() || !Number.isSafeInteger(delta) || delta === 0) return;
  phaseCounts.set(name, (phaseCounts.get(name) ?? 0) + delta);
};

export const timePerfPhase = <T>(name: string, fn: () => T): T => {
  if (!profilingLive()) return fn();
  const startedAt = getPerfMs();
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => {
        observePerfPhase(name, getPerfMs() - startedAt);
      }) as T;
    }
    observePerfPhase(name, getPerfMs() - startedAt);
    return result;
  } catch (error) {
    observePerfPhase(name, getPerfMs() - startedAt);
    throw error;
  }
};

export const snapshotPerfPhases = (): Readonly<{
  phases: Record<string, PerfMetricSummary>;
  counts: Record<string, number>;
}> => {
  const phases: Record<string, PerfMetricSummary> = {};
  for (const [name, metric] of phaseMetrics) phases[name] = metric.summary();
  return { phases, counts: Object.fromEntries(phaseCounts) };
};

export const resetPerfPhases = (): void => {
  phaseMetrics.clear();
  phaseCounts.clear();
};
