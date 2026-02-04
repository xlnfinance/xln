#!/usr/bin/env bun
/**
 * Bootstrap Hub Entity
 *
 * Creates hub entities (normal entity + gossip metadata).
 * Idempotent: safe to run multiple times.
 */

import { main, process as runtimeProcess } from '../runtime/runtime';
import { deriveSignerKeySync, registerSignerKey } from '../runtime/account-crypto';
import { encodeBoard, hashBoard } from '../runtime/entity-factory';
import type { ConsensusConfig, Env } from '../runtime/types';

const args = process.argv.slice(2);

const getArg = (name: string, fallback: string): string => {
  const idx = args.indexOf(name);
  return idx === -1 ? fallback : args[idx + 1] || fallback;
};

export type HubConfig = {
  name: string;
  region?: string;
  signerId: string;
  seed: string;
  routingFeePPM?: number;
  relayUrl?: string;
  rpcUrl?: string;
  httpUrl?: string;
  port?: number;
  serverId?: string;
  capabilities?: string[];
  position?: { x: number; y: number; z: number };
};

const DEFAULT_CONFIG: HubConfig = {
  name: getArg('--name', 'Main Hub'),
  region: getArg('--region', 'global'),
  signerId: getArg('--signer', 'hub-validator'),
  seed: getArg('--seed', 'xln-main-hub-2026'),
  routingFeePPM: parseInt(getArg('--fee', '100')),
  relayUrl: getArg('--relay', 'wss://xln.finance/relay'),
  rpcUrl: getArg('--rpc', process.env.PUBLIC_RPC ?? ''),
  httpUrl: getArg('--http', process.env.PUBLIC_HTTP ?? ''),
  port: Number(getArg('--port', process.env.PORT ?? '0')) || undefined,
  serverId: process.env.SERVER_ID ?? undefined,
  capabilities: ['hub', 'routing', 'faucet'],
  position: { x: 0, y: 0, z: 0 },
};

const ensureRuntimeInput = (env: Env) => {
  if (!env.runtimeInput) {
    env.runtimeInput = { runtimeTxs: [], entityInputs: [] };
  }
};

const resolveJurisdiction = (env: Env) => {
  const name = env.activeJurisdiction || (env.jReplicas ? Array.from(env.jReplicas.keys())[0] : undefined);
  if (!name || !env.jReplicas) return null;
  const jr = env.jReplicas.get(name);
  if (!jr) return null;
  return {
    name,
    chainId: Number(jr.jadapter?.chainId ?? jr.chainId ?? 0),
    address: jr.rpcs?.[0] ?? '',
    entityProviderAddress: jr.entityProviderAddress ?? jr.contracts?.entityProvider ?? '',
    depositoryAddress: jr.depositoryAddress ?? jr.contracts?.depository ?? '',
  };
};

const announceHubProfile = (env: Env, entityId: string, config: HubConfig, jurisdictionName?: string, chainId?: number) => {
  if (!env.gossip) return;
  env.gossip.announce({
    entityId,
    runtimeId: env.runtimeId,
    capabilities: config.capabilities || ['hub', 'routing', 'faucet'],
    accounts: [],
    relays: config.relayUrl ? [config.relayUrl] : [],
    endpoints: config.relayUrl ? [config.relayUrl] : [],
    metadata: {
      name: config.name,
      isHub: true,
      region: config.region,
      relayUrl: config.relayUrl,
      rpcUrl: config.rpcUrl || undefined,
      httpUrl: config.httpUrl || undefined,
      port: config.port,
      serverId: config.serverId,
      hubSignerId: config.signerId,
      jurisdiction: jurisdictionName,
      chainId,
      routingFeePPM: config.routingFeePPM ?? 100,
      lastUpdated: Date.now(),
    },
  });
};

export async function bootstrapHub(env?: Env, config?: Partial<HubConfig>): Promise<{ entityId: string; signerId: string } | null> {
  const hubConfig: HubConfig = { ...DEFAULT_CONFIG, ...(config || {}) };

  console.log('[BOOTSTRAP] Starting hub bootstrap...');
  console.log(`[BOOTSTRAP] Name: ${hubConfig.name}`);
  console.log(`[BOOTSTRAP] Region: ${hubConfig.region || 'global'}`);

  // Initialize runtime if not provided
  if (!env) {
    env = await main();
  }

  const jurisdiction = resolveJurisdiction(env);
  const consensusConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [hubConfig.signerId],
    shares: { [hubConfig.signerId]: 1n },
    ...(jurisdiction ? { jurisdiction } : {}),
  };

  const encodedBoard = encodeBoard(consensusConfig);
  const entityId = hashBoard(encodedBoard);

  // Register signer key for this hub
  const privateKey = deriveSignerKeySync(hubConfig.seed, hubConfig.signerId);
  registerSignerKey(hubConfig.signerId, privateKey);

  const replicaExists = !!Array.from(env.eReplicas?.keys?.() || []).find(key => key.startsWith(`${entityId}:`));

  if (!replicaExists) {
    console.log('[BOOTSTRAP] Creating hub entity...');
    console.log(`[BOOTSTRAP]    EntityId: ${entityId}`);

    ensureRuntimeInput(env);
    env.runtimeInput.runtimeTxs.push({
      type: 'importReplica',
      entityId,
      signerId: hubConfig.signerId,
      data: {
        config: consensusConfig,
        isProposer: true,
        position: hubConfig.position || { x: 0, y: 0, z: 0 },
      },
    });

    await runtimeProcess(env, []);
    console.log('[BOOTSTRAP] ✅ Entity created');
  } else if (jurisdiction && env.eReplicas) {
    for (const [key, replica] of env.eReplicas.entries()) {
      if (key.startsWith(entityId)) {
        if (!replica.state.config?.jurisdiction) {
          replica.state.config.jurisdiction = jurisdiction;
          console.log('[BOOTSTRAP] ✅ Patched existing hub jurisdiction config');
        }
      }
    }
    console.log('[BOOTSTRAP] ✅ Hub entity already exists');
  }

  announceHubProfile(env, entityId, hubConfig, jurisdiction?.name, jurisdiction?.chainId);

  if (env.gossip?.getHubs) {
    const hubs = env.gossip.getHubs();
    console.log(`[BOOTSTRAP] Gossip verification: ${hubs?.length || 0} hubs found`);
  }

  console.log('[BOOTSTRAP] ✅ Hub bootstrap complete');
  console.log(`[BOOTSTRAP]    Name: ${hubConfig.name}`);
  console.log(`[BOOTSTRAP]    EntityId: ${entityId.slice(0, 16)}...`);
  console.log(`[BOOTSTRAP]    Region: ${hubConfig.region || 'global'}`);
  console.log(`[BOOTSTRAP]    Fee: ${(hubConfig.routingFeePPM ?? 100) / 10000}%`);
  console.log(`[BOOTSTRAP]    Relay: ${hubConfig.relayUrl}`);

  return { entityId, signerId: hubConfig.signerId };
}

export async function bootstrapHubs(env: Env, configs: HubConfig[]): Promise<string[]> {
  const entityIds: string[] = [];
  for (const config of configs) {
    const result = await bootstrapHub(env, config);
    if (result?.entityId) {
      entityIds.push(result.entityId);
    }
  }
  return entityIds;
}

if (import.meta.main) {
  bootstrapHub(undefined, DEFAULT_CONFIG).catch(err => {
    console.error('[BOOTSTRAP] ❌ Failed:', err);
    process.exit(1);
  });
}
