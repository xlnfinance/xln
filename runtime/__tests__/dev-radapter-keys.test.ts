import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DevRadapterKeysPayload = {
  importUrl: string;
  adminImportUrl: string;
  entries: Array<{ name: string; wsUrl: string; authSeed: string }>;
};

test('dev radapter keys prints one manager source URL without pre-runtime tokens', () => {
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
    const managerLinks = result.stdout.match(/https:\/\/localhost:8084\/radapter\/manage#runtime-import-src=[^\s]+/g) ?? [];
    expect(managerLinks.length).toBe(1);
    expect(result.stdout).not.toContain('key=paste');
    expect(result.stdout).not.toContain('Open these URLs');
    expect(result.stdout).not.toContain('?runtimeList=');
    expect(result.stdout).not.toContain('xlnra1.');

    const payload = JSON.parse(readFileSync(outPath, 'utf8')) as DevRadapterKeysPayload;
    expect(payload.importUrl).toBe(managerLinks[0]);
    expect(payload.importUrl).toContain('/radapter/manage#runtime-import-src=');
    expect(payload.importUrl).not.toContain('?runtimeList=');
    expect(payload.adminImportUrl).toContain('/radapter/manage#runtime-import-src=');
    expect(payload.adminImportUrl).toContain('access%3Dadmin');
    expect(payload.importUrl).not.toContain('xlnra1.');
    expect(payload.adminImportUrl).not.toContain('xlnra1.');
    expect(payload.entries.map(entry => entry.name)).toEqual(['H1', 'H2', 'H3', 'MM']);
    expect(payload.entries[0]?.wsUrl).toBe('ws://127.0.0.1:8092/rpc');
    expect(payload.entries.every(entry => entry.authSeed.length >= 32)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dev radapter keys can suppress early URL logging for bun run dev', () => {
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
      '--suppress-url-log',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('/radapter/manage#runtime-import-src=');
    const payload = JSON.parse(readFileSync(outPath, 'utf8')) as DevRadapterKeysPayload;
    expect(payload.importUrl).toContain('/radapter/manage#runtime-import-src=');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dev radapter keys can run quietly when bun run dev waits for the real manifest URL', () => {
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
      '--suppress-url-log',
      '--quiet',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    const payload = JSON.parse(readFileSync(outPath, 'utf8')) as DevRadapterKeysPayload;
    expect(payload.importUrl).toContain('/radapter/manage#runtime-import-src=');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
