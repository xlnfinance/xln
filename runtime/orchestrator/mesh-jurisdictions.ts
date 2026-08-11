import { clearJurisdictionsCache, loadJurisdictions } from '../jurisdiction/adapter/jurisdiction-loader';
import { getJurisdictionIdentityRef } from '../jurisdiction/machine/jurisdiction-runtime';
import { isLoopbackUrl, normalizeLoopbackUrl, toPublicRpcUrl } from '../network/p2p/loopback-url';

type MeshJurisdictionConfig = {
  name: string;
  chainId: number;
  rpc: string;
  entityProviderDeploymentBlock: number;
  primary?: boolean;
  blockTimeMs?: number;
  contracts?: {
    depository: string;
    entityProvider: string;
    account?: string;
    deltaTransformer?: string;
  };
};

export type ResolvedMeshJurisdictionConfig = MeshJurisdictionConfig & {
  contracts: Required<NonNullable<MeshJurisdictionConfig['contracts']>>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

// jurisdictions.json is external input even though the loader exposes a
// TypeScript shape. Establish the trusted config exactly once here; callers
// must not select a stronger result type through a generic assertion.
const hasRequiredContracts = (entry: unknown): entry is ResolvedMeshJurisdictionConfig => {
  if (!isRecord(entry) || !isRecord(entry['contracts'])) return false;
  const contracts = entry['contracts'];
  return isNonEmptyString(entry['name'])
    && Number.isSafeInteger(entry['chainId'])
    && Number(entry['chainId']) > 0
    && isNonEmptyString(entry['rpc'])
    && Number.isSafeInteger(entry['entityProviderDeploymentBlock'])
    && Number(entry['entityProviderDeploymentBlock']) > 0
    && isNonEmptyString(contracts['account'])
    && isNonEmptyString(contracts['depository'])
    && isNonEmptyString(contracts['entityProvider'])
    && isNonEmptyString(contracts['deltaTransformer']);
};

const sameMeshRpc = (left: unknown, right: unknown): boolean => {
  const leftRaw = String(left || '').trim();
  const rightRaw = String(right || '').trim();
  if (!leftRaw || !rightRaw) return false;
  if (leftRaw === rightRaw) return true;
  if (normalizeLoopbackUrl(leftRaw) === normalizeLoopbackUrl(rightRaw)) return true;
  return leftRaw === toPublicRpcUrl(rightRaw, '/rpc') || rightRaw === toPublicRpcUrl(leftRaw, '/rpc');
};

const isPrimaryJurisdiction = (entry: unknown): boolean =>
  isRecord(entry) && entry['primary'] === true;

export const resetMeshJurisdictionsCache = (): void => {
  clearJurisdictionsCache();
};

export const resolveMeshJurisdictionConfig = (
  rpcUrlOverride: string,
): ResolvedMeshJurisdictionConfig => {
  const data = loadJurisdictions();
  const map = data.jurisdictions ?? {};
  const requestedRpc = String(rpcUrlOverride || '').trim();
  const entries: ResolvedMeshJurisdictionConfig[] = [];
  for (const entry of Object.values(map)) {
    if (hasRequiredContracts(entry)) entries.push(entry);
  }
  const exactMatch = entries.find((entry) => sameMeshRpc(entry.rpc, requestedRpc));
  const selected = exactMatch ?? entries.find(isPrimaryJurisdiction) ?? entries[0];
  if (!selected) {
    throw new Error('JURISDICTION_NOT_FOUND');
  }
  return {
    ...selected,
    rpc: rpcUrlOverride || selected.rpc,
  };
};

export const requireJurisdictionBlockTimeMs = (
  jurisdiction: { name: string; blockTimeMs?: number | undefined },
): number => {
  const value = Number(jurisdiction.blockTimeMs);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  throw new Error(`JURISDICTION_BLOCK_TIME_MISSING:${jurisdiction.name}`);
};

const isSecondaryJurisdictionConfig = (
  key: string,
  jurisdiction: MeshJurisdictionConfig,
  primaryRpc: string,
): boolean => {
  const normalizedKey = String(key || '').trim().toLowerCase();
  const normalizedName = String(jurisdiction.name || '').trim().toLowerCase();
  const normalizedRpc = String(jurisdiction.rpc || '').trim();
  if (primaryRpc && normalizedRpc === primaryRpc) return false;
  const localPrimary = isLoopbackUrl(primaryRpc) || String(primaryRpc || '').trim().startsWith('/');
  const localCandidate = isLoopbackUrl(normalizedRpc) || normalizedRpc.startsWith('/');
  if (localPrimary && !localCandidate) return false;
  return normalizedKey === 'tron' || normalizedKey === 'rpc2' || normalizedName.includes('tron') || normalizedRpc.includes('/rpc2');
};

export const formatJurisdictionDisplayName = (name: string): string =>
  String(name || '')
    .replace(/\s*\((?:local|shared)\s+anvil\)\s*$/i, '')
    .trim();

export const resolveSecondaryJurisdictions = (
  primaryRpc: string,
): ResolvedMeshJurisdictionConfig[] => {
  resetMeshJurisdictionsCache();
  const data = loadJurisdictions();
  const entries: Array<[string, ResolvedMeshJurisdictionConfig]> = [];
  for (const [key, jurisdiction] of Object.entries(data.jurisdictions ?? {})) {
    if (hasRequiredContracts(jurisdiction)) entries.push([key, jurisdiction]);
  }
  return entries
    .filter(([key, jurisdiction]) => isSecondaryJurisdictionConfig(key, jurisdiction, primaryRpc))
    .map(([, jurisdiction]) => jurisdiction);
};

export const resolveMeshJurisdictionRpcBindings = (
  primaryRpc: string,
  resolveRpcUrl: (rpcUrl: string) => string,
): Array<{ jurisdictionRef: string; rpcUrl: string }> => {
  const primary = resolveMeshJurisdictionConfig(primaryRpc);
  return [primary, ...resolveSecondaryJurisdictions(primary.rpc)].map((jurisdiction) => {
    const jurisdictionRef = getJurisdictionIdentityRef(jurisdiction);
    const rpcUrl = resolveRpcUrl(jurisdiction.rpc).trim();
    if (!jurisdictionRef || !rpcUrl) throw new Error('MESH_JURISDICTION_RPC_BINDING_INVALID');
    return { jurisdictionRef, rpcUrl };
  });
};
