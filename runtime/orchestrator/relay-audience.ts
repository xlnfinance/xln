import { canonicalizeRuntimeWsAudience } from '../network/p2p/ws-protocol';

const relayAudienceFromWebOrigin = (origin: string): string | null => {
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.pathname !== '/' || parsed.search || parsed.hash ||
      parsed.username || parsed.password) return null;
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = '/relay';
    return canonicalizeRuntimeWsAudience(parsed.toString());
  } catch {
    return null;
  }
};

export const relayAudienceFromWebUrl = (webUrl: string): string => {
  const parsed = new URL('/relay', webUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return canonicalizeRuntimeWsAudience(parsed.toString());
};

export const resolveConfiguredRelayAudience = (input: {
  requestUrl: string;
  origin: string | null;
  configuredAudiences: ReadonlySet<string>;
}): string | null => {
  // A browser's Origin retains the public TLS scheme after a loopback proxy
  // terminates TLS. It is never authority by itself: only an exact
  // operator-configured audience can be selected.
  const originAudience = input.origin
    ? relayAudienceFromWebOrigin(input.origin)
    : null;
  if (input.origin) {
    return originAudience && input.configuredAudiences.has(originAudience)
      ? originAudience
      : null;
  }
  const directAudience = canonicalizeRuntimeWsAudience(input.requestUrl);
  return input.configuredAudiences.has(directAudience) ? directAudience : null;
};
