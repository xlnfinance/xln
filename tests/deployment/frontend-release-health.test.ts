import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyActiveFrontendRelease } from '../../scripts/deployment/frontend-release-health';
import { FRONTEND_SURFACE_IDS } from '../../scripts/deployment/frontend-release-schema';
import { buildFixtureRelease } from './frontend-release-fixture';

const COMMIT_A = 'a'.repeat(40);

const withManifest = async (
  run: (manifest: ReturnType<typeof buildFixtureRelease>['manifest']) => Promise<void>,
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'xln-frontend-health-'));
  try {
    await run(buildFixtureRelease(root, 'A', COMMIT_A, '1.0.0').manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('active frontend release health', () => {
  test('verifies real HTTP identities and the minimal URL matrix', () => withManifest(async manifest => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const match = path.match(/^\/\.well-known\/xln-build\/(site|docs|wallet|ops)\.json$/);
        if (match) {
          const surface = match[1] as typeof FRONTEND_SURFACE_IDS[number];
          return Response.json({
            schemaVersion: 1,
            releaseId: manifest.releaseId,
            surface,
            sourceCommit: manifest.sourceCommit,
            productVersion: manifest.productVersion,
          });
        }
        return new Response('ok');
      },
    });
    try {
      await expect(verifyActiveFrontendRelease(`http://127.0.0.1:${server.port}`, manifest)).resolves.toBeUndefined();
    } finally {
      await server.stop(true);
    }
  }));

  test('rejects a mixed surface identity even when every URL returns 200', () => withManifest(async manifest => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const match = path.match(/^\/\.well-known\/xln-build\/(site|docs|wallet|ops)\.json$/);
        if (!match) return new Response('ok');
        const surface = match[1] as typeof FRONTEND_SURFACE_IDS[number];
        return Response.json({
          schemaVersion: 1,
          releaseId: manifest.releaseId,
          surface,
          sourceCommit: surface === 'wallet' ? 'b'.repeat(40) : manifest.sourceCommit,
          productVersion: manifest.productVersion,
        });
      },
    });
    try {
      await expect(verifyActiveFrontendRelease(`http://127.0.0.1:${server.port}`, manifest))
        .rejects.toThrow('FRONTEND_RELEASE_HEALTH_IDENTITY_MISMATCH:wallet');
    } finally {
      await server.stop(true);
    }
  }));
});
