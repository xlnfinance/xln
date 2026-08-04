export type OpsAudience = 'production-operator' | 'developer' | 'runtime-free-embed';
export type OpsCapability = 'health-read' | 'qa-read' | 'qa-admin' | 'local-scenario' | 'ai-tools' | 'embed-read';

export type OpsRouteContract = Readonly<{
  id: 'health' | 'qa' | 'runs' | 'scenarios' | 'ai' | 'embed';
  pattern: string;
  audience: OpsAudience;
  capabilities: readonly OpsCapability[];
  dataSources: readonly string[];
  mobile: 'supported' | 'workspace-message';
}>;

const opsRouteContracts: readonly OpsRouteContract[] = [
  { id: 'health', pattern: '/health', audience: 'production-operator', capabilities: ['health-read'], dataSources: ['/api/health', 'runtime-adapter projection'], mobile: 'supported' },
  { id: 'qa', pattern: '/qa', audience: 'production-operator', capabilities: ['qa-read', 'qa-admin'], dataSources: ['/api/qa/**', '/api/health'], mobile: 'supported' },
  { id: 'runs', pattern: '/runs', audience: 'production-operator', capabilities: ['qa-read'], dataSources: ['/api/qa/runs'], mobile: 'supported' },
  { id: 'scenarios', pattern: '/scenarios', audience: 'developer', capabilities: ['local-scenario'], dataSources: ['runtime.js scenario registry'], mobile: 'workspace-message' },
  { id: 'ai', pattern: '/ai/:chatId?', audience: 'developer', capabilities: ['ai-tools'], dataSources: ['/api/models', '/api/chats', '/api/chat', '/api/council', '/api/xln/**'], mobile: 'supported' },
  { id: 'embed', pattern: '/embed', audience: 'runtime-free-embed', capabilities: ['embed-read'], dataSources: ['runtime.js scenario registry', 'URL hash trail'], mobile: 'workspace-message' },
];

export const OPS_ROUTE_CONTRACTS: readonly OpsRouteContract[] = Object.freeze(
  opsRouteContracts.map(route => Object.freeze({
    ...route,
    capabilities: Object.freeze([...route.capabilities]),
    dataSources: Object.freeze([...route.dataSources]),
  })),
);

export const validateOpsRouteContracts = (contracts: readonly OpsRouteContract[] = OPS_ROUTE_CONTRACTS): readonly string[] => {
  const errors: string[] = [];
  const ids = new Set<string>();
  const patterns = new Set<string>();
  for (const route of contracts) {
    if (ids.has(route.id)) errors.push(`OPS_ROUTE_ID_DUPLICATE:${route.id}`);
    if (patterns.has(route.pattern)) errors.push(`OPS_ROUTE_PATTERN_DUPLICATE:${route.pattern}`);
    if (!route.pattern.startsWith('/')) errors.push(`OPS_ROUTE_PATTERN_INVALID:${route.id}`);
    if (route.capabilities.length === 0) errors.push(`OPS_ROUTE_CAPABILITY_MISSING:${route.id}`);
    if (route.dataSources.length === 0) errors.push(`OPS_ROUTE_DATA_SOURCE_MISSING:${route.id}`);
    ids.add(route.id);
    patterns.add(route.pattern);
  }
  return Object.freeze(errors.toSorted());
};

export const resolveOpsRoute = (pathname: string): OpsRouteContract => {
  const normalized = pathname === '/' ? '/health' : `/${pathname.split('/').filter(Boolean).join('/')}`;
  const route = normalized === '/ai' || normalized.startsWith('/ai/')
    ? OPS_ROUTE_CONTRACTS.find(candidate => candidate.id === 'ai')
    : OPS_ROUTE_CONTRACTS.find(candidate => candidate.pattern === normalized);
  if (!route) throw new Error(`OPS_ROUTE_UNKNOWN:${normalized}`);
  return route;
};
