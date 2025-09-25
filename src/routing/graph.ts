/**
 * Network Graph Structure for Payment Routing
 * Builds from gossip profiles to create routing graph
 */

import type { Profile } from '../gossip';

export interface ChannelEdge {
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
  edges: Map<string, ChannelEdge[]>; // from -> edges[]

  // Quick lookup for channel capacities
  channelCapacities: Map<string, {
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
  const edges = new Map<string, ChannelEdge[]>();
  const channelCapacities = new Map<string, {
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
    const fromEdges: ChannelEdge[] = [];

    if (profile.accounts) {
      for (const account of profile.accounts) {
        const toEntity = account.counterpartyId;

        // Only add if counterparty exists in network
        if (!nodes.has(toEntity)) continue;

        // Get capacities for this token
        const tokenCapacity = account.tokenCapacities.get(tokenId);
        if (!tokenCapacity || tokenCapacity.outCapacity === 0n) continue;

        // Get fee configuration from profile with explicit validation
        const metadata = profile.metadata;
        if (!metadata) {
          console.warn(`🚨 ROUTING-SAFETY: Entity ${fromEntity} has no metadata, using safe defaults`);
        }
        const baseFee = metadata?.baseFee ?? 0n; // Explicit null/undefined check
        const feePPM = metadata?.routingFeePPM ?? 100; // Explicit default: 100 PPM (0.01%)

        // Create edge
        const edge: ChannelEdge = {
          from: fromEntity,
          to: toEntity,
          tokenId,
          capacity: tokenCapacity.outCapacity,
          baseFee,
          feePPM,
          disabled: false,
        };

        fromEdges.push(edge);

        // Store channel capacities
        const channelKey = `${fromEntity}:${toEntity}:${tokenId}`;
        channelCapacities.set(channelKey, {
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
    channelCapacities,
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
): ChannelEdge | undefined {
  const edges = graph.edges.get(from) ?? [];  // Explicit undefined handling
  return edges.find(e => e.to === to && e.tokenId === tokenId);
}