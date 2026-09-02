import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compareStableText, safeStringify } from '../../core/protocol/serialization';
import { verifyCandidateReleaseDirectory } from './candidate-release-verifier';

export const PWA_CANDIDATE_CACHE_PREFIX = 'xln-react-candidate:';
export const PWA_CANDIDATE_SCOPE = '/';
export const PWA_CANDIDATE_WORKER_PATH = '/__xln-pwa-worker.js';
export const PWA_CANDIDATE_RELEASE_PATH = '/__xln-pwa-release';

export type PwaCandidateFile = Readonly<{
  path: string;
  sha256: string;
  size: number;
}>;

export type PwaCandidatePlan = Readonly<{
  releaseId: `sha256-${string}`;
  cacheName: string;
  scope: typeof PWA_CANDIDATE_SCOPE;
  files: readonly PwaCandidateFile[];
  serviceWorkerSource: string;
  serviceWorkerSha256: string;
}>;

const RELEASE_MANIFEST = 'release-manifest.json';
const WALLET_ENTRY = 'apps/wallet/index.html';
const hashBytes = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const renderServiceWorker = (
  releaseId: `sha256-${string}`,
  cacheName: string,
  files: readonly PwaCandidateFile[],
): string => `const RELEASE_ID = ${safeStringify(releaseId)};
const CACHE_NAME = ${safeStringify(cacheName)};
const SOURCE_PREFIX = ${safeStringify(`${PWA_CANDIDATE_RELEASE_PATH}/${releaseId}/`)};
const WALLET_ENTRY = ${safeStringify(WALLET_ENTRY)};
const FILES = ${safeStringify(files)};
const FILE_PATHS = new Set(FILES.map(({ path }) => path));

const encodedPath = (path) => path.split('/').map(encodeURIComponent).join('/');
const sourceUrl = (path) => new URL(SOURCE_PREFIX + encodedPath(path), self.location.origin).href;
const hex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const responseMatches = async (response, file) => {
  if (!response || !response.ok) return false;
  const bytes = await response.clone().arrayBuffer();
  if (bytes.byteLength !== file.size) return false;
  return hex(await crypto.subtle.digest('SHA-256', bytes)) === file.sha256;
};

const cacheIsComplete = async (cache) => {
  for (const file of FILES) {
    if (!await responseMatches(await cache.match(sourceUrl(file.path)), file)) return false;
  }
  return (await cache.keys()).length === FILES.length;
};

const installRelease = async () => {
  const existing = await caches.open(CACHE_NAME);
  if (await cacheIsComplete(existing)) {
    await self.skipWaiting();
    return;
  }
  await caches.delete(CACHE_NAME);
  const cache = await caches.open(CACHE_NAME);
  try {
    for (const file of FILES) {
      const url = sourceUrl(file.path);
      const response = await fetch(url, { cache: 'no-store' });
      if (!await responseMatches(response, file)) throw new Error('PWA_RELEASE_FILE_MISMATCH:' + file.path);
      await cache.put(url, response);
    }
    if (!await cacheIsComplete(cache)) throw new Error('PWA_RELEASE_CACHE_INCOMPLETE');
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
  await self.skipWaiting();
};

const candidatePath = (requestUrl) => {
  if (requestUrl.origin !== self.location.origin) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    return null;
  }
  if (pathname === '/app' || pathname === '/testnet' || pathname === '/address' || pathname.startsWith('/address/')) {
    return WALLET_ENTRY;
  }
  const path = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  return FILE_PATHS.has(path) ? path : null;
};

const cachedResponse = async (path) => {
  const response = await (await caches.open(CACHE_NAME)).match(sourceUrl(path));
  if (!response) return new Response('PWA_RELEASE_CACHE_MISS:' + path, { status: 503 });
  const headers = new Headers(response.headers);
  headers.set('x-xln-pwa-release', RELEASE_ID);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

self.addEventListener('install', (event) => event.waitUntil(installRelease()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const path = candidatePath(new URL(event.request.url));
  if (path !== null) event.respondWith(cachedResponse(path));
});
`;

export const createPwaCandidatePlan = async (releaseDirectory: string): Promise<PwaCandidatePlan> => {
  const manifest = await verifyCandidateReleaseDirectory(releaseDirectory);
  if (!manifest.files.some(({ path }) => path === WALLET_ENTRY)) {
    throw new Error('PWA_CANDIDATE_WALLET_ENTRY_MISSING');
  }
  const manifestBytes = await readFile(join(releaseDirectory, RELEASE_MANIFEST));
  const files = [
    ...manifest.files,
    { path: RELEASE_MANIFEST, sha256: hashBytes(manifestBytes), size: manifestBytes.byteLength },
  ].sort(({ path: left }, { path: right }) => compareStableText(left, right));
  const cacheName = `${PWA_CANDIDATE_CACHE_PREFIX}${manifest.releaseId}`;
  const serviceWorkerSource = renderServiceWorker(manifest.releaseId, cacheName, files);
  return {
    releaseId: manifest.releaseId,
    cacheName,
    scope: PWA_CANDIDATE_SCOPE,
    files,
    serviceWorkerSource,
    serviceWorkerSha256: hashBytes(serviceWorkerSource),
  };
};
