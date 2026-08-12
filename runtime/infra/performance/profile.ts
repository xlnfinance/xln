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
    const sorted = [...this.percentileSamples].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
    return sorted[index] ?? this.maximumMs;
  }
}
