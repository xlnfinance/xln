import { describe, expect, test } from 'bun:test';

import { buildQaPerformanceTrend } from '../../frontend/src/lib/qa/performanceTrend';
import type { QaHistoryEntry } from '../../frontend/src/lib/qa/types';

const row = (
  runId: string,
  createdAt: number,
  values: Partial<QaHistoryEntry>,
): QaHistoryEntry => ({
  runId,
  createdAt,
  completedAt: createdAt + 1,
  status: 'passed',
  totalMs: 0,
  totalShards: 1,
  passedShards: 1,
  failedShards: 0,
  gitHead: null,
  gitBranch: null,
  dirty: false,
  codeHash: null,
  avgLoad1: null,
  peakLoad1: null,
  maxChildCpuPct: null,
  maxChildRssKb: null,
  suiteKey: null,
  benchmarkStatus: null,
  benchmarkDeltaPct: null,
  benchmarkComparedRunId: null,
  browserIssueCount: 0,
  browserErrorCount: 0,
  browserWarningCount: 0,
  networkFailureCount: 0,
  httpErrorCount: 0,
  childCpuP95Pct: null,
  avgShardMs: null,
  maxShardMs: null,
  bootstrapMs: null,
  apiHealthyMs: null,
  playwrightMs: null,
  phaseP95: null,
  logsDir: '',
  ...values,
});

describe('QA performance trend', () => {
  test('orders runs chronologically and reports lower wall time as improvement', () => {
    const trend = buildQaPerformanceTrend([
      row('new', 2, { totalMs: 500 }),
      row('old', 1, { totalMs: 1_000 }),
    ], 'wall');
    expect(trend?.first).toBe(1_000);
    expect(trend?.latest).toBe(500);
    expect(trend?.deltaPct).toBe(-50);
    expect(trend?.improved).toBeTrue();
    expect(trend?.points.split(' ')).toHaveLength(2);
  });

  test('converts RSS from KiB to MiB and ignores absent samples', () => {
    const trend = buildQaPerformanceTrend([
      row('none', 1, {}),
      row('old', 2, { maxChildRssKb: 2_048 }),
      row('new', 3, { maxChildRssKb: 1_024 }),
    ], 'rss');
    expect(trend?.first).toBe(2);
    expect(trend?.latest).toBe(1);
    expect(trend?.samples).toBe(2);
  });
});
