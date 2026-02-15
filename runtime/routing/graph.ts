/**
 * Network Graph Structure for Payment Routing
 * Builds from gossip profiles to create routing graph
 */

import type { Profile } from '../networking/gossip';
import { getTokenCapacity } from './capacity';
import { calculateDirectionalFeePPM, sanitizeBaseFee, sanitizeFeePPM } from './fees';

export interface AccountEdge {
  from: string;
  to: string;
  tokenId: number;
  capacity: bigint;
  baseFee: bigint; // Base fee in smallest unit
  feePPM: number; // Fee rate in parts per million
  disabled: boolean;
}

export interface NetworkGraph {
  nodes: Set<string>; // Entity IDs
  edges: Map<string, AccountEdge[]>; // from -> edges[]

  // Quick lookup for account capacities
  accountCapacities: Map<string, {
    outbound: bigint;
    inbound: bigint;
  }>;
}

/**
 * Build network graph from gossip profiles
 */
export function buildNetworkGraph(
  profiles: Map<string, Profile>,
  tokenId: number
): NetworkGraph {
  const nodes = new Set<string>();
  const edges = new Map<string, AccountEdge[]>();
  const accountCapacities = new Map<string, {
    outbound: bigint;
    inbound: bigint;
  }>();

  // Add all entities as nodes
  for (const profile of profiles.values()) {
    nodes.add(profile.entityId);
  }

  // Build edges from account relationships
  for (const profile of profiles.values()) {
    const fromEntity = profile.entityId;
    const fromEdges: AccountEdge[] = [];

    if (profile.accounts) {
      for (const account of profile.accounts) {
        const toEntity = account.counterpartyId;

        // Only add if counterparty exists in network
        if (!nodes.has(toEntity)) continue;

        // Get capacities for this token
        const tokenCapacity = getTokenCapacity(account.tokenCapacities, tokenId);
        if (!tokenCapacity || tokenCapacity.outCapacity === 0n) continue;

        // Get fee configuration from profile with explicit validation
        const metadata = profile.metadata;
        if (!metadata) {
          console.warn(`🚨 ROUTING-SAFETY: Entity ${fromEntity} has no metadata, using safe defaults`);
        }
        const baseFee = sanitizeBaseFee(metadata?.baseFee ?? 0n);
        const basePpm = sanitizeFeePPM(metadata?.routingFeePPM ?? 100, 100);
        const feePPM = calculateDirectionalFeePPM(
          basePpm,
          tokenCapacity.outCapacity,
          tokenCapacity.inCapacity
        );

        // Create edge
        const edge: AccountEdge = {
          from: fromEntity,
          to: toEntity,
          tokenId,
          capacity: tokenCapacity.outCapacity,
          baseFee,
          feePPM,
          disabled: false,
        };

        fromEdges.push(edge);

        // Store account capacities
        const accountKey = `${fromEntity}:${toEntity}:${tokenId}`;
        accountCapacities.set(accountKey, {
          outbound: tokenCapacity.outCapacity,
          inbound: tokenCapacity.inCapacity,
        });
      }
    }

    if (fromEdges.length > 0) {
      edges.set(fromEntity, fromEdges);
    }
  }

  return {
    nodes,
    edges,
    accountCapacities,
  };
}

/**
 * Get edge between two nodes
 */
export function getEdge(
  graph: NetworkGraph,
  from: string,
  to: string,
  tokenId: number
): AccountEdge | undefined {
  const edges = graph.edges.get(from) ?? [];  // Explicit undefined handling
  return edges.find(e => e.to === to && e.tokenId === tokenId);
}
