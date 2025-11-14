/**
 * EntityObject - Encapsulates entity 3D representation
 *
 * Hierarchy:
 * EntityObject (THREE.Group)
 *   ├─ mesh (octahedron)
 *   ├─ label (sprite - ATTACHED)
 *   ├─ reserveBar (cylinder - ATTACHED)
 *   └─ edges[] (lines to accounts - MANAGED)
 *
 * This ensures label moves WITH entity, not separately.
 */

import * as THREE from 'three';

export interface EntityData {
  entityId: string;
  name?: string;
  reserves?: Map<string, bigint>;
  accounts?: Map<string, any>;
  position?: THREE.Vector3;
}

export class EntityObject extends THREE.Group {
  entityId: string;
  entityName: string;

  // Components (owned by this entity)
  private octahedron: THREE.Mesh;
  private label: THREE.Sprite;
  private reserveBar: THREE.Mesh | null = null;

  // State
  private _position: THREE.Vector3;
  private _reserves: Map<string, bigint> = new Map();

  constructor(data: EntityData, size: number = 8) {
    super();

    this.entityId = data.entityId;
    this.entityName = data.name || `Entity ${data.entityId.slice(2, 8)}`;
    this._position = data.position || new THREE.Vector3();
    this._reserves = data.reserves || new Map();

    // Create octahedron (main body)
    const geometry = new THREE.OctahedronGeometry(size);
    const material = new THREE.MeshStandardMaterial({
      color: 0x00aaff,
      emissive: 0x002244,
      metalness: 0.3,
      roughness: 0.7
    });
    this.octahedron = new THREE.Mesh(geometry, material);
    this.octahedron.castShadow = true;
    this.octahedron.receiveShadow = true;
    this.octahedron.scale.set(1, 1.6, 1); // Vertically stretched
    this.add(this.octahedron);

    // Create label (sprite ATTACHED to entity)
    this.label = this.createLabel(this.entityName, size);
    this.add(this.label); // ← KEY: label is CHILD of entity group

    // Set initial position
    this.position.copy(this._position);

    // Create reserve bar if reserves exist
    if (this._reserves.size > 0) {
      this.updateReserveBar();
    }
  }

  private createLabel(text: string, entitySize: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = 512;
    canvas.height = 128;

    context.fillStyle = '#000000';
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.font = 'bold 48px monospace';
    context.fillStyle = '#00ffff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 256, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(25, 6, 1);

    // Position RELATIVE to entity center (local coordinates)
    sprite.position.set(0, entitySize * 1.6 + 15, 0); // Above octahedron

    return sprite;
  }

  /**
   * Update entity position (moves entire group including label)
   */
  setPosition(x: number, y: number, z: number) {
    this._position.set(x, y, z);
    this.position.copy(this._position);
    // Label automatically moves because it's a child!
  }

  /**
   * Update reserves and re-render bar
   */
  setReserves(reserves: Map<string, bigint>) {
    this._reserves = reserves;
    this.updateReserveBar();
  }

  private updateReserveBar() {
    // Remove old bar
    if (this.reserveBar) {
      this.remove(this.reserveBar);
      this.reserveBar.geometry.dispose();
      (this.reserveBar.material as THREE.Material).dispose();
    }

    // Calculate total reserves (simplified - just token 1 for now)
    const reserveAmount = Number(this._reserves.get('1') || 0n) / 1e18;

    if (reserveAmount > 0) {
      const height = Math.min(reserveAmount / 5000, 100); // Scale: $5k = 1 unit
      const geometry = new THREE.CylinderGeometry(2, 2, height, 16);
      const material = new THREE.MeshStandardMaterial({
        color: 0x00ff44,
        emissive: 0x004400,
        transparent: true,
        opacity: 0.8
      });
      this.reserveBar = new THREE.Mesh(geometry, material);

      // Position RELATIVE to entity (above octahedron)
      this.reserveBar.position.set(0, 8 * 1.6 + height / 2 + 20, 0);
      this.add(this.reserveBar); // ← Child of entity group
    }
  }

  /**
   * Update label text (e.g., name change)
   */
  updateLabel(newText: string) {
    this.entityName = newText;
    // Remove old label
    this.remove(this.label);
    this.label.material.map?.dispose();
    this.label.material.dispose();

    // Create new label
    this.label = this.createLabel(newText, 8);
    this.add(this.label);
  }

  /**
   * Cleanup on removal
   */
  dispose() {
    // Dispose geometries and materials
    this.octahedron.geometry.dispose();
    (this.octahedron.material as THREE.Material).dispose();

    this.label.material.map?.dispose();
    this.label.material.dispose();

    if (this.reserveBar) {
      this.reserveBar.geometry.dispose();
      (this.reserveBar.material as THREE.Material).dispose();
    }
  }
}
