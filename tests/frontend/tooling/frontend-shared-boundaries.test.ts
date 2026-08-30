import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAPABILITIES } from '../../../frontend/config/capabilities';
import { PLATFORM_INVENTORY } from '../../../frontend/config/platform-inventory';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PACKAGE_ROOTS = [
  'frontend/packages/browser/src',
  'frontend/packages/runtime-client/src',
] as const;

const walkFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(join(REPOSITORY_ROOT, root), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const pathname = `${root}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await walkFiles(pathname));
    else if (entry.isFile()) paths.push(pathname);
  }
  return paths.sort((left, right) => left.localeCompare(right));
};

const readSources = async (roots: readonly string[]): Promise<ReadonlyMap<string, string>> => {
  const paths = (await Promise.all(roots.map((root) => walkFiles(root)))).flat();
  return new Map(await Promise.all(paths.map(async (pathname) => [
    pathname,
    await readFile(join(REPOSITORY_ROOT, pathname), 'utf8'),
  ] as const)));
};

const importSpecifiers = (source: string): readonly string[] => [
  ...source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g),
].map((match) => match[1] ?? '');

describe('frontend shared browser and Runtime-client boundaries', () => {
  test('keeps every shared module in the typed ownership inventory', async () => {
    const modules = (await Promise.all(PACKAGE_ROOTS.map((root) => walkFiles(root)))).flat();
    const inventory = new Set([
      ...CAPABILITIES.flatMap(({ currentSources }) => currentSources),
      ...PLATFORM_INVENTORY.flatMap(({ sources }) => sources),
    ]);

    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) expect(inventory.has(module)).toBe(true);
  });

  test('has live legacy-Svelte and React consumers for both shared packages', async () => {
    const consumers = await readSources(['frontend/src', 'frontend/apps']);
    for (const packageName of ['browser', 'runtime-client'] as const) {
      const marker = `packages/${packageName}/src`;
      const paths = [...consumers]
        .filter(([, source]) => source.includes(marker))
        .map(([pathname]) => pathname);

      expect(paths.some((pathname) => pathname.startsWith('frontend/src/'))).toBe(true);
      expect(paths.some((pathname) => pathname.startsWith('frontend/apps/'))).toBe(true);
    }
  });

  test('does not import Runtime, Entity, Account, consensus, or persistence implementations', async () => {
    const sources = await readSources(PACKAGE_ROOTS);
    const coreImports = [...sources.values()].flatMap(importSpecifiers)
      .filter((specifier) => specifier.includes('/core/'));
    const source = [...sources.values()].join('\n');

    expect([...new Set(coreImports)]).toEqual(['../../../../core/config/remote-runtime']);
    for (const forbidden of [
      'applyRuntimeInput',
      'applyEntityInput',
      'applyAccountInput',
      'computeFrameHash',
      'leftCreditLimit',
      'rightCreditLimit',
    ]) expect(source.includes(forbidden)).toBe(false);
  });

  test('keeps browser persistence and lifecycle effects out of runtime-client', async () => {
    const sources = await readSources(['frontend/packages/runtime-client/src']);
    const source = [...sources.values()].join('\n');

    for (const browserEffect of [
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'BroadcastChannel',
      'navigator.locks',
      'navigator.serviceWorker',
      'new Worker',
    ]) expect(source.includes(browserEffect)).toBe(false);
  });

  test('keeps shared packages independent from application entry points', async () => {
    const sources = await readSources(PACKAGE_ROOTS);
    const imports = [...sources.values()].flatMap(importSpecifiers);

    expect(imports.some((specifier) => specifier.includes('/frontend/apps/'))).toBe(false);
    expect(imports.some((specifier) => specifier.includes('/frontend/src/'))).toBe(false);
  });
});
