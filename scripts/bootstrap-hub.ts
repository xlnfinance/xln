#!/usr/bin/env bun
/**
 * Bootstrap Hub Entity
 *
 * Creates hub entities (normal entity + gossip metadata).
 * Idempotent: safe to run multiple times.
 */

import { main, process as runtimeProcess } from '../runtime/runtime.ts';
import {
  deriveSignerKeySync,
  deriveSignerAddressSync,
  registerSignerKey,
} from '../runtime/account-crypto';
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
  matchingStrategy?: 'amount' | 'time' | 'fee';
  policyVersion?: number;
  routingFeePPM?: number;
  baseFee?: bigint;
  swapTakerFeeBps?: number;
  disputeAutoFinalizeMode?: 'auto' | 'ignore';
  minCollateralThreshold?: bigint;
  c2rWithdrawSoftLimit?: bigint;
  minFeeBps?: bigint;
  rebalanceBaseFee?: bigint;
  rebalanceLiquidityFeeBps?: bigint;
  rebalanceGasFee?: bigint;
  rebalanceTimeoutMs?: number;
  relayUrl?: string;
  rpcUrl?: string;
  httpUrl?: string;
  port?: number;
  serverId?: string;
  position?: { x: number; y: number; z: number };
};

const DEFAULT_CONFIG: HubConfig = {
  name: getArg('--name', 'Main Hub'),
  region: getArg('--region', 'global'),
  signerId: getArg('--signer', 'hub-validator'),
  seed: getArg('--seed', 'xln-main-hub-2026'),
  routingFeePPM: parseInt(getArg('--fee', '100')),
  swapTakerFeeBps: parseInt(getArg('--swap-taker-fee-bps', '1')),
  relayUrl: getArg('--relay', 'wss://xln.finance/relay'),
  rpcUrl: getArg('--rpc', process.env.PUBLIC_RPC ?? ''),
  httpUrl: getArg('--http', process.env.PUBLIC_HTTP ?? ''),
  port: Number(getArg('--port', process.env.PORT ?? '0')) || undefined,
  serverId: process.env.SERVER_ID ?? undefined,
  position: { x: 0, y: 0, z: 0 },
};

const deriveHubSigner = (seed: string, signerLabel: string): { signerAddress: string; signerLabel: string } => {
  const privateKey = deriveSignerKeySync(seed, signerLabel);
  const signerAddress = deriveSignerAddressSync(seed, signerLabel);
  registerSignerKey(signerAddress, privateKey);
  return { signerAddress, signerLabel };
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

export async function bootstrapHub(env?: Env, config?: Partial<HubConfig>): Promise<{ entityId: string; signerId: string } | null> {
  const hubConfig: HubConfig = { ...DEFAULT_CONFIG, ...(config || {}) };
  const { signerAddress, signerLabel } = deriveHubSigner(hubConfig.seed, hubConfig.signerId);

  console.log('[BOOTSTRAP] Starting hub bootstrap...');
  console.log(`[BOOTSTRAP] Name: ${hubConfig.name}`);
  console.log(`[BOOTSTRAP] Region: ${hubConfig.region || 'global'}`);
  console.log(`[BOOTSTRAP] Signer: ${signerAddress}`);

  // Initialize runtime if not provided
  if (!env) {
    env = await main();
  }

  const jurisdiction = resolveJurisdiction(env);
  const consensusConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerAddress],
    shares: { [signerAddress]: 1n },
    ...(jurisdiction ? { jurisdiction } : {}),
  };

  const encodedBoard = encodeBoard(consensusConfig);
  const entityId = hashBoard(encodedBoard);

  const replicaExists = !!Array.from(env.eReplicas?.keys?.() || []).find(key => key.startsWith(`${entityId}:`));

  if (!replicaExists) {
    console.log('[BOOTSTRAP] Creating hub entity...');
    console.log(`[BOOTSTRAP]    EntityId: ${entityId}`);

    ensureRuntimeInput(env);
    env.runtimeInput.runtimeTxs.push({
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

  ensureRuntimeInput(env);
  env.runtimeInput.entityInputs.push({
    entityId,
    signerId: signerAddress,
    entityTxs: [
      {
        type: 'setHubConfig',
        data: {
          matchingStrategy: hubConfig.matchingStrategy ?? 'amount',
          ...(hubConfig.policyVersion !== undefined ? { policyVersion: hubConfig.policyVersion } : {}),
          routingFeePPM: hubConfig.routingFeePPM ?? 100,
          baseFee: hubConfig.baseFee ?? 0n,
          swapTakerFeeBps: hubConfig.swapTakerFeeBps ?? 1,
          disputeAutoFinalizeMode: hubConfig.disputeAutoFinalizeMode ?? 'auto',
          ...(hubConfig.minCollateralThreshold !== undefined ? { minCollateralThreshold: hubConfig.minCollateralThreshold } : {}),
          ...(hubConfig.c2rWithdrawSoftLimit !== undefined ? { c2rWithdrawSoftLimit: hubConfig.c2rWithdrawSoftLimit } : {}),
          ...(hubConfig.minFeeBps !== undefined ? { minFeeBps: hubConfig.minFeeBps } : {}),
          ...(hubConfig.rebalanceBaseFee !== undefined ? { rebalanceBaseFee: hubConfig.rebalanceBaseFee } : {}),
          ...(hubConfig.rebalanceLiquidityFeeBps !== undefined ? { rebalanceLiquidityFeeBps: hubConfig.rebalanceLiquidityFeeBps } : {}),
          ...(hubConfig.rebalanceGasFee !== undefined ? { rebalanceGasFee: hubConfig.rebalanceGasFee } : {}),
          ...(hubConfig.rebalanceTimeoutMs !== undefined ? { rebalanceTimeoutMs: hubConfig.rebalanceTimeoutMs } : {}),
        },
      },
    ],
  });
  await runtimeProcess(env, []);

  if (env.gossip?.getHubs) {
    const hubs = env.gossip.getHubs();
    console.log(`[BOOTSTRAP] Gossip verification: ${hubs?.length || 0} hubs found`);
  }

  console.log('[BOOTSTRAP] ✅ Hub bootstrap complete');
  console.log(`[BOOTSTRAP]    Name: ${hubConfig.name}`);
  console.log(`[BOOTSTRAP]    EntityId: ${entityId.slice(0, 16)}...`);
  console.log(`[BOOTSTRAP]    Region: ${hubConfig.region || 'global'}`);
  console.log(`[BOOTSTRAP]    Fee: ${(hubConfig.routingFeePPM ?? 100) / 10000}%`);
  console.log(`[BOOTSTRAP]    Swap taker fee: ${(hubConfig.swapTakerFeeBps ?? 1) / 100}%`);
  console.log(`[BOOTSTRAP]    Relay: ${hubConfig.relayUrl}`);

  return { entityId, signerId: signerAddress };
}

export async function bootstrapHubs(env: Env, configs: HubConfig[]): Promise<Array<{ entityId: string; signerId: string; signerLabel: string }>> {
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
  bootstrapHub(undefined, DEFAULT_CONFIG).catch(err => {
    console.error('[BOOTSTRAP] ❌ Failed:', err);
    process.exit(1);
  });
}
