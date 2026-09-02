import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, cp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import {
  PACKAGED_SHELL_CANDIDATE_MANIFEST,
  createPackagedShellCandidatePlan,
  verifyPackagedShellCandidateDirectory,
} from '../../scripts/native/packaged-shell-candidate-manifest';
import { verifyPackagedShellPolicy } from '../../scripts/native/packaged-shell-policy';
import { copyPackagedShellCandidate } from '../../scripts/native/copy-packaged-shell-candidate';
import { snapshotRegularTree } from '../../scripts/native/regular-tree';
import {
  createNativeWalletStageFixture,
  fixturePathExists,
  secureWalletCandidateHtml,
} from './wallet-candidate-fixture';

const repositoryRoot = join(import.meta.dir, '../..');
const cleanupRoots: string[] = [];
const iconBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const createFixture = async (name: string, withIcon = true) => {
  const fixture = await createNativeWalletStageFixture(
    secureWalletCandidateHtml(`<script src="/assets/wallet/${name}.js"></script>`),
    withIcon ? [{ path: 'android-chrome-192x192.png', contents: iconBytes }] : [],
  );
  cleanupRoots.push(fixture.root);
  const outputRoot = join(fixture.root, 'packaged-shells');
  return { ...fixture, outputRoot };
};

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('desktop and extension candidate materialization', () => {
  test('copies exact wallet and canonical shell bytes without changing sources', async () => {
    const fixture = await createFixture('exact-packaged-shells');
    const [stageBefore, desktopBefore, extensionBefore] = await Promise.all([
      snapshotRegularTree(fixture.stagingDirectory),
      snapshotRegularTree(join(repositoryRoot, 'native/desktop')),
      snapshotRegularTree(join(repositoryRoot, 'native/extension')),
    ]);
    const result = await copyPackagedShellCandidate(fixture.stagingDirectory, fixture.outputRoot);
    const verified = await verifyPackagedShellCandidateDirectory(
      result.workspaceDirectory,
      fixture.stagingDirectory,
      fixture.outputRoot,
    );
    const [stageAfter, desktopAfter, extensionAfter, version] = await Promise.all([
      snapshotRegularTree(fixture.stagingDirectory),
      snapshotRegularTree(join(repositoryRoot, 'native/desktop')),
      snapshotRegularTree(join(repositoryRoot, 'native/extension')),
      readFile(join(repositoryRoot, 'VERSION'), 'utf8').then((value) => value.trim()),
    ]);

    expect(result.status).toBe('created');
    expect(verified.workspaceId).toBe(result.workspaceId);
    expect(stageAfter).toEqual(stageBefore);
    expect(desktopAfter).toEqual(desktopBefore);
    expect(extensionAfter).toEqual(extensionBefore);
    expect(await readFile(join(result.workspaceDirectory, 'desktop/frontend/build/index.html')))
      .toEqual(await readFile(join(fixture.stagingDirectory, 'index.html')));
    expect(await readFile(join(result.workspaceDirectory, 'extension/app.html')))
      .toEqual(await readFile(join(fixture.stagingDirectory, 'index.html')));
    expect(await readFile(join(result.workspaceDirectory, 'extension/icon-128.png')))
      .toEqual(await readFile(join(fixture.stagingDirectory, 'android-chrome-192x192.png')));
    expect(await fixturePathExists(join(result.workspaceDirectory, 'extension/native-wallet-candidate.json'))).toBe(false);
    expect((JSON.parse(await readFile(join(result.workspaceDirectory, 'desktop/package.json'), 'utf8')) as { version: string }).version)
      .toBe(version);
  });

  test('reuses exact bytes and refuses corruption without repair', async () => {
    const fixture = await createFixture('reuse-packaged-shells');
    const created = await copyPackagedShellCandidate(fixture.stagingDirectory, fixture.outputRoot);
    const reused = await copyPackagedShellCandidate(fixture.stagingDirectory, fixture.outputRoot);
    const appPath = join(created.workspaceDirectory, 'extension/app.html');
    await writeFile(appPath, 'corrupt');

    expect(reused.status).toBe('reused');
    await expect(copyPackagedShellCandidate(fixture.stagingDirectory, fixture.outputRoot))
      .rejects.toThrow('PACKAGED_CANDIDATE_FILE_SET_MISMATCH');
    expect(await readFile(appPath, 'utf8')).toBe('corrupt');
  });

  test('rejects extra files, symlinks, and manifest evidence drift', async () => {
    const extraFixture = await createFixture('extra-packaged-shells');
    const extra = await copyPackagedShellCandidate(extraFixture.stagingDirectory, extraFixture.outputRoot);
    await writeFile(join(extra.workspaceDirectory, 'unexpected.txt'), 'unexpected');
    await expect(verifyPackagedShellCandidateDirectory(
      extra.workspaceDirectory,
      extraFixture.stagingDirectory,
      extraFixture.outputRoot,
    )).rejects.toThrow('PACKAGED_CANDIDATE_FILE_SET_MISMATCH');

    const linkFixture = await createFixture('link-packaged-shells');
    const linked = await copyPackagedShellCandidate(linkFixture.stagingDirectory, linkFixture.outputRoot);
    await symlink('app.html', join(linked.workspaceDirectory, 'extension/alias.html'));
    await expect(verifyPackagedShellCandidateDirectory(
      linked.workspaceDirectory,
      linkFixture.stagingDirectory,
      linkFixture.outputRoot,
    )).rejects.toThrow('PACKAGED_CANDIDATE_SYMLINK:extension/alias.html');

    const driftFixture = await createFixture('drift-packaged-shells');
    const drifted = await copyPackagedShellCandidate(driftFixture.stagingDirectory, driftFixture.outputRoot);
    const manifestPath = join(drifted.workspaceDirectory, PACKAGED_SHELL_CANDIDATE_MANIFEST);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, `${safeStringify({ ...manifest, layoutSha256: '0'.repeat(64) }, 2)}\n`);
    await expect(verifyPackagedShellCandidateDirectory(
      drifted.workspaceDirectory,
      driftFixture.stagingDirectory,
      driftFixture.outputRoot,
    )).rejects.toThrow('PACKAGED_CANDIDATE_INPUT_EVIDENCE_MISMATCH');
  });

  test('rejects missing icons and weakened extension permissions or CSP', async () => {
    const missing = await createFixture('missing-packaged-icon', false);
    await expect(createPackagedShellCandidatePlan(missing.stagingDirectory, missing.outputRoot))
      .rejects.toThrow('PACKAGED_CANDIDATE_ICON_MISSING:android-chrome-192x192.png');

    const fixture = await createFixture('packaged-policy');
    const result = await copyPackagedShellCandidate(fixture.stagingDirectory, fixture.outputRoot);
    const plan = await createPackagedShellCandidatePlan(fixture.stagingDirectory, fixture.outputRoot);
    const policyRoot = join(fixture.root, 'policy-copy');
    await cp(result.workspaceDirectory, policyRoot, { recursive: true });
    const extensionManifestPath = join(policyRoot, 'extension/manifest.json');
    const extensionManifest = JSON.parse(await readFile(extensionManifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(extensionManifestPath, `${safeStringify({ ...extensionManifest, permissions: ['storage'] }, 2)}\n`);
    await expect(verifyPackagedShellPolicy(policyRoot, plan.desktopPackageText))
      .rejects.toThrow('PACKAGED_CANDIDATE_EXTENSION_PERMISSIONS_INVALID');

    await cp(join(result.workspaceDirectory, 'extension/manifest.json'), extensionManifestPath);
    await writeFile(join(policyRoot, 'extension/app.html'), '<html><body>unsafe</body></html>\n');
    await chmod(join(policyRoot, 'extension/app.html'), 0o644);
    await expect(verifyPackagedShellPolicy(policyRoot, plan.desktopPackageText))
      .rejects.toThrow('NATIVE_CAPACITOR_CSP_META_COUNT:0');
  });
});
