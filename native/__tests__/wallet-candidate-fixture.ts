import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE } from '../../frontend/config/content-security-policy.js';
import { compareStableText, safeStringify } from '../../core/protocol/serialization';
import { NATIVE_WALLET_CANDIDATE_MANIFEST } from '../../scripts/native/wallet-candidate-manifest';

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export type NativeWalletFixtureFile = Readonly<{
  path: string;
  contents: string | Uint8Array;
  sourcePath?: string;
}>;

export const secureWalletCandidateHtml = (
  script = '<script src="/assets/wallet/index.js"></script>',
): string =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" ` +
  `content="${CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE}"></head><body>${script}</body></html>\n`;

export const createNativeWalletStageFixture = async (
  html: string,
  extraFiles: readonly NativeWalletFixtureFile[] = [],
): Promise<Readonly<{
  root: string;
  releaseId: `sha256-${string}`;
  stagingDirectory: string;
}>> => {
  const extraEvidence = extraFiles.map(({ path, contents, sourcePath }) => ({
    path,
    sourcePath: sourcePath ?? `generated/wallet/${path}`,
    sha256: hash(contents),
  }));
  const releaseId = `sha256-${hash(safeStringify({ html, extraEvidence }))}` as const;
  const root = await mkdtemp(join(tmpdir(), 'xln-native-candidate-'));
  const stagingDirectory = join(root, releaseId);
  const viteManifest = '{}\n';
  await mkdir(stagingDirectory);
  await writeFile(join(stagingDirectory, 'index.html'), html);
  await writeFile(join(stagingDirectory, 'manifest.json'), viteManifest);
  for (const file of extraFiles) {
    if (!file.path || file.path.startsWith('/') || file.path.includes('\\') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('NATIVE_WALLET_FIXTURE_PATH_INVALID');
    }
    const pathname = join(stagingDirectory, file.path);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, file.contents);
  }
  await writeFile(join(stagingDirectory, NATIVE_WALLET_CANDIDATE_MANIFEST), `${safeStringify({
    schemaVersion: 1,
    releaseId,
    application: 'wallet',
    files: [
      {
        sourcePath: 'apps/wallet/index.html',
        path: 'index.html',
        sha256: hash(html),
        size: Buffer.byteLength(html),
      },
      {
        sourcePath: 'apps/wallet/manifest.json',
        path: 'manifest.json',
        sha256: hash(viteManifest),
        size: Buffer.byteLength(viteManifest),
      },
      ...extraFiles.map(({ path, contents, sourcePath }) => ({
        sourcePath: sourcePath ?? `generated/wallet/${path}`,
        path,
        sha256: hash(contents),
        size: typeof contents === 'string' ? Buffer.byteLength(contents) : contents.byteLength,
      })),
    ].sort(({ path: left }, { path: right }) => compareStableText(left, right)),
  }, 2)}\n`);
  return { root, releaseId, stagingDirectory };
};

export const fixturePathExists = async (pathname: string): Promise<boolean> => {
  try {
    await lstat(pathname);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};
