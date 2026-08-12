import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectReleaseAssets } from '../../scripts/release/build-release-manifest.ts';

const VERSION = '0.1.31';
const EXACT_ASSETS = [
  `xlnfinance-${VERSION}.tgz`,
  `xln-finance-${VERSION}-mac-arm64-signed-notarized.zip`,
  `xln-finance-chrome-${VERSION}.zip`,
  `xln-finance-${VERSION}-android-release-signed.apk`,
] as const;

const fixture = (names: readonly string[]): string => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-release-assets-'));
  for (const name of names) {
    const artifactPath = join(directory, name);
    writeFileSync(artifactPath, name);
    const sha256 = createHash('sha256').update(name).digest('hex');
    if (name.endsWith('-android-release-signed.apk')) {
      writeFileSync(`${artifactPath}.release-proof.json`, JSON.stringify({
        schema: 'xln:native-release-proof',
        artifact: name,
        sha256,
        version: VERSION,
        platform: 'android',
        release: true,
        signed: true,
        notarized: false,
        debuggable: false,
        signerCertificateSha256: 'ab'.repeat(32),
      }));
    }
    if (name.endsWith('-signed-notarized.zip') && name.includes('-mac-')) {
      writeFileSync(`${artifactPath}.release-proof.json`, JSON.stringify({
        schema: 'xln:native-release-proof',
        artifact: name,
        sha256,
        version: VERSION,
        platform: name.includes('-arm64-') ? 'macos-arm64' : 'macos-x64',
        release: true,
        signed: true,
        notarized: true,
        debuggable: false,
        teamId: 'TEAMID1234',
        codesignIdentity: 'Developer ID Application: xln finance (TEAMID1234)',
      }));
    }
  }
  return directory;
};

describe('release asset manifest', () => {
  test('binds exactly one artifact for every required distribution', () => {
    const directory = fixture(EXACT_ASSETS);
    try {
      const assets = collectReleaseAssets(directory, VERSION);
      expect(assets.map(asset => asset.kind).sort()).toEqual(['android', 'chrome', 'desktop', 'launcher']);
      expect(assets.every(asset => asset.bytes > 0 && asset.sha256.length === 64)).toBe(true);
      expect(assets.find(asset => asset.kind === 'android')?.releaseProof).toMatchObject({
        signed: true,
        notarized: false,
        debuggable: false,
      });
      expect(assets.find(asset => asset.kind === 'desktop')?.releaseProof).toMatchObject({
        signed: true,
        notarized: true,
        debuggable: false,
      });

      writeFileSync(join(directory, `notes-${VERSION}.txt`), 'unclassified');
      expect(() => collectReleaseAssets(directory, VERSION)).toThrow('RELEASE_ASSET_UNCLASSIFIED');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects missing and duplicate distribution kinds', () => {
    const missing = fixture(EXACT_ASSETS.filter(name => !name.includes('chrome')));
    const duplicate = fixture([...EXACT_ASSETS, `xlnfinance-extra-${VERSION}.tgz`]);
    const collision = fixture(EXACT_ASSETS);
    try {
      mkdirSync(join(collision, 'nested'));
      writeFileSync(join(collision, 'nested', EXACT_ASSETS[0]), 'collision');
      expect(() => collectReleaseAssets(missing, VERSION)).toThrow('RELEASE_ASSET_KIND_COUNT:chrome:0');
      expect(() => collectReleaseAssets(duplicate, VERSION)).toThrow('RELEASE_ASSET_KIND_COUNT:launcher:2');
      expect(() => collectReleaseAssets(collision, VERSION)).toThrow('RELEASE_ASSET_NAME_COLLISION');
    } finally {
      rmSync(missing, { recursive: true, force: true });
      rmSync(duplicate, { recursive: true, force: true });
      rmSync(collision, { recursive: true, force: true });
    }
  });

  test('rejects debug, unsigned, and ambiguously named native artifacts', () => {
    for (const unsafeName of [
      `xln-finance-${VERSION}-android-debug.apk`,
      `xln-finance-${VERSION}-android-release.apk`,
      `xln-finance-${VERSION}-mac-arm64.zip`,
      `xln-finance-${VERSION}-mac-arm64-signed.zip`,
    ]) {
      const directory = fixture(EXACT_ASSETS.map(name => name.includes('android-release-signed.apk')
        ? unsafeName
        : name));
      try {
        expect(() => collectReleaseAssets(directory, VERSION)).toThrow('RELEASE_ASSET_UNCLASSIFIED');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test('binds native release proof to bytes and rejects fabricated trust evidence', () => {
    const directory = fixture(EXACT_ASSETS);
    const android = join(directory, EXACT_ASSETS.find(name => name.endsWith('.apk'))!);
    try {
      writeFileSync(android, 'tampered unsigned bytes');
      expect(() => collectReleaseAssets(directory, VERSION)).toThrow('RELEASE_NATIVE_PROOF_DIGEST');

      const sha256 = createHash('sha256').update('tampered unsigned bytes').digest('hex');
      writeFileSync(`${android}.release-proof.json`, JSON.stringify({
        schema: 'xln:native-release-proof',
        artifact: android.split('/').at(-1),
        sha256,
        version: VERSION,
        platform: 'android',
        release: true,
        signed: true,
        notarized: false,
        debuggable: true,
        signerCertificateSha256: 'ab'.repeat(32),
      }));
      expect(() => collectReleaseAssets(directory, VERSION)).toThrow('RELEASE_NATIVE_PROOF_TRUST');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
