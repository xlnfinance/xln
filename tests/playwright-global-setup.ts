import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const PLAYWRIGHT_ARTIFACT_CLEANUP_CWD = resolve(__dirname, '..');
const PLAYWRIGHT_ARTIFACT_CLEANUP_SCRIPT = resolve(__dirname, '../runtime/scripts/test-artifact-cleanup.ts');

export const runPlaywrightArtifactCleanup = (cwd = PLAYWRIGHT_ARTIFACT_CLEANUP_CWD): void => {
  const inheritedParentLease = process.env['XLN_TEST_ARTIFACT_CLEANUP_DONE'] === '1';
  const result = spawnSync('bun', [
    PLAYWRIGHT_ARTIFACT_CLEANUP_SCRIPT,
    ...(inheritedParentLease ? ['--validate-inherited-lease'] : []),
    '--reason',
    'playwright',
    '--scope',
    'e2e',
    '--cwd',
    cwd,
  ], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PLAYWRIGHT_ARTIFACT_CLEANUP_FAILED: status=${String(result.status)} signal=${String(result.signal)}`);
  }
};

export default async function globalSetup(): Promise<void> {
  runPlaywrightArtifactCleanup();
}
