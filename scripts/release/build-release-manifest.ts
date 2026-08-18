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

import { safeStringify } from '../../core/protocol/serialization';

type VersionFile = Readonly<{ version: string }>;
type ReleaseAsset = Readonly<{
  name: string;
  kind: 'launcher' | 'desktop' | 'android' | 'chrome';
  platform: string;
  bytes: number;
  sha256: string;
  url: string;
  releaseProof?: Readonly<{
    proofSha256: string;
    signed: true;
    notarized: boolean;
    debuggable: false;
    signerIdentity: string;
  }>;
}>;
type NativeReleaseProof = Readonly<{
  schema?: unknown;
  artifact?: unknown;
  sha256?: unknown;
  version?: unknown;
  platform?: unknown;
  release?: unknown;
  signed?: unknown;
  notarized?: unknown;
  debuggable?: unknown;
  signerCertificateSha256?: unknown;
  teamId?: unknown;
  codesignIdentity?: unknown;
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
  if (
    name === `xln-finance-${releaseVersion}-mac-arm64-signed-notarized.zip` ||
    name === `xln-finance-${releaseVersion}-mac-x64-signed-notarized.zip`
  ) {
    const architecture = name.includes('-arm64-') ? 'arm64' : 'x64';
    return { name, kind: 'desktop', platform: `macos-${architecture}-signed-notarized` };
  }
  if (name === `xln-finance-${releaseVersion}-android-release-signed.apk`) {
    return { name, kind: 'android', platform: 'android-release-signed' };
  }
  if (/chrome.*\.zip$/.test(name)) return { name, kind: 'chrome', platform: 'chrome' };
  return null;
};

const nativeProofFor = (
  artifactPath: string,
  identity: Pick<ReleaseAsset, 'name' | 'kind' | 'platform'>,
  releaseVersion: string,
): ReleaseAsset['releaseProof'] => {
  const proofPath = `${artifactPath}.release-proof.json`;
  if (!existsSync(proofPath)) throw new Error(`RELEASE_NATIVE_PROOF_MISSING:${identity.name}`);
  const proof = readJson<NativeReleaseProof>(proofPath);
  if (proof.schema !== 'xln:native-release-proof') throw new Error(`RELEASE_NATIVE_PROOF_SCHEMA:${identity.name}`);
  if (proof.artifact !== identity.name) throw new Error(`RELEASE_NATIVE_PROOF_ARTIFACT:${identity.name}`);
  if (proof.version !== releaseVersion) throw new Error(`RELEASE_NATIVE_PROOF_VERSION:${identity.name}`);
  if (proof.sha256 !== digest(artifactPath)) throw new Error(`RELEASE_NATIVE_PROOF_DIGEST:${identity.name}`);
  if (proof.release !== true || proof.signed !== true || proof.debuggable !== false) {
    throw new Error(`RELEASE_NATIVE_PROOF_TRUST:${identity.name}`);
  }
  const proofSha256 = digest(proofPath);
  if (identity.kind === 'android') {
    const signer = String(proof.signerCertificateSha256 || '').toLowerCase();
    if (proof.platform !== 'android' || proof.notarized !== false || !/^[0-9a-f]{64}$/.test(signer)) {
      throw new Error(`RELEASE_ANDROID_PROOF_INVALID:${identity.name}`);
    }
    return { proofSha256, signed: true, notarized: false, debuggable: false, signerIdentity: signer };
  }
  const teamId = String(proof.teamId || '');
  const codesignIdentity = String(proof.codesignIdentity || '');
  if (
    proof.platform !== identity.platform.replace('-signed-notarized', '') ||
    proof.notarized !== true ||
    !/^[A-Z0-9]+$/.test(teamId) ||
    !codesignIdentity.startsWith('Developer ID Application:')
  ) {
    throw new Error(`RELEASE_MACOS_PROOF_INVALID:${identity.name}`);
  }
  return {
    proofSha256,
    signed: true,
    notarized: true,
    debuggable: false,
    signerIdentity: `${codesignIdentity} [${teamId}]`,
  };
};

export const collectReleaseAssets = (assetDir: string, releaseVersion: string): ReleaseAsset[] => {
  const allFiles = walk(assetDir);
  const proofFiles = allFiles.filter(path => path.endsWith('.release-proof.json'));
  const assets = allFiles.filter(path => !path.endsWith('.release-proof.json')).map(path => {
    const identity = classify(path, releaseVersion);
    if (!identity) throw new Error(`RELEASE_ASSET_UNCLASSIFIED:${path.slice(assetDir.length + 1)}`);
    return {
      ...identity,
      bytes: statSync(path).size,
      sha256: digest(path),
      url: `https://github.com/xlnfinance/xln/releases/download/v${releaseVersion}/${identity.name}`,
      ...(identity.kind === 'android' || identity.kind === 'desktop'
        ? { releaseProof: nativeProofFor(path, identity, releaseVersion) }
        : {}),
    } satisfies ReleaseAsset;
  }).sort((left, right) => left.name.localeCompare(right.name));

  if (new Set(assets.map(asset => asset.name)).size !== assets.length) {
    throw new Error('RELEASE_ASSET_NAME_COLLISION');
  }
  const expectedProofNames = assets
    .filter(asset => asset.kind === 'android' || asset.kind === 'desktop')
    .map(asset => `${asset.name}.release-proof.json`)
    .sort();
  const actualProofNames = proofFiles.map(path => basename(path)).sort();
  if (JSON.stringify(actualProofNames) !== JSON.stringify(expectedProofNames)) {
    throw new Error(`RELEASE_NATIVE_PROOF_SET_INVALID:${actualProofNames.join(',')}`);
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
