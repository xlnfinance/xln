import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE } from '../../frontend/config/content-security-policy.js';
import { safeStringify } from '../../core/protocol/serialization';
import { NATIVE_WALLET_CANDIDATE_MANIFEST } from '../../scripts/native/wallet-candidate-manifest';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export const secureWalletCandidateHtml = (
  script = '<script src="/assets/wallet/index.js"></script>',
): string =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" ` +
  `content="${CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE}"></head><body>${script}</body></html>\n`;

export const createNativeWalletStageFixture = async (html: string): Promise<Readonly<{
  root: string;
  releaseId: `sha256-${string}`;
  stagingDirectory: string;
}>> => {
  const root = await mkdtemp(join(tmpdir(), 'xln-capacitor-candidate-'));
  const releaseId = `sha256-${hash(`release:${html}`)}` as const;
  const stagingDirectory = join(root, releaseId);
  const viteManifest = '{}\n';
  await mkdir(stagingDirectory);
  await writeFile(join(stagingDirectory, 'index.html'), html);
  await writeFile(join(stagingDirectory, 'manifest.json'), viteManifest);
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
    ],
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
