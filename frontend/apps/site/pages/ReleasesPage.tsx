import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import {
  requiresFoundationAttestation,
  verifyReleaseManifestPolicy,
  verifyReleaseManifestSnapshotBinding,
  type ReleaseManifestClaim,
  type ReleaseManifestPolicyClaim,
  type ReleaseSnapshotClaim,
} from '$lib/releases/release-signature';
import { renderSafeMarkdown } from '$lib/security/safe-markdown';

import './releases.css';

type Metrics = Readonly<{ code: number; complexity: number; files: number; testCode: number; testCodeRatio: number }>;
type ReleaseEntry = Omit<ReleaseManifestClaim, 'metrics' | 'modules'> & Readonly<{ metrics: Metrics; modules: Record<string, Metrics> }>;
type Manifest = Omit<ReleaseManifestPolicyClaim, 'schemaVersion' | 'releases'> & Readonly<{ schemaVersion: 1; releases: ReleaseEntry[] }>;
type MetricKey = keyof Metrics;

const METRICS: readonly Readonly<{ key: MetricKey; label: string }>[] = [
  { key: 'code', label: 'Code LOC' },
  { key: 'complexity', label: 'Complexity' },
  { key: 'files', label: 'Files' },
  { key: 'testCode', label: 'Test LOC' },
  { key: 'testCodeRatio', label: 'Test / source' },
];

const formatMetric = (key: MetricKey, value: number): string => key === 'testCodeRatio'
  ? `${(value * 100).toFixed(1)}%`
  : Math.round(value).toLocaleString('en-US');

const fetchJson = async <T,>(url: string, signal: AbortSignal): Promise<T> => {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`RELEASE_REQUEST_FAILED:${response.status}:${url}`);
  return await response.json() as T;
};

const verificationLabel = (release: ReleaseEntry): string => requiresFoundationAttestation(release.version)
  ? 'Foundation code root verified'
  : 'Historical catalog entry';

export default function ReleasesPage() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('code');
  const [selectedScope, setSelectedScope] = useState('repository');
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const loaded = await fetchJson<Manifest>('/docs-catalog/releases/manifest.json', controller.signal);
        if (!verifyReleaseManifestPolicy(loaded)) throw new Error('INVALID_FOUNDATION_HANKO:manifest_policy');
        await Promise.all(loaded.releases.map(async release => {
          const snapshot = await fetchJson<ReleaseSnapshotClaim>(release.snapshot, controller.signal);
          if (!verifyReleaseManifestSnapshotBinding(release, snapshot)) {
            throw new Error(`INVALID_FOUNDATION_HANKO:${release.version}`);
          }
        }));
        if (!controller.signal.aborted) {
          setManifest(loaded);
          setSelectedVersion(loaded.latest);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!manifest || !selectedVersion) return;
    const release = manifest.releases.find(entry => entry.version === selectedVersion);
    if (!release) throw new Error(`RELEASE_SELECTION_UNKNOWN:${selectedVersion}`);
    const controller = new AbortController();
    const loadMarkdown = async (): Promise<void> => {
      try {
        const response = await fetch(release.markdown, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`RELEASE_DOCUMENT_FAILED:${response.status}:${release.version}`);
        const text = await response.text();
        if (!controller.signal.aborted) setMarkdown(renderSafeMarkdown(text));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void loadMarkdown();
    return () => controller.abort();
  }, [manifest, selectedVersion]);

  const selectedRelease = manifest?.releases.find(release => release.version === selectedVersion) ?? null;
  const scopes = useMemo(() => {
    const values = new Set<string>();
    manifest?.releases.forEach(release => Object.keys(release.modules).forEach(name => values.add(name)));
    const priority = ['runtime', 'jurisdictions', 'frontend'];
    return ['repository', ...[...values].sort((left, right) => {
      const li = priority.indexOf(left);
      const ri = priority.indexOf(right);
      return li === ri ? left.localeCompare(right) : (li < 0 ? 999 : li) - (ri < 0 ? 999 : ri);
    })];
  }, [manifest]);
  const chartPoints = useMemo(() => {
    const releases = [...(manifest?.releases ?? [])].reverse();
    const values = releases.map(release => ({ release, value: Number((selectedScope === 'repository' ? release.metrics : release.modules[selectedScope])?.[selectedMetric] ?? 0) }));
    const maximum = Math.max(...values.map(point => point.value), 1);
    const minimum = Math.min(...values.map(point => point.value), 0);
    const spread = Math.max(maximum - minimum, 1);
    const chartLeft = values.length <= 3 ? 132 : 44;
    const chartWidth = values.length <= 3 ? 496 : 672;
    return values.map((point, index) => ({ ...point, x: values.length === 1 ? 380 : chartLeft + index * (chartWidth / Math.max(values.length - 1, 1)), y: 158 - ((point.value - minimum) / spread) * 112 }));
  }, [manifest, selectedMetric, selectedScope]);
  const chartPath = chartPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

  const selectRelease = (version: string): void => {
    setError('');
    setMarkdown('');
    setSelectedVersion(version);
  };
  const handleChartKey = (event: KeyboardEvent<SVGGElement>, version: string): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectRelease(version);
  };

  return (
    <div className="react-releases">
      <header className="release-header-react"><div><p>verified engineering record</p><h1>Releases</h1></div>{selectedRelease ? <div className="release-identity-react"><strong>{selectedRelease.tag}</strong><span>{selectedRelease.sourceCommit.slice(0, 12)}</span><span className="verified">◆ {verificationLabel(selectedRelease)}</span></div> : null}</header>
      {loading ? <p className="release-state" role="status">Verifying release history…</p> : null}
      {!loading && error ? <section className="release-failure" role="alert"><strong>Release verification stopped</strong><code>{error}</code><p>No unverified release data has been rendered.</p></section> : null}
      {!loading && !error && manifest && selectedRelease ? <>
        <section className="metrics-band-react" aria-label="Release metric history">
          <div className="metric-controls-react"><label><span>Metric</span><select value={selectedMetric} onChange={event => setSelectedMetric(event.currentTarget.value as MetricKey)}>{METRICS.map(metric => <option value={metric.key} key={metric.key}>{metric.label}</option>)}</select></label><label><span>Scope</span><select value={selectedScope} onChange={event => setSelectedScope(event.currentTarget.value)}>{scopes.map(scope => <option value={scope} key={scope}>{scope === 'repository' ? 'Entire repository' : `${scope}/`}</option>)}</select></label><div><span>Current</span><strong>{formatMetric(selectedMetric, Number((selectedScope === 'repository' ? selectedRelease.metrics : selectedRelease.modules[selectedScope])?.[selectedMetric] ?? 0))}</strong></div></div>
          <div className="release-chart-scroll"><svg viewBox="0 0 760 200" role="img" aria-label={`${selectedMetric} history for ${selectedScope}`}><line x1="44" y1="158" x2="716" y2="158" className="axis"/><path d={chartPath} className="trend"/>{chartPoints.map((point, index) => {
            const selected = point.release.version === selectedVersion;
            const labeled = selected || index === 0 || index === chartPoints.length - 1 || index % 5 === 0;
            return <g className={selected ? 'point selected' : 'point'} onClick={() => selectRelease(point.release.version)} onKeyDown={event => handleChartKey(event, point.release.version)} role="button" tabIndex={0} key={point.release.version}><circle cx={point.x} cy={point.y} r={selected ? 6 : 4}/>{labeled ? <><text x={point.x} y={point.y - 13} textAnchor="middle" className="point-value">{formatMetric(selectedMetric, point.value)}</text><text x={point.x} y="184" textAnchor="middle" className="point-label">{point.release.version}</text></> : null}</g>;
          })}</svg></div>
        </section>
        <div className="release-layout-react">
          <aside aria-label="Release versions">{manifest.releases.map(release => <button type="button" className={release.version === selectedVersion ? 'active' : undefined} onClick={() => selectRelease(release.version)} key={release.version}><strong>{release.version}</strong><span>{new Date(release.generatedAt).toLocaleDateString('en-CA')}</span></button>)}</aside>
          <main className="release-document-react"><div className="document-actions-react"><span>commit {selectedRelease.sourceCommit.slice(0, 12)}</span><a href={selectedRelease.snapshot} target="_blank" rel="noreferrer">Raw verified snapshot ↗</a></div>{markdown ? <article className="release-markdown" dangerouslySetInnerHTML={{ __html: markdown }} /> : <p className="release-state">Loading signed release notes…</p>}</main>
        </div>
      </> : null}
    </div>
  );
}
