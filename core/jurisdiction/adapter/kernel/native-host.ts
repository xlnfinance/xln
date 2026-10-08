/** Public catalogues use this exact same-origin proxy path; canonical node config uses absolute hosts. */
export function resolveNativeTransportHost(host: string, browserOrigin?: string): string {
  if (/^\/api\/tron\/\d+$/.test(host) && browserOrigin) return new URL(host, browserOrigin).href;
  return host;
}
