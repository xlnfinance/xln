import { afterEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { safeStringify } from '../../../core/protocol/serialization';
import { SURFACE_IDS, type SurfaceId } from '../../../frontend/config/surfaces';
import { assembleCandidateRelease } from '../../../frontend/scripts/candidate-release';
import { verifyCandidateReleaseDirectory } from '../../../frontend/scripts/candidate-release-verifier';

const temporaryRoots: string[] = [];

const createFrontendRoot = async (): Promise<string> => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'xln-candidate-verifier-'));
  temporaryRoots.push(repositoryRoot);
  const frontendRoot = join(repositoryRoot, 'frontend');
  await mkdir(frontendRoot, { recursive: true });
  return frontendRoot;
};

const writeSurfaceArtifact = async (
  frontendRoot: string,
  surfaceId: SurfaceId,
  marker = surfaceId,
): Promise<void> => {
  const artifactRoot = join(frontendRoot, '.artifacts', surfaceId);
  const assetPath = `assets/${surfaceId}/index.js`;
  await mkdir(join(artifactRoot, `assets/${surfaceId}`), { recursive: true });
  await writeFile(join(artifactRoot, 'index.html'), `<script type="module" src="/${assetPath}"></script>\n`);
  await writeFile(join(artifactRoot, assetPath), `console.info('${marker}')\n`);
  await writeFile(join(artifactRoot, 'manifest.json'), `${safeStringify({
    'index.html': { file: assetPath, name: 'index', src: 'index.html', isEntry: true },
  }, 2)}\n`);
};

const assembleFixture = async (frontendRoot: string, marker = 'base') => {
  for (const surfaceId of SURFACE_IDS) await writeSurfaceArtifact(frontendRoot, surfaceId, `${marker}-${surfaceId}`);
  await writeFile(join(frontendRoot, '.artifacts/site/assets/site/chunk-runtime-C.js'), 'runtime\n');
  await writeFile(join(frontendRoot, '.artifacts/site/assets/site/chunk-S.js'), 'surface\n');
  return assembleCandidateRelease(frontendRoot, []);
};

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('React candidate release verifier', () => {
  test('verifies a complete content-addressed release without build inputs', async () => {
    const release = await assembleFixture(await createFrontendRoot());
    const manifest = await verifyCandidateReleaseDirectory(release.releaseDirectory);

    expect(manifest.releaseId).toBe(release.releaseId);
    expect(manifest.files).toEqual(release.manifest.files);
  });

  test('rejects missing, extra, and symlinked release files', async () => {
    const missing = await assembleFixture(await createFrontendRoot(), 'missing');
    await rm(join(missing.releaseDirectory, 'assets/site/index.js'));
    await expect(verifyCandidateReleaseDirectory(missing.releaseDirectory))
      .rejects.toThrow('CANDIDATE_RELEASE_FILE_SET_MISMATCH');

    const extra = await assembleFixture(await createFrontendRoot(), 'extra');
    await writeFile(join(extra.releaseDirectory, 'extra.js'), 'extra\n');
    await expect(verifyCandidateReleaseDirectory(extra.releaseDirectory))
      .rejects.toThrow('CANDIDATE_RELEASE_FILE_SET_MISMATCH');

    const linked = await assembleFixture(await createFrontendRoot(), 'linked');
    await symlink(join(linked.releaseDirectory, 'assets/site/index.js'), join(linked.releaseDirectory, 'linked.js'));
    await expect(verifyCandidateReleaseDirectory(linked.releaseDirectory))
      .rejects.toThrow('CANDIDATE_RELEASE_SYMLINK:linked.js');

    const rootLinked = await assembleFixture(await createFrontendRoot(), 'root-linked');
    const linksRoot = join(await createFrontendRoot(), 'release-links');
    await mkdir(linksRoot, { recursive: true });
    const releaseLink = join(linksRoot, rootLinked.releaseId);
    await symlink(rootLinked.releaseDirectory, releaseLink);
    await expect(verifyCandidateReleaseDirectory(releaseLink))
      .rejects.toThrow('CANDIDATE_RELEASE_ROOT_INVALID');
  });

  test('rejects bytes mixed between two valid releases', async () => {
    const first = await assembleFixture(await createFrontendRoot(), 'first');
    const second = await assembleFixture(await createFrontendRoot(), 'second');
    await copyFile(
      join(second.releaseDirectory, 'assets/wallet/index.js'),
      join(first.releaseDirectory, 'assets/wallet/index.js'),
    );

    await expect(verifyCandidateReleaseDirectory(first.releaseDirectory))
      .rejects.toThrow('CANDIDATE_RELEASE_FILE_MISMATCH:assets/wallet/index.js');
  });

  test('rejects duplicate or unsafe manifest paths before reading payloads', async () => {
    const duplicate = await assembleFixture(await createFrontendRoot(), 'duplicate');
    await writeFile(join(duplicate.releaseDirectory, 'release-manifest.json'), `${safeStringify({
      ...duplicate.manifest,
      files: [...duplicate.manifest.files, duplicate.manifest.files[0]],
    }, 2)}\n`);
    await expect(verifyCandidateReleaseDirectory(duplicate.releaseDirectory))
      .rejects.toThrow('CANDIDATE_RELEASE_FILE_DUPLICATE');

    const unsafe = await assembleFixture(await createFrontendRoot(), 'unsafe');
    const firstFile = unsafe.manifest.files[0];
    if (!firstFile) throw new Error('TEST_CANDIDATE_FILE_MISSING');
    await writeFile(join(unsafe.releaseDirectory, 'release-manifest.json'), `${safeStringify({
      ...unsafe.manifest,
      files: [{ ...firstFile, path: '../escape' }, ...unsafe.manifest.files.slice(1)],
    }, 2)}\n`);
    await expect(verifyCandidateReleaseDirectory(unsafe.releaseDirectory))
      .rejects.toThrow('CANDIDATE_RELEASE_FILE_PATH_INVALID');
  });

  test('rejects a manifest copied under a different release identity', async () => {
    const first = await assembleFixture(await createFrontendRoot(), 'identity-a');
    const second = await assembleFixture(await createFrontendRoot(), 'identity-b');
    await copyFile(
      join(second.releaseDirectory, 'release-manifest.json'),
      join(first.releaseDirectory, 'release-manifest.json'),
    );

    await expect(verifyCandidateReleaseDirectory(first.releaseDirectory))
      .rejects.toThrow('CANDIDATE_RELEASE_DIRECTORY_ID_MISMATCH');
  });
});
