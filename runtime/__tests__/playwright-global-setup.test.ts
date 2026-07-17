import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../..');
const globalSetupPath = join(repoRoot, 'tests/playwright-global-setup.ts');

const writeFile = (root: string, relativePath: string, body = 'x'): void => {
  const path = join(root, relativePath);
  mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(path, body, 'utf8');
};

describe('playwright global setup cleanup', () => {
  test('direct Playwright runs remove stale e2e artifacts without deleting the shared frontend build', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-playwright-cleanup-'));
    try {
      writeFile(root, '.logs/e2e-parallel/old-run/log.txt');
      writeFile(root, 'frontend/.svelte-kit-e2e/old-run/output.txt');
      writeFile(root, 'frontend/build/index.html');
      writeFile(root, 'frontend/playwright-report/index.html');

      const result = spawnSync('bun', ['-e', [
        `const mod = await import(${JSON.stringify(globalSetupPath)});`,
        `mod.runPlaywrightArtifactCleanup(${JSON.stringify(root)});`,
      ].join(' ')], {
        cwd: join(repoRoot, 'frontend'),
        env: {
          ...process.env,
          XLN_TEST_ARTIFACT_CLEANUP_DONE: undefined,
          XLN_TEST_ARTIFACT_RUN_TOKEN: undefined,
          XLN_MIN_DISK_FREE_BYTES: '1',
        },
        encoding: 'utf8',
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('test artifact cleanup (playwright): removing .logs/e2e-parallel');
      expect(result.stdout).toContain('test artifact budget (playwright):');
      expect(result.stdout).not.toContain('removing frontend/build');
      expect(existsSync(join(root, '.logs/e2e-parallel'))).toBe(false);
      expect(existsSync(join(root, 'frontend/.svelte-kit-e2e'))).toBe(false);
      expect(readFileSync(join(root, 'frontend/build/index.html'), 'utf8')).toBe('x');
      expect(existsSync(join(root, 'frontend/playwright-report'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('inherited cleanup marker fails loud without its token-bound parent lease', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-playwright-invalid-lease-'));
    try {
      const result = spawnSync('bun', ['-e', [
        `const mod = await import(${JSON.stringify(globalSetupPath)});`,
        `mod.runPlaywrightArtifactCleanup(${JSON.stringify(root)});`,
      ].join(' ')], {
        cwd: repoRoot,
        env: {
          ...process.env,
          XLN_TEST_ARTIFACT_CLEANUP_DONE: '1',
          XLN_TEST_ARTIFACT_RUN_TOKEN: undefined,
          XLN_FOUNDRY_HOME: join(root, '.foundry'),
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TEST_ARTIFACT_RUN_LEASE_REQUIRED');
      expect(result.stderr).toContain('PLAYWRIGHT_ARTIFACT_CLEANUP_FAILED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('root and frontend Playwright configs share the cleanup setup', () => {
    const rootConfig = readFileSync(join(repoRoot, 'playwright.config.ts'), 'utf8');
    const frontendConfig = readFileSync(join(repoRoot, 'frontend/playwright.config.ts'), 'utf8');
    const globalSetup = readFileSync(globalSetupPath, 'utf8');

    expect(rootConfig).toContain("globalSetup: './tests/playwright-global-setup.ts'");
    expect(frontendConfig).toContain("globalSetup: '../tests/playwright-global-setup.ts'");
    expect(rootConfig).toContain("delete process.env['NO_COLOR'];");
    expect(frontendConfig).toContain("delete process.env['NO_COLOR'];");
    expect(globalSetup).toContain('PLAYWRIGHT_ARTIFACT_CLEANUP_CWD');
    expect(globalSetup).toContain("resolve(__dirname, '..')");
    expect(globalSetup).not.toContain('import.meta.dir');
    expect(globalSetup).not.toContain("from '../runtime/scripts/test-artifact-cleanup'");
  });
});
