import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createJAdapter } from '../jadapter';
import { resolveJurisdictionsJsonPath } from '../jurisdiction/jurisdictions-path';
import { computeJurisdictionsNetworkVersion } from '../jurisdiction/jurisdictions-version';
import { normalizeLoopbackUrl, toPublicRpcUrl } from '../networking/loopback-url';
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

export const deployRpc2JurisdictionStack = async (config: OrchestratorJurisdictionsConfig): Promise<void> => {
  if (!config.rpc2Url) return;
  const startedAt = Date.now();
  const chainId = await readRpcChainId(config.rpc2Url);
  const jadapter = await createJAdapter({
    mode: 'rpc',
    chainId,
    rpcUrl: config.rpc2Url,
  });
  await jadapter.deployStack();

  const current: ShardJurisdictionsFile = existsSync(config.shardJurisdictionsPath)
    ? JSON.parse(readFileSync(config.shardJurisdictionsPath, 'utf8'))
    : {};
  const jurisdictions = current.jurisdictions ?? {};
  const updatedAt = new Date().toISOString();
  jurisdictions['tron'] = {
    ...(jurisdictions['tron'] ?? {}),
    name: 'Tron',
    chainId,
    rpc: toPublicRpcUrl(config.rpc2Url, '/rpc2'),
    blockTimeMs: 1_000,
    explorer: '',
    currency: 'TRX',
    status: 'active',
    description: 'Second local EVM chain used to simulate Tron cross-jurisdiction swaps',
    contracts: {
      ...(jurisdictions['tron']?.contracts ?? {}),
      account: jadapter.addresses.account,
      depository: jadapter.addresses.depository,
      entityProvider: jadapter.addresses.entityProvider,
      deltaTransformer: jadapter.addresses.deltaTransformer,
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
  console.log(`RPC2_JURISDICTION_READY chainId=${chainId} rpc=${config.rpc2Url} ms=${Date.now() - startedAt}`);
};

export const toPublicJurisdictionsPayload = (
  config: OrchestratorJurisdictionsConfig,
  raw: string,
): string => {
  try {
    const parsed = JSON.parse(raw) as ShardJurisdictionsFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.jurisdictions) return raw;
    const networkVersion = computeJurisdictionsNetworkVersion(parsed, String(parsed.version || '3'));
    parsed['deployVersion'] = networkVersion;
    parsed['networkVersion'] = networkVersion;
    for (const [key, jurisdiction] of Object.entries(parsed.jurisdictions)) {
      if (!jurisdiction || typeof jurisdiction !== 'object') continue;
      const fallback = resolvePublicRpcPath(config, key, jurisdiction);
      jurisdiction.rpc = toPublicRpcUrl(String(jurisdiction.rpc || fallback), fallback);
    }
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return raw;
  }
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
