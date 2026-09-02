import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import type { PreparedGeneratedInputDefinition } from '../../frontend/config/generated-inputs';
import { SURFACE_IDS, type SurfaceId } from '../../frontend/config/surfaces';
import { assembleCandidateRelease } from '../../frontend/scripts/candidate-release';
import { prepareGeneratedInputs } from '../../frontend/scripts/generated-inputs';
import { materializeNativeWalletCandidate } from '../../scripts/native/stage-wallet-candidate';
import {
  NATIVE_WALLET_CANDIDATE_MANIFEST,
  verifyNativeWalletCandidateDirectory,
} from '../../scripts/native/wallet-candidate-manifest';

const temporaryRoots: string[] = [];

const INPUT_DEFINITIONS: readonly PreparedGeneratedInputDefinition[] = [
  {
    id: 'site-input',
    owner: 'site',
    sourcePaths: ['fixtures/site-only.txt'],
    outputNamespace: 'site-input',
    producer: {
      kind: 'copy',
      entries: [{ sourcePath: 'fixtures/site-only.txt', destinationPath: 'site-only.txt' }],
    },
  },
  {
    id: 'wallet-input',
    owner: 'wallet',
    sourcePaths: ['fixtures/runtime.js'],
    outputNamespace: 'wallet-input',
    producer: {
      kind: 'copy',
      entries: [{ sourcePath: 'fixtures/runtime.js', destinationPath: 'runtime.js' }],
    },
  },
];

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'xln-native-wallet-candidate-'));
  temporaryRoots.push(root);
  return root;
};

const exists = async (pathname: string): Promise<boolean> => {
  try {
    await readFile(pathname);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const writeSurfaceArtifact = async (frontendRoot: string, surfaceId: SurfaceId): Promise<void> => {
  const artifactRoot = join(frontendRoot, '.artifacts', surfaceId);
  const assetPath = `assets/${surfaceId}/index.js`;
  await mkdir(join(artifactRoot, `assets/${surfaceId}`), { recursive: true });
  await writeFile(join(artifactRoot, 'index.html'), `<script type="module" src="/${assetPath}"></script>\n`);
  await writeFile(join(artifactRoot, assetPath), `console.info('${surfaceId}')\n`);
  await writeFile(join(artifactRoot, 'manifest.json'), `${safeStringify({
    'index.html': { file: assetPath, name: 'index', src: 'index.html', isEntry: true },
  }, 2)}\n`);
};

const assembleFixture = async () => {
  const root = await createRoot();
  const frontendRoot = join(root, 'frontend');
  await mkdir(join(frontendRoot, 'build'), { recursive: true });
  await mkdir(join(root, 'fixtures'), { recursive: true });
  await writeFile(join(frontendRoot, 'build/index.html'), 'canonical-svelte-build\n');
  await writeFile(join(root, 'fixtures/site-only.txt'), 'site\n');
  await writeFile(join(root, 'fixtures/runtime.js'), 'runtime\n');
  for (const surfaceId of SURFACE_IDS) await writeSurfaceArtifact(frontendRoot, surfaceId);
  await prepareGeneratedInputs(root, frontendRoot, ['site', 'wallet'], INPUT_DEFINITIONS);
  const release = await assembleCandidateRelease(frontendRoot, INPUT_DEFINITIONS);
  return { root, frontendRoot, release, stagingRoot: join(root, 'native-staging') };
};

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('native wallet candidate staging', () => {
  test('stages only wallet-owned files under the verified whole-release identity', async () => {
    const fixture = await assembleFixture();
    const result = await materializeNativeWalletCandidate(fixture.release.releaseDirectory, fixture.stagingRoot);
    const verified = await verifyNativeWalletCandidateDirectory(result.stagingDirectory, result.releaseId);

    expect(result.status).toBe('created');
    expect(verified.releaseId).toBe(fixture.release.releaseId);
    expect(verified.files.map(({ path }) => path)).toEqual([
      'assets/wallet/index.js',
      'index.html',
      'manifest.json',
      'runtime.js',
    ]);
    expect(await readFile(join(result.stagingDirectory, 'index.html'), 'utf8'))
      .toBe(await readFile(join(fixture.release.releaseDirectory, 'apps/wallet/index.html'), 'utf8'));
    expect(await exists(join(result.stagingDirectory, 'assets/site/index.js'))).toBe(false);
    expect(await exists(join(result.stagingDirectory, 'site-only.txt'))).toBe(false);
    expect(await readFile(join(fixture.frontendRoot, 'build/index.html'), 'utf8')).toBe('canonical-svelte-build\n');
  });

  test('reuses an exact stage and rejects corruption without repairing it', async () => {
    const fixture = await assembleFixture();
    const created = await materializeNativeWalletCandidate(fixture.release.releaseDirectory, fixture.stagingRoot);
    const reused = await materializeNativeWalletCandidate(fixture.release.releaseDirectory, fixture.stagingRoot);
    expect(reused.status).toBe('reused');

    await writeFile(join(created.stagingDirectory, 'runtime.js'), 'corrupt\n');
    await expect(materializeNativeWalletCandidate(fixture.release.releaseDirectory, fixture.stagingRoot))
      .rejects.toThrow('NATIVE_WALLET_CANDIDATE_FILE_MISMATCH:runtime.js');
    expect(await readFile(join(created.stagingDirectory, 'runtime.js'), 'utf8')).toBe('corrupt\n');
  });

  test('rejects a corrupt source candidate before creating a staging root', async () => {
    const fixture = await assembleFixture();
    await writeFile(join(fixture.release.releaseDirectory, 'apps/wallet/index.html'), 'corrupt\n');

    await expect(materializeNativeWalletCandidate(fixture.release.releaseDirectory, fixture.stagingRoot))
      .rejects.toThrow('CANDIDATE_RELEASE_FILE_MISMATCH:apps/wallet/index.html');
    expect(await exists(join(fixture.stagingRoot, fixture.release.releaseId, 'index.html'))).toBe(false);
  });

  test('rejects extra files, symlinks, and unsafe stage manifest paths', async () => {
    const fixture = await assembleFixture();
    const result = await materializeNativeWalletCandidate(fixture.release.releaseDirectory, fixture.stagingRoot);
    await writeFile(join(result.stagingDirectory, 'extra.js'), 'extra\n');
    await expect(verifyNativeWalletCandidateDirectory(result.stagingDirectory, result.releaseId))
      .rejects.toThrow('NATIVE_WALLET_CANDIDATE_FILE_SET_MISMATCH');
    await rm(join(result.stagingDirectory, 'extra.js'));

    await symlink(join(result.stagingDirectory, 'runtime.js'), join(result.stagingDirectory, 'linked.js'));
    await expect(verifyNativeWalletCandidateDirectory(result.stagingDirectory, result.releaseId))
      .rejects.toThrow('NATIVE_WALLET_CANDIDATE_SYMLINK:linked.js');
    await rm(join(result.stagingDirectory, 'linked.js'));

    const firstFile = result.manifest.files[0];
    if (!firstFile) throw new Error('TEST_NATIVE_WALLET_CANDIDATE_FILE_MISSING');
    await writeFile(join(result.stagingDirectory, NATIVE_WALLET_CANDIDATE_MANIFEST), `${safeStringify({
      ...result.manifest,
      files: [{ ...firstFile, path: '../escape' }, ...result.manifest.files.slice(1)],
    }, 2)}\n`);
    await expect(verifyNativeWalletCandidateDirectory(result.stagingDirectory, result.releaseId))
      .rejects.toThrow('NATIVE_WALLET_CANDIDATE_PATH_INVALID');
  });
});
