import { clearJurisdictionsCache, loadJurisdictions } from '../jurisdiction-loader';

export type MeshJurisdictionConfig = {
  name: string;
  chainId: number;
  rpc: string;
  blockTimeMs?: number;
  contracts?: {
    depository: string;
    entityProvider: string;
    account?: string;
    deltaTransformer?: string;
  };
};

export const resetMeshJurisdictionsCache = (): void => {
  clearJurisdictionsCache();
};

export const resolveMeshJurisdictionConfig = <T extends MeshJurisdictionConfig = MeshJurisdictionConfig>(
  rpcUrlOverride: string,
): T => {
  const data = loadJurisdictions();
  const map = data.jurisdictions ?? {};
  const requestedRpc = String(rpcUrlOverride || '').trim();
  const exactMatch = Object.values(map).find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return String((entry as MeshJurisdictionConfig).rpc || '').trim() === requestedRpc;
  });
  const arrakis = exactMatch ?? map['arrakis'] ?? Object.values(map)[0];
  if (!arrakis) {
    throw new Error('JURISDICTION_NOT_FOUND');
  }
  return {
    ...(arrakis as MeshJurisdictionConfig),
    rpc: rpcUrlOverride || (arrakis as MeshJurisdictionConfig).rpc,
  } as T;
};

export const requireJurisdictionBlockTimeMs = (jurisdiction: MeshJurisdictionConfig): number => {
  const value = Number(jurisdiction.blockTimeMs);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  throw new Error(`JURISDICTION_BLOCK_TIME_MISSING:${jurisdiction.name}`);
};

export const isSecondaryJurisdictionConfig = (
  key: string,
  jurisdiction: MeshJurisdictionConfig,
  primaryRpc: string,
): boolean => {
  const normalizedKey = String(key || '').trim().toLowerCase();
  const normalizedName = String(jurisdiction.name || '').trim().toLowerCase();
  const normalizedRpc = String(jurisdiction.rpc || '').trim();
  if (primaryRpc && normalizedRpc === primaryRpc) return false;
  return normalizedKey === 'tron' || normalizedKey === 'rpc2' || normalizedName.includes('tron') || normalizedRpc.includes('/rpc2');
};

export const formatJurisdictionDisplayName = (name: string): string =>
  String(name || '')
    .replace(/\s*\((?:local|shared)\s+anvil\)\s*$/i, '')
    .trim();

export const resolveSecondaryJurisdictions = <T extends MeshJurisdictionConfig = MeshJurisdictionConfig>(
  primaryRpc: string,
): T[] => {
  resetMeshJurisdictionsCache();
  const data = loadJurisdictions();
  const entries = Object.entries(data.jurisdictions ?? {});
  return entries
    .filter(([, jurisdiction]) => Boolean(jurisdiction?.rpc && jurisdiction?.contracts?.depository && jurisdiction?.contracts?.entityProvider))
    .filter(([key, jurisdiction]) => isSecondaryJurisdictionConfig(key, jurisdiction as MeshJurisdictionConfig, primaryRpc))
    .map(([, jurisdiction]) => jurisdiction as unknown as T);
};
