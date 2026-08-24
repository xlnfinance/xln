import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  decodeReleaseManifest,
  decodeReleaseSnapshot,
} from '../../../frontend/src/lib/releases/release-catalog';
import {
  deriveReleaseChartPath,
  deriveReleaseChartPoints,
  formatReleaseMetric,
  getReleaseScopes,
} from '../../../frontend/src/lib/releases/release-chart';
import {
  verifyReleaseManifestEntry,
  verifyReleaseManifestPolicy,
  verifyReleaseManifestSnapshotBinding,
} from '../../../frontend/src/lib/releases/release-signature';

const ROOT = resolve(import.meta.dir, '../../..');
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as unknown;

describe('React releases pilot', () => {
  test('decodes and verifies the canonical release catalog', () => {
    const manifest = decodeReleaseManifest(readJson('docs/releases/manifest.json'));
    const latest = manifest.releases.find(({ version }) => version === manifest.latest);
    if (!latest) throw new Error('RELEASE_LATEST_MISSING');
    const snapshot = decodeReleaseSnapshot(readJson(`docs/releases/data/${latest.version}.json`));

    expect(manifest.latest).toBe('0.1.31');
    expect(manifest.releases).toHaveLength(22);
    expect(Object.keys(latest.metrics).length).toBeGreaterThan(5);
    expect(verifyReleaseManifestPolicy({ ...manifest, releases: [...manifest.releases] })).toBe(true);
    expect(verifyReleaseManifestEntry(latest)).toBe(true);
    expect(verifyReleaseManifestSnapshotBinding(latest, snapshot)).toBe(true);
  });

  test('derives deterministic scope ordering and chart geometry', () => {
    const manifest = decodeReleaseManifest(readJson('docs/releases/manifest.json'));
    const scopes = getReleaseScopes(manifest.releases);
    const points = deriveReleaseChartPoints(manifest.releases, 'frontend', 'testCodeRatio');

    expect(scopes.slice(0, 4)).toEqual(['repository', 'runtime', 'jurisdictions', 'frontend']);
    expect(points).toHaveLength(manifest.releases.length);
    expect(points[0]?.release.version).toBe(manifest.releases.at(-1)?.version);
    expect(deriveReleaseChartPath(points)).toStartWith('M ');
    expect(formatReleaseMetric(0.4824, 'testCodeRatio')).toBe('48.2%');
  });

  test('rejects malformed catalog and snapshot boundaries loudly', () => {
    const manifest = readJson('docs/releases/manifest.json');
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('TEST_MANIFEST_INVALID');
    expect(() => decodeReleaseManifest({ ...manifest, injected: true })).toThrow('RELEASE_MANIFEST_EXTRA_FIELD');

    const snapshot = readJson('docs/releases/data/0.1.31.json');
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('TEST_SNAPSHOT_INVALID');
    expect(() => decodeReleaseSnapshot({ ...snapshot, injected: true })).toThrow('RELEASE_SNAPSHOT_EXTRA_FIELD');
  });

  test('keeps both frontends on the shared verified and sanitized loaders', () => {
    const reactSource = readFileSync(resolve(ROOT, 'frontend/apps/site/src/releases-page.tsx'), 'utf8');
    const svelteSource = readFileSync(resolve(ROOT, 'frontend/src/lib/components/Releases/ReleasesView.svelte'), 'utf8');
    const catalogSource = readFileSync(resolve(ROOT, 'frontend/src/lib/releases/release-catalog.ts'), 'utf8');

    expect(reactSource).toContain('fetchVerifiedReleaseManifest');
    expect(reactSource).toContain('fetchReleaseDocument');
    expect(reactSource).toContain('dangerouslySetInnerHTML');
    expect(reactSource).not.toContain('marked.parse');
    expect(svelteSource).toContain("from '$lib/releases/release-catalog'");
    expect(svelteSource).not.toContain('function decodeManifest');
    expect(catalogSource).toContain('sanitizeRenderedHtml');
    expect(catalogSource).toContain('verifyReleaseManifestSnapshotBinding');
  });
});
