import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

const sourceFiles = (directory: string): string[] => readdirSync(directory)
  .flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  })
  .filter((path) => /\.(?:ts|tsx|js)$/.test(path));

const forbiddenImports = (directory: string, patterns: readonly RegExp[]): string[] =>
  sourceFiles(directory).flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    return patterns.some((pattern) => pattern.test(source)) ? [relative(root, path)] : [];
  });

const containsForbiddenImport = (source: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(source));

test('framework-neutral packages do not import React or Svelte', () => {
  expect(forbiddenImports(resolve(root, 'frontend/packages/client-core'), [
    /from ['"]react['"]/,
    /from ['"]svelte(?:\/store)?['"]/,
  ])).toEqual([]);
});

test('target store modules keep framework imports in adapters', () => {
  const targetStores = [
    'appStateStore.ts',
    'errorLogStore.ts',
    'runtimeCommandBus.ts',
    'runtimeControllerStore.ts',
    'runtimeQueryClient.ts',
    'runtimeStore.ts',
    'settingsStore.ts',
    'tabStore.ts',
    'timeStore.ts',
    'toastStore.ts',
    'xlnRuntimeLoader.ts',
  ];
  const violations = targetStores.filter((file) => containsForbiddenImport(
    readFileSync(resolve(root, 'frontend/src/lib/stores', file), 'utf8'),
    [/from ['"]react['"]/, /from ['"]svelte(?:\/store)?['"]/],
  ));
  expect(violations).toEqual([]);
});

test('React and Svelte adapters cannot import each other', () => {
  expect(forbiddenImports(resolve(root, 'frontend/packages/react-adapters'), [
    /from ['"]svelte(?:\/store)?['"]/,
    /src\/lib\/stores\/adapters\/svelteExternalStore/,
  ])).toEqual([]);
  expect(forbiddenImports(resolve(root, 'frontend/src/lib/stores/adapters'), [
    /from ['"]react['"]/,
    /packages\/react-adapters/,
  ])).toEqual([]);
});

test('public site and docs cannot import the runtime client or store adapters', () => {
  for (const surface of ['site', 'docs']) {
    expect(forbiddenImports(resolve(root, `frontend/apps/${surface}`), [
      /packages\/runtime-client/,
      /src\/lib\/stores/,
      /packages\/react-adapters/,
    ])).toEqual([]);
  }
});

test('boundary matcher rejects fixture violations', () => {
  expect(containsForbiddenImport(
    "import { writable } from 'svelte/store';",
    [/from ['"]svelte(?:\/store)?['"]/],
  )).toBe(true);
  expect(containsForbiddenImport(
    "import { useSyncExternalStore } from 'react';",
    [/from ['"]react['"]/],
  )).toBe(true);
});
