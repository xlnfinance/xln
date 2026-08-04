import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  frontendSurfaceEntrypoints,
  resolveFrontendSurfaceSources,
} from '../../scripts/deployment/frontend-surface-build';
import { FRONTEND_SURFACE_IDS } from '../../scripts/deployment/frontend-release-schema';

const write = (root: string, path: string): void => {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${path}\n`);
};

const createSurfaceFixture = (buildRoot: string): void => {
  const entrypoints = frontendSurfaceEntrypoints();
  for (const surface of FRONTEND_SURFACE_IDS) {
    for (const entrypoint of entrypoints[surface]) write(join(buildRoot, surface), entrypoint);
  }
};

const withFixture = (run: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'xln-surface-build-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

describe('canonical frontend surface build', () => {
  test('requires exactly four independently owned roots and every page entrypoint', () => withFixture(root => {
    const buildRoot = join(root, 'build');
    createSurfaceFixture(buildRoot);
    const surfaces = resolveFrontendSurfaceSources(buildRoot);

    expect(Object.keys(surfaces).sort()).toEqual(['docs', 'ops', 'site', 'wallet']);
    expect(frontendSurfaceEntrypoints().wallet).toEqual(['address/index.html', 'index.html', 'testnet/index.html']);
  }));

  test('rejects missing, extra, and release-owned build identity inputs', () => withFixture(root => {
    const buildRoot = join(root, 'build');
    createSurfaceFixture(buildRoot);
    write(buildRoot, 'extra/index.html');
    expect(() => resolveFrontendSurfaceSources(buildRoot)).toThrow('FRONTEND_SURFACE_BUILD_ROOTS_INVALID');
    rmSync(join(buildRoot, 'extra'), { recursive: true, force: true });
    rmSync(join(buildRoot, 'wallet/index.html'));
    expect(() => resolveFrontendSurfaceSources(buildRoot)).toThrow('FRONTEND_SURFACE_ENTRYPOINT_MISSING:wallet:index.html');
    write(buildRoot, 'wallet/index.html');
    write(buildRoot, 'wallet/build-identity.json');
    expect(() => resolveFrontendSurfaceSources(buildRoot)).toThrow('FRONTEND_SURFACE_RESERVED_ASSET:wallet');
  }));
});
