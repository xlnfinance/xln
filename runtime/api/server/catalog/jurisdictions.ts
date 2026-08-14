import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JAdapter } from '../../../jurisdiction/adapter';
import { normalizeJurisdictionKey, selectWritableJurisdictionKey, type WritableJurisdictionEntry } from '../../../jurisdiction/machine/config/jurisdiction-key';
import { resolveJurisdictionsJsonPath } from '../../../jurisdiction/adapter/jurisdictions-path';
import { computeJurisdictionsNetworkVersion } from '../../../jurisdiction/adapter/core/jurisdictions-version';
import { toPublicRpcUrl } from '../../../network/p2p/loopback-url';
import { createStructuredLogger } from '../../../infra/logger';
import { validateJurisdictionsDataValue } from '../../../jurisdiction/adapter/core/jurisdiction-loader';
import { safeStringify } from '../../../protocol/serialization';
import { isRecord } from '../utils';

const serverLog = createStructuredLogger('server');

const normalizeJurisdictionDisplayName = (value: unknown): string =>
  String(value || '').trim();

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && !Array.isArray(value);

export type UpdatedRuntimeJurisdiction = {
  key: string;
  name: string;
};

export const updateJurisdictionsJson = async (
  contracts: JAdapter['addresses'],
  rpcUrl?: string,
  chainIdOverride?: number,
  targetKeyOverride?: string,
  entityProviderDeploymentBlockOverride?: number,
): Promise<UpdatedRuntimeJurisdiction | null> => {
  const entityProviderDeploymentBlock = Number(entityProviderDeploymentBlockOverride);
  if (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1) {
    throw new Error(
      `JURISDICTIONS_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID:${String(entityProviderDeploymentBlockOverride)}`,
    );
  }
  try {
    const canonicalPath = resolveJurisdictionsJsonPath();
    const publicRpc = toPublicRpcUrl(String(process.env['PUBLIC_RPC'] || rpcUrl || '/rpc'));
    await mkdir(dirname(canonicalPath), { recursive: true });

    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(canonicalPath, 'utf-8'));
      data = validateJurisdictionsDataValue(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      data = {};
    }
    const updatedAt = new Date().toISOString();
    data['version'] = String(data['version'] || '').trim() || '1';
    data['lastUpdated'] = updatedAt;
    if (data['defaults'] !== undefined && !isPlainRecord(data['defaults'])) {
      throw new Error('JURISDICTIONS_DEFAULTS_INVALID');
    }
    const defaults = data['defaults'] ?? {
      timeout: 30000,
      retryAttempts: 3,
      gasLimit: 1_000_000,
      rebalancePolicyUsd: {
        r2cRequestSoftLimit: 500,
        hardLimit: 10_000,
        maxFee: 15,
      },
    };
    defaults['rebalancePolicyUsd'] = defaults['rebalancePolicyUsd'] ?? {
      r2cRequestSoftLimit: 500,
      hardLimit: 10_000,
      maxFee: 15,
    };
    data['defaults'] = defaults;
    if (data['testnet']) delete data['testnet'];
    if (data['jurisdictions'] !== undefined && !isPlainRecord(data['jurisdictions'])) {
      throw new Error('JURISDICTIONS_MAP_INVALID');
    }
    const jurisdictions: Record<string, WritableJurisdictionEntry> = Object.fromEntries(
      Object.entries(data['jurisdictions'] ?? {}).map(([key, value]) => {
        if (!isPlainRecord(value)) throw new Error(`JURISDICTION_ENTRY_INVALID:${key}`);
        return [key, value];
      }),
    );
    const rawTargetKeyOverride = String(targetKeyOverride || '').trim();
    const requestedTargetKey = rawTargetKeyOverride ? normalizeJurisdictionKey(rawTargetKeyOverride) : '';
    const existingRequestedKey = requestedTargetKey
      ? Object.keys(jurisdictions).find(key => normalizeJurisdictionKey(key, '') === requestedTargetKey)
      : '';
    const targetKey = existingRequestedKey || requestedTargetKey || selectWritableJurisdictionKey(jurisdictions, undefined, [rpcUrl, publicRpc]);
    const previous = jurisdictions[targetKey] ?? {};
    const displayName = normalizeJurisdictionDisplayName(previous['name']) || targetKey;
    jurisdictions[targetKey] = {
      ...previous,
      name: displayName,
      primary: previous['primary'] ?? true,
      status: previous['status'] ?? 'active',
      chainId: chainIdOverride ?? 31337,
      blockTimeMs: previous['blockTimeMs'] ?? 1_000,
      explorer: previous['explorer'] ?? '',
      currency: previous['currency'] ?? 'ETH',
      entityProviderDeploymentBlock,
      rpc: publicRpc,
      rebalancePolicyUsd: previous['rebalancePolicyUsd'] ?? defaults['rebalancePolicyUsd'],
      contracts: {
        account: contracts.account,
        depository: contracts.depository,
        entityProvider: contracts.entityProvider,
        deltaTransformer: contracts.deltaTransformer,
      },
    };
    data['jurisdictions'] = jurisdictions;
    const networkVersion = computeJurisdictionsNetworkVersion(data, String(data['version'] || '1'));
    data['deployVersion'] = networkVersion;
    data['networkVersion'] = networkVersion;

    validateJurisdictionsDataValue(data);
    const payload = safeStringify(data, 2);
    await writeFile(canonicalPath, payload);
    serverLog.info('jurisdictions.updated', { path: canonicalPath });
    return { key: targetKey, name: displayName };
  } catch (err) {
    serverLog.error('jurisdictions.update_failed', { error: (err as Error).message });
    throw err;
  }
};

export const readCanonicalJurisdictionsJson = async (): Promise<string> =>
  await readFile(resolveJurisdictionsJsonPath(), 'utf8');

const readCanonicalJurisdictionsVersion = async (): Promise<string> => {
  const raw = await readCanonicalJurisdictionsJson();
  const parsed = validateJurisdictionsDataValue(JSON.parse(raw));
  const version = String(parsed['version'] || '').trim();
  if (!version) {
    throw new Error('MISSING_JURISDICTIONS_VERSION');
  }
  return version;
};

const readCanonicalNetworkVersion = async (): Promise<string> => {
  const raw = await readCanonicalJurisdictionsJson();
  const parsed = validateJurisdictionsDataValue(JSON.parse(raw));
  return computeJurisdictionsNetworkVersion(parsed, await readCanonicalJurisdictionsVersion());
};

export const buildRuntimeJurisdictionsJson = async (env?: RuntimeReplica | null): Promise<string | null> => {
  if (!env?.state.jReplicas || env.state.jReplicas.size === 0) return null;
  const jurisdictionName = env.activeJurisdiction ?? env.state.jReplicas.keys().next().value;
  if (typeof jurisdictionName !== 'string' || !jurisdictionName) return null;
  const replica = env.state.jReplicas.get(jurisdictionName) as
    | {
        name?: string;
        chainId?: number;
        rpcs?: string[];
        depositoryAddress?: string;
        entityProviderAddress?: string;
        entityProviderDeploymentBlock?: number;
        contracts?: {
          account?: string;
          depository?: string;
          entityProvider?: string;
          deltaTransformer?: string;
        };
      }
    | undefined;
  if (!replica) return null;

  const account = String(replica.contracts?.account || '').trim();
  const depository =
    String(replica.contracts?.depository || '').trim();
  const entityProvider =
    String(replica.contracts?.entityProvider || '').trim();
  const deltaTransformer = String(replica.contracts?.deltaTransformer || '').trim();
  if (!account || !depository || !entityProvider || !deltaTransformer) return null;
  const entityProviderDeploymentBlock = Number(
    replica.entityProviderDeploymentBlock,
  );
  if (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1) {
    throw new Error(
      `RUNTIME_JURISDICTION_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID:${String(entityProviderDeploymentBlock)}`,
    );
  }

  const version = await readCanonicalJurisdictionsVersion();
  const networkVersion = await readCanonicalNetworkVersion();
  const displayName =
    normalizeJurisdictionDisplayName(replica.name || jurisdictionName) ||
    normalizeJurisdictionDisplayName(jurisdictionName) ||
    'primary';
  const jurisdictionKey = normalizeJurisdictionKey(jurisdictionName || displayName);
  const payload = {
    version,
    deployVersion: networkVersion,
    networkVersion,
    lastUpdated: new Date().toISOString(),
    jurisdictions: {
      [jurisdictionKey]: {
        name: displayName,
        primary: true,
        status: 'active',
        chainId: Number(replica.chainId || 31337),
        entityProviderDeploymentBlock,
        rpc: toPublicRpcUrl(String(process.env['PUBLIC_RPC'] || replica.rpcs?.[0] || '/rpc')),
        contracts: {
          account,
          depository,
          entityProvider,
          deltaTransformer,
        },
      },
    },
  };
  return JSON.stringify(payload);
};
