#!/usr/bin/env bun
/**
 * Bootstrap Hub Entity
 *
 * Creates hub entities (normal entity + gossip metadata).
 * Idempotent: safe to run multiple times.
 */

import { main, processRuntime } from '../runtime/runtime.ts';
import {
  deriveSignerKeySync,
  deriveSignerAddressSync,
  registerSignerKey,
} from '../runtime/account/crypto';
import { encodeBoard, hashBoard } from '../runtime/entity/factory';
import { createStructuredLogger } from '../runtime/infra/logger';
import { requireJurisdictionBlockTimeMs } from '../runtime/orchestrator/mesh-jurisdictions';
import type { ConsensusConfig } from '../runtime/entity/types';
import type { RuntimeReplica } from '../runtime/runtime/types';

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
  matchingStrategy?: 'amount' | 'time' | 'fee';
  policyVersion?: number;
  routingFeePPM?: number;
  baseFee?: bigint;
  swapTakerFeeBps?: number;
  disputeAutoFinalizeMode?: 'auto' | 'ignore';
  minCollateralThreshold?: bigint;
  c2rWithdrawSoftLimit?: bigint;
  rebalanceBaseFee?: bigint;
  rebalanceLiquidityFeeBps?: bigint;
  rebalanceGasFee?: bigint;
  rebalanceTimeoutMs?: number;
  relayUrl?: string;
  rpcUrl?: string;
  httpUrl?: string;
  port?: number;
  serverId?: string;
  position?: { x: number; y: number; z: number; jurisdiction?: string };
  jurisdictionName?: string;
};

const defaultPort = Number(getArg('--port', process.env['PORT'] ?? '0')) || undefined;
const defaultServerId = process.env['SERVER_ID'] ?? undefined;
const bootstrapLog = createStructuredLogger('bootstrap.hub');

const DEFAULT_CONFIG: HubConfig = {
  name: getArg('--name', 'Main Hub'),
  region: getArg('--region', 'global'),
  signerId: getArg('--signer', 'hub-validator'),
  seed: getArg('--seed', process.env['XLN_RUNTIME_SEED'] ?? ''),
  routingFeePPM: parseInt(getArg('--fee', '100')),
  swapTakerFeeBps: parseInt(getArg('--swap-taker-fee-bps', '1')),
  relayUrl: getArg('--relay', 'wss://xln.finance/relay'),
  rpcUrl: getArg('--rpc', process.env['PUBLIC_RPC'] ?? ''),
  httpUrl: getArg('--http', process.env['PUBLIC_HTTP'] ?? ''),
  ...(defaultPort !== undefined ? { port: defaultPort } : {}),
  ...(defaultServerId !== undefined ? { serverId: defaultServerId } : {}),
  position: { x: 0, y: 0, z: 0 },
};

const deriveHubSigner = (seed: string, signerLabel: string): { signerAddress: string; signerLabel: string } => {
  const privateKey = deriveSignerKeySync(seed, signerLabel);
  const signerAddress = deriveSignerAddressSync(seed, signerLabel);
  registerSignerKey(seed, signerAddress, privateKey);
  return { signerAddress, signerLabel };
};

const ensureRuntimeInput = (env: RuntimeReplica) => {
  if (!env.runtimeMempool) {
    env.runtimeMempool = { runtimeTxs: [], entityInputs: [] };
  }
};

const resolveJurisdiction = (env: RuntimeReplica, requestedName?: string) => {
  const normalizedRequested = String(requestedName || '').trim().toLowerCase();
  const name = (normalizedRequested && env.state.jReplicas
      ? Array.from(env.state.jReplicas.keys()).find((key) => key.toLowerCase() === normalizedRequested)
      : undefined)
    || env.activeJurisdiction
    || (env.state.jReplicas ? Array.from(env.state.jReplicas.keys())[0] : undefined);
  if (!name || !env.state.jReplicas) return null;
  const jr = env.state.jReplicas.get(name);
  if (!jr) return null;
  const blockTimeMs = requireJurisdictionBlockTimeMs({ name, blockTimeMs: jr.blockTimeMs });
  return {
    name,
    chainId: Number(jr.chainId ?? 0),
    address: jr.rpcs?.[0] ?? '',
    entityProviderAddress: jr.contracts?.entityProvider ?? '',
    depositoryAddress: jr.contracts?.depository ?? '',
    blockTimeMs,
  };
};

export async function bootstrapHub(env?: RuntimeReplica, config?: Partial<HubConfig>): Promise<{ entityId: string; signerId: string } | null> {
  const hubConfig: HubConfig = { ...DEFAULT_CONFIG, ...(config || {}) };
  const { signerAddress } = deriveHubSigner(hubConfig.seed, hubConfig.signerId);
  bootstrapLog.info('hub.start', {
    name: hubConfig.name,
    region: hubConfig.region || 'global',
    signer: signerAddress,
    jurisdictionName: hubConfig.jurisdictionName || '',
  });

  // Initialize runtime if not provided
  if (!env) {
    env = await main();
  }

  const jurisdiction = resolveJurisdiction(env, hubConfig.jurisdictionName);
  const consensusConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerAddress],
    shares: { [signerAddress]: 1n },
    ...(jurisdiction ? { jurisdiction } : {}),
  };

  const encodedBoard = encodeBoard(consensusConfig);
  const entityId = hashBoard(encodedBoard);

  const replicaExists = !!Array.from(env.state.eReplicas?.keys?.() || []).find(key => key.startsWith(`${entityId}:`));

  if (!replicaExists) {
    ensureRuntimeInput(env);
    env.runtimeMempool.runtimeTxs.push({
      type: 'importReplica',
      entityId,
      signerId: signerAddress,
      data: {
        config: consensusConfig,
        isProposer: true,
        profileName: hubConfig.name,
        position: hubConfig.position || { x: 0, y: 0, z: 0 },
      },
    });

    await processRuntime(env, []);
    bootstrapLog.info('hub.entity_created', {
      name: hubConfig.name,
      entityId,
      jurisdictionName: jurisdiction?.name || hubConfig.jurisdictionName || '',
    });
  } else if (jurisdiction && env.state.eReplicas) {
    for (const [key, replica] of env.state.eReplicas.entries()) {
      if (key.startsWith(entityId)) {
        if (!replica.state.config?.jurisdiction) {
          replica.state.config.jurisdiction = jurisdiction;
          bootstrapLog.info('hub.jurisdiction_config_patched', {
            name: hubConfig.name,
            entityId,
            jurisdictionName: jurisdiction.name,
          });
        }
      }
    }
    bootstrapLog.info('hub.entity_reused', {
      name: hubConfig.name,
      entityId,
      jurisdictionName: jurisdiction.name,
    });
  }

  ensureRuntimeInput(env);
  env.runtimeMempool.entityInputs.push({
    entityId,
    signerId: signerAddress,
    entityTxs: [
      {
        type: 'setHubConfig',
        data: {
          hubName: hubConfig.name,
          matchingStrategy: hubConfig.matchingStrategy ?? 'amount',
          ...(hubConfig.policyVersion !== undefined ? { policyVersion: hubConfig.policyVersion } : {}),
          routingFeePPM: hubConfig.routingFeePPM ?? 100,
          baseFee: hubConfig.baseFee ?? 0n,
          swapTakerFeeBps: hubConfig.swapTakerFeeBps ?? 1,
          disputeAutoFinalizeMode: hubConfig.disputeAutoFinalizeMode ?? 'auto',
          ...(hubConfig.minCollateralThreshold !== undefined ? { minCollateralThreshold: hubConfig.minCollateralThreshold } : {}),
          ...(hubConfig.c2rWithdrawSoftLimit !== undefined ? { c2rWithdrawSoftLimit: hubConfig.c2rWithdrawSoftLimit } : {}),
          ...(hubConfig.rebalanceBaseFee !== undefined ? { rebalanceBaseFee: hubConfig.rebalanceBaseFee } : {}),
          ...(hubConfig.rebalanceLiquidityFeeBps !== undefined ? { rebalanceLiquidityFeeBps: hubConfig.rebalanceLiquidityFeeBps } : {}),
          ...(hubConfig.rebalanceGasFee !== undefined ? { rebalanceGasFee: hubConfig.rebalanceGasFee } : {}),
          ...(hubConfig.rebalanceTimeoutMs !== undefined ? { rebalanceTimeoutMs: hubConfig.rebalanceTimeoutMs } : {}),
        },
      },
    ],
  });
  await processRuntime(env, []);

  if (env.gossip?.getHubs) {
    const hubs = env.gossip.getHubs();
    bootstrapLog.debug('hub.gossip_verified', {
      name: hubConfig.name,
      entityId,
      hubs: hubs?.length || 0,
    });
  }

  bootstrapLog.info('hub.ready', {
    name: hubConfig.name,
    entityId,
    region: hubConfig.region || 'global',
    jurisdictionName: jurisdiction?.name || hubConfig.jurisdictionName || '',
    routingFeePct: (hubConfig.routingFeePPM ?? 100) / 10000,
    swapTakerFeePct: (hubConfig.swapTakerFeeBps ?? 1) / 100,
    relay: hubConfig.relayUrl,
  });

  return { entityId, signerId: signerAddress };
}

export async function bootstrapHubs(env: RuntimeReplica, configs: HubConfig[]): Promise<Array<{ entityId: string; signerId: string; signerLabel: string }>> {
  const entities: Array<{ entityId: string; signerId: string; signerLabel: string }> = [];
  for (const config of configs) {
    const result = await bootstrapHub(env, config);
    if (result?.entityId) {
      entities.push({
        entityId: result.entityId,
        signerId: result.signerId,
        signerLabel: config.signerId,
      });
    }
  }
  return entities;
}

if (import.meta.main) {
  if (!DEFAULT_CONFIG.seed) {
    throw new Error('Hub seed is required via --seed or XLN_RUNTIME_SEED');
  }
  bootstrapHub(undefined, DEFAULT_CONFIG).catch(err => {
    console.error('[BOOTSTRAP] ❌ Failed:', err);
    process.exit(1);
  });
}
