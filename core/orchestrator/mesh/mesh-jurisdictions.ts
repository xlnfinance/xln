import { clearJurisdictionsCache, loadJurisdictions } from '../../jurisdiction/adapter/kernel/jurisdiction-loader';
import { getJurisdictionIdentityRef } from '../../jurisdiction/machine/jurisdiction-runtime';
import { isLoopbackUrl, normalizeLoopbackUrl, toPublicRpcUrl } from '../../network/p2p/loopback-url';
import { isRecord } from '../../support/boundary-guards';
import { DEV_CHAIN_IDS } from '../../jurisdiction/adapter/chain-ids';
import { getTokenIdsForJurisdiction } from '../../account/utils';

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

// Catalog publication includes auxiliary verifier metadata. importJ owns only
// these four bindings; copying the catalog object makes the first WAL invalid.
const runtimeJurisdictionConfig = (entry: ResolvedMeshJurisdictionConfig): ResolvedMeshJurisdictionConfig => ({
  ...entry,
  contracts: { account: entry.contracts.account, depository: entry.contracts.depository,
    entityProvider: entry.contracts.entityProvider, deltaTransformer: entry.contracts.deltaTransformer },
});

export const resetMeshJurisdictionsCache = (): void => {
  clearJurisdictionsCache();
};

/** Public operators use the admitted registry; development assets stay on dev chains. */
export const getMeshJurisdictionTokenIds = (identity: { name: string; chainId: number }): number[] => {
  if (DEV_CHAIN_IDS.has(identity.chainId)) return getTokenIdsForJurisdiction(identity);
  const entries = Object.values(loadJurisdictions().jurisdictions)
    .filter(entry => entry.chainId === identity.chainId && entry.name === identity.name);
  if (entries.length !== 1) throw new Error(`MESH_TOKEN_JURISDICTION_AMBIGUOUS:${identity.name}`);
  const entry = entries[0];
  if (!isRecord(entry) || !isRecord(entry['tokens'])) throw new Error(`MESH_TOKEN_REGISTRY_REQUIRED:${identity.name}`);
  const ids = Object.values(entry['tokens']).map(token => {
    if (!isRecord(token) || !Number.isSafeInteger(token['tokenId']) || Number(token['tokenId']) <= 0)
      throw new Error(`MESH_TOKEN_ID_INVALID:${identity.name}`);
    return Number(token['tokenId']);
  });
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error(`MESH_TOKEN_REGISTRY_INVALID:${identity.name}`);
  return ids.sort((left, right) => left - right);
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
  if (entries.length === 0) throw new Error('JURISDICTION_NOT_FOUND');
  const exactMatch = entries.find((entry) => sameMeshRpc(entry.rpc, requestedRpc));
  if (requestedRpc && !exactMatch) throw new Error(`MESH_RPC_OVERRIDE_UNMAPPED:${requestedRpc}`);
  const selected = exactMatch ?? entries.find(isPrimaryJurisdiction) ?? entries[0];
  if (!selected) {
    throw new Error('JURISDICTION_NOT_FOUND');
  }
  return {
    ...runtimeJurisdictionConfig(selected),
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
  jurisdiction: Pick<MeshJurisdictionConfig, 'name' | 'rpc'>,
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
  const primaryOnly = String(process.env['XLN_MESH_PRIMARY_JURISDICTION_ONLY'] || '').trim();
  if (primaryOnly && primaryOnly !== '0' && primaryOnly !== '1') {
    throw new Error(`XLN_MESH_PRIMARY_JURISDICTION_ONLY_INVALID:${primaryOnly}`);
  }
  if (primaryOnly === '1') return [];
  resetMeshJurisdictionsCache();
  const data = loadJurisdictions();
  const entries: ResolvedMeshJurisdictionConfig[] = [];
  for (const [key, jurisdiction] of Object.entries(data.jurisdictions ?? {})) {
    if (!isSecondaryJurisdictionConfig(key, jurisdiction, primaryRpc)) continue;
    if (!hasRequiredContracts(jurisdiction)) throw new TypeError(`MESH_JURISDICTION_INCOMPLETE:${key}`);
    entries.push(runtimeJurisdictionConfig(jurisdiction));
  }
  return entries;
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
