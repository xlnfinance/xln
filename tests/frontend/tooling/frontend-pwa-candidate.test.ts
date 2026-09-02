import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SURFACE_IDS } from '../../../frontend/config/surfaces';
import { assembleCandidateRelease } from '../../../frontend/scripts/candidate-release';
import {
  createPwaCandidatePlan,
  PWA_CANDIDATE_CACHE_PREFIX,
  PWA_CANDIDATE_RELEASE_PATH,
  PWA_CANDIDATE_SCOPE,
} from '../../../frontend/scripts/pwa-candidate';

const roots: string[] = [];

const createRelease = async (walletMarker: string) => {
  const frontendRoot = await mkdtemp(join(tmpdir(), 'xln-pwa-candidate-'));
  roots.push(frontendRoot);
  for (const surface of SURFACE_IDS) {
    const artifact = join(frontendRoot, '.artifacts', surface);
    const asset = `assets/${surface}/index.js`;
    await mkdir(join(artifact, 'assets', surface), { recursive: true });
    await writeFile(
      join(artifact, 'index.html'),
      `<!doctype html><body>${surface === 'wallet' ? walletMarker : surface}<script src="/${asset}"></script></body>`,
    );
    await writeFile(join(artifact, 'manifest.json'), `${JSON.stringify({
      'index.html': { file: asset, isEntry: true },
    })}\n`);
    await writeFile(join(artifact, asset), `export default ${JSON.stringify(surface)};\n`);
  }
  return assembleCandidateRelease(frontendRoot, []);
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('isolated PWA candidate plan', () => {
  test('pins one verified whole release to one deterministic cache and root scope', async () => {
    const release = await createRelease('install');
    const first = await createPwaCandidatePlan(release.releaseDirectory);
    const second = await createPwaCandidatePlan(release.releaseDirectory);

    expect(second).toEqual(first);
    expect(first.releaseId).toBe(release.releaseId);
    expect(first.scope).toBe(PWA_CANDIDATE_SCOPE);
    expect(first.cacheName).toBe(`${PWA_CANDIDATE_CACHE_PREFIX}${release.releaseId}`);
    expect(first.files).toHaveLength(release.manifest.files.length + 1);
    expect(first.files.map(({ path }) => path)).toContain('release-manifest.json');
    expect(first.serviceWorkerSource).toContain(`${PWA_CANDIDATE_RELEASE_PATH}/${release.releaseId}/`);
    expect(() => new Function(first.serviceWorkerSource)).not.toThrow();
  });

  test('gives distinct verified releases distinct worker and cache identities', async () => {
    const [install, update] = await Promise.all([createRelease('install'), createRelease('update')]);
    const [installPlan, updatePlan] = await Promise.all([
      createPwaCandidatePlan(install.releaseDirectory),
      createPwaCandidatePlan(update.releaseDirectory),
    ]);

    expect(updatePlan.releaseId).not.toBe(installPlan.releaseId);
    expect(updatePlan.cacheName).not.toBe(installPlan.cacheName);
    expect(updatePlan.serviceWorkerSha256).not.toBe(installPlan.serviceWorkerSha256);
    expect(updatePlan.serviceWorkerSource).toContain('PWA_RELEASE_FILE_MISMATCH:');
    expect(updatePlan.serviceWorkerSource).toContain('requestUrl.origin !== self.location.origin');
    expect(updatePlan.serviceWorkerSource).toContain('self.clients.claim()');
  });

  test('rejects candidate corruption before generating a service worker', async () => {
    const release = await createRelease('corrupt');
    await writeFile(join(release.releaseDirectory, 'apps/wallet/index.html'), 'corrupt\n');
    await expect(createPwaCandidatePlan(release.releaseDirectory))
      .rejects.toThrow('CANDIDATE_RELEASE_FILE_MISMATCH:apps/wallet/index.html');
  });
});
