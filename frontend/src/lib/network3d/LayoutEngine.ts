/**
 * LayoutEngine - Pure layout algorithms for entity positioning
 *
 * Extracted from Graph3DPanel.svelte for testability and reusability.
 * All functions are pure - no side effects, no component state dependencies.
 */

import * as THREE from 'three';
import type { LayoutPosition } from './types';

export interface EntityProfile {
  entityId: string;
  [key: string]: unknown;
}

export interface LayoutConfig {
  width?: number;
  height?: number;
  iterations?: number;
  coolingFactor?: number;
}

/**
 * Fruchterman-Reingold force-directed layout algorithm
 *
 * Algorithm:
 * - Repulsion: All nodes push each other apart (Coulomb's law)
 * - Attraction: Connected nodes attract via springs (weighted by capacity)
 * - Cooling: Temperature decreases over iterations for stability
 *
 * @param profiles - Entity profiles with entityId
 * @param connectionMap - Map of entityId -> Set of connected entityIds
 * @param capacityMap - Map of "entityA-entityB" (sorted) -> capacity for weighting
 * @param config - Optional layout configuration
 * @returns Map of entityId -> THREE.Vector3 position
 */
export function applyForceDirectedLayout(
  profiles: EntityProfile[],
  connectionMap: Map<string, Set<string>>,
  capacityMap: Map<string, number>,
  config: LayoutConfig = {}
): Map<string, THREE.Vector3> {
  const positions = new Map<string, THREE.Vector3>();

  if (profiles.length === 0) {
    return positions;
  }

  // Configuration with defaults
  const width = config.width ?? 100;
  const height = config.height ?? 100;
  const iterations = config.iterations ?? 100;
  const coolingFactor = config.coolingFactor ?? 0.95;

  // Detect hubs for initial positioning
  const connectionCounts = new Map<string, number>();
  profiles.forEach(profile => {
    const connections = connectionMap.get(profile.entityId);
    connectionCounts.set(profile.entityId, connections?.size || 0);
  });

  // Initialize positions (random with bias for hubs toward center)
  const nodePositions = new Map<string, { x: number; y: number }>();
  profiles.forEach((profile, index) => {
    const degree = connectionCounts.get(profile.entityId) || 0;
    const isHub = degree > 2;

    // Hubs near center, leaves spread out
    const radius = isHub ? 10 : 30 + Math.random() * 20;
    const angle = (index / profiles.length) * Math.PI * 2;
    nodePositions.set(profile.entityId, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    });
  });

  // Fruchterman-Reingold algorithm parameters
  const area = width * height;
  const k = Math.sqrt(area / profiles.length); // Optimal distance
  let temperature = width / 10; // Initial temperature (cooling schedule)

  // Force calculations
  const repulsionForce = (dist: number) => (k * k) / dist;
  const attractionForce = (dist: number, capacity: number) => {
    // Weight attraction by capacity (bigger capacity = stronger spring)
    const weight = Math.max(0.1, Math.log10(capacity + 1));
    return (dist * dist * weight) / k;
  };

  // Iterative force simulation
  for (let iter = 0; iter < iterations; iter++) {
    const displacement = new Map<string, { x: number; y: number }>();

    // Initialize displacements
    profiles.forEach(p => {
      displacement.set(p.entityId, { x: 0, y: 0 });
    });

    // Calculate repulsive forces (all pairs)
    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const v = profiles[i];
        const u = profiles[j];
        if (!v || !u) continue;

        const vPos = nodePositions.get(v.entityId)!;
        const uPos = nodePositions.get(u.entityId)!;

        const dx = vPos.x - uPos.x;
        const dy = vPos.y - uPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01; // Avoid division by zero

        const force = repulsionForce(dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        const vDisp = displacement.get(v.entityId)!;
        const uDisp = displacement.get(u.entityId)!;
        vDisp.x += fx;
        vDisp.y += fy;
        uDisp.x -= fx;
        uDisp.y -= fy;
      }
    }

    // Calculate attractive forces (connected pairs)
    for (const [entityId, neighbors] of connectionMap.entries()) {
      const vPos = nodePositions.get(entityId);
      if (!vPos) continue;

      for (const neighborId of neighbors) {
        const uPos = nodePositions.get(neighborId);
        if (!uPos) continue;

        const dx = vPos.x - uPos.x;
        const dy = vPos.y - uPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;

        // Get capacity for this connection
        const capacityKey = [entityId, neighborId].sort().join('-');
        const capacity = capacityMap.get(capacityKey) || 1;

        const force = attractionForce(dist, Number(capacity));
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        const vDisp = displacement.get(entityId)!;
        vDisp.x -= fx;
        vDisp.y -= fy;
      }
    }

    // Apply displacements with cooling
    profiles.forEach(profile => {
      const pos = nodePositions.get(profile.entityId)!;
      const disp = displacement.get(profile.entityId)!;

      const dispLength = Math.sqrt(disp.x * disp.x + disp.y * disp.y) || 0.01;
      const cappedDisp = Math.min(dispLength, temperature);

      pos.x += (disp.x / dispLength) * cappedDisp;
      pos.y += (disp.y / dispLength) * cappedDisp;

      // Keep within bounds
      const halfWidth = width / 2;
      const halfHeight = height / 2;
      pos.x = Math.max(-halfWidth, Math.min(halfWidth, pos.x));
      pos.y = Math.max(-halfHeight, Math.min(halfHeight, pos.y));
    });

    // Cool down
    temperature *= coolingFactor;
  }

  // Convert to 3D positions
  profiles.forEach(profile => {
    const pos2d = nodePositions.get(profile.entityId)!;
    positions.set(profile.entityId, new THREE.Vector3(pos2d.x, pos2d.y, 0));
  });

  return positions;
}

/**
 * Simple radial layout (fallback when force layout disabled)
 *
 * Places entities in a circle, with hubs toward the center based on connection count.
 *
 * @param profiles - Entity profiles with entityId
 * @param connectionMap - Map of entityId -> Set of connected entityIds
 * @returns Map of entityId -> THREE.Vector3 position
 */
export function applySimpleRadialLayout(
  profiles: EntityProfile[],
  connectionMap: Map<string, Set<string>>
): Map<string, THREE.Vector3> {
  const positions = new Map<string, THREE.Vector3>();

  if (profiles.length === 0) {
    return positions;
  }

  const connectionCounts = new Map<string, number>();
  profiles.forEach(profile => {
    const connections = connectionMap.get(profile.entityId);
    connectionCounts.set(profile.entityId, connections?.size || 0);
  });

  // Sort by connection count (hubs first), then by entityId for stability
  const sorted = [...profiles].sort((a, b) => {
    const countA = connectionCounts.get(a.entityId) || 0;
    const countB = connectionCounts.get(b.entityId) || 0;
    if (countB !== countA) return countB - countA;
    return a.entityId.localeCompare(b.entityId);
  });

  // Radial layout parameters
  const baseRadius = 5;
  const maxRadius = 50;
  const angleStep = (Math.PI * 2) / profiles.length;

  sorted.forEach((profile, index) => {
    const degree = connectionCounts.get(profile.entityId) || 0;
    const radius = degree > 0 ? Math.max(baseRadius, maxRadius / (degree + 1)) : maxRadius;
    const angle = index * angleStep;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    positions.set(profile.entityId, new THREE.Vector3(x, y, 0));
  });

  return positions;
}

/**
 * Calculate connection map from replicas
 *
 * Extracts entity connections from replica account data.
 *
 * @param replicas - Map of "signerId:entityId" -> replica data
 * @returns Connection map of entityId -> Set of connected entityIds
 */
export function buildConnectionMap(
  replicas: Map<string, { state?: { accounts?: Map<string, unknown> } }>
): Map<string, Set<string>> {
  const connectionMap = new Map<string, Set<string>>();

  for (const [key, replica] of replicas.entries()) {
    const entityId = key.split(':')[0];
    if (!entityId) continue;

    const accounts = replica.state?.accounts;
    if (!accounts) continue;

    if (!connectionMap.has(entityId)) {
      connectionMap.set(entityId, new Set());
    }

    for (const counterpartyId of accounts.keys()) {
      connectionMap.get(entityId)!.add(counterpartyId as string);

      // Bidirectional
      if (!connectionMap.has(counterpartyId as string)) {
        connectionMap.set(counterpartyId as string, new Set());
      }
      connectionMap.get(counterpartyId as string)!.add(entityId);
    }
  }

  return connectionMap;
}

/**
 * Calculate capacity map from replicas and XLN functions
 *
 * Extracts total capacity for each connection to use as spring strength weights.
 *
 * @param replicas - Map of "signerId:entityId" -> replica data
 * @param tokenId - Token ID to calculate capacity for
 * @param deriveDelta - Function to derive account data from delta
 * @returns Capacity map of "entityA-entityB" (sorted) -> total capacity
 */
export function buildCapacityMap(
  replicas: Map<string, { state?: { accounts?: Map<string, { deltas?: Map<number, unknown> }> } }>,
  tokenId: number,
  deriveDelta?: (delta: unknown, isLeft: boolean) => { totalCapacity?: bigint }
): Map<string, number> {
  const capacityMap = new Map<string, number>();

  if (!deriveDelta) {
    return capacityMap;
  }

  for (const [key, replica] of replicas.entries()) {
    const entityId = key.split(':')[0];
    if (!entityId) continue;

    const accounts = replica.state?.accounts;
    if (!accounts) continue;

    for (const [counterpartyId, accountData] of accounts.entries()) {
      const delta = accountData.deltas?.get(tokenId);
      if (!delta) continue;

      const capacityKey = [entityId, counterpartyId].sort().join('-');
      if (capacityMap.has(capacityKey)) continue; // Already calculated from other side

      const isLeft = entityId < (counterpartyId as string);
      const derived = deriveDelta(delta, isLeft);
      const totalCapacity = Number(derived.totalCapacity || 0n);

      capacityMap.set(capacityKey, totalCapacity);
    }
  }

  return capacityMap;
}

/**
 * LayoutEngine class for stateful layout management
 *
 * Wraps pure functions with state management for incremental updates.
 */
export class LayoutEngine {
  private positions = new Map<string, THREE.Vector3>();
  private forceLayoutEnabled = true;
  private config: LayoutConfig;

  constructor(config: LayoutConfig = {}) {
    this.config = config;
  }

  /**
   * Enable or disable force-directed layout
   */
  setForceLayoutEnabled(enabled: boolean): void {
    this.forceLayoutEnabled = enabled;
  }

  /**
   * Calculate positions for all entities
   */
  calculatePositions(
    profiles: EntityProfile[],
    connectionMap: Map<string, Set<string>>,
    capacityMap: Map<string, number>
  ): Map<string, THREE.Vector3> {
    if (this.forceLayoutEnabled) {
      this.positions = applyForceDirectedLayout(profiles, connectionMap, capacityMap, this.config);
    } else {
      this.positions = applySimpleRadialLayout(profiles, connectionMap);
    }
    return this.positions;
  }

  /**
   * Get position for a specific entity
   */
  getPosition(entityId: string): THREE.Vector3 | undefined {
    return this.positions.get(entityId);
  }

  /**
   * Get all positions
   */
  getAllPositions(): Map<string, THREE.Vector3> {
    return this.positions;
  }

  /**
   * Update position for a single entity (e.g., after drag)
   */
  setPosition(entityId: string, position: THREE.Vector3): void {
    this.positions.set(entityId, position.clone());
  }

  /**
   * Clear all positions
   */
  clear(): void {
    this.positions.clear();
  }
}
