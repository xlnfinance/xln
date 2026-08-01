/**
 * Resolve unified-server relay transport and cryptographic identity separately.
 *
 * INTERNAL_RELAY_URL is only a process-local connection target. The public
 * audience is explicit deployment authority shared by browser and server; it
 * must never be inferred from an HTTP Host header or from the internal socket.
 */

import {
  canonicalizeRuntimeWsAudience,
  isLoopbackRuntimeWsHostname,
  isWildcardRuntimeWsHostname,
} from '../p2p/hello-transcript';

export type UnifiedRelayEndpointOptions = {
  port: number;
  publicRelayUrl?: string;
  internalRelayUrl?: string;
};

export type UnifiedRelayEndpoints = {
  internalUrl: string;
  publicAudience: string;
};

const canonicalizeRelayEndpoint = (input: string, label: 'PUBLIC' | 'INTERNAL'): string => {
  const parsed = new URL(input);
  if ((parsed.pathname.replace(/\/+$/, '') || '/') !== '/relay') {
    throw new Error(`${label}_RELAY_AUDIENCE_PATH_INVALID:${parsed.pathname}`);
  }
  if (parsed.search || parsed.hash) throw new Error(`${label}_RELAY_AUDIENCE_SUFFIX_FORBIDDEN`);
  if (isWildcardRuntimeWsHostname(parsed.hostname)) {
    throw new Error(`${label}_RELAY_WILDCARD_FORBIDDEN:${parsed.hostname}`);
  }
  if (
    (parsed.protocol === 'ws:' || parsed.protocol === 'http:')
    && !isLoopbackRuntimeWsHostname(parsed.hostname)
  ) {
    throw new Error(`${label}_RELAY_PLAINTEXT_FORBIDDEN:${parsed.hostname}`);
  }
  return canonicalizeRuntimeWsAudience(input);
};

export const resolveUnifiedRelayEndpoints = (
  options: UnifiedRelayEndpointOptions,
): UnifiedRelayEndpoints => {
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error(`UNIFIED_RELAY_PORT_INVALID:${String(options.port)}`);
  }
  const publicRelayUrl = String(options.publicRelayUrl || '').trim();
  if (!publicRelayUrl) throw new Error('PUBLIC_RELAY_AUDIENCE_REQUIRED');
  const internalRelayUrl = String(options.internalRelayUrl || '').trim()
    || `ws://127.0.0.1:${options.port}/relay`;
  const internalUrl = canonicalizeRelayEndpoint(internalRelayUrl, 'INTERNAL');
  const publicAudience = canonicalizeRelayEndpoint(publicRelayUrl, 'PUBLIC');
  if (
    !isLoopbackRuntimeWsHostname(new URL(internalUrl).hostname)
    && internalUrl !== publicAudience
  ) {
    throw new Error(
      `INTERNAL_RELAY_PUBLIC_AUDIENCE_MISMATCH:transport=${internalUrl}:expected=${publicAudience}`,
    );
  }
  return {
    internalUrl,
    publicAudience,
  };
};
