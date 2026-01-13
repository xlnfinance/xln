/**
 * EntityManager - Manages 3D entity nodes in the network visualization
 *
 * Responsibilities:
 * - Create/destroy entity meshes
 * - Create entity labels (auto-billboarded THREE.Sprite)
 * - Calculate entity sizes based on token balances
 * - Format entity display names
 * - Track entity metadata (isHub, pulsePhase, etc.)
 */

import * as THREE from 'three';
import type { EntityData, LayoutPosition } from './types';

export class EntityManager {
  private scene: THREE.Scene;
  private entities = new Map<string, EntityData>();
  private entitySizeCache = new Map<string, Map<number, number>>();
  private lastReplicaHash: string | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Create a new entity node
   */
  createEntity(
    entityId: string,
    profile: any,
    position: LayoutPosition,
    isHub: boolean = false
  ): EntityData {
    // Create sphere geometry
    const geometry = new THREE.SphereGeometry(2, 32, 32);

    // Hub entities get glowing material (SOLID - no transparency)
    const material = new THREE.MeshLambertMaterial({
      color: isHub ? 0x00ff88 : 0x007acc,
      emissive: isHub ? 0x00ff88 : 0x000000,
      emissiveIntensity: isHub ? 2.0 : 0,
      // Solid spheres - no transparency, write to depth buffer
      transparent: false,
      depthWrite: true
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position.x, position.y, position.z);
    mesh.userData['entityId'] = entityId;
    mesh.renderOrder = 10; // Render entities AFTER boxes/lines
    this.scene.add(mesh);

    // Create label sprite
    const label = this.createLabel(entityId);
    label.position.set(position.x, position.y + 3, position.z);
    this.scene.add(label);

    const entity: EntityData = {
      id: entityId,
      position: new THREE.Vector3(position.x, position.y, position.z),
      mesh,
      label,
      profile,
      isHub,
      pulsePhase: Math.random() * Math.PI * 2,
      lastActivity: 0,
      isPinned: false,
      isHovered: false,
      isDragging: false,
      activityRing: null,
      hubConnectedIds: isHub ? new Set() : undefined,
      reserveLabel: undefined
    };

    this.entities.set(entityId, entity);
    return entity;
  }

  /**
   * Create billboarded text sprite for entity label
   */
  private createLabel(entityId: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = 256;
    canvas.height = 64;

    // Get short name
    const shortName = this.getShortName(entityId);

    // Draw text
    context.fillStyle = 'rgba(0, 0, 0, 0)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = 'Bold 24px monospace';
    context.fillStyle = 'rgba(255, 255, 255, 0.9)';
    context.textAlign = 'center';
    context.fillText(shortName, canvas.width / 2, canvas.height / 2 + 8);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.9
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(4, 1, 1);
    sprite.userData['entityId'] = entityId;

    return sprite;
  }

  /**
   * Get entity by ID
   */
  getEntity(entityId: string): EntityData | undefined {
    return this.entities.get(entityId);
  }

  /**
   * Get all entities
   */
  getAllEntities(): EntityData[] {
    return Array.from(this.entities.values());
  }

  /**
   * Get entity IDs
   */
  getEntityIds(): string[] {
    return Array.from(this.entities.keys());
  }

  /**
   * Update entity position
   */
  updatePosition(entityId: string, position: THREE.Vector3) {
    const entity = this.entities.get(entityId);
    if (!entity) return;

    entity.position.copy(position);
    entity.mesh.position.copy(position);

    if (entity.label) {
      entity.label.position.copy(position);
      entity.label.position.y += 3;
    }
  }

  /**
   * Remove entity
   */
  removeEntity(entityId: string) {
    const entity = this.entities.get(entityId);
    if (!entity) return;

    // Remove from scene
    if (entity.mesh) {
      this.scene.remove(entity.mesh);
      entity.mesh.geometry.dispose();
      if (entity.mesh.material instanceof THREE.Material) {
        entity.mesh.material.dispose();
      }
    }

    if (entity.label) {
      this.scene.remove(entity.label);
      if (entity.label.material.map) {
        entity.label.material.map.dispose();
      }
      entity.label.material.dispose();
    }

    if (entity.activityRing) {
      this.scene.remove(entity.activityRing);
      entity.activityRing.geometry.dispose();
      if (entity.activityRing.material instanceof THREE.Material) {
        entity.activityRing.material.dispose();
      }
    }

    this.entities.delete(entityId);
  }

  /**
   * Clear all entities
   */
  clear() {
    const entityIds = Array.from(this.entities.keys());
    entityIds.forEach(id => this.removeEntity(id));
    this.entitySizeCache.clear();
  }

  /**
   * Get entity size for token (cached for performance)
   */
  getSizeForToken(
    entityId: string,
    tokenId: number,
    xlnFunctions: any,
    replicas: Map<string, any>
  ): number {
    // Check if we need to invalidate cache (replica state changed)
    const replicaHash = this.hashReplicas(replicas);
    if (replicaHash !== this.lastReplicaHash) {
      this.entitySizeCache.clear();
      this.lastReplicaHash = replicaHash;
    }

    // Check cache
    if (!this.entitySizeCache.has(entityId)) {
      this.entitySizeCache.set(entityId, new Map());
    }

    const tokenSizes = this.entitySizeCache.get(entityId)!;
    if (tokenSizes.has(tokenId)) {
      return tokenSizes.get(tokenId)!;
    }

    // Calculate size
    const replica = this.getReplicaForEntity(entityId, replicas);
    if (!replica) {
      tokenSizes.set(tokenId, 2);
      return 2;
    }

    let totalCapacity = 0;
    replica.state.accounts?.forEach((account: any) => {
      const delta = account.deltas?.get(tokenId);
      if (delta && xlnFunctions?.deriveDelta) {
        const isLeft = entityId < account.counterpartyEntityId;
        const derived = xlnFunctions.deriveDelta(delta, isLeft);
        totalCapacity += Number(derived.totalCapacity || 0n);
      }
    });

    const size = Math.max(2, Math.min(10, 2 + Math.log10(totalCapacity / 1e18 + 1) * 2));
    tokenSizes.set(tokenId, size);
    return size;
  }

  /**
   * Get short display name for entity
   */
  getShortName(entityId: string): string {
    // Try to extract number from numbered entity
    const match = entityId.match(/#(\d+)/);
    if (match) {
      return `#${match[1]}`;
    }

    // Show first 6 chars of hash
    return entityId.substring(0, 6).toUpperCase();
  }

  /**
   * Get balance info for tooltip
   */
  getBalanceInfo(
    entityId: string,
    tokenId: number,
    xlnFunctions: any,
    replicas: Map<string, any>
  ): string {
    const replica = this.getReplicaForEntity(entityId, replicas);
    if (!replica) return 'No data';

    const reserves = replica.state.reserves || new Map();
    const reserve = reserves.get(tokenId) || 0n;

    let totalCapacity = 0n;
    let totalCollateral = 0n;

    replica.state.accounts?.forEach((account: any) => {
      const delta = account.deltas?.get(tokenId);
      if (delta && xlnFunctions?.deriveDelta) {
        const isLeft = entityId < account.counterpartyEntityId;
        const derived = xlnFunctions.deriveDelta(delta, isLeft);
        totalCapacity += derived.totalCapacity || 0n;
        totalCollateral += derived.collateral || 0n;
      }
    });

    const tokenInfo = xlnFunctions?.getTokenInfo?.(tokenId);
    const symbol = tokenInfo?.symbol || `Token${tokenId}`;

    return `Reserve: ${this.formatAmount(reserve)} ${symbol}\n` +
           `Capacity: ${this.formatAmount(totalCapacity)} ${symbol}\n` +
           `Collateral: ${this.formatAmount(totalCollateral)} ${symbol}`;
  }

  /**
   * Format bigint amount for display
   */
  private formatAmount(amount: bigint): string {
    const num = Number(amount) / 1e18;
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(2)}K`;
    return num.toFixed(2);
  }

  /**
   * Get replica for entity (handles signerId:entityId format)
   */
  private getReplicaForEntity(entityId: string, replicas: Map<string, any>): any {
    // Try direct lookup
    if (replicas.has(entityId)) {
      return replicas.get(entityId);
    }

    // Try with signerId prefix
    for (const [key, replica] of replicas.entries()) {
      if (key.includes(entityId)) {
        return replica;
      }
    }

    return null;
  }

  /**
   * Hash replica keys for cache invalidation
   */
  private hashReplicas(replicas: Map<string, any>): string {
    const keys = Array.from(replicas.keys()).sort();
    return keys.join(',');
  }

  /**
   * Set hover state
   */
  setHovered(entityId: string, hovered: boolean) {
    const entity = this.entities.get(entityId);
    if (entity) {
      entity.isHovered = hovered;
    }
  }

  /**
   * Set dragging state
   */
  setDragging(entityId: string, dragging: boolean) {
    const entity = this.entities.get(entityId);
    if (entity) {
      entity.isDragging = dragging;
    }
  }

  /**
   * Set pinned state (manually positioned)
   */
  setPinned(entityId: string, pinned: boolean) {
    const entity = this.entities.get(entityId);
    if (entity) {
      entity.isPinned = pinned;
    }
  }
}
