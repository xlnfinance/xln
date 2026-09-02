import { afterEach, describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';

import { safeStringify } from '../../core/protocol/serialization';
import {
  CAPACITOR_SHELL_CANDIDATE_MANIFEST,
  createCapacitorShellCandidatePlan,
  snapshotRegularTree,
  verifyCapacitorShellCandidateDirectory,
} from '../../scripts/native/capacitor-shell-candidate-manifest';
import { copyCapacitorShellCandidate } from '../../scripts/native/copy-capacitor-shell-candidate';
import { createNativeWalletStageFixture, secureWalletCandidateHtml } from './wallet-candidate-fixture';

const frontendRoot = join(import.meta.dir, '../../frontend');
const cleanupRoots: string[] = [];

const createFixture = async (name: string) => {
  const fixture = await createNativeWalletStageFixture(
    secureWalletCandidateHtml(`<script src="/assets/wallet/${name}.js"></script>`),
  );
  cleanupRoots.push(fixture.root);
  const plan = await createCapacitorShellCandidatePlan(fixture.stagingDirectory);
  const releaseRoot = dirname(plan.workspaceDirectory);
  await rm(releaseRoot, { recursive: true, force: true });
  cleanupRoots.push(releaseRoot);
  return { ...fixture, plan };
};

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Capacitor disposable shell candidate', () => {
  test('copies the exact candidate into real iOS and Android shell replicas only', async () => {
    const fixture = await createFixture('real-shell-copy');
    const [iosBefore, androidBefore] = await Promise.all([
      snapshotRegularTree(join(frontendRoot, 'ios')),
      snapshotRegularTree(join(frontendRoot, 'android')),
    ]);
    const result = await copyCapacitorShellCandidate(fixture.stagingDirectory);
    const verified = await verifyCapacitorShellCandidateDirectory(
      result.workspaceDirectory,
      fixture.stagingDirectory,
    );
    const [iosAfter, androidAfter] = await Promise.all([
      snapshotRegularTree(join(frontendRoot, 'ios')),
      snapshotRegularTree(join(frontendRoot, 'android')),
    ]);

    expect(result.status).toBe('created');
    expect(verified.workspaceId).toBe(result.workspaceId);
    expect(verified.releaseId).toBe(fixture.releaseId);
    expect(verified.files.map(({ path }) => path)).toContain('ios/App/App/public/index.html');
    expect(verified.files.map(({ path }) => path)).toContain('ios/App/App/capacitor.config.json');
    expect(verified.files.map(({ path }) => path)).toContain('android/app/src/main/assets/public/index.html');
    expect(verified.files.map(({ path }) => path)).toContain('android/app/src/main/assets/capacitor.config.json');
    expect(iosAfter).toEqual(iosBefore);
    expect(androidAfter).toEqual(androidBefore);
    expect(await readFile(join(result.workspaceDirectory, 'ios/App/App/public/index.html'), 'utf8'))
      .toBe(await readFile(join(fixture.stagingDirectory, 'index.html'), 'utf8'));
    expect(await readFile(join(result.workspaceDirectory, 'android/app/src/main/assets/public/cordova.js'), 'utf8'))
      .toBe('');
  });

  test('reuses exact shell bytes and refuses corruption without repair', async () => {
    const fixture = await createFixture('reuse-shell-copy');
    const created = await copyCapacitorShellCandidate(fixture.stagingDirectory);
    const reused = await copyCapacitorShellCandidate(fixture.stagingDirectory);
    expect(reused.status).toBe('reused');

    const copiedIndex = join(created.workspaceDirectory, 'ios/App/App/public/index.html');
    await writeFile(copiedIndex, 'corrupt\n');
    await expect(copyCapacitorShellCandidate(fixture.stagingDirectory))
      .rejects.toThrow('CAPACITOR_SHELL_FILE_SET_MISMATCH');
    expect(await readFile(copiedIndex, 'utf8')).toBe('corrupt\n');
  });

  test('rejects extra files, symlinks, and source-evidence drift', async () => {
    const fixture = await createFixture('reject-shell-drift');
    const result = await copyCapacitorShellCandidate(fixture.stagingDirectory);
    const extraPath = join(result.workspaceDirectory, 'extra.txt');
    await writeFile(extraPath, 'extra\n');
    await expect(verifyCapacitorShellCandidateDirectory(result.workspaceDirectory, fixture.stagingDirectory))
      .rejects.toThrow('CAPACITOR_SHELL_FILE_SET_MISMATCH');
    await rm(extraPath);

    const linkPath = join(result.workspaceDirectory, 'linked-shell');
    await symlink(join(result.workspaceDirectory, 'ios'), linkPath);
    await expect(verifyCapacitorShellCandidateDirectory(result.workspaceDirectory, fixture.stagingDirectory))
      .rejects.toThrow('CAPACITOR_SHELL_SYMLINK:linked-shell');
    await rm(linkPath);

    const manifestPath = join(result.workspaceDirectory, CAPACITOR_SHELL_CANDIDATE_MANIFEST);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, `${safeStringify({
      ...manifest,
      sourceShells: { ios: '0'.repeat(64), android: '0'.repeat(64) },
    }, 2)}\n`);
    await expect(verifyCapacitorShellCandidateDirectory(result.workspaceDirectory, fixture.stagingDirectory))
      .rejects.toThrow('CAPACITOR_SHELL_INPUT_EVIDENCE_MISMATCH');
  });
});
