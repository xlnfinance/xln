import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('dev link banner prints stable subsystem links and bulk import fragments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xln-dev-links-'));
  const keysPath = join(dir, 'radapter-keys.json');
  const envPath = join(dir, 'radapter-keys.env');

  try {
    const keys = spawnSync('bun', [
      'runtime/scripts/dev-radapter-keys.ts',
      '--web-port',
      '8084',
      '--api-port',
      '8082',
      '--out',
      keysPath,
      '--env-out',
      envPath,
      '--suppress-url-log',
      '--quiet',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(keys.status, keys.stderr).toBe(0);

    const banner = spawnSync('bun', [
      'runtime/scripts/print-dev-links.ts',
      '--web-port',
      '8084',
      '--web-http-port',
      '8085',
      '--api-port',
      '8082',
      '--rpc-port',
      '8545',
      '--rpc2-port',
      '8546',
      '--custody-port',
      '8087',
      '--custody-daemon-port',
      '8088',
      '--watchtower-port',
      '9100',
      '--keys',
      keysPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    });

    expect(banner.status, banner.stderr).toBe(0);
    expect(banner.stdout).toContain('XLN DEV CONTROL PANEL');
    expect(banner.stdout).toContain('Open any subsystem from here');
    expect(banner.stdout).toContain('wallet');
    expect(banner.stdout).toContain('https://localhost:8084/app');
    expect(banner.stdout).toContain('wallet browser QA');
    expect(banner.stdout).toContain('http://localhost:8085/app');
    expect(banner.stdout).toContain('radapter manager QA');
    expect(banner.stdout).toContain('http://localhost:8085/radapter/manage');
    expect(banner.stdout).toContain('health admin');
    expect(banner.stdout).toContain('https://localhost:8084/health');
    expect(banner.stdout).toContain('qa cockpit');
    expect(banner.stdout).toContain('https://localhost:8084/qa');
    expect(banner.stdout).toContain('remote import read');
    expect(banner.stdout).toContain('remote import admin');
    expect(banner.stdout).toContain('/app#runtime-import-src=');
    expect(banner.stdout).not.toContain('/radapter/manage#runtime-import-src=');
    expect(banner.stdout).toContain('access%3Dread');
    expect(banner.stdout).toContain('access%3Dadmin');
    expect(banner.stdout).not.toContain('xlnra1.');
    expect(banner.stdout).not.toContain('\u001B]8;;');
    expect(banner.stdout).not.toContain('[open read import]');
    expect(banner.stdout).toContain('runtime import key file:');
    expect(banner.stdout).toContain('http://127.0.0.1:8082/api/health');
    expect(banner.stdout).toContain('https://localhost:8087');
    expect(banner.stdout).toContain('http://127.0.0.1:9100/api/tower/healthz');
    expect(banner.stdout).toContain('runtime import links fetch fresh tokens into the app runtime list.');
    expect(banner.stdout).toContain('VITE_HTTP');
    expect(banner.stdout).not.toContain('key=paste');
    expect(banner.stdout).not.toContain('Open these URLs');
    expect(banner.stdout).not.toContain('?runtimeList=');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bun run dev does not print token-bearing runtime import URLs by default', () => {
  const runDev = readFileSync(join(process.cwd(), 'scripts/dev/run-dev.sh'), 'utf8');

  expect(runDev).not.toContain('XLN_RUNTIME_IMPORT_LOG_URL=1');
  expect(runDev).toContain('runtime/orchestrator/orchestrator.ts');
  expect(runDev).toContain('MESH_LOG_LEVEL="${XLN_LOG_LEVEL:-warn}"');
  expect(runDev).toContain('XLN_LOG_LEVEL=${MESH_LOG_LEVEL}');
});
