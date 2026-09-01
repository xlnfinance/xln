import { deriveRuntimeAdapterCapabilityToken } from '../../api/runtime-adapter/security/auth';
import { REMOTE_RUNTIME } from '../../config/constants';

type RuntimeImportManifestEntry = {
  label: string;
  engine: 'ts' | 'rust';
  access: 'admin';
  wsUrl: string;
  token: string;
};

export type RuntimeImportManifest = {
  v: 1;
  issuedAt: number;
  expiresAt: number;
  entries: RuntimeImportManifestEntry[];
};

export type RuntimeImportCandidate = {
  label: string;
  engine: 'ts' | 'rust';
  wsUrl: string;
  authSeed: string;
  audience: string;
  keyId: string;
};

export const buildPublicDirectWsUrl = (baseUrl: string, publicPort: number): string => {
  const url = new URL(baseUrl);
  url.port = String(publicPort);
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
};

export const buildRuntimeNodeRpcUrl = (
  baseUrl: string,
  loopback: boolean,
  apiPort: number,
  publicPort: number,
): string => {
  // Local nodes have no nginx public-port proxy; production nodes do.
  const url = new URL(baseUrl);
  url.port = String(loopback ? apiPort : publicPort);
  url.pathname = '/rpc';
  url.search = '';
  url.hash = '';
  return url.toString();
};

export const buildCustodyRpcUrl = (
  configuredUrl: string,
  baseUrl: string,
  loopback: boolean,
  daemonPort: number,
): string | null => {
  // Custody has no shared public proxy and must never advertise a dead URL.
  if (configuredUrl) return configuredUrl;
  return loopback ? buildRuntimeNodeRpcUrl(baseUrl, true, daemonPort, daemonPort) : null;
};

export const buildRuntimeImportUrl = (walletUrl: string): string => {
  const url = new URL(walletUrl);
  url.pathname = '/app';
  url.search = '';
  url.hash = `${REMOTE_RUNTIME.IMPORT_SOURCE_HASH_PARAM}=${encodeURIComponent('/api/runtime-import?access=admin')}`;
  return url.toString();
};

export const createRuntimeImportManifest = (
  candidates: readonly RuntimeImportCandidate[],
  tokenTtlMs: number,
  issuedAt = Date.now(),
): RuntimeImportManifest | null => {
  const expiresAt = issuedAt + tokenTtlMs;
  const entries = candidates.map((candidate): RuntimeImportManifestEntry => ({
    label: candidate.label,
    engine: candidate.engine,
    access: 'admin',
    wsUrl: candidate.wsUrl,
    token: deriveRuntimeAdapterCapabilityToken(candidate.authSeed, 'full', expiresAt, {
      audience: candidate.audience,
      keyId: candidate.keyId,
      tokenId: `bulk-${candidate.keyId}-${expiresAt}`,
    }),
  }));
  return entries.length > 0 ? { v: 1, issuedAt, expiresAt, entries } : null;
};
