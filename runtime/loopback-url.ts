const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export const normalizeLoopbackUrl = (value: string, preferredHost = '127.0.0.1'): string => {
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
