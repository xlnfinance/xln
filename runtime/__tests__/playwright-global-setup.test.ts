import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  test('direct Playwright runs remove stale e2e artifacts before starting', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-playwright-cleanup-'));
    try {
      writeFile(root, '.logs/e2e-parallel/old-run/log.txt');
      writeFile(root, 'frontend/.svelte-kit-e2e/old-run/output.txt');
      writeFile(root, 'frontend/build/index.html');

      const result = spawnSync('bun', ['-e', `import globalSetup from ${JSON.stringify(globalSetupPath)}; await globalSetup();`], {
        cwd: root,
        env: {
          ...process.env,
          XLN_MIN_DISK_FREE_BYTES: '1',
        },
        encoding: 'utf8',
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('test artifact cleanup (playwright): removing .logs/e2e-parallel');
      expect(result.stdout).toContain('test artifact budget (playwright):');
      expect(existsSync(join(root, '.logs/e2e-parallel'))).toBe(false);
      expect(existsSync(join(root, 'frontend/.svelte-kit-e2e'))).toBe(false);
      expect(existsSync(join(root, 'frontend/build'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
