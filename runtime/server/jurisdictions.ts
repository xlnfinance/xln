import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { Env } from '../types';
import type { JAdapter } from '../jadapter';
import { resolveJurisdictionsJsonPath } from '../jurisdictions-path';
import { computeJurisdictionsNetworkVersion } from '../jurisdictions-version';
import { toPublicRpcUrl } from '../loopback-url';
import { createStructuredLogger } from '../logger';
import { isRecord } from '../server-utils';

const serverLog = createStructuredLogger('server');
const PRIMARY_TESTNET_JURISDICTION_NAME = 'Testnet';

const normalizeJurisdictionDisplayName = (value: unknown): string => {
  const name = String(value || '').trim();
  const normalized = name.toLowerCase();
  if (
    normalized === 'arrakis'
    || normalized === 'arrakis (shared anvil)'
    || normalized === 'shared anvil'
    || normalized === 'wakanda'
  ) {
    return PRIMARY_TESTNET_JURISDICTION_NAME;
  }
  return name;
};

export const updateJurisdictionsJson = async (
  contracts: JAdapter['addresses'],
  rpcUrl?: string,
  chainIdOverride?: number,
): Promise<void> => {
  try {
    const canonicalPath = resolveJurisdictionsJsonPath();
    const publicRpc = toPublicRpcUrl(String(process.env['PUBLIC_RPC'] || rpcUrl || '/rpc'));
    await mkdir(dirname(canonicalPath), { recursive: true });

    type MutableJurisdictionsJson = Record<string, unknown> & {
      defaults?: Record<string, unknown> & { rebalancePolicyUsd?: unknown };
      jurisdictions?: Record<string, Record<string, unknown>>;
    };
    let data: MutableJurisdictionsJson = {};
    try {
      const parsed = JSON.parse(await readFile(canonicalPath, 'utf-8'));
      data = isRecord(parsed) ? parsed as MutableJurisdictionsJson : {};
    } catch {
      data = {};
    }
    const updatedAt = new Date().toISOString();
    data['version'] = String(data['version'] || '').trim() || '1';
    data['lastUpdated'] = updatedAt;
    const defaults = data.defaults ?? {
      timeout: 30000,
      retryAttempts: 3,
      gasLimit: 1_000_000,
      rebalancePolicyUsd: {
        r2cRequestSoftLimit: 500,
        hardLimit: 10_000,
        maxFee: 15,
      },
    };
    defaults.rebalancePolicyUsd = defaults.rebalancePolicyUsd ?? {
      r2cRequestSoftLimit: 500,
      hardLimit: 10_000,
      maxFee: 15,
    };
    data.defaults = defaults;
    if (data['testnet']) delete data['testnet'];
    const jurisdictions = data.jurisdictions ?? {};
    for (const key of Object.keys(jurisdictions)) {
      if (key !== 'arrakis' && key.startsWith('arrakis_')) delete jurisdictions[key];
    }
    const existingArrakis = jurisdictions['arrakis'] ?? {};
    jurisdictions['arrakis'] = {
      ...existingArrakis,
      name: 'Testnet',
      chainId: chainIdOverride ?? 31337,
      rpc: publicRpc,
      rebalancePolicyUsd: existingArrakis['rebalancePolicyUsd'] ?? defaults.rebalancePolicyUsd,
      contracts: {
        account: contracts.account,
        depository: contracts.depository,
        entityProvider: contracts.entityProvider,
        deltaTransformer: contracts.deltaTransformer,
      },
    };
    data.jurisdictions = jurisdictions;
    const networkVersion = computeJurisdictionsNetworkVersion(data, String(data['version'] || '1'));
    data['deployVersion'] = networkVersion;
    data['networkVersion'] = networkVersion;

    const payload = JSON.stringify(data, null, 2);
    await writeFile(canonicalPath, payload);
    serverLog.info('jurisdictions.updated', { path: canonicalPath });
  } catch (err) {
    serverLog.warn('jurisdictions.update_failed', { error: (err as Error).message });
  }
};

export const readCanonicalJurisdictionsJson = async (): Promise<string> =>
  await readFile(resolveJurisdictionsJsonPath(), 'utf8');

const readCanonicalJurisdictionsVersion = async (): Promise<string> => {
  const raw = await readCanonicalJurisdictionsJson();
  const parsed = JSON.parse(raw) as { version?: unknown };
  const version = String(parsed.version || '').trim();
  if (!version) {
    throw new Error('MISSING_JURISDICTIONS_VERSION');
  }
  return version;
};

const readCanonicalNetworkVersion = async (): Promise<string> => {
  const raw = await readCanonicalJurisdictionsJson();
  const parsed = JSON.parse(raw) as {
    deployVersion?: unknown;
    networkVersion?: unknown;
    lastUpdated?: unknown;
  };
  return computeJurisdictionsNetworkVersion(parsed, await readCanonicalJurisdictionsVersion());
};

export const buildRuntimeJurisdictionsJson = async (env?: Env | null): Promise<string | null> => {
  if (!env?.jReplicas || env.jReplicas.size === 0) return null;
  const jurisdictionName = env.activeJurisdiction ?? env.jReplicas.keys().next().value;
  if (typeof jurisdictionName !== 'string' || !jurisdictionName) return null;
  const replica = env.jReplicas.get(jurisdictionName) as
    | {
        name?: string;
        chainId?: number;
        rpcs?: string[];
        depositoryAddress?: string;
        entityProviderAddress?: string;
        contracts?: {
          account?: string;
          depository?: string;
          entityProvider?: string;
          deltaTransformer?: string;
        };
        jadapter?: {
          addresses?: {
            account?: string;
            depository?: string;
            entityProvider?: string;
            deltaTransformer?: string;
          };
        };
      }
    | undefined;
  if (!replica) return null;

  const addresses = replica.jadapter?.addresses ?? {};
  const depository =
    String(addresses.depository || replica.depositoryAddress || replica.contracts?.depository || '').trim();
  const entityProvider =
    String(addresses.entityProvider || replica.entityProviderAddress || replica.contracts?.entityProvider || '').trim();
  if (!depository || !entityProvider) return null;

  const version = await readCanonicalJurisdictionsVersion();
  const networkVersion = await readCanonicalNetworkVersion();
  const payload = {
    version,
    deployVersion: networkVersion,
    networkVersion,
    lastUpdated: new Date().toISOString(),
    jurisdictions: {
      arrakis: {
        name: normalizeJurisdictionDisplayName(replica.name || jurisdictionName) || PRIMARY_TESTNET_JURISDICTION_NAME,
        chainId: Number(replica.chainId || 31337),
        rpc: toPublicRpcUrl(String(process.env['PUBLIC_RPC'] || replica.rpcs?.[0] || '/rpc')),
        contracts: {
          account: String(addresses.account || replica.contracts?.account || ''),
          depository,
          entityProvider,
          deltaTransformer: String(addresses.deltaTransformer || replica.contracts?.deltaTransformer || ''),
        },
      },
    },
  };
  return JSON.stringify(payload);
};
