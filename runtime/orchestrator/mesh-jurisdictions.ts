import { clearJurisdictionsCache, loadJurisdictions } from '../jurisdiction-loader';
import { normalizeLoopbackUrl, toPublicRpcUrl } from '../loopback-url';

export type MeshJurisdictionConfig = {
  name: string;
  chainId: number;
  rpc: string;
  primary?: boolean;
  blockTimeMs?: number;
  contracts?: {
    depository: string;
    entityProvider: string;
    account?: string;
    deltaTransformer?: string;
  };
};

const hasRequiredContracts = (entry: unknown): entry is MeshJurisdictionConfig => {
  const jurisdiction = entry as MeshJurisdictionConfig | null | undefined;
  return Boolean(
    jurisdiction?.contracts?.account &&
    jurisdiction.contracts.depository &&
    jurisdiction.contracts.entityProvider &&
    jurisdiction.contracts.deltaTransformer,
  );
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
  (entry as { primary?: unknown } | null | undefined)?.primary === true;

export const resetMeshJurisdictionsCache = (): void => {
  clearJurisdictionsCache();
};

export const resolveMeshJurisdictionConfig = <T extends MeshJurisdictionConfig = MeshJurisdictionConfig>(
  rpcUrlOverride: string,
): T => {
  const data = loadJurisdictions();
  const map = data.jurisdictions ?? {};
  const requestedRpc = String(rpcUrlOverride || '').trim();
  const entries = Object.values(map).filter(hasRequiredContracts);
  const exactMatch = entries.find((entry) => sameMeshRpc(entry.rpc, requestedRpc));
  const selected = exactMatch ?? entries.find(isPrimaryJurisdiction) ?? entries[0];
  if (!selected) {
    throw new Error('JURISDICTION_NOT_FOUND');
  }
  return {
    ...selected,
    rpc: rpcUrlOverride || selected.rpc,
  } as unknown as T;
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
    .filter(([, jurisdiction]) => Boolean(jurisdiction?.rpc && hasRequiredContracts(jurisdiction)))
    .filter(([key, jurisdiction]) => isSecondaryJurisdictionConfig(key, jurisdiction as MeshJurisdictionConfig, primaryRpc))
    .map(([, jurisdiction]) => jurisdiction as unknown as T);
};
