const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export const isLoopbackUrl = (value: string): boolean => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

export const normalizeLoopbackUrl = (value: string, preferredHost = 'localhost'): string => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return parsed.toString();
    }
    parsed.hostname = preferredHost;
    return parsed.toString();
  } catch {
    return raw;
  }
};

export const toPublicRpcUrl = (value: string, fallback = '/rpc'): string => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (raw.startsWith('/')) return raw;
  return isLoopbackUrl(raw) ? fallback : raw;
};
