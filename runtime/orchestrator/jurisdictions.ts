import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createJAdapter } from '../jadapter';
import { resolveJurisdictionsJsonPath } from '../jurisdictions-path';
import { computeJurisdictionsNetworkVersion } from '../jurisdictions-version';
import { normalizeLoopbackUrl, toPublicRpcUrl } from '../loopback-url';

export type OrchestratorJurisdictionsConfig = {
  shardJurisdictionsPath: string;
  rpc2Url: string;
};

type ShardJurisdictionEntry = Record<string, unknown> & {
  name?: string;
  chainId?: number;
  rpc?: unknown;
  contracts?: Record<string, unknown> & {
    depository?: string;
    entityProvider?: string;
  };
};

type ShardJurisdictionsFile = Record<string, unknown> & {
  version?: unknown;
  jurisdictions?: Record<string, ShardJurisdictionEntry>;
  defaults?: Record<string, unknown>;
};

const isRpc2Jurisdiction = (
  config: OrchestratorJurisdictionsConfig,
  key: string,
  jurisdiction: ShardJurisdictionEntry,
): boolean => {
  const normalizedKey = String(key || '').trim().toLowerCase();
  if (normalizedKey === 'tron' || normalizedKey === 'rpc2' || normalizedKey === 'localhost2') return true;
  const name = String(jurisdiction.name || '').trim().toLowerCase();
  if (name.includes('tron')) return true;
  const rpc = String(jurisdiction.rpc || '').trim();
  return Boolean(config.rpc2Url && normalizeLoopbackUrl(rpc) === normalizeLoopbackUrl(config.rpc2Url));
};

export const readShardJurisdictions = (config: OrchestratorJurisdictionsConfig): string => {
  const canonicalPath = resolveJurisdictionsJsonPath();
  if (!existsSync(canonicalPath)) {
    throw new Error(`CANONICAL_JURISDICTIONS_MISSING path=${canonicalPath}`);
  }
  if (!existsSync(config.shardJurisdictionsPath)) {
    throw new Error(`JURISDICTIONS_JSON_MISSING path=${config.shardJurisdictionsPath}`);
  }
  const canonical = readFileSync(canonicalPath, 'utf8');
  const shard = readFileSync(config.shardJurisdictionsPath, 'utf8');
  try {
    const canonicalVersion = String((JSON.parse(canonical) as { version?: unknown }).version || '').trim() || '1';
    const shardPayload = JSON.parse(shard) as { version?: unknown };
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

export const resolvePrimaryHubJurisdictionFallback = (config: OrchestratorJurisdictionsConfig): {
  name: string;
  chainId?: number;
  depositoryAddress?: string;
  entityProviderAddress?: string;
} | null => {
  if (!existsSync(config.shardJurisdictionsPath)) return null;
  try {
    const payload = JSON.parse(readFileSync(config.shardJurisdictionsPath, 'utf8')) as ShardJurisdictionsFile;
    const entries = Object.entries(payload.jurisdictions ?? {});
    const match = entries.find(([key, jurisdiction]) => !isRpc2Jurisdiction(config, key, jurisdiction)) ?? entries[0];
    if (!match) return null;
    const [, jurisdiction] = match;
    const name = String(jurisdiction.name || '').trim();
    if (!name) return null;
    return {
      name,
      ...(jurisdiction.chainId !== undefined ? { chainId: jurisdiction.chainId } : {}),
      ...(jurisdiction.contracts?.depository ? { depositoryAddress: jurisdiction.contracts.depository } : {}),
      ...(jurisdiction.contracts?.entityProvider ? { entityProviderAddress: jurisdiction.contracts.entityProvider } : {}),
    };
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
  console.log(`[MESH] rpc2 jurisdiction ready chainId=${chainId} rpc=${config.rpc2Url} ms=${Date.now() - startedAt}`);
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
      const fallback = isRpc2Jurisdiction(config, key, jurisdiction) ? '/rpc2' : '/rpc';
      jurisdiction.rpc = toPublicRpcUrl(String(jurisdiction.rpc || fallback), fallback);
    }
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return raw;
  }
};

export const seedShardJurisdictions = (config: OrchestratorJurisdictionsConfig): void => {
  const canonicalPath = resolveJurisdictionsJsonPath();
  if (!existsSync(canonicalPath)) {
    throw new Error(`CANONICAL_JURISDICTIONS_MISSING path=${canonicalPath}`);
  }
  writeFileSync(config.shardJurisdictionsPath, readFileSync(canonicalPath, 'utf8'), 'utf8');
};
