import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectReleaseAssets } from '../../scripts/release/build-release-manifest.ts';

const VERSION = '0.1.31';
const EXACT_ASSETS = [
  `xlnfinance-${VERSION}.tgz`,
  `xln-finance-${VERSION}-mac-arm64.zip`,
  `xln-finance-chrome-${VERSION}.zip`,
  `xln-finance-${VERSION}.apk`,
] as const;

const fixture = (names: readonly string[]): string => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-release-assets-'));
  for (const name of names) writeFileSync(join(directory, name), name);
  return directory;
};

describe('release asset manifest', () => {
  test('binds exactly one artifact for every required distribution', () => {
    const directory = fixture(EXACT_ASSETS);
    try {
      const assets = collectReleaseAssets(directory, VERSION);
      expect(assets.map(asset => asset.kind).sort()).toEqual(['android', 'chrome', 'desktop', 'launcher']);
      expect(assets.every(asset => asset.bytes > 0 && asset.sha256.length === 64)).toBe(true);

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
});
