import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { assertNoBlockedReactCandidateBuild } from '../../scripts/deployment/current-frontend-surface-build';
import { produceDocsCatalog } from '../scripts/docs-catalog-producer.ts';
import { FRONTEND_ROUTES } from '../src/lib/contracts/frontendSurfaces';
import {
  buildReactCandidateManifest,
  buildReactSiteCandidateManifest,
  buildReactWalletCandidateManifest,
  REACT_CANDIDATE_MANIFEST_FILE,
  validateReactCandidateManifest,
} from '../packages/build-contracts/react-candidate';
import {
  createReactViteSurfaceContract,
  resolveReactFrontendSurface,
} from '../packages/build-contracts/vite-surfaces';

const FRONTEND_ROOT = resolve(import.meta.dir, '..');
const temporaryRoots: string[] = [];

afterEach(() => temporaryRoots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('React Vite surface contract', () => {
  test('maps every public route to an exact MPA entry and isolated output', () => {
    const expectedRoutes = FRONTEND_ROUTES.filter(route => route.surface === 'site' && route.kind === 'page');
    const site = createReactViteSurfaceContract(FRONTEND_ROOT, 'site');
    const docs = createReactViteSurfaceContract(FRONTEND_ROOT, 'docs');
    const wallet = createReactViteSurfaceContract(FRONTEND_ROOT, 'wallet');
    const all = createReactViteSurfaceContract(FRONTEND_ROOT, 'all');

    expect(site.root).toBe(resolve(FRONTEND_ROOT, 'apps/site/entries'));
    expect(site.outDir).toBe(resolve(FRONTEND_ROOT, 'build/site'));
    expect(site.routes).toEqual(expectedRoutes);
    expect(site.inputs).toEqual(Object.fromEntries(expectedRoutes.map(route => [
      route.id,
      resolve(FRONTEND_ROOT, 'apps/site/entries', route.outputEntry!),
    ])));
    expect(docs.root).toBe(resolve(FRONTEND_ROOT, 'apps/docs/entries'));
    expect(docs.outDir).toBe(resolve(FRONTEND_ROOT, 'build/docs'));
    expect(docs.routes.map(route => route.id)).toEqual(['docs-reader']);
    expect(docs.inputs).toEqual({
      'docs-reader': resolve(FRONTEND_ROOT, 'apps/docs/entries/index.html'),
    });
    expect(wallet.root).toBe(resolve(FRONTEND_ROOT, 'apps/wallet/entries'));
    expect(wallet.outDir).toBe(resolve(FRONTEND_ROOT, 'build/wallet'));
    expect(wallet.routes.map(route => route.id)).toEqual([
      'wallet-app',
      'wallet-address-index',
      'wallet-address-detail',
      'wallet-testnet',
    ]);
    expect(all.root).toBe(FRONTEND_ROOT);
    expect(all.outDir).toBe(resolve(FRONTEND_ROOT, 'build/react-all'));
    expect(all.inputs).toEqual({ ...site.inputs, ...docs.inputs, ...wallet.inputs });
  });

  test('rejects unknown selectors instead of falling back to another surface', () => {
    expect(resolveReactFrontendSurface(undefined)).toBe('all');
    expect(resolveReactFrontendSurface('site')).toBe('site');
    expect(resolveReactFrontendSurface('docs')).toBe('docs');
    expect(resolveReactFrontendSurface('wallet')).toBe('wallet');
  });

  test('docs candidate binds activation to the exact catalog hash', () => {
    const routes = FRONTEND_ROUTES.filter(route => route.surface === 'docs' && route.kind === 'page');
    const hash = 'a'.repeat(64);
    const manifest = buildReactCandidateManifest('docs', routes, hash);
    expect(validateReactCandidateManifest(manifest, ['index.html'], 'docs', hash)).toEqual([]);
    expect(validateReactCandidateManifest(manifest, ['index.html'], 'docs', 'b'.repeat(64)))
      .toContain('CANDIDATE_CATALOG_SHA256_MISMATCH');
  });

  test('release boundary rejects a docs candidate whose catalog hash drifts', () => {
    const buildRoot = mkdtempSync(join(tmpdir(), 'xln-react-docs-candidate-'));
    temporaryRoots.push(buildRoot);
    const sourceRoot = join(buildRoot, 'source');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, 'readme.md'), '# xln Documentation\n');
    const catalog = produceDocsCatalog(sourceRoot, join(buildRoot, 'docs/docs-catalog'));
    const routes = FRONTEND_ROUTES.filter(route => route.surface === 'docs' && route.kind === 'page');
    const manifest = buildReactCandidateManifest('docs', routes, 'b'.repeat(64));
    writeFileSync(join(buildRoot, 'docs', REACT_CANDIDATE_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
    expect(catalog.contentSha256).not.toBe('b'.repeat(64));
    expect(() => assertNoBlockedReactCandidateBuild(buildRoot))
      .toThrow('CANDIDATE_CATALOG_SHA256_MISMATCH');
  });

  test('emits a valid deterministic candidate manifest that release activation refuses', () => {
    const routes = FRONTEND_ROUTES.filter(route => route.surface === 'site' && route.kind === 'page');
    const manifest = buildReactSiteCandidateManifest(routes);
    const expectedEntrypoints = routes.map(route => route.outputEntry!);
    expect(validateReactCandidateManifest(manifest, expectedEntrypoints)).toEqual([]);
    expect(JSON.stringify(buildReactSiteCandidateManifest(routes))).toBe(JSON.stringify(manifest));

    const buildRoot = mkdtempSync(join(tmpdir(), 'xln-react-candidate-'));
    temporaryRoots.push(buildRoot);
    mkdirSync(join(buildRoot, 'site'), { recursive: true });
    writeFileSync(join(buildRoot, 'site', REACT_CANDIDATE_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
    expect(() => assertNoBlockedReactCandidateBuild(buildRoot))
      .toThrow('FRONTEND_REACT_CANDIDATE_ACTIVATION_BLOCKED:site');
  });

  test('wallet candidate stays blocked with its shared address entry represented deterministically', () => {
    const routes = FRONTEND_ROUTES.filter(route => route.surface === 'wallet' && route.kind === 'page');
    const manifest = buildReactWalletCandidateManifest(routes);
    const expectedEntrypoints = routes.map(route => route.outputEntry!);
    expect(validateReactCandidateManifest(manifest, expectedEntrypoints, 'wallet')).toEqual([]);
    expect(manifest).toMatchObject({ surface: 'wallet', activationBlocked: true });
  });

  test('rejects malformed candidate manifests before the activation boundary', () => {
    const buildRoot = mkdtempSync(join(tmpdir(), 'xln-react-candidate-'));
    temporaryRoots.push(buildRoot);
    mkdirSync(join(buildRoot, 'site'), { recursive: true });
    writeFileSync(join(buildRoot, 'site', REACT_CANDIDATE_MANIFEST_FILE), '{"activationBlocked":false}\n');
    expect(() => assertNoBlockedReactCandidateBuild(buildRoot))
      .toThrow('FRONTEND_REACT_CANDIDATE_MANIFEST_INVALID');
  });
});
