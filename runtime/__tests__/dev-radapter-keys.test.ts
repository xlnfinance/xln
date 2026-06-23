import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DevRadapterKeysPayload = {
  importUrl: string;
  adminImportUrl: string;
  importManifest: {
    entries: Array<{ label: string; access: string; wsUrl: string; token: string }>;
  };
  adminImportManifest: {
    entries: Array<{ label: string; access: string; wsUrl: string; token: string }>;
  };
  entries: Array<{ name: string; appUrl: string; adminAppUrl: string; inspectToken: string; adminToken: string }>;
};

test('dev radapter keys prints one auto-import runtimeList URL with ready tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xln-dev-radapter-'));
  const outPath = join(dir, 'radapter-keys.json');
  const envOutPath = join(dir, 'radapter-keys.env');
  try {
    const result = spawnSync('bun', [
      'runtime/scripts/dev-radapter-keys.ts',
      '--web-port',
      '8084',
      '--api-port',
      '8082',
      '--out',
      outPath,
      '--env-out',
      envOutPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    });

    expect(result.status, result.stderr).toBe(0);
    const appLinks = result.stdout.match(/https:\/\/localhost:8084\/app\?runtimeList=[^\s]+/g) ?? [];
    expect(appLinks.length).toBe(1);
    expect(result.stdout).not.toContain('key=paste');
    expect(result.stdout).not.toContain('Open these URLs');

    const payload = JSON.parse(readFileSync(outPath, 'utf8')) as DevRadapterKeysPayload;
    expect(payload.importUrl).toBe(appLinks[0]);
    expect(payload.importUrl).toContain('/app?runtimeList=');
    expect(payload.importUrl).not.toContain('runtime-import=');
    expect(payload.adminImportUrl).toContain('/app?runtimeList=');

    const runtimeList = new URL(payload.importUrl).searchParams.get('runtimeList') || '';
    for (const label of ['H1', 'H2', 'H3', 'MM']) {
      expect(runtimeList).toContain(label);
    }
    expect(runtimeList).toContain('xlnra1.read.');
    expect(runtimeList).not.toContain('xlnra1.full.');
    expect(payload.importManifest.entries.every(entry => entry.access === 'read')).toBe(true);
    expect(payload.adminImportManifest.entries.every(entry => entry.access === 'admin')).toBe(true);
    expect(payload.adminImportUrl).toContain('xlnra1.full.');
    expect(payload.entries.every(entry => entry.appUrl.includes('&token='))).toBe(true);
    expect(payload.entries.every(entry => !entry.appUrl.includes('key=paste'))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
