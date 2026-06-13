export type BrowserLocationLike = {
  protocol: string;
  host: string;
  hostname: string;
  origin: string;
};

export type OrderbookRelayResolution = {
  url: string | null;
  explicit: boolean;
  usedDefault: boolean;
  unavailableReason: string;
};

const isLoopbackHost = (hostname: string): boolean => {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
};

const isTrustedBrowserRelayUrl = (parsed: URL, pageLocation: BrowserLocationLike): boolean => {
  const pageHost = String(pageLocation.hostname || '').trim().toLowerCase();
  const relayHost = String(parsed.hostname || '').trim().toLowerCase();
  if (relayHost === pageHost) return true;
  return isLoopbackHost(relayHost) && isLoopbackHost(pageHost);
};

const defaultRelayWsUrl = (pageLocation: BrowserLocationLike): string => {
  const protocol = pageLocation.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${pageLocation.host}/relay`;
};

export const resolveOrderbookRelayWsUrl = (
  value: string,
  pageLocation: BrowserLocationLike | null | undefined,
): OrderbookRelayResolution => {
  if (!pageLocation) {
    return { url: null, explicit: Boolean(String(value || '').trim()), usedDefault: false, unavailableReason: '' };
  }

  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return { url: defaultRelayWsUrl(pageLocation), explicit: false, usedDefault: true, unavailableReason: '' };
  }

  try {
    const parsed = trimmed.startsWith('/')
      ? new URL(trimmed, pageLocation.origin)
      : new URL(trimmed);
    if (!isTrustedBrowserRelayUrl(parsed, pageLocation)) {
      return {
        url: null,
        explicit: true,
        usedDefault: false,
        unavailableReason: 'Relay unavailable for selected hub',
      };
    }
    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
      return { url: parsed.toString(), explicit: true, usedDefault: false, unavailableReason: '' };
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return { url: parsed.toString(), explicit: true, usedDefault: false, unavailableReason: '' };
    }
    return {
      url: null,
      explicit: true,
      usedDefault: false,
      unavailableReason: 'Relay unavailable for selected hub',
    };
  } catch {
    return {
      url: null,
      explicit: true,
      usedDefault: false,
      unavailableReason: 'Relay unavailable for selected hub',
    };
  }
};
