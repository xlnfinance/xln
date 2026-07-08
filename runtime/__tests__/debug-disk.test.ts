import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../..');
const scriptPath = join(repoRoot, 'runtime/scripts/debug-disk.ts');
const packageJsonPath = join(repoRoot, 'package.json');

describe('debug:disk', () => {
  test('prints read-only disk JSON without writing storage history', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-debug-disk-'));
    try {
      const result = spawnSync('bun', [scriptPath, '--json'], {
        cwd: root,
        env: {
          ...process.env,
          XLN_MIN_DISK_FREE_BYTES: '1',
        },
        encoding: 'utf8',
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        readOnly: boolean;
        minFreeBytes: number;
        freeBytes: number;
        tracked: unknown[];
      };
      expect(payload.ok).toBe(true);
      expect(payload.readOnly).toBe(true);
      expect(payload.minFreeBytes).toBeGreaterThanOrEqual(1024 ** 3);
      expect(payload.freeBytes).toBeGreaterThan(0);
      expect(Array.isArray(payload.tracked)).toBe(true);
      expect(existsSync(join(root, 'data/storage-health-history.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('package exposes the disk diagnostic script', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['debug:disk']).toBe('bun runtime/scripts/debug-disk.ts');
  });
});
