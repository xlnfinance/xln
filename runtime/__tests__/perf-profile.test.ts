import { describe, expect, test } from 'bun:test';
import { BoundedPerfMetric, cumulativeMarksToDurations } from '../infra/perf-profile';

describe('runtime performance profiling', () => {
  test('converts cumulative frame marks into non-overlapping stages', () => {
    expect(cumulativeMarksToDurations({ validate: 10, apply: 42, save: 90 }, 100)).toEqual({
      validate: 10,
      apply: 32,
      save: 48,
      remainder: 10,
    });
  });

  test('never fabricates negative stage time from equal or regressed marks', () => {
    expect(cumulativeMarksToDurations({ first: 12, same: 12, regressed: 5 }, 15)).toEqual({
      first: 12,
      same: 0,
      regressed: 0,
      remainder: 3,
    });
  });

  test('keeps bounded histogram statistics without retaining samples', () => {
    const metric = new BoundedPerfMetric();
    for (const value of [1, 5, 10, 100, 1_000]) metric.observe(value);
    expect(metric.summary()).toEqual({
      count: 5,
      avgMs: 223.2,
      minMs: 1,
      p50Ms: 10,
      p95Ms: 1_000,
      p99Ms: 1_000,
      maxMs: 1_000,
      totalMs: 1_116,
    });
  });
});
