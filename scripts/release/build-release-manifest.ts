#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { safeStringify } from '../../runtime/protocol/serialization';

type VersionFile = Readonly<{ version: string }>;
type ReleaseAsset = Readonly<{
  name: string;
  kind: 'launcher' | 'desktop' | 'android' | 'chrome';
  platform: string;
  bytes: number;
  sha256: string;
  url: string;
}>;

const ROOT = resolve(import.meta.dir, '../..');
const OUT_DIR = join(ROOT, 'native/dist');
const ASSET_DIR = join(OUT_DIR, 'release-assets');
const REQUIRED_KINDS = ['launcher', 'desktop', 'android', 'chrome'] as const;
const VERSION_PATHS = [
  'package.json',
  'frontend/package.json',
  'packages/npm/xlnfinance/package.json',
  'native/extension/manifest.json',
] as const;

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const walk = (root: string): string[] => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
};

const version = (): string => {
  const versions = VERSION_PATHS.map(path => readJson<VersionFile>(join(ROOT, path)).version);
  if (new Set(versions).size !== 1) throw new Error(`RELEASE_VERSION_MISMATCH:${versions.join(':')}`);
  return versions[0]!;
};

const classify = (path: string, releaseVersion: string): Omit<ReleaseAsset, 'bytes' | 'sha256' | 'url'> | null => {
  const name = basename(path);
  if (!name.includes(releaseVersion)) return null;
  if (/^xlnfinance-.*\.tgz$/.test(name)) return { name, kind: 'launcher', platform: 'macos-windows-linux' };
  if (/xln-finance-.*-mac-.*\.zip$/.test(name)) return { name, kind: 'desktop', platform: 'macos' };
  if (/\.apk$/.test(name)) return { name, kind: 'android', platform: 'android' };
  if (/chrome.*\.zip$/.test(name)) return { name, kind: 'chrome', platform: 'chrome' };
  return null;
};

export const collectReleaseAssets = (assetDir: string, releaseVersion: string): ReleaseAsset[] => {
  const assets = walk(assetDir).map(path => {
    const identity = classify(path, releaseVersion);
    if (!identity) throw new Error(`RELEASE_ASSET_UNCLASSIFIED:${path.slice(assetDir.length + 1)}`);
    return {
      ...identity,
      bytes: statSync(path).size,
      sha256: digest(path),
      url: `https://github.com/xlnfinance/xln/releases/download/v${releaseVersion}/${identity.name}`,
    } satisfies ReleaseAsset;
  }).sort((left, right) => left.name.localeCompare(right.name));

  if (new Set(assets.map(asset => asset.name)).size !== assets.length) {
    throw new Error('RELEASE_ASSET_NAME_COLLISION');
  }
  for (const kind of REQUIRED_KINDS) {
    const count = assets.filter(asset => asset.kind === kind).length;
    if (count !== 1) throw new Error(`RELEASE_ASSET_KIND_COUNT:${kind}:${count}`);
  }
  return assets;
};

const main = (): void => {
  const releaseVersion = version();
  const assets = collectReleaseAssets(ASSET_DIR, releaseVersion);

  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim();
  const distribution = readJson<Record<string, unknown>>(join(ROOT, 'release/channels.json'));
  const manifest = {
    schemaVersion: 1,
    product: 'xln finance',
    version: releaseVersion,
    tag: `v${releaseVersion}`,
    commit,
    generatedAt: new Date().toISOString(),
    distribution,
    assets,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'release-manifest.json'), `${safeStringify(manifest, 2)}\n`);
  writeFileSync(join(OUT_DIR, 'SHA256SUMS'), `${assets.map(asset => `${asset.sha256}  ${asset.name}`).join('\n')}\n`);
  console.log(`xln ${releaseVersion}: release manifest contains ${assets.length} artifact(s)`);
};

if (import.meta.main) main();
