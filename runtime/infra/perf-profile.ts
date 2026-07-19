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

const HISTOGRAM_BOUNDS_MS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  1_000, 2_000, 5_000, 10_000, 20_000, 30_000,
  40_000, 45_000, 50_000, 60_000, 70_000, 80_000, 90_000,
  120_000, 300_000, 600_000, Number.POSITIVE_INFINITY,
] as const;

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
  private readonly buckets = HISTOGRAM_BOUNDS_MS.map(() => 0);
  private sumMs = 0;
  private minimumMs = Number.POSITIVE_INFINITY;
  private maximumMs = 0;
  private sampleCount = 0;

  observe(rawDurationMs: number): void {
    if (!Number.isFinite(rawDurationMs) || rawDurationMs < 0) return;
    const durationMs = rawDurationMs;
    this.sampleCount += 1;
    this.sumMs += durationMs;
    this.minimumMs = Math.min(this.minimumMs, durationMs);
    this.maximumMs = Math.max(this.maximumMs, durationMs);
    const bucketIndex = HISTOGRAM_BOUNDS_MS.findIndex(bound => durationMs <= bound);
    const resolvedBucketIndex = bucketIndex < 0 ? this.buckets.length - 1 : bucketIndex;
    this.buckets[resolvedBucketIndex] = (this.buckets[resolvedBucketIndex] ?? 0) + 1;
  }

  summary(): PerfMetricSummary {
    if (this.sampleCount === 0) {
      return { count: 0, avgMs: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, totalMs: 0 };
    }
    return {
      count: this.sampleCount,
      avgMs: this.sumMs / this.sampleCount,
      minMs: this.minimumMs,
      p50Ms: this.percentile(0.50),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      maxMs: this.maximumMs,
      totalMs: this.sumMs,
    };
  }

  private percentile(ratio: number): number {
    const target = Math.max(1, Math.ceil(this.sampleCount * ratio));
    let seen = 0;
    for (let index = 0; index < this.buckets.length; index += 1) {
      seen += this.buckets[index]!;
      if (seen >= target) {
        const bound = HISTOGRAM_BOUNDS_MS[index]!;
        return Number.isFinite(bound) ? bound : this.maximumMs;
      }
    }
    return this.maximumMs;
  }
}
