import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../..');

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
      cwd: repoRoot,
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
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    expect(banner.status, banner.stderr).toBe(0);
    expect(banner.stdout).toContain('XLN DEV CONTROL PANEL');
    expect(banner.stdout).toContain('Open any subsystem from here');
    expect(banner.stdout).toContain('service status/log lines stream below');
    expect(banner.stdout).toContain('wallet');
    expect(banner.stdout).toContain('https://localhost:8084/app');
    expect(banner.stdout).toContain('wallet browser QA');
    expect(banner.stdout).toContain('http://localhost:8085/app');
    expect(banner.stdout).toContain('health admin');
    expect(banner.stdout).toContain('https://localhost:8084/health');
    expect(banner.stdout).toContain('qa cockpit');
    expect(banner.stdout).toContain('https://localhost:8084/qa');
    expect(banner.stdout).toContain('remote import read');
    expect(banner.stdout).toContain('remote import admin');
    expect(banner.stdout).toContain('suggested runtimes');
    expect(banner.stdout).toContain('http://127.0.0.1:8082/api/runtime-import?access=read');
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
    expect(banner.stdout).toContain('suggested runtimes endpoint lists fresh H/MM/Custody import tokens for the app runtime list.');
    expect(banner.stdout).toContain('expected remote runtimes: H1, H2, H3, MM, Custody');
    expect(banner.stdout).toContain('status/logs below:');
    expect(banner.stdout).toContain('VITE_HTTP');
    expect(banner.stdout).not.toContain('radapter manager QA');
    expect(banner.stdout).not.toContain('radapter inspector');
    expect(banner.stdout).not.toContain('radapter manager');
    expect(banner.stdout).not.toContain('/radapter/manage');
    expect(banner.stdout).not.toContain('key=paste');
    expect(banner.stdout).not.toContain('Open these URLs');
    expect(banner.stdout).not.toContain('?runtimeList=');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bun run dev does not print token-bearing runtime import URLs by default', () => {
  const runDev = readFileSync(join(repoRoot, 'scripts/dev/run-dev.sh'), 'utf8');
  const devChild = readFileSync(join(repoRoot, 'scripts/dev/run-dev-child.sh'), 'utf8');
  const runtimeWatcher = readFileSync(join(repoRoot, 'scripts/dev/watch-runtime-build.sh'), 'utf8');

  expect(runDev).not.toContain('XLN_RUNTIME_IMPORT_LOG_URL=1');
  expect(runDev).toContain('DEV_CHILD_COMMAND="\\"$REPO_ROOT/scripts/dev/run-dev-child.sh\\""');
  expect(runDev).toContain('"${DEV_CHILD_COMMAND} stack"');
  expect(devChild).toContain('"${DEV_CHILD_COMMAND} mesh"');
  expect(devChild).toContain('"${DEV_CHILD_COMMAND} vite-http"');
  expect(runDev).not.toContain('USE_ANVIL=true RUNTIME_VERBOSE_LOGS=');
  expect(runDev).not.toContain('exec concurrently');
  expect(runDev).toContain('bun --no-orphans "$CONCURRENTLY_JS"');
  expect(runDev).toContain('--kill-timeout 5000');
  expect(runDev).toContain('trap cleanup_dev_stack EXIT');
  expect(runDev).toContain('concurrently_status=$?');
  expect(runDev).toContain('exit "$concurrently_status"');
  expect(devChild).toContain('runtime/orchestrator/orchestrator.ts');
  expect(devChild).toContain('DEV_CHILD_ROLE_UNKNOWN');
  expect(devChild).toContain('set -euo pipefail');
  expect(devChild).toContain('VITE_DEV_SERVER_START port=${port}');
  expect(devChild).toContain('XLN_AUTO_PROVISION_EXTERNAL_FAUCET="${XLN_AUTO_PROVISION_EXTERNAL_FAUCET:-1}"');
  expect(devChild).toContain('./scripts/dev/watch-runtime-build.sh');
  expect(runDev).not.toContain('bun build runtime/runtime.ts');
  expect(runDev).toContain('MESH_LOG_LEVEL="${XLN_LOG_LEVEL:-warn}"');
  expect(devChild).toContain('XLN_LOG_LEVEL="$MESH_LOG_LEVEL"');
  expect(runtimeWatcher).toContain('set -euo pipefail');
  expect(runtimeWatcher).toContain('bun --no-orphans build runtime/runtime.ts');
  expect(runtimeWatcher).toContain('--external buffer');
  expect(runtimeWatcher).toContain('if [[ -z "${line//[[:space:]]/}" ]]');
});

test('dev hub does not disable durable storage during bootstrap', () => {
  const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');

  expect(hubNode).not.toContain("nodeLog.info('dev_bootstrap.storage_disabled'");
  expect(hubNode).not.toContain('DEV_BOOTSTRAP_STORAGE_DISABLED');
  expect(hubNode).not.toContain('BOOTSTRAP_STORAGE_PAUSED');
});
