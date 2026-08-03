import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { FRONTEND_ROUTES } from '../../frontend/src/lib/contracts/frontendSurfaces';
import {
  assembleCurrentFrontendSurfaces,
  currentFrontendEntrypoints,
} from '../../scripts/deployment/current-frontend-surface-build';

const write = (root: string, path: string): void => {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${path}\n`);
};

const pageSource = (pattern: string): string => {
  if (pattern === '/') return 'index.html';
  return `${pattern.split('/').filter(Boolean)[0]}.html`;
};

const createUnifiedFixture = (root: string): void => {
  FRONTEND_ROUTES.forEach(route => {
    if (route.surface === 'edge' || route.pattern.endsWith('/**')) return;
    write(root, route.kind === 'page' ? pageSource(route.pattern) : route.pattern.slice(1));
  });
  [
    '_app/version.json', 'docs-catalog/index.html', 'docs-static/readme.md', 'llms_runtime.txt',
    'contracts/Account.json', 'sounds/done.mp3', 'hash-wasm-argon2.js', 'img/logo.png',
    'bikes/rcpan.svg', 'news/index.html', 'favicon.ico', 'apple-touch-icon.png',
    'android-chrome-192x192.png', 'install.sh', 'comparative-results.json', 'radapter.html',
  ].forEach(path => write(root, path));
};

const withFixture = (run: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'xln-surface-build-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('current frontend surface assembler', () => {
  test('normalizes current Svelte outputs into the four canonical roots', () => withFixture(root => {
    const buildRoot = join(root, 'build');
    const outputRoot = join(root, 'surfaces');
    createUnifiedFixture(buildRoot);
    const surfaces = assembleCurrentFrontendSurfaces(buildRoot, outputRoot);

    expect(readFileSync(join(surfaces.site, 'install/index.html'), 'utf8')).toBe('install.html\n');
    expect(readFileSync(join(surfaces.docs, 'docs-catalog/index.html'), 'utf8')).toBe('docs-catalog/index.html\n');
    expect(readFileSync(join(surfaces.wallet, 'address/index.html'), 'utf8')).toBe('address.html\n');
    expect(readFileSync(join(surfaces.ops, 'health/index.html'), 'utf8')).toBe('health.html\n');
    expect(existsSync(join(surfaces.site, 'radapter.html'))).toBe(false);
    expect(currentFrontendEntrypoints().wallet).toEqual(['address/index.html', 'index.html', 'testnet/index.html']);
  }));

  test('fails loudly on an unowned build artifact', () => withFixture(root => {
    const buildRoot = join(root, 'build');
    createUnifiedFixture(buildRoot);
    write(buildRoot, 'mystery.bin');
    expect(() => assembleCurrentFrontendSurfaces(buildRoot, join(root, 'surfaces')))
      .toThrow('FRONTEND_UNIFIED_BUILD_ASSET_UNOWNED:mystery.bin');
  }));
});
