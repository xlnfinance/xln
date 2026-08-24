import type { ReleaseEntry, ReleaseMetricKey } from './release-catalog';

export type ReleaseChartPoint = Readonly<{
  release: ReleaseEntry;
  value: number;
  x: number;
  y: number;
}>;

const SCOPE_PRIORITY = ['runtime', 'jurisdictions', 'frontend'] as const;

export const getReleaseScopes = (releases: readonly ReleaseEntry[]): readonly string[] => {
  const names = new Set<string>();
  for (const release of releases) {
    for (const name of Object.keys(release.modules)) names.add(name);
  }
  return ['repository', ...[...names].sort((left, right) => {
    const leftIndex = SCOPE_PRIORITY.indexOf(left as typeof SCOPE_PRIORITY[number]);
    const rightIndex = SCOPE_PRIORITY.indexOf(right as typeof SCOPE_PRIORITY[number]);
    if (leftIndex !== rightIndex) return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
    return left.localeCompare(right);
  })];
};

export const getReleaseMetricValue = (
  release: ReleaseEntry,
  scope: string,
  metric: ReleaseMetricKey,
): number => Number((scope === 'repository' ? release.metrics : release.modules[scope])?.[metric] ?? 0);

export const deriveReleaseChartPoints = (
  releases: readonly ReleaseEntry[],
  scope: string,
  metric: ReleaseMetricKey,
): readonly ReleaseChartPoint[] => {
  const values = [...releases].reverse().map((release) => ({ release, value: getReleaseMetricValue(release, scope, metric) }));
  const maximum = Math.max(...values.map(({ value }) => value), 1);
  const minimum = Math.min(...values.map(({ value }) => value), 0);
  const spread = Math.max(maximum - minimum, 1);
  const chartLeft = values.length <= 3 ? 132 : 44;
  const chartWidth = values.length <= 3 ? 496 : 672;
  return values.map((point, index) => ({
    ...point,
    x: values.length === 1 ? 380 : chartLeft + (index * (chartWidth / Math.max(values.length - 1, 1))),
    y: 158 - (((point.value - minimum) / spread) * 112),
  }));
};

export const deriveReleaseChartPath = (points: readonly ReleaseChartPoint[]): string => points
  .map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`)
  .join(' ');

export const formatReleaseMetric = (value: number, metric: ReleaseMetricKey): string => metric === 'testCodeRatio'
  ? `${(value * 100).toFixed(1)}%`
  : Math.round(value).toLocaleString('en-US');
