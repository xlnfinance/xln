import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  collectFolderWidths,
  evaluateFolderWidths,
  FOLDER_WIDTH_DEBT,
} from '../../runtime/scripts/checks/architecture/check-folder-width';

const temporaryRoots: string[] = [];

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'xln-folder-width-'));
  temporaryRoots.push(root);
  return root;
};

const addTypeScriptFiles = (directory: string, count: number): void => {
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(directory, `file-${index}.ts`), 'export {};\n');
  }
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository source folder-width invariant', () => {
  test('allows ten direct source files and rejects the eleventh', () => {
    expect(evaluateFolderWidths([{ path: 'runtime/ten', files: 10 }], {})).toEqual([]);
    expect(evaluateFolderWidths([{ path: 'runtime/eleven', files: 11 }], {})).toEqual([
      'FOLDER_TOO_WIDE runtime/eleven:11 > 10',
    ]);
  });

  test('counts every supported source language together and ignores data files', () => {
    const root = makeRoot();
    const extensions = [
      'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'svelte', 'sol', 'sh',
    ];
    for (const [index, extension] of extensions.entries()) {
      writeFileSync(join(root, `source-${index}.${extension}`), 'source\n');
    }
    writeFileSync(join(root, 'notes.md'), 'not source\n');
    writeFileSync(join(root, 'data.json'), '{}\n');

    expect(collectFolderWidths(root)).toEqual([{ path: '.', files: 11 }]);
  });

  test('counts nested directories independently and does not exempt fixtures', () => {
    const root = makeRoot();
    addTypeScriptFiles(root, 2);
    addTypeScriptFiles(join(root, 'fixtures'), 11);
    expect(collectFolderWidths(root)).toEqual([
      { path: '.', files: 2 },
      { path: 'fixtures', files: 11 },
    ]);
    expect(evaluateFolderWidths(collectFolderWidths(root), {})).toEqual([
      'FOLDER_TOO_WIDE fixtures:11 > 10',
    ]);
  });

  test('requires debt to match exactly and rejects stale allowances', () => {
    expect(evaluateFolderWidths([{ path: 'runtime/debt', files: 12 }], { 'runtime/debt': 12 })).toEqual([]);
    expect(evaluateFolderWidths([{ path: 'runtime/debt', files: 13 }], { 'runtime/debt': 12 })).toEqual([
      'FOLDER_WIDTH_DEBT_CHANGED runtime/debt:13 != 12',
    ]);
    expect(evaluateFolderWidths([{ path: 'runtime/debt', files: 11 }], { 'runtime/debt': 12 })).toEqual([
      'FOLDER_WIDTH_DEBT_CHANGED runtime/debt:11 != 12',
    ]);
    expect(evaluateFolderWidths([{ path: 'runtime/debt', files: 10 }], { 'runtime/debt': 12 })).toEqual([
      'STALE_FOLDER_WIDTH_DEBT runtime/debt:10 <= 10',
    ]);
    expect(evaluateFolderWidths([], { 'runtime/debt': 12 })).toEqual([
      'STALE_FOLDER_WIDTH_DEBT runtime/debt:missing allowance=12',
    ]);
  });

  test('ignores symlinked files and directories instead of escaping the scanned tree', () => {
    const root = makeRoot();
    const outside = makeRoot();
    addTypeScriptFiles(outside, 11);
    writeFileSync(join(root, 'real.ts'), 'export {};\n');
    symlinkSync(join(outside, 'file-0.ts'), join(root, 'linked.ts'));
    symlinkSync(outside, join(root, 'linked-directory'));
    expect(collectFolderWidths(root)).toEqual([{ path: '.', files: 1 }]);
  });

  test('prunes generated and exact excluded trees without hiding similarly named source', () => {
    const root = makeRoot();
    addTypeScriptFiles(join(root, 'node_modules'), 11);
    addTypeScriptFiles(join(root, 'build'), 11);
    addTypeScriptFiles(join(root, '.archive'), 11);
    addTypeScriptFiles(join(root, 'reports'), 11);
    addTypeScriptFiles(join(root, 'reports-live'), 11);
    addTypeScriptFiles(join(root, 'src', 'build-tools'), 11);

    expect(collectFolderWidths(root)).toEqual([
      { path: '.', files: 0 },
      { path: 'reports-live', files: 11 },
      { path: 'src', files: 0 },
      { path: 'src/build-tools', files: 11 },
    ]);
  });

  test('the repository has only the exact declared source-folder debt', () => {
    const repoRoot = resolve(import.meta.dir, '../..');
    const widths = collectFolderWidths(repoRoot);
    expect(evaluateFolderWidths(widths, FOLDER_WIDTH_DEBT)).toEqual([]);
    expect(widths.filter(entry => entry.files > 10)).toEqual([
      { path: 'brainvault', files: 11 },
      { path: 'frontend', files: 11 },
      { path: 'frontend/src/lib/components/Entity', files: 45 },
      { path: 'frontend/src/lib/stores', files: 13 },
      { path: 'jurisdictions/contracts', files: 16 },
      { path: 'jurisdictions/test', files: 19 },
      { path: 'scripts', files: 25 },
      { path: 'scripts/dev', files: 12 },
      { path: 'tests', files: 53 },
      { path: 'tests/frontend', files: 45 },
      { path: 'tests/utils', files: 20 },
    ]);
  });

  test('runtime retains no source-folder debt', () => {
    const repoRoot = resolve(import.meta.dir, '../..');
    const runtimeWidths = collectFolderWidths(repoRoot, resolve(repoRoot, 'runtime'));
    expect(runtimeWidths.filter(entry => entry.files > 10)).toEqual([]);
  });
});
