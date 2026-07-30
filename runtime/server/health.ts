// Health check endpoint
// Returns status of all J-machines, hubs, and system health

import type { RuntimeReplica } from '../runtime/types.js';
import type { EntityReplica } from '../entity/types.js';
import { getP2PState } from '../runtime.js';
import { compareStableText } from '../protocol/serialization';
import { withRuntimeCommittedRead } from '../runtime/frame/writer-lock';
import { getLiveJAdapter } from '../runtime/live-jadapters';

export interface HealthStatus {
  timestamp: number;
  uptime: number;
  jMachines: JMachineHealth[];
  hubs: HubHealth[];
  system: SystemHealth;
  disk?: {
    ok: boolean;
    minFreeBytes: number;
    shortfallBytes: number;
    freeBytes: number;
    usedBytes: number;
    totalBytes: number;
    shortfallGiB: number;
    freeGiB: number;
    usedGiB: number;
    totalGiB: number;
    usedPct: number;
  };
}

export interface JMachineHealth {
  name: string;
  chainId: number;
  rpc: string[];
  status: 'healthy' | 'degraded' | 'down';
  lastBlock?: number;
  watching?: boolean;
  responseTime?: number;
  error?: string;
}

export interface HubHealth {
  entityId: string;
  name: string;
  runtimeId?: string | undefined;
  online?: boolean | undefined;
  selfRelayPresence?: boolean | undefined;
  activeClients?: string[] | undefined;
  status: 'healthy' | 'degraded' | 'down';
  reserves?: Record<string, string> | undefined;
  accounts?: number | undefined;
  error?: string | undefined;
}

export interface SystemHealth {
  runtime: boolean;
  p2p: boolean;
  relay: boolean;
}

const startTime = Date.now();

const buildEntityReplicaIndex = (env: RuntimeReplica): Map<string, EntityReplica> => {
  const replicas = new Map<string, EntityReplica>();
  for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
    const fallbackEntityId = String(replicaKey).split(':')[0] || '';
    const entityId = String(replica.entityId || fallbackEntityId).toLowerCase();
    if (!entityId || replicas.has(entityId)) continue;
    replicas.set(entityId, replica);
  }
  return replicas;
};

const serializeReserves = (reserves: ReadonlyMap<string | number, bigint>): Record<string, string> => {
  const entries = Array.from(reserves.entries())
    .map(([tokenId, amount]) => [String(tokenId), amount.toString()] as const)
    .sort(([left], [right]) => {
      const leftNum = Number(left);
      const rightNum = Number(right);
      if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
        return leftNum - rightNum;
      }
      return compareStableText(left, right);
    });
  return Object.fromEntries(entries);
};

const buildHealthStatus = (env: RuntimeReplica | null): HealthStatus => {
  const jMachines: JMachineHealth[] = [];
  const hubs: HubHealth[] = [];
  const replicasByEntityId = env ? buildEntityReplicaIndex(env) : new Map<string, EntityReplica>();

  // Check J-machines
  if (env?.state.jReplicas) {
    for (const [name, jReplica] of env.state.jReplicas.entries()) {
      try {
        const jadapter = getLiveJAdapter(env, name);
        const status: JMachineHealth = {
          name,
          chainId: jReplica.chainId || 31337,
          rpc: jReplica.rpcs || [],
          status: 'healthy',
        };

        // Health must not create its own RPC polling path. The J-watcher is the
        // single source of observed chain progress; expose its persisted cursor.
        const blockNumber = Number(jReplica.blockNumber ?? 0n);
        if (Number.isFinite(blockNumber) && blockNumber >= 0) {
          status.lastBlock = Math.floor(blockNumber);
        }
        if (jadapter?.isWatching) {
          status.watching = jadapter.isWatching();
        }

        jMachines.push(status);
      } catch (err) {
        jMachines.push({
          name,
          chainId: 31337,
          rpc: [],
          status: 'down',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Check hubs (entities with isHub = true in gossip)
  if (env?.gossip) {
    const profiles = env.gossip.getProfiles();
    for (const profile of profiles) {
      if (profile.metadata.isHub === true) {
        const replica = replicasByEntityId.get(String(profile.entityId).toLowerCase());
        const hasReplica = Boolean(replica?.state);
        const accounts = replica?.state?.accounts?.size;
        hubs.push({
          entityId: profile.entityId,
          name: profile.name,
          status: hasReplica ? 'healthy' : 'degraded',
          ...(replica?.state?.reserves?.size ? { reserves: serializeReserves(replica.state.reserves) } : {}),
          ...(accounts !== undefined ? { accounts } : {}),
          ...(hasReplica ? {} : { error: 'hub profile visible but no local replica state' }),
        });
      }
    }
  }

  const p2pState = env ? getP2PState(env) : null;

  return {
    timestamp: Date.now(),
    uptime: Date.now() - startTime,
    jMachines,
    hubs,
    system: {
      runtime: !!env,
      p2p: p2pState?.connected === true,
      // This endpoint is served by the local runtime HTTP/relay process; P2P
      // connectivity is reported separately above.
      relay: !!env,
    },
  };
};

/**
 * Project health from one WAL-confirmed Runtime view.
 *
 * Health is externally visible. It must not leak balances from H+1 while the
 * writer is still awaiting the WAL commit that makes H+1 real.
 */
export const getHealthStatus = (env: RuntimeReplica | null): Promise<HealthStatus> =>
  env
    ? withRuntimeCommittedRead(env, () => buildHealthStatus(env))
    : Promise.resolve(buildHealthStatus(null));
