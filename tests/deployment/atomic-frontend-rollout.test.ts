import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activateFrontendRelease,
  frontendReleasePointerTarget,
  pruneFrontendReleases,
  rollbackFrontendRelease,
} from '../../scripts/deployment/atomic-frontend-release';
import { buildFixtureRelease } from './frontend-release-fixture';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

const withTempRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'xln-atomic-frontend-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('atomic frontend rollout', () => {
  test('activates A, activates B, and rolls every surface back to A', () => withTempRoot(async root => {
    const releaseA = buildFixtureRelease(root, 'A', COMMIT_A, '1.0.0').manifest.releaseId;
    const releaseB = buildFixtureRelease(root, 'B', COMMIT_B, '1.1.0').manifest.releaseId;

    expect(await activateFrontendRelease(root, releaseA)).toEqual({ current: releaseA, previous: null });
    expect(await activateFrontendRelease(root, releaseB)).toEqual({ current: releaseB, previous: releaseA });
    expect(await rollbackFrontendRelease(root)).toEqual({ current: releaseA, previous: releaseB });
    expect(frontendReleasePointerTarget(root, 'current')).toBe(releaseA);
    expect(frontendReleasePointerTarget(root, 'previous')).toBe(releaseB);
  }));

  test('failed post-activation health restores both pointers', () => withTempRoot(async root => {
    const releaseA = buildFixtureRelease(root, 'A', COMMIT_A, '1.0.0').manifest.releaseId;
    const releaseB = buildFixtureRelease(root, 'B', COMMIT_B, '1.1.0').manifest.releaseId;
    await activateFrontendRelease(root, releaseA);

    await expect(activateFrontendRelease(root, releaseB, () => {
      throw new Error('identity mismatch');
    })).rejects.toThrow('FRONTEND_RELEASE_HEALTH_FAILED_ROLLED_BACK');
    expect(frontendReleasePointerTarget(root, 'current')).toBe(releaseA);
    expect(frontendReleasePointerTarget(root, 'previous')).toBeNull();
  }));

  test('corrupt and incomplete staging cannot change current', () => withTempRoot(async root => {
    const releaseA = buildFixtureRelease(root, 'A', COMMIT_A, '1.0.0').manifest.releaseId;
    const releaseB = buildFixtureRelease(root, 'B', COMMIT_B, '1.1.0');
    await activateFrontendRelease(root, releaseA);
    writeFileSync(join(releaseB.releaseRoot, 'wallet/index.html'), 'corrupt');

    await expect(activateFrontendRelease(root, releaseB.manifest.releaseId))
      .rejects.toThrow('FRONTEND_RELEASE_ASSET_INVENTORY_MISMATCH:wallet');
    await expect(activateFrontendRelease(root, '../escape'))
      .rejects.toThrow('FRONTEND_RELEASE_ID_INVALID');
    expect(frontendReleasePointerTarget(root, 'current')).toBe(releaseA);
  }));

  test('fails loudly for a dangling live pointer', () => withTempRoot(async root => {
    buildFixtureRelease(root, 'A', COMMIT_A, '1.0.0');
    symlinkSync('releases/missing', join(root, 'current'));
    expect(() => frontendReleasePointerTarget(root, 'current')).toThrow();
  }));

  test('prunes only explicit validated releases that are not rollback targets', () => withTempRoot(async root => {
    const releaseA = buildFixtureRelease(root, 'A', COMMIT_A, '1.0.0').manifest.releaseId;
    const releaseB = buildFixtureRelease(root, 'B', COMMIT_B, '1.1.0').manifest.releaseId;
    const releaseC = buildFixtureRelease(root, 'C', 'c'.repeat(40), '1.2.0').manifest.releaseId;
    await activateFrontendRelease(root, releaseA);
    await activateFrontendRelease(root, releaseB);

    expect(() => pruneFrontendReleases(root, [releaseA])).toThrow('FRONTEND_RELEASE_PRUNE_ACTIVE_REFUSED');
    expect(() => pruneFrontendReleases(root, [releaseB])).toThrow('FRONTEND_RELEASE_PRUNE_ACTIVE_REFUSED');
    expect(pruneFrontendReleases(root, [releaseC])).toEqual([releaseC]);
    expect(existsSync(join(root, 'releases', releaseC))).toBeFalse();
    expect(frontendReleasePointerTarget(root, 'current')).toBe(releaseB);
    expect(frontendReleasePointerTarget(root, 'previous')).toBe(releaseA);
  }));
});
