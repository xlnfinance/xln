// Health check endpoint
// Returns status of all J-machines, hubs, and system health

import type { Env } from './types.js';
import { getP2P } from './runtime.js';

export interface HealthStatus {
  timestamp: number;
  uptime: number;
  jMachines: JMachineHealth[];
  hubs: HubHealth[];
  system: SystemHealth;
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
  region?: string;
  relayUrl?: string;
  status: 'healthy' | 'degraded' | 'down';
  reserves?: Record<string, string>;
  accounts?: number;
  error?: string;
}

export interface SystemHealth {
  runtime: boolean;
  p2p: boolean;
  database: boolean;
  relay: boolean;
}

const startTime = Date.now();

export async function getHealthStatus(env: Env | null): Promise<HealthStatus> {
  const jMachines: JMachineHealth[] = [];
  const hubs: HubHealth[] = [];

  // Check J-machines
  if (env?.jReplicas) {
    for (const [name, jReplica] of env.jReplicas.entries()) {
      try {
        const jadapter = jReplica.jadapter;
        const status: JMachineHealth = {
          name,
          chainId: jReplica.chainId || 0,
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
          chainId: 0,
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
      if (profile.metadata?.isHub) {
        hubs.push({
          entityId: profile.entityId,
          name: profile.metadata.name || 'Unknown',
          region: profile.metadata.region,
          relayUrl: profile.metadata.relayUrl,
          status: 'healthy', // TODO: Add health check
        });
      }
    }
  }

  // Check entities with reserves (potential hubs)
  if (env?.eReplicas) {
    for (const [entityId, replica] of env.eReplicas.entries()) {
      const state = replica.state;
      if (state?.reserves && Object.keys(state.reserves).length > 0) {
        // Only add if not already in hubs list
        if (!hubs.find(h => h.entityId === entityId)) {
          hubs.push({
            entityId,
            name: entityId.slice(0, 10) + '...',
            status: 'healthy',
            reserves: state.reserves,
            accounts: state.accounts?.size || 0,
          });
        }
      }
    }
  }

  return {
    timestamp: Date.now(),
    uptime: Date.now() - startTime,
    jMachines,
    hubs,
    system: {
      runtime: !!env,
      p2p: !!(env && getP2P(env)),
      database: true, // TODO: Check actual DB connection
      relay: !!(env && getP2P(env)?.isConnected()),
    },
  };
}
