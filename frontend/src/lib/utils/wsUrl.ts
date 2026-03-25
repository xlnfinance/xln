const normalizeLoopbackHost = (host: string): string => {
  const normalized = String(host || '').trim().toLowerCase();
  if (normalized === '0.0.0.0' || normalized === '[::1]' || normalized === '::1') {
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

export const normalizeWsUrl = (value: string): string => {
  const parsed = parseWsUrl(value);
  if (!parsed) return String(value || '').trim();
  parsed.hostname = normalizeLoopbackHost(parsed.hostname);
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString();
};

export const getWsUrlKey = (value: string, ignoreProtocol = false): string | null => {
  const parsed = parseWsUrl(value);
  if (!parsed) return null;
  const host = normalizeLoopbackHost(parsed.hostname);
  const port = parsed.port || (parsed.protocol === 'wss:' ? '443' : '80');
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${ignoreProtocol ? 'ws*' : parsed.protocol}//${host}:${port}${pathname}`;
};

export const sameWsEndpoint = (left: string, right: string, ignoreProtocol = false): boolean => {
  const leftKey = getWsUrlKey(left, ignoreProtocol);
  const rightKey = getWsUrlKey(right, ignoreProtocol);
  return !!leftKey && leftKey === rightKey;
};
