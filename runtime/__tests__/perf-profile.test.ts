import { describe, expect, test } from 'bun:test';
import {
  BoundedPerfMetric,
  cumulativeMarksToDurations,
  cumulativeMarksToPhases,
} from '../infra/perf-profile';
import { asDurationMs, parseProfileLine } from '../scripts/analyze-runtime-perf';

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

  test('emits ordered phase deltas without ambiguous equal cumulative marks', () => {
    expect(cumulativeMarksToPhases({ first: 12, same: 12, apply: 15 }, 20)).toEqual([
      { name: 'first', ms: 12 },
      { name: 'same', ms: 0 },
      { name: 'apply', ms: 3 },
      { name: 'remainder', ms: 5 },
    ]);
  });

  test('reports exact percentiles for a bounded sample window', () => {
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

  test('does not inflate incident percentiles to histogram bucket ceilings', () => {
    const metric = new BoundedPerfMetric();
    for (const value of [25_000, 42_700, 66_800]) metric.observe(value);
    expect(metric.summary()).toMatchObject({
      p50Ms: 42_700,
      p95Ms: 66_800,
      maxMs: 66_800,
    });
  });

  test('bounds percentile memory to the latest configured samples', () => {
    const metric = new BoundedPerfMetric(3);
    for (const value of [1, 2, 100, 200]) metric.observe(value);
    expect(metric.summary()).toMatchObject({
      count: 4,
      avgMs: 75.75,
      minMs: 1,
      p50Ms: 100,
      p95Ms: 200,
      maxMs: 200,
    });
  });

  test('parses orchestrator stdout, stderr, and nested supervisor prefixes', () => {
    const payload = '{"elapsedMs":12,"phases":[{"name":"apply","ms":12}]}';
    expect(parseProfileLine(`[MM] [INFO][runtime] process.profile ${payload}`)?.runtime).toBe('MM');
    expect(parseProfileLine(`[MM] [WARN][runtime] process.profile ${payload}`)?.runtime).toBe('MM');
    expect(parseProfileLine(`[MM:err] [WARN][runtime] process.profile ${payload}`)?.runtime).toBe('MM');
    expect(parseProfileLine(`[STACK] [MESH] [H1] [WARN][runtime] process.profile ${payload}`)?.runtime).toBe('H1');
  });

  test('accepts only real finite numeric durations', () => {
    expect(asDurationMs(12.5)).toBe(12.5);
    for (const value of [null, true, false, '12', Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(asDurationMs(value)).toBeUndefined();
    }
  });
});
