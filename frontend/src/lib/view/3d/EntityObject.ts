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
    
    // Create octahedron (main body)
    const geometry = new THREE.OctahedronGeometry(size);
    const material = new THREE.MeshStandardMaterial({
      color: 0x00dd88, // Changed to a more vibrant green
      emissive: 0x004422,
      metalness: 0.3,
      roughness: 0.7
    });
    this.octahedron = new THREE.Mesh(geometry, material);
    this.octahedron.castShadow = true;
    this.octahedron.receiveShadow = true;
    this.add(this.octahedron);

    // Create label (sprite ATTACHED to entity)
    this.label = this.createLabel(this.entityName, size);
    this.add(this.label); // ← KEY: label is CHILD of entity group

    // Set initial position and reserves
    this.position.copy(this._position);
    this.setReserves(data.reserves || new Map());
  }

  private createLabel(text: string, entitySize: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = 512;
    canvas.height = 128;

    context.font = 'bold 48px monospace';
    context.fillStyle = '#ffffff'; // Brighter label
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 256, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.1, 0.025, 1); // Scale for world units if sizeAttenuation is false

    // Position RELATIVE to entity center (local coordinates)
    sprite.position.set(0, entitySize * 1.8 + 0.1, 0); // Position above scaled octahedron

    return sprite;
  }

  /**
   * Update entity position (moves entire group including label)
   */
  setPosition(x: number, y: number, z: number) {
    this._position.set(x, y, z);
    this.position.copy(this._position);
  }

  /**
   * Update reserves and trigger visual updates.
   */
  setReserves(reserves: Map<string, bigint>) {
    this._reserves = reserves;
    this.updateEntityScale();
    // The reserve bar has been removed in favor of scaling the main entity
    // this.updateReserveBar(); 
  }

  /**
   * NEW: Scales the entire entity based on its total reserves.
   */
  private updateEntityScale() {
    let totalReserves = 0n;
    // Sum up reserves across all token types
    for (const amount of this._reserves.values()) {
        totalReserves += amount;
    }

    // Convert from wei (1e18) to a numerical value for calculation
    const reserveValue = Number(totalReserves) / 1e18;

    // Use a logarithmic scale for better visualization across a wide range of values.
    // This formula ensures entities with 0 reserves have a base size, and large reserves don't become infinitely large.
    // The constants (e.g., 0.8, 0.3) can be tweaked for best visual effect.
    const newScale = 0.8 + Math.log1p(reserveValue / 1000) * 0.3; // log1p(x) is log(1+x)
    
    // Clamp the scale to a reasonable min/max to keep the scene tidy
    const clampedScale = Math.max(0.6, Math.min(newScale, 8.0));

    // Apply the scale to the main octahedron mesh
    this.octahedron.scale.set(clampedScale, clampedScale, clampedScale);

    // Adjust label position based on new scale
    this.label.position.set(0, 8 * clampedScale + 0.15, 0);
  }

  updateLabel(newText: string) {
    this.entityName = newText;
    this.remove(this.label);
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.label = this.createLabel(newText, 8);
    this.add(this.label);
  }

  dispose() {
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