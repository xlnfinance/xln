import type { QaHistoryEntry } from './types';

export type QaPerformanceMetric = 'wall' | 'cpu' | 'rss' | 'load';

export type QaPerformanceTrend = {
  metric: QaPerformanceMetric;
  label: string;
  unit: string;
  points: string;
  samples: number;
  latest: number;
  first: number;
  deltaPct: number;
  improved: boolean;
};

const metricValue = (row: QaHistoryEntry, metric: QaPerformanceMetric): number | null => {
  const value = metric === 'wall'
    ? row.totalMs
    : metric === 'cpu'
      ? row.childCpuP95Pct ?? row.maxChildCpuPct
      : metric === 'rss'
        ? row.maxChildRssKb === null ? null : row.maxChildRssKb / 1024
        : row.peakLoad1;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};

const metricMeta: Record<QaPerformanceMetric, { label: string; unit: string }> = {
  wall: { label: 'Run wall', unit: 'ms' },
  cpu: { label: 'Child CPU p95', unit: '%' },
  rss: { label: 'Child RSS peak', unit: 'MiB' },
  load: { label: 'Host load peak', unit: '' },
};

export const buildQaPerformanceTrend = (
  history: readonly QaHistoryEntry[],
  metric: QaPerformanceMetric,
  limit = 20,
): QaPerformanceTrend | null => {
  const values = [...history]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(row => metricValue(row, metric))
    .filter((value): value is number => value !== null)
    .slice(-Math.max(2, Math.floor(limit)));
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(Number.EPSILON, max - min);
  const width = 240;
  const height = 72;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const first = values[0]!;
  const latest = values.at(-1)!;
  const deltaPct = first === 0 ? (latest === 0 ? 0 : 100) : ((latest - first) / first) * 100;
  return {
    metric,
    ...metricMeta[metric],
    points,
    samples: values.length,
    latest,
    first,
    deltaPct,
    improved: latest <= first,
  };
};

export const buildQaPerformanceTrends = (
  history: readonly QaHistoryEntry[],
): QaPerformanceTrend[] => (['wall', 'cpu', 'rss', 'load'] as const)
  .map(metric => buildQaPerformanceTrend(history, metric))
  .filter((trend): trend is QaPerformanceTrend => trend !== null);
