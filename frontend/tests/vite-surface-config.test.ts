import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { assertNoBlockedReactCandidateBuild } from '../../scripts/deployment/current-frontend-surface-build';
import { FRONTEND_ROUTES } from '../src/lib/contracts/frontendSurfaces';
import {
  buildReactSiteCandidateManifest,
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
    const all = createReactViteSurfaceContract(FRONTEND_ROOT, 'all');

    expect(site.root).toBe(resolve(FRONTEND_ROOT, 'apps/site/entries'));
    expect(site.outDir).toBe(resolve(FRONTEND_ROOT, 'build/site'));
    expect(site.routes).toEqual(expectedRoutes);
    expect(site.inputs).toEqual(Object.fromEntries(expectedRoutes.map(route => [
      route.id,
      resolve(FRONTEND_ROOT, 'apps/site/entries', route.outputEntry!),
    ])));
    expect(all.root).toBe(FRONTEND_ROOT);
    expect(all.outDir).toBe(resolve(FRONTEND_ROOT, 'build/react-all'));
    expect(all.inputs).toEqual(site.inputs);
  });

  test('rejects unknown selectors instead of falling back to another surface', () => {
    expect(resolveReactFrontendSurface(undefined)).toBe('all');
    expect(resolveReactFrontendSurface('site')).toBe('site');
    expect(() => resolveReactFrontendSurface('wallet')).toThrow('REACT_FRONTEND_SURFACE_UNKNOWN:wallet');
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

  test('rejects malformed candidate manifests before the activation boundary', () => {
    const buildRoot = mkdtempSync(join(tmpdir(), 'xln-react-candidate-'));
    temporaryRoots.push(buildRoot);
    mkdirSync(join(buildRoot, 'site'), { recursive: true });
    writeFileSync(join(buildRoot, 'site', REACT_CANDIDATE_MANIFEST_FILE), '{"activationBlocked":false}\n');
    expect(() => assertNoBlockedReactCandidateBuild(buildRoot))
      .toThrow('FRONTEND_REACT_CANDIDATE_MANIFEST_INVALID');
  });
});
