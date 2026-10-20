#!/usr/bin/env bun
/**
 * Bootstrap Hub Entity
 *
 * Creates hub entities (normal entity + gossip metadata).
 * Idempotent: safe to run multiple times.
 */

import { enqueueRuntimeInput, main, waitForRuntimeWorkDrained } from '../core/runtime.ts';
import { deriveSignerKeySync, deriveSignerAddressSync, registerSignerKey } from '../core/account/crypto';
import { encodeBoard, hashBoard } from '../core/entity/factory';
import { createStructuredLogger } from '../core/support/logger';
import { getPerfMs } from '../core/support/time';
import { requireJurisdictionBlockTimeMs } from '../core/orchestrator/mesh/mesh-jurisdictions';
import type { ConsensusConfig } from '../core/entity/types';
import type { RuntimeReplica } from '../core/runtime/types';
import { importEntity } from '../core/runtime/registration/entity-creation';
import { buildHubConfig } from '../core/entity/tx/handlers/account/lifecycle/admin';
import { canonicalConsensusValuesEqual } from '../core/protocol/serialization/binary-codec';
import type { EntityTx } from '../core/types/entity-tx';

const args = process.argv.slice(2);

const getArg = (name: string, defaultValue: string): string => {
  const idx = args.indexOf(name);
  return idx === -1 ? defaultValue : args[idx + 1] || defaultValue;
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

const HUB_BOOTSTRAP_DRAIN_TIMEOUT_MS = 10_000;

const drainBootstrapInput = async (env: RuntimeReplica, stage: string): Promise<void> => {
  const startedAt = getPerfMs();
  const initialHeight = env.state.height;
  const drained = await waitForRuntimeWorkDrained(env, HUB_BOOTSTRAP_DRAIN_TIMEOUT_MS, 0);
  if (drained) return;
  const state = env.infrastructure;
  bootstrapLog.error('hub.drain_timeout', {
    stage,
    elapsedMs: getPerfMs() - startedAt,
    initialHeight,
    height: env.state.height,
    framePhase: state?.runtimeFramePhase ?? null,
    processing: Boolean(state?.processingPromise),
    loop: Boolean(state?.loopPromise),
    wakeRequested: state?.wakeRequested ?? false,
    stateMutationInFlight: state?.stateMutationInFlight ?? false,
    inFlightEntityInputs: state?.inFlightEntityInputs ?? 0,
    runtimeTxs: env.runtimeMempool.runtimeTxs.map(tx => tx.type),
    entityInputs: env.runtimeMempool.entityInputs.length,
    jInputs: env.runtimeMempool.jInputs?.length ?? 0,
    pendingOutputs: env.pendingOutputs?.length ?? 0,
    pendingNetworkOutputs: env.pendingNetworkOutputs?.length ?? 0,
    networkInbox: env.networkInbox?.length ?? 0,
    entities: [...env.state.eReplicas.values()].map(replica => ({
      entityId: replica.entityId,
      height: replica.state.height,
      hubConfigCommitted: Boolean(replica.state.hubRebalanceConfig),
      mempool: replica.mempool.map(tx => tx.type),
      proposal: Boolean(replica.proposal),
      lockedFrame: Boolean(replica.lockedFrame),
      accounts: replica.state.accounts.size,
    })),
  });
  throw new Error(`HUB_BOOTSTRAP_DRAIN_TIMEOUT:${stage}`);
};

const findHubReplica = (env: RuntimeReplica, entityId: string) =>
  Array.from(env.state.eReplicas.entries()).find(([key]) => key.startsWith(`${entityId}:`))?.[1];

const resolveJurisdiction = (env: RuntimeReplica, requestedName?: string) => {
  const normalizedRequested = String(requestedName || '')
    .trim()
    .toLowerCase();
  const name =
    (normalizedRequested && env.state.jReplicas
      ? Array.from(env.state.jReplicas.keys()).find(key => key.toLowerCase() === normalizedRequested)
      : undefined) ||
    env.activeJurisdiction ||
    (env.state.jReplicas ? Array.from(env.state.jReplicas.keys())[0] : undefined);
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

export async function bootstrapHub(
  env?: RuntimeReplica,
  config?: Partial<HubConfig>,
): Promise<{ entityId: string; signerId: string } | null> {
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
    enqueueRuntimeInput(env, {
      runtimeTxs: [
        importEntity({
          entityId,
          signerId: signerAddress,
          data: {
            config: consensusConfig,
            isProposer: true,
            profileName: hubConfig.name,
            position: hubConfig.position || { x: 0, y: 0, z: 0 },
          },
          entitySeed: hubConfig.seed,
        }),
      ],
      entityInputs: [],
    });
    await drainBootstrapInput(env, 'entity-import');
    if (!findHubReplica(env, entityId)) {
      throw new Error(`HUB_BOOTSTRAP_ENTITY_COMMIT_MISSING:${entityId}`);
    }
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

  const configInput: Extract<EntityTx, { type: 'setHubConfig' }> = {
    type: 'setHubConfig',
    data: {
      hubName: hubConfig.name,
      matchingStrategy: hubConfig.matchingStrategy ?? 'amount',
      ...(hubConfig.policyVersion !== undefined ? { policyVersion: hubConfig.policyVersion } : {}),
      routingFeePPM: hubConfig.routingFeePPM ?? 100,
      baseFee: hubConfig.baseFee ?? 0n,
      swapTakerFeeBps: hubConfig.swapTakerFeeBps ?? 1,
      disputeAutoFinalizeMode: hubConfig.disputeAutoFinalizeMode ?? 'auto',
      ...(hubConfig.minCollateralThreshold !== undefined
        ? { minCollateralThreshold: hubConfig.minCollateralThreshold }
        : {}),
      ...(hubConfig.c2rWithdrawSoftLimit !== undefined ? { c2rWithdrawSoftLimit: hubConfig.c2rWithdrawSoftLimit } : {}),
      ...(hubConfig.rebalanceBaseFee !== undefined ? { rebalanceBaseFee: hubConfig.rebalanceBaseFee } : {}),
      ...(hubConfig.rebalanceLiquidityFeeBps !== undefined
        ? { rebalanceLiquidityFeeBps: hubConfig.rebalanceLiquidityFeeBps }
        : {}),
      ...(hubConfig.rebalanceGasFee !== undefined ? { rebalanceGasFee: hubConfig.rebalanceGasFee } : {}),
      ...(hubConfig.rebalanceTimeoutMs !== undefined ? { rebalanceTimeoutMs: hubConfig.rebalanceTimeoutMs } : {}),
    },
  };
  const previousConfig = findHubReplica(env, entityId)?.state.hubRebalanceConfig;
  // Restart reuses the committed policy. Re-admitting an identical config
  // signs fresh Account policy proposals while peer sessions are still down.
  // Canonical normalization also keeps real changes on the normal transaction path.
  if (
    !previousConfig ||
    !canonicalConsensusValuesEqual(previousConfig, buildHubConfig(previousConfig, configInput.data).config)
  ) {
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{ entityId, signerId: signerAddress, entityTxs: [configInput] }],
    });
    await drainBootstrapInput(env, 'hub-config');
  }
  if (!findHubReplica(env, entityId)?.state.hubRebalanceConfig) {
    throw new Error(`HUB_BOOTSTRAP_CONFIG_COMMIT_MISSING:${entityId}`);
  }

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

if (import.meta.main) {
  if (!DEFAULT_CONFIG.seed) {
    throw new Error('Hub seed is required via --seed or XLN_RUNTIME_SEED');
  }
  bootstrapHub(undefined, DEFAULT_CONFIG).catch(err => {
    console.error('[BOOTSTRAP] ❌ Failed:', err);
    process.exit(1);
  });
}
