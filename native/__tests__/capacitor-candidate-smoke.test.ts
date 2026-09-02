import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import {
  NATIVE_CAPACITOR_CANDIDATE_MANIFEST,
  NATIVE_CAPACITOR_CONFIG,
  prepareNativeCapacitorCandidate,
  verifyNativeCapacitorCandidateDirectory,
} from '../../scripts/native/capacitor-candidate';
import { smokeNativeCapacitorCandidate } from '../../scripts/native/smoke-capacitor-candidate';
import {
  createNativeWalletStageFixture,
  fixturePathExists,
  secureWalletCandidateHtml,
} from './wallet-candidate-fixture';

const temporaryRoots: string[] = [];

const createStage = async (html: string): Promise<string> => {
  const fixture = await createNativeWalletStageFixture(html);
  temporaryRoots.push(fixture.root);
  return fixture.stagingDirectory;
};

const secureHtml = secureWalletCandidateHtml;

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('isolated Capacitor candidate smoke', () => {
  test('loads the exact staged release through the real Capacitor web-copy path', async () => {
    const stagingDirectory = await createStage(secureHtml());
    const result = await smokeNativeCapacitorCandidate(stagingDirectory);
    const manifest = await verifyNativeCapacitorCandidateDirectory(result.workspaceDirectory, stagingDirectory);
    const config = JSON.parse(await readFile(join(result.workspaceDirectory, NATIVE_CAPACITOR_CONFIG), 'utf8')) as {
      appId: string;
      webDir: string;
      server: { hostname: string };
    };

    expect(result.status).toBe('created');
    expect(manifest.releaseId).toBe(result.releaseId);
    expect(config.appId).toBe('finance.xln.wallet');
    expect(config.webDir).toBe(`../../${result.releaseId}`);
    expect(config.server.hostname).toBe('localhost');
    expect(await fixturePathExists(join(result.workspaceDirectory, 'ios'))).toBe(false);
    expect(await fixturePathExists(join(result.workspaceDirectory, 'android'))).toBe(false);
  });

  test('reuses an exact workspace and refuses corruption without repair', async () => {
    const stagingDirectory = await createStage(secureHtml());
    const created = await prepareNativeCapacitorCandidate(stagingDirectory);
    const reused = await prepareNativeCapacitorCandidate(stagingDirectory);
    expect(reused.status).toBe('reused');

    const configPath = join(created.workspaceDirectory, NATIVE_CAPACITOR_CONFIG);
    await writeFile(configPath, 'corrupt\n');
    await expect(prepareNativeCapacitorCandidate(stagingDirectory))
      .rejects.toThrow('NATIVE_CAPACITOR_CONFIG_JSON_INVALID');
    expect(await readFile(configPath, 'utf8')).toBe('corrupt\n');
  });

  test('rejects missing CSP and inline scripts before creating a workspace', async () => {
    const missingPolicyStage = await createStage('<!doctype html><script src="/index.js"></script>\n');
    await expect(prepareNativeCapacitorCandidate(missingPolicyStage))
      .rejects.toThrow('NATIVE_CAPACITOR_CSP_META_COUNT:0');
    expect(await fixturePathExists(join(missingPolicyStage, '../.capacitor'))).toBe(false);

    const inlineScriptStage = await createStage(secureHtml('<script>globalThis.compromised = true</script>'));
    await expect(prepareNativeCapacitorCandidate(inlineScriptStage))
      .rejects.toThrow('NATIVE_CAPACITOR_INLINE_SCRIPT_FORBIDDEN');
    expect(await fixturePathExists(join(inlineScriptStage, '../.capacitor'))).toBe(false);
  });

  test('rejects extra workspace files and manifest drift', async () => {
    const stagingDirectory = await createStage(secureHtml());
    const result = await prepareNativeCapacitorCandidate(stagingDirectory);
    await writeFile(join(result.workspaceDirectory, 'extra.json'), '{}\n');
    await expect(verifyNativeCapacitorCandidateDirectory(result.workspaceDirectory, stagingDirectory))
      .rejects.toThrow('NATIVE_CAPACITOR_WORKSPACE_FILE_SET_MISMATCH');
    await rm(join(result.workspaceDirectory, 'extra.json'));

    const manifestPath = join(result.workspaceDirectory, NATIVE_CAPACITOR_CANDIDATE_MANIFEST);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, `${safeStringify({ ...manifest, webDir: '../wrong' }, 2)}\n`);
    await expect(verifyNativeCapacitorCandidateDirectory(result.workspaceDirectory, stagingDirectory))
      .rejects.toThrow('NATIVE_CAPACITOR_MANIFEST_MISMATCH');
  });

  test('refuses a symlinked workspace root before writing configuration', async () => {
    const stagingDirectory = await createStage(secureHtml());
    const redirectedRoot = join(dirname(stagingDirectory), 'redirected-workspace');
    await mkdir(redirectedRoot);
    await symlink(redirectedRoot, join(dirname(stagingDirectory), '.capacitor'));

    await expect(prepareNativeCapacitorCandidate(stagingDirectory))
      .rejects.toThrow('NATIVE_CAPACITOR_WORKSPACE_INVALID');
  });
});
