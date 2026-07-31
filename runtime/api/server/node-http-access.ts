const PRIVATE_EXACT_PATHS = new Set([
  '/api/info',
  '/api/account/status',
  '/api/health/full',
]);

export const requiresLocalNodeOperator = (url: URL): boolean =>
  PRIVATE_EXACT_PATHS.has(url.pathname) ||
  url.pathname.startsWith('/api/control/') ||
  url.pathname.startsWith('/api/debug/') ||
  (url.pathname === '/api/health' && url.searchParams.get('full') === '1');
