import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { SITE_ASSET_DIRECTORIES, SITE_ASSET_FILES } from '../apps/site/build/site-build-plugin';

const FRONTEND_ROOT = resolve(import.meta.dir, '..');
const SITE_ROOT = resolve(FRONTEND_ROOT, 'apps/site');
const SHARED_ROOT = resolve(FRONTEND_ROOT, 'packages');

const sourceFiles = (root: string): readonly string[] => readdirSync(root).flatMap(name => {
  const path = join(root, name);
  if (statSync(path).isDirectory()) return sourceFiles(path);
  return /\.(?:ts|tsx)$/.test(path) ? [path] : [];
});

const importSpecifiers = (source: string): readonly string[] => [...source.matchAll(
  /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g,
)].map(match => match[1]!);

const RCPAN_PROTOCOL_SOURCES = [
  'src/lib/components/Rcpan/microscope-finance.ts',
  'src/lib/components/Rcpan/microscope-tokens.ts',
  'src/lib/components/Rcpan/microscope-display-utils.ts',
  'src/lib/releases/release-signature.ts',
] as const;

const ALLOWED_PROTOCOL_IMPORTS = [
  '../../../../runtime/hanko/claims',
  '../../../../runtime/hanko/codec',
  '../../../../runtime/types/hanko',
  '@xln/runtime/account/delta',
  '@xln/runtime/account/utils',
  '@xln/runtime/protocol/dispute/finalization',
  '@xln/runtime/types/account',
] as const;

describe('public-site import boundaries', () => {
  test('site entries cannot initialize wallet, runtime, docs, ops, or native implementations', () => {
    const violations = sourceFiles(SITE_ROOT).flatMap(file => importSpecifiers(readFileSync(file, 'utf8'))
      .filter(specifier => /(?:svelte|capacitor|electron|brainvault|runtimeStore|vault|commandJournal|apps\/(?:wallet|docs|ops)|src\/routes)/i.test(specifier))
      .map(specifier => `${relative(FRONTEND_ROOT, file)} -> ${specifier}`));
    expect(violations).toEqual([]);
  });

  test('the only protocol imports are existing pure Account and Hanko helpers', () => {
    const actual = [...new Set(RCPAN_PROTOCOL_SOURCES.flatMap(path => importSpecifiers(readFileSync(resolve(FRONTEND_ROOT, path), 'utf8')))
      .filter(specifier => specifier.includes('runtime')))]
      .toSorted((left, right) => left.localeCompare(right));
    expect(actual).toEqual([...ALLOWED_PROTOCOL_IMPORTS]);
  });

  test('shared build contracts stay framework-neutral and app-independent', () => {
    const violations = sourceFiles(SHARED_ROOT).flatMap(file => importSpecifiers(readFileSync(file, 'utf8'))
      .filter(specifier => /(?:react|svelte|apps\/|runtime|vault|capacitor)/i.test(specifier))
      .map(specifier => `${relative(FRONTEND_ROOT, file)} -> ${specifier}`));
    expect(violations).toEqual([]);
  });

  test('site assets exclude wallet workers, manifests, contracts, and native payloads', () => {
    const assets = [...SITE_ASSET_DIRECTORIES, ...SITE_ASSET_FILES];
    expect(assets).not.toContain('contracts');
    expect(assets).not.toContain('runtime.js');
    expect(assets).not.toContain('brainvault-worker.js');
    expect(assets).not.toContain('push-wake-sw.js');
    expect(assets).not.toContain('site.webmanifest');
  });

  test('the RCPAN animation clock cannot feed negative time into deterministic protocol views', () => {
    const source = readFileSync(resolve(SITE_ROOT, 'pages/RcpanPage.tsx'), 'utf8');
    expect(source).toContain('setElapsed(Math.max(0, Math.floor(now - startedAt)))');
  });
});
