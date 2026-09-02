#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import { SURFACES, SURFACE_IDS, matchesRoute, resolveRouteOwner, type SurfaceId } from '../config/surfaces';
import { assembleCandidateRelease, type CandidateReleaseManifest } from './candidate-release';
import { verifyCandidateReleaseDirectory } from './candidate-release-verifier';
import {
  activateDeploymentCandidate,
  deploymentReleaseDirectory,
  readDeploymentCandidateState,
  rollbackDeploymentCandidate,
} from './deployment-candidate';

const FRONTEND_ROOT = join(import.meta.dir, '..');
const HOST = process.env['XLN_DEPLOYMENT_SMOKE_HOST'] ?? '127.0.0.1';
const PORT = Number(process.env['XLN_DEPLOYMENT_SMOKE_PORT'] ?? '19092');
const UPDATE_MARKER = '<!-- xln-deployment-isolated-update -->';
const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

type SmokeRelease = Readonly<{
  directory: string;
  manifest: CandidateReleaseManifest;
  walletEntrySha256: string;
  docsEntrySha256: string;
}>;

const assertPort = (): void => {
  if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65_535) {
    throw new Error('DEPLOYMENT_SMOKE_PORT_INVALID');
  }
};

const prepareUpdateRelease = async (smokeRoot: string): Promise<SmokeRelease> => {
  const frontendRoot = join(smokeRoot, 'frontend');
  const artifacts = join(frontendRoot, '.artifacts');
  await mkdir(artifacts, { recursive: true });
  await Promise.all([
    ...SURFACE_IDS.map((surface) => cp(
      join(FRONTEND_ROOT, '.artifacts', surface),
      join(artifacts, surface),
      { recursive: true },
    )),
    cp(join(FRONTEND_ROOT, '.artifacts', 'inputs'), join(artifacts, 'inputs'), { recursive: true }),
  ]);
  const walletEntry = join(artifacts, 'wallet/index.html');
  const html = await readFile(walletEntry, 'utf8');
  if (html.includes(UPDATE_MARKER) || html.split('</body>').length !== 2) {
    throw new Error('DEPLOYMENT_SMOKE_WALLET_ENTRY_INVALID');
  }
  await writeFile(walletEntry, html.replace('</body>', `${UPDATE_MARKER}</body>`));
  const release = await assembleCandidateRelease(frontendRoot);
  return smokeRelease(release.releaseDirectory);
};

const releaseEntryHash = (manifest: CandidateReleaseManifest, surface: SurfaceId): string => {
  const application = manifest.applications.find(({ id }) => id === surface);
  if (!application) throw new Error(`DEPLOYMENT_SMOKE_APPLICATION_MISSING:${surface}`);
  const entry = manifest.files.find(({ path }) => path === application.entryHtml);
  if (!entry) throw new Error(`DEPLOYMENT_SMOKE_ENTRY_MISSING:${surface}`);
  return entry.sha256;
};

const smokeRelease = async (directory: string): Promise<SmokeRelease> => {
  const manifest = await verifyCandidateReleaseDirectory(directory);
  return {
    directory,
    manifest,
    walletEntrySha256: releaseEntryHash(manifest, 'wallet'),
    docsEntrySha256: releaseEntryHash(manifest, 'docs'),
  };
};

const applicationEntry = (pathname: string): string | null => {
  const owner = resolveRouteOwner(pathname);
  if (owner === 'edge') return null;
  const surface = SURFACES.find(({ id }) => id === owner);
  return surface?.routes.some((rule) => matchesRoute(pathname, rule))
    ? `apps/${owner}/index.html`
    : null;
};

const requestedReleasePath = (pathname: string, manifest: CandidateReleaseManifest): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, '');
  if (relative && (relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..'))) {
    return null;
  }
  if (relative) {
    if (relative === 'release-manifest.json' || manifest.files.some(({ path }) => path === relative)) return relative;
  }
  return applicationEntry(decoded);
};

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.wasm', 'application/wasm'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

const jsonResponse = (value: unknown, status = 200): Response => new Response(`${safeStringify(value, 2)}\n`, {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const main = async (): Promise<void> => {
  assertPort();
  const smokeRoot = await mkdtemp(join(tmpdir(), 'xln-deployment-smoke-'));
  const deploymentRoot = join(smokeRoot, 'deployment');
  const installPlan = await assembleCandidateRelease(FRONTEND_ROOT);
  const [install, update] = await Promise.all([
    smokeRelease(installPlan.releaseDirectory),
    prepareUpdateRelease(smokeRoot),
  ]);
  if (install.manifest.releaseId === update.manifest.releaseId) throw new Error('DEPLOYMENT_SMOKE_RELEASE_IDS_EQUAL');
  const releases = [install, update] as const;
  const releaseMap = new Map(releases.map((release) => [release.manifest.releaseId, release]));
  await activateDeploymentCandidate(install.directory, deploymentRoot);
  const corruptDirectory = join(smokeRoot, 'corrupt', update.manifest.releaseId);
  await cp(update.directory, corruptDirectory, { recursive: true });
  await writeFile(join(corruptDirectory, 'unexpected.txt'), 'unexpected\n');

  const state = async () => ({
    selection: await readDeploymentCandidateState(deploymentRoot),
    releases: releases.map(({ manifest, walletEntrySha256, docsEntrySha256 }) => ({
      releaseId: manifest.releaseId,
      fileCount: manifest.files.length + 1,
      walletEntrySha256,
      docsEntrySha256,
    })),
  });

  const control = async (pathname: string): Promise<Response> => {
    try {
      if (pathname === '/__xln-deployment/activate-update') {
        await activateDeploymentCandidate(update.directory, deploymentRoot);
      } else if (pathname === '/__xln-deployment/rollback') {
        await rollbackDeploymentCandidate(deploymentRoot);
      } else if (pathname === '/__xln-deployment/activate-corrupt') {
        await activateDeploymentCandidate(corruptDirectory, deploymentRoot);
      } else {
        return new Response('DEPLOYMENT_SMOKE_CONTROL_UNKNOWN', { status: 404 });
      }
      return jsonResponse(await state());
    } catch (error: unknown) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  };

  const server = Bun.serve({
    hostname: HOST,
    port: PORT,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/__xln-deployment/state') return jsonResponse(await state());
      if (request.method === 'POST' && url.pathname.startsWith('/__xln-deployment/')) {
        return control(url.pathname);
      }
      const selection = await readDeploymentCandidateState(deploymentRoot);
      if (selection === null) return new Response('DEPLOYMENT_SMOKE_STATE_MISSING', { status: 500 });
      const release = releaseMap.get(selection.activeReleaseId);
      if (!release) return new Response('DEPLOYMENT_SMOKE_RELEASE_UNKNOWN', { status: 500 });
      const relativePath = requestedReleasePath(url.pathname, release.manifest);
      if (relativePath === null) return new Response('Not found', { status: 404 });
      const bytes = await readFile(deploymentReleaseDirectory(deploymentRoot, selection.activeReleaseId) + `/${relativePath}`);
      return new Response(bytes, {
        headers: {
          'cache-control': 'no-store',
          'content-type': mimeTypes.get(extname(relativePath)) ?? 'application/octet-stream',
          'x-xln-deployment-release': selection.activeReleaseId,
          'x-xln-content-sha256': hashBytes(bytes),
        },
      });
    },
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.stop(true);
    await rm(smokeRoot, { recursive: true, force: true });
  };
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  console.info(
    `DEPLOYMENT_CANDIDATE_SMOKE_READY origin=http://${HOST}:${PORT} ` +
    `install=${install.manifest.releaseId} update=${update.manifest.releaseId}`,
  );
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
