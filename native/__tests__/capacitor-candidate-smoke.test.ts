import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE } from '../../frontend/config/content-security-policy.js';
import { safeStringify } from '../../core/protocol/serialization';
import {
  NATIVE_CAPACITOR_CANDIDATE_MANIFEST,
  NATIVE_CAPACITOR_CONFIG,
  prepareNativeCapacitorCandidate,
  verifyNativeCapacitorCandidateDirectory,
} from '../../scripts/native/capacitor-candidate';
import { smokeNativeCapacitorCandidate } from '../../scripts/native/smoke-capacitor-candidate';
import { NATIVE_WALLET_CANDIDATE_MANIFEST } from '../../scripts/native/wallet-candidate-manifest';

const temporaryRoots: string[] = [];
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const createStage = async (html: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'xln-capacitor-candidate-'));
  temporaryRoots.push(root);
  const releaseId = `sha256-${hash(`release:${html}`)}`;
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
  return stagingDirectory;
};

const secureHtml = (script = '<script src="/assets/wallet/index.js"></script>'): string =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE}"></head>` +
  `<body>${script}</body></html>\n`;

const pathExists = async (pathname: string): Promise<boolean> => {
  try {
    await lstat(pathname);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

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
    expect(await pathExists(join(result.workspaceDirectory, 'ios'))).toBe(false);
    expect(await pathExists(join(result.workspaceDirectory, 'android'))).toBe(false);
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
    expect(await pathExists(join(missingPolicyStage, '../.capacitor'))).toBe(false);

    const inlineScriptStage = await createStage(secureHtml('<script>globalThis.compromised = true</script>'));
    await expect(prepareNativeCapacitorCandidate(inlineScriptStage))
      .rejects.toThrow('NATIVE_CAPACITOR_INLINE_SCRIPT_FORBIDDEN');
    expect(await pathExists(join(inlineScriptStage, '../.capacitor'))).toBe(false);
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
