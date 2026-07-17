import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createJAdapter } from '../jadapter';
import type { JAdapter } from '../jadapter/types';
import { resolveJurisdictionsJsonPath } from '../jurisdiction/jurisdictions-path';
import { computeJurisdictionsNetworkVersion } from '../jurisdiction/jurisdictions-version';
import { normalizeLoopbackUrl, toPublicRpcUrl } from '../networking/loopback-url';
import {
  assertCanonicalRpcContractStack,
  findMissingRpcContractCode,
  REQUIRED_RPC_CONTRACT_KEYS,
  type RpcContractAddresses,
} from './contract-readiness';
import {
  isRpc2Jurisdiction,
  selectPrimaryHubJurisdiction,
  type HubJurisdictionEntry as ShardJurisdictionEntry,
  type PrimaryHubJurisdiction,
} from './jurisdiction-select';

export type OrchestratorJurisdictionsConfig = {
  shardJurisdictionsPath: string;
  rpc2Url: string;
  rpcUrls?: Record<number, string>;
};

type ShardJurisdictionsFile = Record<string, unknown> & {
  version?: unknown;
  jurisdictions?: Record<string, ShardJurisdictionEntry>;
  defaults?: Record<string, unknown>;
};

type CompleteRpcContractAddresses = Record<(typeof REQUIRED_RPC_CONTRACT_KEYS)[number], string>;

export type PrimaryRpcProvisionResult = {
  key: string;
  chainId: number;
  contracts: CompleteRpcContractAddresses;
  entityProviderDeploymentBlock: number;
  deployed: boolean;
};

type ProvisionedRpcStack = Pick<
  PrimaryRpcProvisionResult,
  'contracts' | 'entityProviderDeploymentBlock'
>;

const resolveRepoJurisdictionsJsonPath = (): string => {
  const repoUrl = new URL('../../jurisdictions/jurisdictions.json', import.meta.url);
  return resolve(decodeURIComponent(repoUrl.pathname));
};

const rpcPublicPath = (index: number): string => index <= 1 ? '/rpc' : `/rpc${index}`;

const parseRpcIndex = (value: string): number | null => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'tron' || normalized === 'localhost2') return 2;
  const match = normalized.match(/^rpc([2-8])$/);
  if (!match) return null;
  return Number(match[1]);
};

const resolvePublicRpcPath = (
  config: OrchestratorJurisdictionsConfig,
  key: string,
  jurisdiction: ShardJurisdictionEntry,
): string => {
  const rpc = String(jurisdiction.rpc || '').trim();
  const normalizedRpc = normalizeLoopbackUrl(rpc);
  const rpcUrls = config.rpcUrls ?? {
    1: '',
    2: config.rpc2Url,
  };
  for (const [rawIndex, rawUrl] of Object.entries(rpcUrls)) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 1 || index > 8 || !rawUrl) continue;
    if (normalizedRpc === normalizeLoopbackUrl(rawUrl)) {
      return rpcPublicPath(index);
    }
  }

  const namedIndex = parseRpcIndex(key) ?? parseRpcIndex(String(jurisdiction.name || ''));
  if (namedIndex !== null) return rpcPublicPath(namedIndex);
  return '/rpc';
};

export const readShardJurisdictions = (config: OrchestratorJurisdictionsConfig): string => {
  const canonicalPath = resolveJurisdictionsJsonPath();
  if (!existsSync(config.shardJurisdictionsPath)) {
    throw new Error(`JURISDICTIONS_JSON_MISSING path=${config.shardJurisdictionsPath}`);
  }
  const canonical = existsSync(canonicalPath) ? readFileSync(canonicalPath, 'utf8') : '';
  const shard = readFileSync(config.shardJurisdictionsPath, 'utf8');
  try {
    const shardPayload = JSON.parse(shard) as { version?: unknown };
    const canonicalVersion = canonical
      ? String((JSON.parse(canonical) as { version?: unknown }).version || '').trim() || '1'
      : String(shardPayload.version || '').trim() || '1';
    const shardVersion = String(shardPayload.version || '').trim();
    if (shardVersion !== canonicalVersion) {
      shardPayload.version = canonicalVersion;
      const next = `${JSON.stringify(shardPayload, null, 2)}\n`;
      writeFileSync(config.shardJurisdictionsPath, next, 'utf8');
      return next;
    }
  } catch {
    // If either payload is malformed, just return the shard payload unchanged.
  }
  return shard;
};

export const hasShardRpc2Jurisdiction = (config: OrchestratorJurisdictionsConfig): boolean => {
  if (!existsSync(config.shardJurisdictionsPath)) return false;
  try {
    const payload = JSON.parse(readFileSync(config.shardJurisdictionsPath, 'utf8')) as ShardJurisdictionsFile;
    return Object.entries(payload.jurisdictions ?? {}).some(([key, jurisdiction]) =>
      Boolean(
        jurisdiction?.contracts?.depository &&
        jurisdiction?.contracts?.entityProvider &&
        isRpc2Jurisdiction(config, key, jurisdiction),
      ),
    );
  } catch {
    return false;
  }
};

export const resolvePrimaryHubJurisdictionFallback = (config: OrchestratorJurisdictionsConfig): PrimaryHubJurisdiction | null => {
  if (!existsSync(config.shardJurisdictionsPath)) return null;
  try {
    const payload = JSON.parse(readFileSync(config.shardJurisdictionsPath, 'utf8')) as ShardJurisdictionsFile;
    return selectPrimaryHubJurisdiction(payload, config);
  } catch {
    return null;
  }
};

const readRpcChainId = async (rpcUrl: string): Promise<number> => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  });
  if (!response.ok) {
    throw new Error(`RPC_CHAIN_ID_HTTP_${response.status}`);
  }
  const payload = await response.json() as { result?: unknown; error?: { message?: string } };
  if (payload.error) throw new Error(`RPC_CHAIN_ID_ERROR:${payload.error.message || 'unknown'}`);
  const result = String(payload.result || '').trim();
  const chainId = result.startsWith('0x') ? Number.parseInt(result.slice(2), 16) : Number(result);
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error(`RPC_CHAIN_ID_INVALID:${result || 'empty'}`);
  return Math.floor(chainId);
};

const requireCompleteRpcContracts = (
  contracts: RpcContractAddresses | null | undefined,
  context: string,
): CompleteRpcContractAddresses => {
  const invalid = REQUIRED_RPC_CONTRACT_KEYS.filter((key) =>
    !/^0x[0-9a-fA-F]{40}$/.test(String(contracts?.[key] || '')));
  if (invalid.length > 0) throw new Error(`${context}_CONTRACTS_INVALID:${invalid.join(',')}`);
  return Object.fromEntries(
    REQUIRED_RPC_CONTRACT_KEYS.map((key) => [key, String(contracts?.[key])]),
  ) as CompleteRpcContractAddresses;
};

const requireEntityProviderDeploymentBlock = (value: unknown, context: string): number => {
  const block = Number(value);
  if (!Number.isSafeInteger(block) || block < 1) {
    throw new Error(`${context}_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID:${String(value)}`);
  }
  return block;
};

export const assertDeterministicRpcStackAddresses = (
  primary: RpcContractAddresses,
  secondary: RpcContractAddresses,
): void => {
  const mismatches = REQUIRED_RPC_CONTRACT_KEYS.filter(key =>
    String(primary[key] || '').toLowerCase() !== String(secondary[key] || '').toLowerCase());
  if (mismatches.length > 0) {
    throw new Error(`CROSS_CHAIN_CONTRACT_ADDRESS_MISMATCH:${mismatches.join(',')}`);
  }
};

const deployRpcStack = async (
  rpcUrl: string,
  chainId: number,
): Promise<ProvisionedRpcStack> => {
  const adapter: JAdapter = await createJAdapter({ mode: 'rpc', chainId, rpcUrl });
  let contracts: CompleteRpcContractAddresses | undefined;
  let entityProviderDeploymentBlock: number | undefined;
  let deploymentError: unknown;
  try {
    await adapter.deployStack();
    contracts = requireCompleteRpcContracts(adapter.addresses, 'PRIMARY_RPC_DEPLOYED');
    entityProviderDeploymentBlock = requireEntityProviderDeploymentBlock(
      adapter.entityProviderDeploymentBlock,
      'PRIMARY_RPC_DEPLOYED',
    );
  } catch (error) {
    deploymentError = error;
  }
  try {
    await adapter.close();
  } catch (closeError) {
    if (deploymentError !== undefined) {
      throw new AggregateError([deploymentError, closeError], 'PRIMARY_RPC_DEPLOY_AND_CLOSE_FAILED');
    }
    throw closeError;
  }
  if (deploymentError !== undefined) throw deploymentError;
  if (!contracts) throw new Error('PRIMARY_RPC_DEPLOYED_CONTRACTS_MISSING');
  if (entityProviderDeploymentBlock === undefined) {
    throw new Error('PRIMARY_RPC_DEPLOYED_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_MISSING');
  }
  return { contracts, entityProviderDeploymentBlock };
};

const persistPrimaryRpcStack = (
  config: OrchestratorJurisdictionsConfig,
  payload: ShardJurisdictionsFile,
  key: string,
  rpcUrl: string,
  chainId: number,
  contracts: CompleteRpcContractAddresses,
  entityProviderDeploymentBlock: number,
): void => {
  const jurisdiction = payload.jurisdictions?.[key];
  if (!jurisdiction) throw new Error(`PRIMARY_RPC_JURISDICTION_MISSING:${key}`);
  payload.jurisdictions![key] = {
    ...jurisdiction,
    chainId,
    entityProviderDeploymentBlock,
    rpc: toPublicRpcUrl(rpcUrl, '/rpc'),
    contracts: { ...(jurisdiction.contracts ?? {}), ...contracts },
  };
  const updatedAt = new Date().toISOString();
  payload['lastUpdated'] = updatedAt;
  const version = String(payload.version || '').trim() || '3';
  const networkVersion = computeJurisdictionsNetworkVersion(payload, version);
  payload['deployVersion'] = networkVersion;
  payload['networkVersion'] = networkVersion;
  writeFileSync(config.shardJurisdictionsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

export const provisionPrimaryRpcJurisdictionStack = async (
  config: OrchestratorJurisdictionsConfig,
): Promise<PrimaryRpcProvisionResult> => {
  if (!existsSync(config.shardJurisdictionsPath)) {
    throw new Error(`PRIMARY_RPC_JURISDICTIONS_MISSING:${config.shardJurisdictionsPath}`);
  }
  const payload = JSON.parse(readFileSync(config.shardJurisdictionsPath, 'utf8')) as ShardJurisdictionsFile;
  const primary = selectPrimaryHubJurisdiction(payload, config);
  if (!primary) throw new Error('PRIMARY_RPC_JURISDICTION_UNRESOLVED');
  const jurisdiction = payload.jurisdictions?.[primary.key];
  if (!jurisdiction) throw new Error(`PRIMARY_RPC_JURISDICTION_MISSING:${primary.key}`);
  const rpcUrl = String(config.rpcUrls?.[1] || '').trim();
  if (!rpcUrl) throw new Error('PRIMARY_RPC_URL_MISSING');
  const chainId = await readRpcChainId(rpcUrl);
  if (jurisdiction.chainId !== undefined && Number(jurisdiction.chainId) !== chainId) {
    throw new Error(`PRIMARY_RPC_CHAIN_ID_MISMATCH:configured=${String(jurisdiction.chainId)}:actual=${chainId}`);
  }
  const missingCode = await findMissingRpcContractCode(rpcUrl, jurisdiction.contracts);
  if (missingCode.length !== 0 && missingCode.length !== REQUIRED_RPC_CONTRACT_KEYS.length) {
    throw new Error(`PRIMARY_RPC_PARTIAL_STACK_CORRUPTION:${missingCode.join(',')}`);
  }
  const deployed = missingCode.length > 0;
  const provisioned = deployed
    ? await deployRpcStack(rpcUrl, chainId)
    : {
        contracts: requireCompleteRpcContracts(jurisdiction.contracts, 'PRIMARY_RPC_CONFIGURED'),
        entityProviderDeploymentBlock: requireEntityProviderDeploymentBlock(
          jurisdiction.entityProviderDeploymentBlock,
          'PRIMARY_RPC_CONFIGURED',
        ),
      };
  const { contracts, entityProviderDeploymentBlock } = provisioned;
  await assertCanonicalRpcContractStack(rpcUrl, contracts, 'PRIMARY_RPC');
  if (deployed) {
    persistPrimaryRpcStack(
      config,
      payload,
      primary.key,
      rpcUrl,
      chainId,
      contracts,
      entityProviderDeploymentBlock,
    );
  }
  return { key: primary.key, chainId, contracts, entityProviderDeploymentBlock, deployed };
};

export const deployRpc2JurisdictionStack = async (config: OrchestratorJurisdictionsConfig): Promise<void> => {
  if (!config.rpc2Url) return;
  const startedAt = Date.now();
  const chainId = await readRpcChainId(config.rpc2Url);
  const current: ShardJurisdictionsFile = existsSync(config.shardJurisdictionsPath)
    ? JSON.parse(readFileSync(config.shardJurisdictionsPath, 'utf8'))
    : {};
  const jurisdictions = current.jurisdictions ?? {};
  const primary = selectPrimaryHubJurisdiction(current, config);
  if (!primary) throw new Error('RPC2_PRIMARY_JURISDICTION_UNRESOLVED');
  const primaryJurisdiction = jurisdictions[primary.key];
  const primaryChainId = Number(primaryJurisdiction?.chainId);
  if (!Number.isSafeInteger(primaryChainId) || primaryChainId <= 0) {
    throw new Error(`RPC2_PRIMARY_CHAIN_ID_INVALID:${String(primaryJurisdiction?.chainId)}`);
  }
  if (primaryChainId === chainId) {
    throw new Error(`RPC2_STACK_DOMAIN_COLLISION:chainId=${chainId}`);
  }
  const existing = jurisdictions['tron'];
  if (existing?.chainId !== undefined && Number(existing.chainId) !== chainId) {
    throw new Error(`RPC2_CHAIN_ID_MISMATCH:configured=${String(existing.chainId)}:actual=${chainId}`);
  }
  const missingCode = await findMissingRpcContractCode(config.rpc2Url, existing?.contracts);
  if (missingCode.length !== 0 && missingCode.length !== REQUIRED_RPC_CONTRACT_KEYS.length) {
    throw new Error(`RPC2_PARTIAL_STACK_CORRUPTION:${missingCode.join(',')}`);
  }
  const provisioned = missingCode.length === 0
    ? {
        contracts: requireCompleteRpcContracts(existing?.contracts, 'RPC2_CONFIGURED'),
        entityProviderDeploymentBlock: requireEntityProviderDeploymentBlock(
          existing?.entityProviderDeploymentBlock,
          'RPC2_CONFIGURED',
        ),
      }
    : await deployRpcStack(config.rpc2Url, chainId);
  const { contracts, entityProviderDeploymentBlock } = provisioned;
  await assertCanonicalRpcContractStack(config.rpc2Url, contracts, 'RPC2');
  const primaryContracts = requireCompleteRpcContracts(
    jurisdictions[primary.key]?.contracts as RpcContractAddresses | undefined,
    'RPC2_PRIMARY_CONFIGURED',
  );
  assertDeterministicRpcStackAddresses(primaryContracts, contracts);
  const updatedAt = new Date().toISOString();
  jurisdictions['tron'] = {
    ...(jurisdictions['tron'] ?? {}),
    name: 'Tron',
    chainId,
    entityProviderDeploymentBlock,
    rpc: toPublicRpcUrl(config.rpc2Url, '/rpc2'),
    blockTimeMs: 1_000,
    explorer: '',
    currency: 'TRX',
    status: 'active',
    description: 'Second local EVM chain used to simulate Tron cross-jurisdiction swaps',
    contracts: {
      ...(jurisdictions['tron']?.contracts ?? {}),
      ...contracts,
    },
  };
  const nextPayload: ShardJurisdictionsFile = {
    version: String(current.version || '').trim() || '3',
    lastUpdated: updatedAt,
    jurisdictions,
    defaults: current.defaults ?? {
      timeout: 30000,
      retryAttempts: 3,
      gasLimit: 1000000,
    },
  };
  const networkVersion = computeJurisdictionsNetworkVersion(nextPayload, String(nextPayload.version || '3'));
  nextPayload['deployVersion'] = networkVersion;
  nextPayload['networkVersion'] = networkVersion;
  writeFileSync(config.shardJurisdictionsPath, JSON.stringify(nextPayload, null, 2) + '\n', 'utf8');
  console.log(
    `RPC2_JURISDICTION_READY chainId=${chainId} rpc=${config.rpc2Url} ` +
    `deployed=${missingCode.length > 0 ? 'yes' : 'no'} ms=${Date.now() - startedAt}`,
  );
};

const assertPublicActiveRpcDeploymentMetadata = (
  key: string,
  jurisdiction: ShardJurisdictionEntry,
): void => {
  const status = String(jurisdiction['status'] ?? 'active').trim().toLowerCase();
  const hasRpc = String(jurisdiction.rpc ?? '').trim().length > 0;
  const hasConfiguredContract = Object.values(jurisdiction.contracts ?? {})
    .some((value) => String(value ?? '').trim().length > 0);
  if (status !== 'active' || !hasRpc || !hasConfiguredContract) return;

  const invalidContracts = REQUIRED_RPC_CONTRACT_KEYS.filter((contractKey) =>
    !/^0x[0-9a-fA-F]{40}$/.test(String(jurisdiction.contracts?.[contractKey] ?? '')));
  if (invalidContracts.length > 0) {
    throw new Error(
      `PUBLIC_RPC_JURISDICTION_CONTRACT_STACK_INVALID:${key}:${invalidContracts.join(',')}`,
    );
  }

  const deploymentBlock = Number(jurisdiction.entityProviderDeploymentBlock);
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 1) {
    throw new Error(
      `PUBLIC_RPC_JURISDICTION_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID:${key}:` +
      String(jurisdiction.entityProviderDeploymentBlock),
    );
  }
};

export const toPublicJurisdictionsPayload = (
  config: OrchestratorJurisdictionsConfig,
  raw: string,
): string => {
  let parsed: ShardJurisdictionsFile;
  try {
    parsed = JSON.parse(raw) as ShardJurisdictionsFile;
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.jurisdictions) return raw;
  const networkVersion = computeJurisdictionsNetworkVersion(parsed, String(parsed.version || '3'));
  parsed['deployVersion'] = networkVersion;
  parsed['networkVersion'] = networkVersion;
  for (const [key, jurisdiction] of Object.entries(parsed.jurisdictions)) {
    if (!jurisdiction || typeof jurisdiction !== 'object') continue;
    assertPublicActiveRpcDeploymentMetadata(key, jurisdiction);
    const fallback = resolvePublicRpcPath(config, key, jurisdiction);
    jurisdiction.rpc = toPublicRpcUrl(String(jurisdiction.rpc || fallback), fallback);
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
};

export const seedShardJurisdictions = (config: OrchestratorJurisdictionsConfig): void => {
  const canonicalPath = resolveJurisdictionsJsonPath();
  const seedPath = existsSync(canonicalPath) ? canonicalPath : resolveRepoJurisdictionsJsonPath();
  if (!existsSync(seedPath)) {
    throw new Error(`JURISDICTIONS_SEED_MISSING canonical=${canonicalPath} repo=${resolveRepoJurisdictionsJsonPath()}`);
  }
  mkdirSync(dirname(config.shardJurisdictionsPath), { recursive: true });
  writeFileSync(config.shardJurisdictionsPath, readFileSync(seedPath, 'utf8'), 'utf8');
};

export const syncCanonicalJurisdictionsFromShard = (config: OrchestratorJurisdictionsConfig): void => {
  const canonicalPath = resolveJurisdictionsJsonPath();
  if (resolve(canonicalPath) === resolve(config.shardJurisdictionsPath)) return;
  const payload = readShardJurisdictions(config);
  mkdirSync(dirname(canonicalPath), { recursive: true });
  writeFileSync(canonicalPath, payload, 'utf8');
};
