import { canonicalJson } from './canonical-json';
import type { FrontendBuildIdentity } from './frontend-release-files';
import {
  FRONTEND_SURFACE_IDS,
  type FrontendReleaseManifest,
  type FrontendReleaseSurfaceId,
} from './frontend-release-schema';

const SURFACE_HEALTH_PATHS: Readonly<Record<FrontendReleaseSurfaceId, string>> = {
  site: '/',
  docs: '/docs',
  wallet: '/app',
  ops: '/health',
};
const fetchRequired = async (url: string): Promise<Response> => {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    headers: { 'cache-control': 'no-cache, no-store, must-revalidate' },
  });
  if (!response.ok) throw new Error(`FRONTEND_RELEASE_HEALTH_HTTP:${response.status}:${url}`);
  return response;
};

const expectedIdentity = (
  manifest: FrontendReleaseManifest,
  surface: FrontendReleaseSurfaceId,
): FrontendBuildIdentity => ({
  schemaVersion: 1,
  releaseId: manifest.releaseId,
  surface,
  sourceCommit: manifest.sourceCommit,
  productVersion: manifest.productVersion,
});

const verifySurfaceIdentity = async (
  baseUrl: string,
  manifest: FrontendReleaseManifest,
  surface: FrontendReleaseSurfaceId,
): Promise<void> => {
  const response = await fetchRequired(`${baseUrl}/.well-known/xln-build/${surface}.json`);
  const identity: unknown = await response.json();
  if (canonicalJson(identity) !== canonicalJson(expectedIdentity(manifest, surface))) {
    throw new Error(`FRONTEND_RELEASE_HEALTH_IDENTITY_MISMATCH:${surface}`);
  }
};

export const verifyActiveFrontendRelease = async (
  rawBaseUrl: string,
  manifest: FrontendReleaseManifest,
): Promise<void> => {
  const parsed = new URL(rawBaseUrl);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`FRONTEND_RELEASE_HEALTH_BASE_URL_INVALID:${rawBaseUrl}`);
  }
  const baseUrl = parsed.toString().replace(/\/$/, '');
  for (const surface of FRONTEND_SURFACE_IDS) {
    await verifySurfaceIdentity(baseUrl, manifest, surface);
    await fetchRequired(`${baseUrl}${SURFACE_HEALTH_PATHS[surface]}`);
  }
  await fetchRequired(`${baseUrl}/site.webmanifest`);
  await fetchRequired(`${baseUrl}/docs-catalog/manifest.json`);
};
