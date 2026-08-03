import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyFrontendReleaseTree } from '../../scripts/deployment/frontend-release-files';
import {
  parseFrontendReleaseManifest,
  validateFrontendReleaseManifest,
} from '../../scripts/deployment/frontend-release-schema';
import {
  buildFixtureRelease,
  readFixtureManifestText,
} from './frontend-release-fixture';

const COMMIT_A = 'a'.repeat(40);

const withTempRoot = (run: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'xln-frontend-release-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('frontend release manifest', () => {
  test('builds and verifies one strict four-surface release', () => withTempRoot(root => {
    const { manifest, releaseRoot } = buildFixtureRelease(root, 'A', COMMIT_A, '1.2.3');
    expect(validateFrontendReleaseManifest(manifest)).toEqual([]);
    expect(() => verifyFrontendReleaseTree(releaseRoot, manifest)).not.toThrow();
    expect(Object.keys(manifest.surfaces).sort()).toEqual(['docs', 'ops', 'site', 'wallet']);
    expect(manifest.nativeTargets.desktop.surfaces).toEqual(['wallet']);
  }));

  test('is byte-identical for unchanged inputs', () => withTempRoot(root => {
    const first = buildFixtureRelease(join(root, 'first'), 'same', COMMIT_A, '1.2.3');
    const second = buildFixtureRelease(join(root, 'second'), 'same', COMMIT_A, '1.2.3');
    expect(readFixtureManifestText(first.releaseRoot)).toBe(readFixtureManifestText(second.releaseRoot));
  }));

  test('rejects altered and unexpected files', () => withTempRoot(root => {
    const { manifest, releaseRoot } = buildFixtureRelease(root, 'A', COMMIT_A, '1.2.3');
    writeFileSync(join(releaseRoot, 'wallet/index.html'), 'corrupt');
    expect(() => verifyFrontendReleaseTree(releaseRoot, manifest))
      .toThrow('FRONTEND_RELEASE_ASSET_INVENTORY_MISMATCH:wallet');
    writeFileSync(join(releaseRoot, 'unexpected.txt'), 'unexpected');
    expect(() => verifyFrontendReleaseTree(releaseRoot, manifest))
      .toThrow('FRONTEND_RELEASE_ROOT_ENTRY_UNKNOWN:unexpected.txt');
  }));

  test('rejects unknown, missing, mixed, duplicate, and unsafe manifest fields', () => withTempRoot(root => {
    const { releaseRoot } = buildFixtureRelease(root, 'A', COMMIT_A, '1.2.3');
    const valid = JSON.parse(readFixtureManifestText(releaseRoot)) as Record<string, unknown>;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unknown', { ...valid, unexpected: true }],
      ['missing', { ...valid, surfaces: { ...(valid['surfaces'] as object), ops: undefined } }],
      ['unsafe release', { ...valid, releaseId: '../escape' }],
    ];
    const surfaces = valid['surfaces'] as Record<string, Record<string, unknown>>;
    const wallet = surfaces['wallet'];
    if (!wallet) throw new Error('TEST_FIXTURE_WALLET_MISSING');
    cases.push(['mixed', { ...valid, surfaces: { ...surfaces, wallet: { ...surfaces['wallet'], sourceCommit: 'b'.repeat(40) } } }]);
    cases.push(['version mismatch', { ...valid, surfaces: { ...surfaces, docs: { ...surfaces['docs'], productVersion: '9.9.9' } } }]);
    const walletAssets = wallet['assets'] as Array<Record<string, unknown>>;
    const firstWalletAsset = walletAssets[0];
    if (!firstWalletAsset) throw new Error('TEST_FIXTURE_WALLET_ASSET_MISSING');
    cases.push(['unsafe asset', {
      ...valid,
      surfaces: {
        ...surfaces,
        wallet: { ...wallet, assets: [{ ...firstWalletAsset, path: '../escape.js' }, ...walletAssets.slice(1)] },
      },
    }]);
    cases.push(['duplicate asset', {
      ...valid,
      surfaces: {
        ...surfaces,
        wallet: { ...wallet, assets: [...walletAssets, firstWalletAsset] },
      },
    }]);
    cases.push(['duplicate output', { ...valid, surfaces: { ...surfaces, wallet: { ...surfaces['wallet'], outputRoot: 'site' } } }]);
    cases.forEach(([label, value]) => {
      expect(validateFrontendReleaseManifest(value).length, label).toBeGreaterThan(0);
    });
  }));

  test('parsing fails loudly when a required surface is absent', () => withTempRoot(root => {
    const { releaseRoot } = buildFixtureRelease(root, 'A', COMMIT_A, '1.2.3');
    const parsed = JSON.parse(readFileSync(join(releaseRoot, 'release-manifest.json'), 'utf8')) as Record<string, unknown>;
    const surfaces = parsed['surfaces'] as Record<string, unknown>;
    delete surfaces['docs'];
    expect(() => parseFrontendReleaseManifest(JSON.stringify(parsed)))
      .toThrow('FRONTEND_RELEASE_MANIFEST_INVALID');
  }));

  test('rejects a native target whose declared wallet asset is absent', () => withTempRoot(root => {
    const { manifest, releaseRoot } = buildFixtureRelease(root, 'A', COMMIT_A, '1.2.3');
    const invalid = {
      ...manifest,
      nativeTargets: {
        ...manifest.nativeTargets,
        desktop: {
          ...manifest.nativeTargets.desktop,
          requiredAssets: [...manifest.nativeTargets.desktop.requiredAssets, 'missing-native-input.js'],
        },
      },
    };
    expect(() => verifyFrontendReleaseTree(releaseRoot, invalid))
      .toThrow('FRONTEND_NATIVE_ASSET_MISSING:desktop:missing-native-input.js');
  }));
});
