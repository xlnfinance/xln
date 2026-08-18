/**
 * Network Graph Structure for Payment Routing
 * Builds from gossip profiles to create routing graph
 */

import type { Profile } from '../entity/profile';
import { createStructuredLogger } from '../support/logger';
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

const isHubLikeProfile = (profile: Profile): boolean => {
  return profile.metadata.isHub === true;
};

const routingGraphLog = createStructuredLogger('routing.graph');

const hasRequiredRoutingMetadata = (profile: Profile): boolean => {
  const name = profile.name.trim();
  if (!name) return false;
  const routingFeePPM = Number(profile.metadata.routingFeePPM);
  return Number.isFinite(routingFeePPM) && routingFeePPM >= 0;
};

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

  // Build edges from account relationships.
  //
  // Only the side that opened an Account advertises it, so a lane appears in
  // exactly one Profile. The advertised row still describes the whole bilateral
  // Account, so the reverse direction is recorded from the same row with the
  // capacities mirrored; without it a Hub that never advertises its users would
  // have no outbound edge to deliver on.
  const edgesByFrom = new Map<string, AccountEdge[]>();
  const pushEdge = (edge: AccountEdge): void => {
    const existing = edgesByFrom.get(edge.from);
    if (existing) existing.push(edge);
    else edgesByFrom.set(edge.from, [edge]);
  };
  for (const profile of profiles.values()) {
    const fromEntity = profile.entityId;
    const fromEdges: AccountEdge[] = [];
    const fromIsHubLike = isHubLikeProfile(profile);

    if (fromIsHubLike && !hasRequiredRoutingMetadata(profile)) {
      routingGraphLog.error('drop_hub_profile_missing_metadata', {
        entityId: fromEntity,
        hasName: Boolean(profile.name.trim()),
        routingFeePPM: profile.metadata.routingFeePPM,
      });
      continue;
    }

    for (const account of profile.accounts) {
      const toEntity = account.counterpartyId;

      // Only add if counterparty exists in network
      if (!nodes.has(toEntity)) continue;
      const toProfile = profiles.get(toEntity);
      if (toProfile && isHubLikeProfile(toProfile) && !hasRequiredRoutingMetadata(toProfile)) {
        continue;
      }

      // Get capacities for this token
      const tokenCapacity = getTokenCapacity(account.tokenCapacities, tokenId);
      if (!tokenCapacity || tokenCapacity.outCapacity === 0n) continue;

      const baseFee = sanitizeBaseFee(profile.metadata.baseFee);
      const basePpm = sanitizeFeePPM(profile.metadata.routingFeePPM, 1);
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
      const mirrorKey = `${toEntity}:${fromEntity}:${tokenId}`;
      if (!accountCapacities.has(mirrorKey)) {
        accountCapacities.set(mirrorKey, {
          outbound: tokenCapacity.inCapacity,
          inbound: tokenCapacity.outCapacity,
        });
        if (tokenCapacity.inCapacity > 0n) {
          const mirrorProfile = profiles.get(toEntity);
          pushEdge({
            from: toEntity,
            to: fromEntity,
            tokenId,
            capacity: tokenCapacity.inCapacity,
            baseFee: sanitizeBaseFee(mirrorProfile?.metadata.baseFee ?? 0n),
            feePPM: calculateDirectionalFeePPM(
              sanitizeFeePPM(mirrorProfile?.metadata.routingFeePPM ?? 1, 1),
              tokenCapacity.inCapacity,
              tokenCapacity.outCapacity,
            ),
            disabled: false,
          });
        }
      }
    }

    for (const edge of fromEdges) pushEdge(edge);
  }

  for (const [fromEntity, fromEdges] of edgesByFrom) {
    if (fromEdges.length > 0) edges.set(fromEntity, fromEdges);
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
