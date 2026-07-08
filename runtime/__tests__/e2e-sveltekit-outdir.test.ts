import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { materializeSvelteKitShardOutDir } from '../scripts/run-e2e-parallel-isolated';

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'xln-e2e-sveltekit-'));

const writeFile = (root: string, relativePath: string, body = 'x'): void => {
  const path = join(root, relativePath);
  mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(path, body, 'utf8');
};

describe('E2E SvelteKit shard output', () => {
  test('materializes shard output as links to the shared build snapshot', () => {
    const root = makeTempDir();
    try {
      const sourceOutDir = join(root, 'source');
      const shardOutDir = join(root, 'shard-0');
      writeFile(sourceOutDir, 'output/server/manifest.js', 'export const manifest = {};');
      writeFile(sourceOutDir, 'generated/client-manifest.json', '{"ok":true}');
      writeFile(sourceOutDir, 'ambient.d.ts', 'declare const ok: true;');

      materializeSvelteKitShardOutDir(sourceOutDir, shardOutDir);

      expect(existsSync(join(shardOutDir, 'output/server/manifest.js'))).toBe(true);
      expect(readFileSync(join(shardOutDir, 'output/server/manifest.js'), 'utf8')).toContain('manifest');
      expect(lstatSync(join(shardOutDir, 'output')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(shardOutDir, 'generated')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(shardOutDir, 'ambient.d.ts')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails fast when the shared SvelteKit snapshot is incomplete', () => {
    const root = makeTempDir();
    try {
      const sourceOutDir = join(root, 'source');
      const shardOutDir = join(root, 'shard-0');
      writeFile(sourceOutDir, 'output/server/not-manifest.js', 'missing');

      expect(() => materializeSvelteKitShardOutDir(sourceOutDir, shardOutDir)).toThrow(
        'E2E_SVELTE_KIT_OUTPUT_MISSING',
      );
      expect(existsSync(shardOutDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
