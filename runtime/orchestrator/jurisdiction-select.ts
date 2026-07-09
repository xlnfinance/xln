import { normalizeLoopbackUrl } from '../loopback-url';

export type HubJurisdictionEntry = Record<string, unknown> & {
  name?: string;
  chainId?: number;
  rpc?: unknown;
  contracts?: Record<string, unknown> & {
    depository?: string;
    entityProvider?: string;
  };
};

type HubJurisdictionsPayload = Record<string, unknown> & {
  jurisdictions?: Record<string, HubJurisdictionEntry>;
};

export type PrimaryHubJurisdiction = {
  key: string;
  name: string;
  chainId?: number;
  depositoryAddress?: string;
  entityProviderAddress?: string;
};

export const isRpc2Jurisdiction = (
  config: { rpc2Url?: string },
  key: string,
  jurisdiction: HubJurisdictionEntry,
): boolean => {
  const normalizedKey = String(key || '').trim().toLowerCase();
  if (normalizedKey === 'tron' || normalizedKey === 'rpc2' || normalizedKey === 'localhost2') return true;
  const name = String(jurisdiction.name || '').trim().toLowerCase();
  if (name.includes('tron')) return true;
  const rpc = String(jurisdiction.rpc || '').trim();
  return Boolean(config.rpc2Url && normalizeLoopbackUrl(rpc) === normalizeLoopbackUrl(config.rpc2Url));
};

const isPendingJurisdiction = (jurisdiction: HubJurisdictionEntry): boolean =>
  String(jurisdiction['status'] || '').trim().toLowerCase() === 'pending';

const toPrimaryHubJurisdiction = (
  key: string,
  jurisdiction: HubJurisdictionEntry,
): PrimaryHubJurisdiction | null => {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  const name = String(jurisdiction.name || normalizedKey).trim();
  return {
    key: normalizedKey,
    name,
    ...(jurisdiction.chainId !== undefined ? { chainId: jurisdiction.chainId } : {}),
    ...(jurisdiction.contracts?.depository ? { depositoryAddress: jurisdiction.contracts.depository } : {}),
    ...(jurisdiction.contracts?.entityProvider ? { entityProviderAddress: jurisdiction.contracts.entityProvider } : {}),
  };
};

export const selectPrimaryHubJurisdiction = (
  payload: unknown,
  config: { rpc2Url?: string } = {},
): PrimaryHubJurisdiction | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const entries = Object.entries((payload as HubJurisdictionsPayload).jurisdictions ?? {});
  const localEntries = entries.filter(([key, jurisdiction]) => !isRpc2Jurisdiction(config, key, jurisdiction));
  const activeLocalEntries = localEntries.filter(([, jurisdiction]) => !isPendingJurisdiction(jurisdiction));
  const match =
    activeLocalEntries.find(([, jurisdiction]) => jurisdiction['primary'] === true)
    ?? activeLocalEntries[0]
    ?? localEntries[0]
    ?? entries[0];
  if (!match) return null;
  return toPrimaryHubJurisdiction(match[0], match[1]);
};
