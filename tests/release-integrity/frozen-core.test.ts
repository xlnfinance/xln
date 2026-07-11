import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildFrozenTree, collectFrozenCore, createFrozenManifest, hashFrozenFile } from '../../tools/frozen-core/core.ts';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'xln-frozen-core-'));
  roots.push(root);
  writeFileSync(join(root, 'VERSION'), '0.1.7\n');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(join(root, 'runtime/helper.ts'), 'export const value = 7;\n');
  writeFileSync(join(root, 'runtime/runtime.ts'), "import { value } from './helper';\nexport const result = value;\n");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('frozen core integrity', () => {
  test('builds a stable raw-byte Merkle root and reports mutable imports', () => {
    const root = fixture();
    const manifest = createFrozenManifest(root, ['runtime/runtime.ts'], '0.1.7', 'test baseline');
    const first = collectFrozenCore(root, manifest, '0.1.7');
    const second = collectFrozenCore(root, manifest, '0.1.7');

    expect(first.rootHash).toBe(second.rootHash);
    expect(first.status).toBe('UNCHANGED');
    expect(first.mutableDependencies).toEqual([{ source: 'runtime/runtime.ts', dependency: 'runtime/helper.ts' }]);
  });

  test('fails closed when one frozen byte changes', () => {
    const root = fixture();
    const manifest = createFrozenManifest(root, ['runtime/runtime.ts'], '0.1.7', 'test baseline');
    writeFileSync(join(root, 'runtime/runtime.ts'), "import { value } from './helper';\nexport const result = value + 1;\n");

    expect(() => collectFrozenCore(root, manifest, '0.1.7')).toThrow('FROZEN_CORE_VIOLATION');
  });

  test('renders a recorded owner approval only in its release', () => {
    const root = fixture();
    const manifest = createFrozenManifest(root, ['runtime/runtime.ts'], '0.1.7', 'test baseline');
    const old = manifest.files[0]!;
    writeFileSync(join(root, 'runtime/runtime.ts'), "import { value } from './helper';\nexport const result = value + 1;\n");
    const current = hashFrozenFile(root, old.path);
    manifest.approvals.push({
      path: old.path,
      oldContentHash: old.contentHash,
      newContentHash: current.contentHash,
      oldLeafHash: old.leafHash,
      newLeafHash: current.leafHash,
      release: '0.1.7',
      approvedAt: '2026-07-11T00:00:00.000Z',
      comment: 'Approved test mutation.',
    });
    Object.assign(old, current);
    manifest.rootHash = buildFrozenTree(manifest.files).hash;

    expect(collectFrozenCore(root, manifest, '0.1.7').status).toBe('APPROVED CHANGE');
    expect(collectFrozenCore(root, manifest, '0.1.8').status).toBe('UNCHANGED');
  });

  test('refuses to overwrite an existing frozen-core manifest through init', () => {
    const root = fixture();
    const manifestPath = join(root, 'frozen-core.json');
    const sentinel = '{"ownerApproved":true}\n';
    writeFileSync(manifestPath, sentinel);

    const result = Bun.spawnSync([
      process.execPath,
      resolve(import.meta.dir, '../../tools/frozen-core.ts'),
      'init',
      'runtime/runtime.ts',
      '--reason=attacker reset attempt',
    ], { cwd: root, stdout: 'pipe', stderr: 'pipe' });

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain('FROZEN_CORE_ALREADY_INITIALIZED');
    expect(readFileSync(manifestPath, 'utf8')).toBe(sentinel);
  });
});
