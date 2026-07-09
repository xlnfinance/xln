import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cleanupTestArtifactsBeforeRun,
  DEFAULT_TEST_WORKSPACE_MAX_BYTES,
  KEEP_TEST_ARTIFACTS_ENV,
  TEST_ARTIFACT_CLEANUP_DONE_ENV,
  TEST_WORKSPACE_MAX_BYTES_ENV,
  withoutTestArtifactCleanupDoneEnv,
} from '../scripts/test-artifact-cleanup';
import { parseRunWithTestCleanupArgs } from '../scripts/run-with-test-cleanup';
import { sanitizeChildProcessEnv } from '../child-process-env';

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
      writeFile(root, 'frontend/.svelte-kit/output/client/app.js');
      writeFile(root, '.logs/bootstrap-soundcheck/probe.log');
      writeFile(root, 'frontend/build/index.html');
      writeFile(root, 'frontend/playwright-report/index.html');
      writeFile(root, 'native/dist/xln.dmg');
      writeFile(root, 'tests/test-results/old.png');
      writeFile(root, '.logs/soak/old.json');
      writeFile(root, '.logs/system-tests/old/log.txt');
      writeFile(root, '.logs/gates/report.json');
      writeFile(root, '.logs/bench-radapter/result.json');

      const summary = cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: {},
        argv: [],
        reason: 'unit',
        log: () => undefined,
      });

      expect(summary.skipped).toBe(false);
      expect(summary.maxBytes).toBe(DEFAULT_TEST_WORKSPACE_MAX_BYTES);
      expect(summary.estimatedWorkspaceBytes).toBeGreaterThanOrEqual(0);
      expect(summary.estimatedBudgetedBytes).toBeLessThan(1024 * 1024);
      expect(summary.removed).toContain('.logs/e2e-parallel');
      expect(summary.removed).toContain('.logs/scenarios-parallel');
      expect(summary.removed).toContain('frontend/.svelte-kit-e2e');
      expect(summary.removed).toContain('frontend/.svelte-kit/output');
      expect(summary.removed).toContain('frontend/build');
      expect(summary.removed).toContain('frontend/playwright-report');
      expect(summary.removed).toContain('native/dist');
      expect(summary.removed).toContain('tests/test-results');
      expect(summary.removed).toContain('.logs/soak');
      expect(summary.removed).toContain('.logs/system-tests');
      expect(summary.removed).toContain('.logs/gates');
      expect(summary.removed).toContain('.logs/bench-radapter');
      expect(existsSync(join(root, '.logs/e2e-parallel'))).toBe(false);
      expect(existsSync(join(root, '.logs/scenarios-parallel'))).toBe(false);
      expect(existsSync(join(root, 'frontend/.svelte-kit-e2e'))).toBe(false);
      expect(existsSync(join(root, 'frontend/.svelte-kit/output'))).toBe(false);
      expect(existsSync(join(root, 'frontend/build'))).toBe(false);
      expect(existsSync(join(root, 'frontend/playwright-report'))).toBe(false);
      expect(existsSync(join(root, 'native/dist'))).toBe(false);
      expect(existsSync(join(root, 'tests/test-results'))).toBe(false);
      expect(existsSync(join(root, '.logs/soak'))).toBe(false);
      expect(existsSync(join(root, '.logs/system-tests'))).toBe(false);
      expect(existsSync(join(root, '.logs/gates'))).toBe(false);
      expect(existsSync(join(root, '.logs/bench-radapter'))).toBe(false);
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
      expect(summary.estimatedWorkspaceBytes).toBeGreaterThan(0);
      expect(existsSync(join(root, '.logs/e2e-parallel/old-run/log.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserve mode still enforces the workspace budget', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/e2e-parallel/old-run/log.txt', 'too-large-for-budget');

      expect(() => cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: {
          [KEEP_TEST_ARTIFACTS_ENV]: '1',
          [TEST_WORKSPACE_MAX_BYTES_ENV]: '1',
        },
        argv: [],
        reason: 'unit-keep-budget',
        log: () => undefined,
      })).toThrow('TEST_WORKSPACE_BUDGET_EXCEEDED');
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
      expect(summary.estimatedWorkspaceBytes).toBeGreaterThan(0);
      expect(existsSync(join(root, '.logs/e2e-parallel/current-parent-run/log.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('child-runner skip still enforces the workspace budget', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, '.logs/e2e-parallel/current-parent-run/log.txt', 'too-large-for-budget');

      expect(() => cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: {
          [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1',
          [TEST_WORKSPACE_MAX_BYTES_ENV]: '1',
        },
        argv: [],
        reason: 'unit-child-budget',
        log: () => undefined,
      })).toThrow('TEST_WORKSPACE_BUDGET_EXCEEDED');
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

  test('fails when the whole workspace exceeds the configured budget', () => {
    const root = makeTempWorkspace();
    try {
      writeFile(root, 'node_modules/.cache/large.bin', 'too-large-for-budget');

      expect(() => cleanupTestArtifactsBeforeRun({
        cwd: root,
        env: { [TEST_WORKSPACE_MAX_BYTES_ENV]: '1' },
        argv: [],
        reason: 'unit-workspace-budget',
        log: () => undefined,
      })).toThrow('TEST_WORKSPACE_BUDGET_EXCEEDED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('default workspace budget is the agreed 50 GiB repo cap', () => {
    expect(DEFAULT_TEST_WORKSPACE_MAX_BYTES).toBe(50 * 1024 * 1024 * 1024);
  });

  test('run-with-test-cleanup keeps cleanup flags out of the child command', () => {
    const parsed = parseRunWithTestCleanupArgs([
      '--reason=frontend-playwright',
      '--scope=e2e',
      '--cwd=..',
      '--child-cwd=frontend',
      '--',
      'playwright',
      'test',
      '--keep-test-artifacts',
      'tests/landing.spec.ts',
    ]);

    expect(parsed.reason).toBe('frontend-playwright');
    expect(parsed.scope).toBe('e2e');
    expect(parsed.cleanupCwd).toBe('..');
    expect(parsed.childCwd).toBe('frontend');
    expect(parsed.command).toBe('playwright');
    expect(parsed.commandArgs).toEqual(['test', 'tests/landing.spec.ts']);
    expect(parsed.cleanupArgv).toContain('--keep-test-artifacts');
  });

  test('child process env sanitizer removes NO_COLOR before child tools can set FORCE_COLOR', () => {
    const env = sanitizeChildProcessEnv({
      FORCE_COLOR: '1',
      NO_COLOR: '1',
      KEEP_ME: 'yes',
    });

    expect(env).toEqual({ FORCE_COLOR: '1', KEEP_ME: 'yes' });
  });

  test('package test shortcuts run through cleanup before direct browser or hardhat tests', () => {
    const repoRoot = process.cwd();
    const rootPackage = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    const frontendPackage = readFileSync(join(repoRoot, 'frontend/package.json'), 'utf8');
    const contractsPackage = readFileSync(join(repoRoot, 'jurisdictions/package.json'), 'utf8');
    const scenarioRunner = readFileSync(join(repoRoot, 'runtime/scenarios/run.ts'), 'utf8');

    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=e2e-payment-smoke --scope=e2e');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=e2e-prod-payment --scope=e2e');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=contracts --child-cwd=jurisdictions');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=governance --child-cwd=jurisdictions');
    expect(rootPackage).toContain('run-with-test-cleanup.ts --reason=entity --child-cwd=jurisdictions');
    expect(rootPackage).toContain('"test:scenarios:parallel:isolated": "bun runtime/scenarios/run.ts"');
    expect(rootPackage).toContain('"test:feedback:20": "bun runtime/scenarios/run.ts --set=smoke --workers=2"');
    expect(scenarioRunner).toContain("cleanupTestArtifactsBeforeRun({ reason: 'scenarios', argv: process.argv.slice(2) })");
    expect(scenarioRunner).toContain("cleanupTestArtifactsBeforeRun({ reason: 'scenario', argv: process.argv.slice(2) })");
    expect(scenarioRunner).toContain("[TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1'");
    expect(frontendPackage).toContain('../runtime/scripts/run-with-test-cleanup.ts --cwd=.. --reason=frontend-playwright --scope=e2e');
    expect(frontendPackage).toContain('../runtime/scripts/run-with-test-cleanup.ts --cwd=.. --reason=frontend-ui --scope=e2e');
    expect(contractsPackage).toContain('../runtime/scripts/run-with-test-cleanup.ts --cwd=.. --reason=contracts');
    expect(contractsPackage).toContain('../runtime/scripts/run-with-test-cleanup.ts --cwd=.. --reason=contracts-default');
  });
});
