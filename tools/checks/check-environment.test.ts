import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { assertCheckEnvironment } from './check-environment';

const root = resolve(import.meta.dir, '../..');

test('checks accept the pinned Bun at the repository root', () => {
  expect(() => assertCheckEnvironment()).not.toThrow();
});

test('checks reject a different Bun version', () => {
  expect(() => assertCheckEnvironment(root, '1.3.0')).toThrow('CHECK_BUN_VERSION_MISMATCH:running=1.3.0:pinned=1.4.3');
});

for (const entry of [
  'scripts/verification/verify.ts',
  'scripts/verification/pre-push.ts',
  'core/scripts/e2e/runners/run-unit-tests.ts',
  'core/scripts/e2e/runners/run-all-tests-fast.ts',
  'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts',
  'core/scripts/e2e/runners/run-system-tests-parallel.ts',
  'core/scripts/e2e/runners/run-e2e-fast.ts',
  'core/scenarios/run.ts',
]) {
  test(`${entry} rejects a nested cwd before launching work or reading stdin`, () => {
    const child = Bun.spawnSync([process.execPath, resolve(root, entry)], {
      cwd: resolve(root, 'core'),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 2_000,
    });
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain('CHECK_CWD_MISMATCH:');
  });
}
