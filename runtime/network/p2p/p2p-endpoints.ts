const normalizeLoopbackHost = (host: string): string => {
  const normalized = String(host || '').trim().toLowerCase();
  if (normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1') {
    return 'localhost';
  }
  return normalized;
};

const parseWsUrl = (value: string): URL | null => {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    return parsed;
  } catch {
    return null;
  }
};

export const getWsUrlKey = (value: string, ignoreProtocol = false): string | null => {
  const parsed = parseWsUrl(value);
  if (!parsed) return null;
  const host = normalizeLoopbackHost(parsed.hostname);
  const port = parsed.port || (parsed.protocol === 'wss:' ? '443' : '80');
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${ignoreProtocol ? 'ws*' : parsed.protocol}//${host}:${port}${pathname}`;
};

export const uniqueTransportValues = (items: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const trimmed = String(item || '').trim();
    if (!trimmed) continue;
    const key = getWsUrlKey(trimmed) || trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
};

export const normalizeOptionalWsUrl = (value: string | null | undefined): string | null => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const parsed = parseWsUrl(trimmed);
  return parsed ? trimmed : null;
};

export const sameWsUrl = (left: string | null, right: string | null): boolean => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return getWsUrlKey(left) === getWsUrlKey(right);
};

export const isBrowserDirectWsEndpointAllowed = (endpoint: string): boolean => {
  if (typeof window === 'undefined') return true;
  const pageProtocol = String(window.location?.protocol || '').toLowerCase();
  if (pageProtocol !== 'https:') return true;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol === 'wss:') return true;
    if (parsed.protocol !== 'ws:') return false;
    const host = normalizeLoopbackHost(parsed.hostname);
    return host === 'localhost';
  } catch {
    return false;
  }
};

export const isSameWsUrlList = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const aSorted = [...a].map(value => getWsUrlKey(value) || value).sort();
  const bSorted = [...b].map(value => getWsUrlKey(value) || value).sort();
  return aSorted.every((value, index) => value === bSorted[index]);
};
