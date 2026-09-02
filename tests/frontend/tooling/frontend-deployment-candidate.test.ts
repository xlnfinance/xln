import { afterEach, describe, expect, test } from 'bun:test';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { safeStringify } from '../../../core/protocol/serialization';
import { SURFACE_IDS, type SurfaceId } from '../../../frontend/config/surfaces';
import { assembleCandidateRelease } from '../../../frontend/scripts/candidate-release';
import {
  DEPLOYMENT_CANDIDATE_STATE,
  activateDeploymentCandidate,
  deploymentReleaseDirectory,
  readDeploymentCandidateState,
  resolveDeploymentRoot,
  rollbackDeploymentCandidate,
  stageDeploymentCandidateRelease,
  verifyDeploymentCandidateState,
} from '../../../frontend/scripts/deployment-candidate';

const temporaryRoots: string[] = [];

const writeSurface = async (frontendRoot: string, surface: SurfaceId, marker: string): Promise<void> => {
  const artifactRoot = join(frontendRoot, '.artifacts', surface);
  const assetPath = `assets/${surface}/index.js`;
  await mkdir(join(artifactRoot, `assets/${surface}`), { recursive: true });
  await writeFile(join(artifactRoot, 'index.html'), `<script type="module" src="/${assetPath}"></script>\n`);
  await writeFile(join(artifactRoot, assetPath), `document.body.dataset.release = '${marker}-${surface}';\n`);
  await writeFile(join(artifactRoot, 'manifest.json'), `${safeStringify({
    'index.html': { file: assetPath, name: 'index', src: 'index.html', isEntry: true },
  }, 2)}\n`);
};

const createReleasePair = async () => {
  const root = await mkdtemp(join(tmpdir(), 'xln-deployment-candidate-'));
  temporaryRoots.push(root);
  const frontendRoot = join(root, 'frontend');
  await mkdir(frontendRoot, { recursive: true });
  for (const surface of SURFACE_IDS) await writeSurface(frontendRoot, surface, 'first');
  const first = await assembleCandidateRelease(frontendRoot, []);
  await writeSurface(frontendRoot, 'wallet', 'second');
  const second = await assembleCandidateRelease(frontendRoot, []);
  return { root, deploymentRoot: join(root, 'deployment'), first, second };
};

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('isolated deployment candidate selection', () => {
  test('atomically activates two exact releases and rolls back the whole release', async () => {
    const fixture = await createReleasePair();
    const firstSourceBefore = await readFile(join(fixture.first.releaseDirectory, 'release-manifest.json'));
    const first = await activateDeploymentCandidate(fixture.first.releaseDirectory, fixture.deploymentRoot);
    const second = await activateDeploymentCandidate(fixture.second.releaseDirectory, fixture.deploymentRoot);
    const rolledBack = await rollbackDeploymentCandidate(fixture.deploymentRoot);

    expect(first.state).toEqual({
      schemaVersion: 1,
      activeReleaseId: fixture.first.releaseId,
      rollbackReleaseId: null,
    });
    expect(second.state.activeReleaseId).toBe(fixture.second.releaseId);
    expect(second.state.rollbackReleaseId).toBe(fixture.first.releaseId);
    expect(rolledBack.state.activeReleaseId).toBe(fixture.first.releaseId);
    expect(rolledBack.state.rollbackReleaseId).toBe(fixture.second.releaseId);
    expect(await readFile(join(fixture.first.releaseDirectory, 'release-manifest.json'))).toEqual(firstSourceBefore);
    expect(await readFile(join(rolledBack.activeDirectory, 'apps/wallet/index.html')))
      .toEqual(await readFile(join(fixture.first.releaseDirectory, 'apps/wallet/index.html')));
    await expect(activateDeploymentCandidate(fixture.first.releaseDirectory, fixture.deploymentRoot))
      .rejects.toThrow('DEPLOYMENT_CANDIDATE_ALREADY_ACTIVE');
    expect((await verifyDeploymentCandidateState(fixture.deploymentRoot)).state).toEqual(rolledBack.state);
  });

  test('reuses exact staged releases and refuses stored corruption without repair', async () => {
    const fixture = await createReleasePair();
    const created = await stageDeploymentCandidateRelease(fixture.first.releaseDirectory, fixture.deploymentRoot);
    const reused = await stageDeploymentCandidateRelease(fixture.first.releaseDirectory, fixture.deploymentRoot);
    const storedAsset = join(created.releaseDirectory, 'assets/wallet/index.js');
    await writeFile(storedAsset, 'corrupt\n');

    expect(created.status).toBe('created');
    expect(reused.status).toBe('reused');
    await expect(stageDeploymentCandidateRelease(fixture.first.releaseDirectory, fixture.deploymentRoot))
      .rejects.toThrow('CANDIDATE_RELEASE_FILE_MISMATCH:assets/wallet/index.js');
    expect(await readFile(storedAsset, 'utf8')).toBe('corrupt\n');
  });

  test('rejects mixed, missing, and symlinked candidates before state changes', async () => {
    const fixture = await createReleasePair();
    const active = await activateDeploymentCandidate(fixture.first.releaseDirectory, fixture.deploymentRoot);
    const stateBefore = await readFile(join(fixture.deploymentRoot, DEPLOYMENT_CANDIDATE_STATE));
    const invalidRoot = join(fixture.root, 'invalid');
    const mixed = join(invalidRoot, fixture.second.releaseId);
    await cp(fixture.second.releaseDirectory, mixed, { recursive: true });
    await cp(
      join(fixture.first.releaseDirectory, 'assets/wallet/index.js'),
      join(mixed, 'assets/wallet/index.js'),
    );
    await expect(activateDeploymentCandidate(mixed, fixture.deploymentRoot))
      .rejects.toThrow('CANDIDATE_RELEASE_FILE_MISMATCH:assets/wallet/index.js');
    await rm(join(mixed, 'release-manifest.json'));
    await expect(activateDeploymentCandidate(mixed, fixture.deploymentRoot))
      .rejects.toThrow('CANDIDATE_RELEASE_MANIFEST_READ_FAILED');
    const linkRoot = join(fixture.root, 'links');
    await mkdir(linkRoot);
    const linked = join(linkRoot, fixture.second.releaseId);
    await symlink(fixture.second.releaseDirectory, linked);
    await expect(activateDeploymentCandidate(linked, fixture.deploymentRoot))
      .rejects.toThrow('CANDIDATE_RELEASE_ROOT_INVALID');

    expect(await readFile(join(fixture.deploymentRoot, DEPLOYMENT_CANDIDATE_STATE))).toEqual(stateBefore);
    expect((await verifyDeploymentCandidateState(fixture.deploymentRoot)).state).toEqual(active.state);
  });

  test('fails closed on malformed state, unavailable rollback, and an activation lock', async () => {
    const fixture = await createReleasePair();
    await expect(rollbackDeploymentCandidate(fixture.deploymentRoot))
      .rejects.toThrow('DEPLOYMENT_CANDIDATE_STATE_READ_FAILED');
    await activateDeploymentCandidate(fixture.first.releaseDirectory, fixture.deploymentRoot);
    await expect(rollbackDeploymentCandidate(fixture.deploymentRoot))
      .rejects.toThrow('DEPLOYMENT_CANDIDATE_ROLLBACK_UNAVAILABLE');
    await mkdir(join(fixture.deploymentRoot, '.deployment-candidate.lock'));
    await expect(activateDeploymentCandidate(fixture.second.releaseDirectory, fixture.deploymentRoot))
      .rejects.toThrow('DEPLOYMENT_CANDIDATE_ACTIVATION_BUSY');
    await rm(join(fixture.deploymentRoot, '.deployment-candidate.lock'), { recursive: true });
    await writeFile(join(fixture.deploymentRoot, DEPLOYMENT_CANDIDATE_STATE), '{}\n');
    await expect(readDeploymentCandidateState(fixture.deploymentRoot))
      .rejects.toThrow('DEPLOYMENT_CANDIDATE_STATE_KEYS_INVALID');
    expect(() => deploymentReleaseDirectory(fixture.deploymentRoot, '../escape'))
      .toThrow('DEPLOYMENT_CANDIDATE_RELEASE_ID_INVALID');
    expect(() => resolveDeploymentRoot('/')).toThrow('DEPLOYMENT_CANDIDATE_ROOT_UNSAFE');
    expect((await lstat(deploymentReleaseDirectory(fixture.deploymentRoot, fixture.second.releaseId))).isDirectory())
      .toBe(true);
  });
});
