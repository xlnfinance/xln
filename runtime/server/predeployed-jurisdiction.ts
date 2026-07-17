import { normalizeLoopbackUrl, toPublicRpcUrl } from '../networking/loopback-url';

export type PredeployedJurisdictionEntry = {
  rpc?: unknown;
  chainId?: unknown;
  entityProviderDeploymentBlock?: unknown;
  primary?: unknown;
  contracts?: Record<string, unknown>;
};

export type CompletePredeployedJurisdictionEntry = Omit<PredeployedJurisdictionEntry, 'contracts'> & {
  contracts: Record<string, unknown>;
};

const hasPredeployedContracts = (entry: unknown): entry is CompletePredeployedJurisdictionEntry => {
  const candidate = entry as PredeployedJurisdictionEntry | null | undefined;
  const contracts = candidate?.contracts;
  const deploymentBlock = Number(candidate?.entityProviderDeploymentBlock);
  return Boolean(
    contracts?.['account'] &&
    contracts['depository'] &&
    contracts['entityProvider'] &&
    contracts['deltaTransformer'] &&
    Number.isSafeInteger(deploymentBlock) &&
    deploymentBlock > 0,
  );
};

const samePredeployedRpc = (left: unknown, right: unknown): boolean => {
  const leftRaw = String(left || '').trim();
  const rightRaw = String(right || '').trim();
  if (!leftRaw || !rightRaw) return false;
  if (leftRaw === rightRaw) return true;
  if (normalizeLoopbackUrl(leftRaw) === normalizeLoopbackUrl(rightRaw)) return true;
  return leftRaw === toPublicRpcUrl(rightRaw, '/rpc') || rightRaw === toPublicRpcUrl(leftRaw, '/rpc');
};

const requireUniqueMatch = (
  entries: readonly CompletePredeployedJurisdictionEntry[],
  reason: string,
): CompletePredeployedJurisdictionEntry | null => {
  if (entries.length > 1) {
    throw new Error(`PREDEPLOYED_JURISDICTION_AMBIGUOUS:${reason}:${entries.length}`);
  }
  return entries[0] ?? null;
};

export const selectPredeployedJurisdiction = (
  payload: unknown,
  rpcUrl: string,
  preferredKey?: string,
): CompletePredeployedJurisdictionEntry | null => {
  const jurisdictions = (payload as { jurisdictions?: unknown } | null | undefined)?.jurisdictions;
  if (jurisdictions === undefined) return null;
  if (!jurisdictions || typeof jurisdictions !== 'object' || Array.isArray(jurisdictions)) {
    throw new Error('PREDEPLOYED_JURISDICTIONS_INVALID');
  }

  const keyedEntries = Object.entries(jurisdictions as Record<string, unknown>);
  const preferred = String(preferredKey || '').trim().toLowerCase();
  if (preferred) {
    const match = keyedEntries.find(([key]) => key.trim().toLowerCase() === preferred);
    if (!match) throw new Error(`PREDEPLOYED_JURISDICTION_NOT_FOUND:${preferred}`);
    if (!hasPredeployedContracts(match[1])) throw new Error(`PREDEPLOYED_JURISDICTION_INCOMPLETE:${preferred}`);
    return match[1];
  }

  const entries = keyedEntries.map(([, entry]) => entry).filter(hasPredeployedContracts);
  const rpcMatch = requireUniqueMatch(
    entries.filter(entry => samePredeployedRpc(entry.rpc, rpcUrl)),
    'rpc',
  );
  if (rpcMatch) return rpcMatch;
  const primaryMatch = requireUniqueMatch(entries.filter(entry => entry.primary === true), 'primary');
  if (primaryMatch) return primaryMatch;
  return requireUniqueMatch(entries, 'fallback');
};
