// Health check endpoint
// Returns status of all J-machines, hubs, and system health

import type { EntityReplica, Env } from './types.js';
import { getP2PState } from './runtime.js';
import { compareStableText } from './serialization-utils';

export interface HealthStatus {
  timestamp: number;
  uptime: number;
  jMachines: JMachineHealth[];
  hubs: HubHealth[];
  system: SystemHealth;
  disk?: {
    ok: boolean;
    minFreeBytes: number;
    freeBytes: number;
    usedBytes: number;
    totalBytes: number;
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

const buildEntityReplicaIndex = (env: Env): Map<string, EntityReplica> => {
  const replicas = new Map<string, EntityReplica>();
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
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

export async function getHealthStatus(env: Env | null): Promise<HealthStatus> {
  const jMachines: JMachineHealth[] = [];
  const hubs: HubHealth[] = [];
  const replicasByEntityId = env ? buildEntityReplicaIndex(env) : new Map<string, EntityReplica>();

  // Check J-machines
  if (env?.jReplicas) {
    for (const [name, jReplica] of env.jReplicas.entries()) {
      try {
        const jadapter = jReplica.jadapter;
        const status: JMachineHealth = {
          name,
          chainId: jReplica.chainId || 31337,
          rpc: jReplica.rpcs || [],
          status: 'healthy',
        };

        // Try to get latest block
        if (jadapter?.provider) {
          const start = Date.now();
          try {
            const blockNumber = await jadapter.provider.getBlockNumber();
            status.lastBlock = blockNumber;
            status.responseTime = Date.now() - start;
          } catch (err) {
            status.status = 'down';
            status.error = err instanceof Error ? err.message : String(err);
          }
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
}
