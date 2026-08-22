import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { safeStringify } from '../../../core/protocol/serialization';
import { SURFACE_IDS, type SurfaceId } from '../../../frontend/config/surfaces';
import {
  assembleCandidateRelease,
  planCandidateRelease,
} from '../../../frontend/scripts/candidate-release';

const temporaryRoots: string[] = [];

const createFrontendRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'xln-candidate-release-'));
  temporaryRoots.push(root);
  return root;
};

const writeSurfaceArtifact = async (frontendRoot: string, surfaceId: SurfaceId): Promise<void> => {
  const artifactRoot = join(frontendRoot, '.artifacts', surfaceId);
  const assetPath = `assets/${surfaceId}/index.js`;
  await mkdir(join(artifactRoot, `assets/${surfaceId}`), { recursive: true });
  await writeFile(join(artifactRoot, 'index.html'), `<script type="module" src="/${assetPath}"></script>\n`);
  await writeFile(join(artifactRoot, assetPath), `console.info('${surfaceId}')\n`);
  await writeFile(join(artifactRoot, 'manifest.json'), `${safeStringify({
    'index.html': {
      file: assetPath,
      name: 'index',
      src: 'index.html',
      isEntry: true,
    },
  }, 2)}\n`);
};

const writeCompleteArtifacts = async (frontendRoot: string): Promise<void> => {
  for (const surfaceId of SURFACE_IDS) await writeSurfaceArtifact(frontendRoot, surfaceId);
};

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('React candidate release assembly', () => {
  test('plans one deterministic same-origin release for all four applications', async () => {
    const frontendRoot = await createFrontendRoot();
    await writeCompleteArtifacts(frontendRoot);

    const first = await planCandidateRelease(frontendRoot);
    const second = await planCandidateRelease(frontendRoot);

    expect(second.releaseId).toBe(first.releaseId);
    expect(first.manifest.applications.map(({ id }) => id)).toEqual(SURFACE_IDS);
    expect(first.manifest.applications.find(({ id }) => id === 'wallet')).toMatchObject({
      entryHtml: 'apps/wallet/index.html',
      assetDirectory: 'assets/wallet',
    });
    expect(first.manifest.edgeRoutes).toContainEqual({ kind: 'exact', pathname: '/runtime.js' });
    expect(first.manifest.files.map(({ path }) => path)).toContain('assets/docs/index.js');
  });

  test('writes a versioned candidate without touching the canonical build directory', async () => {
    const frontendRoot = await createFrontendRoot();
    await writeCompleteArtifacts(frontendRoot);
    await mkdir(join(frontendRoot, 'build'), { recursive: true });
    await writeFile(join(frontendRoot, 'build', 'sentinel.txt'), 'svelte-canonical\n');

    const first = await assembleCandidateRelease(frontendRoot);
    const second = await assembleCandidateRelease(frontendRoot);
    const manifest = JSON.parse(await readFile(
      join(first.releaseDirectory, 'release-manifest.json'),
      'utf8',
    )) as unknown;

    expect(second.releaseDirectory).toBe(first.releaseDirectory);
    expect(manifest).toEqual(first.manifest);
    expect(await readFile(join(first.releaseDirectory, 'apps/site/index.html'), 'utf8')).toContain('/assets/site/');
    expect(await readFile(join(frontendRoot, 'build', 'sentinel.txt'), 'utf8')).toBe('svelte-canonical\n');
  });

  test('changes the release identity when an artifact changes', async () => {
    const frontendRoot = await createFrontendRoot();
    await writeCompleteArtifacts(frontendRoot);
    const before = await planCandidateRelease(frontendRoot);

    await writeFile(join(frontendRoot, '.artifacts/site/assets/site/index.js'), 'console.info("changed")\n');
    const after = await planCandidateRelease(frontendRoot);

    expect(after.releaseId).not.toBe(before.releaseId);
  });

  test('rejects corrupted bytes in an existing content-addressed release', async () => {
    const frontendRoot = await createFrontendRoot();
    await writeCompleteArtifacts(frontendRoot);
    const release = await assembleCandidateRelease(frontendRoot);
    await writeFile(join(release.releaseDirectory, 'assets/site/index.js'), 'corrupted\n');

    await expect(assembleCandidateRelease(frontendRoot)).rejects.toThrow(
      'CANDIDATE_RELEASE_FILE_MISMATCH:assets/site/index.js',
    );
  });

  test('rejects files outside an application asset namespace', async () => {
    const frontendRoot = await createFrontendRoot();
    await writeCompleteArtifacts(frontendRoot);
    const foreignPath = join(frontendRoot, '.artifacts/docs/assets/site/foreign.js');
    await mkdir(join(foreignPath, '..'), { recursive: true });
    await writeFile(foreignPath, 'foreign\n');

    await expect(planCandidateRelease(frontendRoot)).rejects.toThrow(
      'CANDIDATE_ARTIFACT_PATH_UNOWNED:docs:assets/site/foreign.js',
    );
  });

  test('rejects a manifest reference that is absent from the artifact', async () => {
    const frontendRoot = await createFrontendRoot();
    await writeCompleteArtifacts(frontendRoot);
    const manifestPath = join(frontendRoot, '.artifacts/ops/manifest.json');
    await writeFile(manifestPath, `${safeStringify({
      'index.html': {
        file: 'assets/ops/missing.js',
        isEntry: true,
      },
    })}\n`);

    await expect(planCandidateRelease(frontendRoot)).rejects.toThrow(
      'CANDIDATE_VITE_REFERENCE_MISSING:ops:assets/ops/missing.js',
    );
    await expect(stat(join(frontendRoot, '.artifacts/releases'))).rejects.toThrow();
  });
});
