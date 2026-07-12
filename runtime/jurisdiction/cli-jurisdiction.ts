import { isUsableContractAddress } from './contract-address';
import { loadJurisdictions } from './jurisdiction-loader';
import { normalizeLoopbackUrl } from '../loopback-url';

type RawJurisdictionEntry = Record<string, unknown> & {
  name?: unknown;
  chainId?: unknown;
  rpc?: unknown;
  primary?: unknown;
  status?: unknown;
  contracts?: Record<string, unknown>;
};

type RawJurisdictionsPayload = Record<string, unknown> & {
  jurisdictions?: Record<string, RawJurisdictionEntry>;
};

export type CliJurisdictionContracts = {
  account: string;
  depository: string;
  entityProvider: string;
  deltaTransformer: string;
};

export type CliJurisdiction = {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  contracts: CliJurisdictionContracts;
};

export type CliJurisdictionSelectionOptions = {
  rpcUrl: string;
  jurisdictionKey?: string | undefined;
};

const normalizeStatus = (entry: RawJurisdictionEntry): string =>
  String(entry.status || 'active').trim().toLowerCase();

const isActive = (entry: RawJurisdictionEntry): boolean =>
  normalizeStatus(entry) === 'active';

const hasRequiredContracts = (entry: RawJurisdictionEntry): boolean =>
  isUsableContractAddress(entry.contracts?.['depository']) &&
  isUsableContractAddress(entry.contracts?.['entityProvider']);

const sameRpc = (left: unknown, right: unknown): boolean => {
  const leftRaw = String(left || '').trim();
  const rightRaw = String(right || '').trim();
  if (!leftRaw || !rightRaw) return false;
  if (leftRaw === rightRaw) return true;
  if (normalizeLoopbackUrl(leftRaw) === normalizeLoopbackUrl(rightRaw)) return true;
  try {
    const leftUrl = leftRaw.startsWith('/') ? null : new URL(leftRaw);
    const rightUrl = rightRaw.startsWith('/') ? null : new URL(rightRaw);
    if (leftRaw.startsWith('/') && rightUrl) return rightUrl.pathname === leftRaw;
    if (rightRaw.startsWith('/') && leftUrl) return leftUrl.pathname === rightRaw;
  } catch {
    return false;
  }
  return false;
};

const resolveRpcUrl = (entryRpc: unknown, fallbackRpcUrl: string): string => {
  const raw = String(entryRpc || '').trim();
  if (!raw) return fallbackRpcUrl;
  if (raw.startsWith('/')) return new URL(raw, fallbackRpcUrl).toString();
  return raw;
};

const optionalContractAddress = (value: unknown): string =>
  isUsableContractAddress(value) ? value : '';

const toCliJurisdiction = (
  key: string,
  entry: RawJurisdictionEntry,
  fallbackRpcUrl: string,
): CliJurisdiction => {
  if (!hasRequiredContracts(entry)) {
    throw new Error(`CLI_JURISDICTION_CONTRACTS_INCOMPLETE:${key}`);
  }
  const chainId = Number(entry.chainId ?? 31337);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`CLI_JURISDICTION_CHAIN_ID_INVALID:${key}`);
  }
  return {
    key,
    name: String(entry.name || key).trim() || key,
    chainId: Math.floor(chainId),
    rpcUrl: resolveRpcUrl(entry.rpc, fallbackRpcUrl),
    contracts: {
      account: optionalContractAddress(entry.contracts?.['account']),
      depository: entry.contracts!['depository'] as string,
      entityProvider: entry.contracts!['entityProvider'] as string,
      deltaTransformer: optionalContractAddress(entry.contracts?.['deltaTransformer']),
    },
  };
};

export const selectCliJurisdiction = (
  payload: unknown,
  options: CliJurisdictionSelectionOptions,
): CliJurisdiction => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('CLI_JURISDICTIONS_PAYLOAD_INVALID');
  }
  const jurisdictions = (payload as RawJurisdictionsPayload).jurisdictions ?? {};
  const allEntries = Object.entries(jurisdictions);

  const requestedKey = String(options.jurisdictionKey || '').trim().toLowerCase();
  if (requestedKey) {
    const requested = allEntries.find(([key]) => key.toLowerCase() === requestedKey);
    if (!requested) throw new Error(`CLI_JURISDICTION_NOT_FOUND:${requestedKey}`);
    return toCliJurisdiction(requested[0], requested[1], options.rpcUrl);
  }

  const entries = allEntries.filter(([, entry]) => hasRequiredContracts(entry));
  if (entries.length === 0) throw new Error('CLI_JURISDICTIONS_EMPTY');
  const match =
    entries.find(([, entry]) => sameRpc(entry.rpc, options.rpcUrl))
    ?? entries.find(([, entry]) => isActive(entry) && entry.primary === true)
    ?? entries.find(([, entry]) => isActive(entry))
    ?? entries[0];

  if (!match) throw new Error('CLI_JURISDICTION_NOT_FOUND');
  return toCliJurisdiction(match[0], match[1], options.rpcUrl);
};

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`CLI_JURISDICTIONS_HTTP_${response.status}`);
  return await response.json();
};

export const loadCliJurisdiction = async (options: {
  rpcUrl: string;
  remote: boolean;
  jurisdictionKey?: string | undefined;
  jurisdictionsUrl?: string | undefined;
}): Promise<CliJurisdiction> => {
  const payload = options.jurisdictionsUrl
    ? await fetchJson(options.jurisdictionsUrl)
    : options.remote
      ? await fetchJson(new URL('/api/jurisdictions', options.rpcUrl).toString())
      : loadJurisdictions();
  return selectCliJurisdiction(payload, options);
};
