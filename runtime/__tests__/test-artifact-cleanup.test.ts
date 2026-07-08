import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cleanupTestArtifactsBeforeRun,
  KEEP_TEST_ARTIFACTS_ENV,
  TEST_ARTIFACT_CLEANUP_DONE_ENV,
  TEST_WORKSPACE_MAX_BYTES_ENV,
  withoutTestArtifactCleanupDoneEnv,
} from '../scripts/test-artifact-cleanup';

const makeTempWorkspace = (): string => mkdtempSync(join(tmpdir(), 'xln-test-artifacts-'));

const writeFile = (root: string, relativePath: string, body = 'x'): void => {
  const path = join(root, relativePath);
  mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(path, body, 'utf8');
};

describe('test artifact cleanup', () => {
  test('removes generated test artifacts by default', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/e2e-parallel/old-run/log.txt');
      writeFile(root, '.logs/scenarios-parallel/old-run/log.txt');
      writeFile(root, 'frontend/.svelte-kit-e2e/old-run/output.txt');
      writeFile(root, '.logs/bootstrap-soundcheck/probe.log');
      writeFile(root, 'frontend/build/index.html');
      writeFile(root, 'native/dist/xln.dmg');
      writeFile(root, 'tests/test-results/old.png');

      const summary = cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: {},
        argv: [],
        reason: 'unit',
        log: () => undefined,
      });

      expect(summary.skipped).toBe(false);
      expect(summary.removed).toContain('.logs/e2e-parallel');
      expect(summary.removed).toContain('.logs/scenarios-parallel');
      expect(summary.removed).toContain('frontend/.svelte-kit-e2e');
      expect(summary.removed).toContain('frontend/build');
      expect(summary.removed).toContain('native/dist');
      expect(summary.removed).toContain('tests/test-results');
      expect(existsSync(join(root, '.logs/e2e-parallel'))).toBe(false);
      expect(existsSync(join(root, '.logs/scenarios-parallel'))).toBe(false);
      expect(existsSync(join(root, 'frontend/.svelte-kit-e2e'))).toBe(false);
      expect(existsSync(join(root, 'frontend/build'))).toBe(false);
      expect(existsSync(join(root, 'native/dist'))).toBe(false);
      expect(existsSync(join(root, 'tests/test-results'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves artifacts when caller asks to keep them', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/e2e-parallel/old-run/log.txt');

      const summary = cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: { [KEEP_TEST_ARTIFACTS_ENV]: '1' },
        argv: [],
        reason: 'unit',
        log: () => undefined,
      });

      expect(summary.skipped).toBe(true);
      expect(existsSync(join(root, '.logs/e2e-parallel/old-run/log.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('child runners skip cleanup after the parent runner did it', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/e2e-parallel/current-parent-run/log.txt');

      const summary = cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: { [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1' },
        argv: [],
        reason: 'unit-child',
        log: () => undefined,
      });

      expect(summary.skipped).toBe(true);
      expect(existsSync(join(root, '.logs/e2e-parallel/current-parent-run/log.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('e2e scope can refresh isolated browser artifacts inside a parent gate', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/e2e-parallel/old-run/log.txt');
      writeFile(root, 'frontend/.svelte-kit-e2e/old-run/output.txt');
      writeFile(root, 'frontend/build/index.html');
      writeFile(root, 'native/dist/xln.dmg');
      writeFile(root, '.logs/bootstrap-soundcheck/current/probe.log');

      const summary = cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: { [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1' },
        argv: [],
        reason: 'unit-e2e',
        scope: 'e2e',
        skipIfAlreadyDone: false,
        log: () => undefined,
      });

      expect(summary.skipped).toBe(false);
      expect(summary.removed).toContain('.logs/e2e-parallel');
      expect(summary.removed).toContain('frontend/.svelte-kit-e2e');
      expect(summary.removed).toContain('frontend/build');
      expect(summary.removed).not.toContain('.logs/bootstrap-soundcheck');
      expect(summary.removed).not.toContain('native/dist');
      expect(existsSync(join(root, '.logs/e2e-parallel'))).toBe(false);
      expect(existsSync(join(root, 'frontend/.svelte-kit-e2e'))).toBe(false);
      expect(existsSync(join(root, 'frontend/build'))).toBe(false);
      expect(existsSync(join(root, 'native/dist/xln.dmg'))).toBe(true);
      expect(existsSync(join(root, '.logs/bootstrap-soundcheck/current/probe.log'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('child runtime env can drop the cleanup marker before browser builds', () => {
    const env = withoutTestArtifactCleanupDoneEnv({
      [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1',
      KEEP_ME: 'yes',
    });

    expect(env[TEST_ARTIFACT_CLEANUP_DONE_ENV]).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');
  });

  test('fails when generated workspace artifacts exceed the configured budget', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/qa-history.sqlite', 'too-large-for-budget');

      expect(() => cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: { [TEST_WORKSPACE_MAX_BYTES_ENV]: '1' },
        argv: [],
        reason: 'unit-budget',
        log: () => undefined,
      })).toThrow('TEST_WORKSPACE_BUDGET_EXCEEDED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
