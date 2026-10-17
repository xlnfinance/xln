import { normalizeWsConnectUrl } from './wsUrl';

export const REMOTE_LINK_KEYS = ['runtime', 'ws', 'token', 'adapter', 'runtimeWs', 'authKey', 'key', 'auth'] as const;
const CURRENT_KEYS = ['runtime', 'ws', 'token'];

// The invoice router owns pay/ fragments; its token field is an asset, not a capability.
const remoteParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.slice(1).toLowerCase().startsWith('pay/') ? '' : url.hash.slice(1));

/** Decode the current operator link; the server alone authenticates its capability. */
export function parseRemoteRuntimeLink(url: URL): { wsUrl: string; authKey: string } | null {
  if (REMOTE_LINK_KEYS.some(key => url.searchParams.has(key)))
    throw new Error('REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN');
  const hash = remoteParams(url);
  if (!REMOTE_LINK_KEYS.some(key => hash.has(key))) return null;
  if (
    [...hash.keys()].some(key => !CURRENT_KEYS.includes(key) || hash.getAll(key).length !== 1) ||
    hash.get('runtime') !== 'remote' ||
    !hash.get('ws')
  )
    throw new Error('REMOTE_RUNTIME_LINK_FORMAT_INVALID');
  const authKey = hash.get('token') ?? '';
  if (authKey && !authKey.startsWith('xlnra1.')) throw new Error('REMOTE_RUNTIME_CAPABILITY_FORMAT_INVALID');
  let endpoint: URL;
  try {
    endpoint = new URL(hash.get('ws') ?? '');
  } catch {
    throw new Error('REMOTE_RUNTIME_WS_REQUIRED');
  }
  if (
    !['ws:', 'wss:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('REMOTE_RUNTIME_WS_REQUIRED');
  return { wsUrl: normalizeWsConnectUrl(endpoint.toString()), authKey };
}

/** Remove capability-bearing link fields without erasing an unrelated invoice or route. */
export function stripRemoteRuntimeLink(url: URL): URL {
  const clean = new URL(url);
  const hash = remoteParams(clean);
  const hasRemoteHash = REMOTE_LINK_KEYS.some(key => hash.has(key));
  const importKeys = ['runtime-import-src', 'runtime-import'];
  const hasImportHash = importKeys.some(key => hash.has(key));
  for (const key of [...REMOTE_LINK_KEYS, ...importKeys]) {
    clean.searchParams.delete(key);
    hash.delete(key);
  }
  if (hasRemoteHash || hasImportHash) clean.hash = hash.toString();
  return clean;
}

/** Current orchestrator manifests are fetched only from this wallet's server. */
export function parseRemoteRuntimeImportLink(url: URL): string | null {
  const keys = ['runtime-import-src', 'runtime-import'];
  if (keys.some(key => url.searchParams.has(key))) throw new Error('REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN');
  const hash = remoteParams(url);
  if (!keys.some(key => hash.has(key))) return null;
  if ([...hash.keys()].length !== 1 || hash.getAll('runtime-import-src').length !== 1)
    throw new Error('REMOTE_RUNTIME_IMPORT_LINK_FORMAT_INVALID');
  const source = hash.get('runtime-import-src');
  if (!source) throw new Error('REMOTE_RUNTIME_IMPORT_SOURCE_REQUIRED');
  const endpoint = new URL(source, url);
  if (
    endpoint.origin !== url.origin ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.pathname !== '/api/runtime-import' ||
    endpoint.searchParams.get('access') !== 'admin' ||
    [...endpoint.searchParams.keys()].some(key => key !== 'access') ||
    endpoint.searchParams.getAll('access').length !== 1
  )
    throw new Error('REMOTE_RUNTIME_IMPORT_SOURCE_INVALID');
  return endpoint.pathname + endpoint.search;
}
