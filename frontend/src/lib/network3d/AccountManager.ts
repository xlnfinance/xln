/**
 * AccountManager - Manages 3D visualization of bilateral accounts (financial relationships)
 *
 * In XLN, an "Account" is a bilateral relationship between two entities (AccountMachine).
 * This manager handles:
 * - Connection lines between entities
 * - 7-region capacity bar visualization (RCPAN + credit)
 * - Account data lookup and perspective calculation
 * - Selective updates for performance
 */

import * as THREE from 'three';
import type { AccountConnectionData, DerivedAccountData, EntityData } from './types';

export class AccountManager {
  private scene: THREE.Scene;
  private accounts = new Map<string, AccountConnectionData>();
  private accountIndexMap = new Map<string, number>();

  // Settings
  private barsMode: 'close' | 'spread' = 'close';
  private selectedTokenId: number = 1;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Create all account connections based on entity data
   */
  createAll(
    entities: EntityData[],
    replicas: Map<string, any>,
    xlnFunctions: any
  ) {
    // Clear existing
    this.clear();

    // Build account index map for O(1) lookups
    let index = 0;
    entities.forEach(fromEntity => {
      entities.forEach(toEntity => {
        if (fromEntity.id >= toEntity.id) return; // Only create once per pair

        // Check if account exists
        if (this.hasAccount(fromEntity.id, toEntity.id, replicas)) {
          const key = this.getAccountKey(fromEntity.id, toEntity.id);
          this.accountIndexMap.set(key, index++);

          // Create connection
          this.createAccount(fromEntity, toEntity, replicas, xlnFunctions);
        }
      });
    });
  }

  /**
   * Create single account visualization
   */
  private createAccount(
    fromEntity: EntityData,
    toEntity: EntityData,
    replicas: Map<string, any>,
    xlnFunctions: any
  ) {
    const key = this.getAccountKey(fromEntity.id, toEntity.id);

    // Create connection line
    const line = this.createLine(fromEntity, toEntity);

    // Create capacity bars (7-region RCPAN visualization)
    const progressBars = this.createCapacityBars(
      fromEntity,
      toEntity,
      replicas,
      xlnFunctions
    );

    const accountData: AccountConnectionData = {
      fromEntityId: fromEntity.id,
      toEntityId: toEntity.id,
      line,
      progressBars,
      account: this.getAccountData(fromEntity.id, toEntity.id, replicas)
    };

    this.accounts.set(key, accountData);
  }

  /**
   * Create connection line between two entities
   */
  private createLine(fromEntity: EntityData, toEntity: EntityData): THREE.Line {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array([
      fromEntity.position.x, fromEntity.position.y, fromEntity.position.z,
      toEntity.position.x, toEntity.position.y, toEntity.position.z
    ]);

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.LineBasicMaterial({
      color: 0x00ccff,
      opacity: 0.3,
      transparent: true,
      linewidth: 1
    });

    const line = new THREE.Line(geometry, material);
    line.userData['fromEntityId'] = fromEntity.id;
    line.userData['toEntityId'] = toEntity.id;

    this.scene.add(line);
    return line;
  }

  /**
   * Create 7-region capacity bars (XLN-specific visualization)
   */
  private createCapacityBars(
    fromEntity: EntityData,
    toEntity: EntityData,
    replicas: Map<string, any>,
    xlnFunctions: any
  ): THREE.Group | undefined {
    const group = new THREE.Group();

    // Get account data
    const accountData = this.getAccountData(fromEntity.id, toEntity.id, replicas);
    if (!accountData) return undefined;

    // Get delta for selected token
    const delta = accountData.deltas?.get(this.selectedTokenId);
    if (!delta) return undefined;

    // Derive perspective-correct data
    const isLeft = fromEntity.id < toEntity.id;
    if (!xlnFunctions?.deriveDelta) return undefined;

    const derived: DerivedAccountData = xlnFunctions.deriveDelta(delta, isLeft);

    // Calculate bar positions
    const midpoint = new THREE.Vector3()
      .addVectors(fromEntity.position, toEntity.position)
      .multiplyScalar(0.5);

    const direction = new THREE.Vector3()
      .subVectors(toEntity.position, fromEntity.position)
      .normalize();

    const perpendicular = new THREE.Vector3(-direction.z, 0, direction.x);

    // Bar height
    const maxHeight = 20;
    const totalCapacity = Number(derived.totalCapacity || 0n);
    const scale = totalCapacity > 0 ? maxHeight / (totalCapacity / 1e18) : 0;

    if (this.barsMode === 'close') {
      // Close mode: bars stack on centerline
      this.createStackedBars(group, midpoint, perpendicular, derived, scale);
    } else {
      // Spread mode: bars extend left and right
      this.createSpreadBars(group, midpoint, perpendicular, direction, derived, scale);
    }

    group.position.copy(midpoint);
    this.scene.add(group);

    return group;
  }

  /**
   * Create stacked bars (close mode)
   */
  private createStackedBars(
    group: THREE.Group,
    _midpoint: THREE.Vector3,
    perpendicular: THREE.Vector3,
    derived: DerivedAccountData,
    scale: number
  ) {
    const barWidth = 0.5;
    let yOffset = 0;

    // Stack order (bottom to top): outOwnCredit → inCollateral → outPeerCredit → inOwnCredit → outCollateral → inPeerCredit
    const layers = [
      { value: derived.outOwnCredit, color: 0x00ff88, name: 'our unused credit' },
      { value: derived.inCollateral, color: 0xffa500, name: 'our collateral' },
      { value: derived.outPeerCredit, color: 0xff4444, name: 'their used credit' },
      { value: derived.inOwnCredit, color: 0xff8888, name: 'our used credit' },
      { value: derived.outCollateral, color: 0xffbb00, name: 'their collateral' },
      { value: derived.inPeerCredit, color: 0x00ff88, name: 'their unused credit' }
    ];

    layers.forEach(layer => {
      const height = (Number(layer.value) / 1e18) * scale;
      if (height > 0.01) {
        const geometry = new THREE.BoxGeometry(barWidth, height, barWidth);
        const material = new THREE.MeshBasicMaterial({
          color: layer.color,
          opacity: 0.8,
          transparent: true
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(perpendicular.clone().multiplyScalar(0));
        mesh.position.y = yOffset + height / 2;
        mesh.userData['layerName'] = layer.name;

        group.add(mesh);
        yOffset += height;
      }
    });
  }

  /**
   * Create spread bars (spread mode)
   * Bars extend FROM each entity toward middle with huge gap
   */
  private createSpreadBars(
    group: THREE.Group,
    _midpoint: THREE.Vector3,
    _perpendicular: THREE.Vector3,
    direction: THREE.Vector3,
    derived: DerivedAccountData,
    scale: number
  ) {
    // NOTE: This is simplified - full implementation needs entity sizes and proper geometry
    // For now, use the original NetworkTopology implementation (lines 1842-1940)
    // TODO: Extract full cylinder-based spread bars with rotation

    const barHeight = 0.4;
    const barRadius = barHeight * 2.5;
    const safeGap = 0.2;
    const minGapSpread = 2;

    // Assume entity size = 2 (will get from EntityManager later)
    const fromEntitySize = 2;

    // Colors from 2019vue.txt pattern
    const colors = {
      availableCredit: 0xff9c9c,  // light red - unused credit
      secured: 0x5cb85c,          // green - collateral
      unsecured: 0xdc3545         // red - used credit
    };

    const barScale = scale / 20; // Normalize scale
    const segments = {
      outOwnCredit: Number(derived.outOwnCredit) / 1e18 * barScale,
      inCollateral: Number(derived.inCollateral) / 1e18 * barScale,
      outPeerCredit: Number(derived.outPeerCredit) / 1e18 * barScale,
      inOwnCredit: Number(derived.inOwnCredit) / 1e18 * barScale,
      outCollateral: Number(derived.outCollateral) / 1e18 * barScale,
      inPeerCredit: Number(derived.inPeerCredit) / 1e18 * barScale
    };

    // Left-side bars extend FROM left entity
    const leftStartPos = direction.clone().normalize().multiplyScalar(-(fromEntitySize + barRadius + safeGap));

    let leftOffset = 0;
    const leftBars = [
      { key: 'outOwnCredit' as const, colorType: 'availableCredit' as const },  // Our unused (pink) - closest to entity
      { key: 'inCollateral' as const, colorType: 'secured' as const },          // Our collateral (green) - middle
      { key: 'outPeerCredit' as const, colorType: 'unsecured' as const }        // Their used (red) - closest to gap
    ];

    leftBars.forEach((barSpec) => {
      const length = segments[barSpec.key];
      if (length > 0.01) {
        const geometry = new THREE.CylinderGeometry(barRadius, barRadius, length, 16);
        const barColor = colors[barSpec.colorType];
        const isCredit = barSpec.colorType === 'availableCredit' || barSpec.colorType === 'unsecured';

        const material = new THREE.MeshLambertMaterial({
          color: barColor,
          transparent: true,
          opacity: isCredit ? 0.3 : 0.9,
          emissive: new THREE.Color(barColor).multiplyScalar(isCredit ? 0.05 : 0.1),
          wireframe: isCredit
        });

        const bar = new THREE.Mesh(geometry, material);
        const barCenter = leftStartPos.clone().add(direction.clone().normalize().multiplyScalar(leftOffset + length / 2));
        bar.position.copy(barCenter);

        // Rotate cylinder to align with direction
        const axis = new THREE.Vector3(0, 1, 0);
        bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

        group.add(bar);
        leftOffset += length;
      }
    });

    // Right-side bars extend FROM right entity
    const leftBarsLength = segments.outOwnCredit + segments.inCollateral + segments.outPeerCredit;
    const gapStart = direction.clone().normalize().multiplyScalar(
      -(fromEntitySize + barRadius + safeGap + leftBarsLength + minGapSpread)
    );

    let rightOffset = 0;
    const rightBars = [
      { key: 'inPeerCredit' as const, colorType: 'availableCredit' as const },   // Their unused (pink) - closest to entity
      { key: 'outCollateral' as const, colorType: 'secured' as const },          // Their collateral (green) - middle
      { key: 'inOwnCredit' as const, colorType: 'unsecured' as const }           // Our used (red) - closest to gap
    ];

    rightBars.forEach((barSpec) => {
      const length = segments[barSpec.key];
      if (length > 0.01) {
        const geometry = new THREE.CylinderGeometry(barRadius, barRadius, length, 16);
        const barColor = colors[barSpec.colorType];
        const isCredit = barSpec.colorType === 'availableCredit' || barSpec.colorType === 'unsecured';

        const material = new THREE.MeshLambertMaterial({
          color: barColor,
          transparent: true,
          opacity: isCredit ? 0.3 : 0.9,
          emissive: new THREE.Color(barColor).multiplyScalar(isCredit ? 0.05 : 0.1),
          wireframe: isCredit
        });

        const bar = new THREE.Mesh(geometry, material);
        const barCenter = gapStart.clone().add(direction.clone().normalize().multiplyScalar(-(rightOffset + length / 2)));
        bar.position.copy(barCenter);

        // Rotate cylinder
        const axis = new THREE.Vector3(0, 1, 0);
        bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

        group.add(bar);
        rightOffset += length;
      }
    });
  }

  /**
   * Update connections for specific entity (selective update for performance)
   */
  updateForEntity(
    entityId: string,
    entities: EntityData[],
    replicas: Map<string, any>,
    xlnFunctions: any
  ) {
    entities.forEach(otherEntity => {
      if (otherEntity.id === entityId) return;

      const key = this.getAccountKey(entityId, otherEntity.id);
      const account = this.accounts.get(key);

      if (account) {
        const fromEntity = entities.find(e => e.id === account.fromEntityId);
        const toEntity = entities.find(e => e.id === account.toEntityId);

        if (fromEntity && toEntity) {
          // Update line positions
          this.updateLine(account.line, fromEntity, toEntity);

          // Update capacity bars
          if (account.progressBars) {
            this.scene.remove(account.progressBars);
            account.progressBars = this.createCapacityBars(
              fromEntity,
              toEntity,
              replicas,
              xlnFunctions
            );
          }
        }
      }
    });
  }

  /**
   * Update line geometry
   */
  private updateLine(line: THREE.Line, fromEntity: EntityData, toEntity: EntityData) {
    const positions = line.geometry.attributes['position'];
    if (positions) {
      const array = positions.array as Float32Array;
      array[0] = fromEntity.position.x;
      array[1] = fromEntity.position.y;
      array[2] = fromEntity.position.z;
      array[3] = toEntity.position.x;
      array[4] = toEntity.position.y;
      array[5] = toEntity.position.z;
      positions.needsUpdate = true;
    }
  }

  /**
   * Set bars display mode
   */
  setBarsMode(mode: 'close' | 'spread') {
    this.barsMode = mode;
  }

  /**
   * Set selected token for capacity bars
   */
  setSelectedToken(tokenId: number) {
    this.selectedTokenId = tokenId;
  }

  /**
   * Get account key (canonical ordering)
   */
  private getAccountKey(entityA: string, entityB: string): string {
    return entityA < entityB ? `${entityA}:${entityB}` : `${entityB}:${entityA}`;
  }

  /**
   * Check if account exists between two entities
   */
  private hasAccount(
    entityA: string,
    entityB: string,
    replicas: Map<string, any>
  ): boolean {
    // Find replica for entityA
    const replicaA = this.getReplicaForEntity(entityA, replicas);
    if (!replicaA) return false;

    // Check if account to entityB exists
    return replicaA.state.accounts?.has(entityB) || false;
  }

  /**
   * Get account machine data
   */
  private getAccountData(
    entityA: string,
    entityB: string,
    replicas: Map<string, any>
  ): any {
    const replica = this.getReplicaForEntity(entityA, replicas);
    if (!replica) return null;

    return replica.state.accounts?.get(entityB) || null;
  }

  /**
   * Get replica for entity
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
   * Get account index (for particle routing)
   */
  getAccountIndex(fromEntityId: string, toEntityId: string): number {
    const key = this.getAccountKey(fromEntityId, toEntityId);
    return this.accountIndexMap.get(key) ?? -1;
  }

  /**
   * Clear all accounts
   */
  clear() {
    this.accounts.forEach(account => {
      if (account.line) {
        this.scene.remove(account.line);
        account.line.geometry.dispose();
        if (account.line.material instanceof THREE.Material) {
          account.line.material.dispose();
        }
      }

      if (account.progressBars) {
        this.scene.remove(account.progressBars);
        account.progressBars.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            if (child.material instanceof THREE.Material) {
              child.material.dispose();
            }
          }
        });
      }
    });

    this.accounts.clear();
    this.accountIndexMap.clear();
  }

  /**
   * Get all accounts
   */
  getAllAccounts(): AccountConnectionData[] {
    return Array.from(this.accounts.values());
  }
}
