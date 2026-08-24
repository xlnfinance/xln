import { useMemo, type ChangeEvent, type KeyboardEvent } from 'react';

import {
  RELEASE_METRICS,
  type ReleaseEntry,
  type ReleaseMetricKey,
} from '$lib/releases/release-catalog';
import {
  deriveReleaseChartPath,
  deriveReleaseChartPoints,
  formatReleaseMetric,
  getReleaseMetricValue,
  getReleaseScopes,
} from '$lib/releases/release-chart';

type ReleaseChartProps = Readonly<{
  releases: readonly ReleaseEntry[];
  selectedRelease: ReleaseEntry;
  selectedMetric: ReleaseMetricKey;
  selectedScope: string;
  onMetricChange: (metric: ReleaseMetricKey) => void;
  onScopeChange: (scope: string) => void;
  onSelectRelease: (release: ReleaseEntry) => void;
}>;

export function ReleaseChart({ releases, selectedRelease, selectedMetric, selectedScope, onMetricChange, onScopeChange, onSelectRelease }: ReleaseChartProps) {
  const scopes = useMemo(() => getReleaseScopes(releases), [releases]);
  const points = useMemo(() => deriveReleaseChartPoints(releases, selectedScope, selectedMetric), [releases, selectedMetric, selectedScope]);
  const path = useMemo(() => deriveReleaseChartPath(points), [points]);
  const selectMetric = (event: ChangeEvent<HTMLSelectElement>): void => {
    const metric = RELEASE_METRICS.find(({ key }) => key === event.currentTarget.value)?.key;
    if (!metric) throw new Error('RELEASE_METRIC_INVALID');
    onMetricChange(metric);
  };
  const selectScope = (event: ChangeEvent<HTMLSelectElement>): void => onScopeChange(event.currentTarget.value);
  const handlePointKey = (event: KeyboardEvent<SVGGElement>, release: ReleaseEntry): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelectRelease(release);
  };
  return (
    <section className="release-metrics" aria-label="Release metric history">
      <div className="release-metric-controls">
        <label><span>Metric</span><select value={selectedMetric} onChange={selectMetric}>{RELEASE_METRICS.map((metric) => <option value={metric.key} key={metric.key}>{metric.label}</option>)}</select></label>
        <label><span>Scope</span><select value={selectedScope} onChange={selectScope}>{scopes.map((scope) => <option value={scope} key={scope}>{scope === 'repository' ? 'Entire repository' : `${scope}/`}</option>)}</select></label>
        <div><span>Selected value</span><strong>{formatReleaseMetric(getReleaseMetricValue(selectedRelease, selectedScope, selectedMetric), selectedMetric)}</strong></div>
      </div>
      <div className="release-chart-scroll">
        <svg className="release-chart" viewBox="0 0 760 200" role="img" aria-label={`${selectedMetric} history for ${selectedScope}`}>
          <line x1="44" y1="158" x2="716" y2="158" className="axis" />
          <path d={path} className="trend" />
          {points.map((point, index) => {
            const selected = point.release.version === selectedRelease.version;
            const labelled = index === 0 || index === points.length - 1 || index % 5 === 0;
            return <g aria-label={`${point.release.version}: ${formatReleaseMetric(point.value, selectedMetric)}`} className={`point${selected ? ' is-selected' : ''}${labelled ? ' is-labelled' : ''}`} key={point.release.version} onClick={() => onSelectRelease(point.release)} onKeyDown={(event) => handlePointKey(event, point.release)} role="button" tabIndex={0}><circle cx={point.x} cy={point.y} r={selected ? 6 : 4} /><text x={point.x} y={point.y - 13} textAnchor="middle" className="point-value">{formatReleaseMetric(point.value, selectedMetric)}</text><text x={point.x} y="184" textAnchor="middle" className="point-label">{point.release.version}</text></g>;
          })}
        </svg>
      </div>
    </section>
  );
}
