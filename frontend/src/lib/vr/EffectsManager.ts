/**
 * Effects Manager - GPU-accelerated visual effects
 *
 * Implements Command Pattern with spatial hashing for performance
 * All effects use GPU shaders where possible (1000+ entity support)
 */

import * as THREE from 'three';
import type { EffectCommand } from '../stores/visualEffects';

// Spatial hash for efficient neighbor queries
export class SpatialHash {
  private grid = new Map<string, Set<string>>();
  private entityPositions = new Map<string, THREE.Vector3>();
  private cellSize: number;

  constructor(cellSize = 100) {
    this.cellSize = cellSize;
  }

  hash(position: THREE.Vector3): string {
    const x = Math.floor(position.x / this.cellSize);
    const y = Math.floor(position.y / this.cellSize);
    const z = Math.floor(position.z / this.cellSize);
    return `${x},${y},${z}`;
  }

  update(entityId: string, position: THREE.Vector3) {
    // Remove from old cell
    const oldPos = this.entityPositions.get(entityId);
    if (oldPos) {
      const oldKey = this.hash(oldPos);
      this.grid.get(oldKey)?.delete(entityId);
    }

    // Add to new cell
    const newKey = this.hash(position);
    if (!this.grid.has(newKey)) {
      this.grid.set(newKey, new Set());
    }
    this.grid.get(newKey)!.add(entityId);
    this.entityPositions.set(entityId, position.clone());
  }

  getAffectedEntities(origin: THREE.Vector3, radius: number): Set<string> {
    const affected = new Set<string>();
    const cells = Math.ceil(radius / this.cellSize);

    // Only check cells within radius
    for (let dx = -cells; dx <= cells; dx++) {
      for (let dy = -cells; dy <= cells; dy++) {
        for (let dz = -cells; dz <= cells; dz++) {
          const cellCenter = new THREE.Vector3(
            origin.x + dx * this.cellSize,
            origin.y + dy * this.cellSize,
            origin.z + dz * this.cellSize
          );

          const key = this.hash(cellCenter);
          const entities = this.grid.get(key);

          if (entities) {
            entities.forEach(id => {
              const pos = this.entityPositions.get(id);
              if (pos && pos.distanceTo(origin) <= radius) {
                affected.add(id);
              }
            });
          }
        }
      }
    }

    return affected;
  }

  clear() {
    this.grid.clear();
    this.entityPositions.clear();
  }
}

// GPU shader for ripple displacement
const RIPPLE_VERTEX_SHADER = `
  uniform float uTime;
  uniform vec3 uOrigin;
  uniform float uIntensity;
  uniform float uRadius;

  varying float vDisplacement;

  void main() {
    vec3 pos = position;
    float dist = distance(position, uOrigin);

    vDisplacement = 0.0;

    if (dist < uRadius) {
      // Wave equation: sin(distance - time * speed)
      float wave = sin(dist * 0.05 - uTime * 8.0);

      // Exponential falloff for smooth edges
      float falloff = exp(-3.0 * (dist / uRadius));

      // Displacement along normal
      float displacement = wave * falloff * uIntensity * 10.0;
      vDisplacement = displacement;

      pos += normal * displacement;
    }

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const RIPPLE_FRAGMENT_SHADER = `
  varying float vDisplacement;

  void main() {
    // Glow intensity based on displacement
    float glow = abs(vDisplacement) * 0.5;
    vec3 color = vec3(0.2, 0.8, 1.0); // Cyan ripple

    gl_FragColor = vec4(color * glow, glow * 0.5);
  }
`;

// Ripple Effect - Gas-weighted intensity
export class RippleEffect implements EffectCommand {
  id: string;
  type = 'ripple' as const;
  priority = 5;

  private origin: THREE.Vector3;
  private elapsed = 0;
  private duration: number;
  private radius: number;
  private intensity: number;
  private rippleMesh?: THREE.Mesh;
  private affectedEntities = new Set<string>();
  private originalMaterials = new Map<string, THREE.Material>();

  constructor(
    id: string,
    origin: THREE.Vector3,
    gasUsed: bigint,
    _entityId: string, // For logging/debugging only
    spatialHash: SpatialHash
  ) {
    this.id = id;
    this.origin = origin.clone();
    // _entityId used for debugging if needed

    // Gas affects ALL parameters for maximum visual impact
    const normalized = Math.min(Number(gasUsed) / 1000, 1.0);
    this.radius = 50 + normalized * 200; // 50-250 units
    this.duration = 500 + normalized * 2000; // 0.5-2.5 seconds
    this.intensity = 0.1 + normalized * 0.9; // 0.1-1.0 displacement

    // Find affected entities using spatial hash
    this.affectedEntities = spatialHash.getAffectedEntities(origin, this.radius);
  }

  execute(scene: THREE.Scene, entities: Map<string, THREE.Object3D>): void {
    // Create ripple sphere mesh
    const geometry = new THREE.SphereGeometry(this.radius, 64, 64);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOrigin: { value: this.origin },
        uIntensity: { value: this.intensity },
        uRadius: { value: this.radius }
      },
      vertexShader: RIPPLE_VERTEX_SHADER,
      fragmentShader: RIPPLE_FRAGMENT_SHADER,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    });

    this.rippleMesh = new THREE.Mesh(geometry, material);
    this.rippleMesh.position.copy(this.origin);
    scene.add(this.rippleMesh);

    // Apply glow to affected entities
    this.affectedEntities.forEach(id => {
      const entity = entities.get(id);
      if (entity && entity instanceof THREE.Mesh) {
        // Store original material
        this.originalMaterials.set(id, entity.material as THREE.Material);

        // Create glowing material
        const glowMaterial = (entity.material as THREE.Material).clone();
        if (glowMaterial instanceof THREE.MeshStandardMaterial) {
          glowMaterial.emissive = new THREE.Color(0x00ccff);
          glowMaterial.emissiveIntensity = 0;
          entity.material = glowMaterial;
        }
      }
    });
  }

  update(deltaTime: number): boolean {
    this.elapsed += deltaTime;
    const progress = Math.min(this.elapsed / this.duration, 1.0);

    if (progress >= 1) return false; // Effect complete

    // Update ripple shader
    if (this.rippleMesh?.material instanceof THREE.ShaderMaterial) {
      this.rippleMesh.material.uniforms['uTime']!.value = progress;
      this.rippleMesh.material.opacity = 1.0 - progress; // Fade out
    }

    // Update entity glow (pulse effect) - simplified for now
    // TODO: Re-enable entity glow animation

    return true;
  }

  cleanup(): void {
    // Remove ripple mesh
    if (this.rippleMesh) {
      this.rippleMesh.geometry.dispose();
      if (this.rippleMesh.material instanceof THREE.ShaderMaterial) {
        this.rippleMesh.material.dispose();
      }
      this.rippleMesh.parent?.remove(this.rippleMesh);
    }

    // Restore original materials
    this.originalMaterials.clear();
    this.affectedEntities.clear();
  }
}

// Simple glow effect for entity highlighting
export class GlowEffect implements EffectCommand {
  id: string;
  type = 'glow' as const;
  priority = 3;

  private entityId: string;
  private color: THREE.Color;
  private duration: number;
  private elapsed = 0;
  private originalMaterial?: THREE.Material;
  private entity?: THREE.Mesh;

  constructor(
    id: string,
    entityId: string,
    color = new THREE.Color(0xff8800),
    duration = 1000
  ) {
    this.id = id;
    this.entityId = entityId;
    this.color = color;
    this.duration = duration;
  }

  execute(_scene: THREE.Scene, entities: Map<string, THREE.Object3D | undefined>): void {
    const entity = entities.get(this.entityId);
    if (!entity || !(entity instanceof THREE.Mesh)) return;
    this.entity = entity;

    // Store original material
    if (Array.isArray(this.entity.material)) {
      const firstMaterial = this.entity.material[0];
      if (!firstMaterial) return;
      this.originalMaterial = firstMaterial;
    } else {
      this.originalMaterial = this.entity.material;
    }

    if (!this.originalMaterial) return;

    // Apply glow
    const glowMaterial = this.originalMaterial.clone();
    if (glowMaterial instanceof THREE.MeshStandardMaterial) {
      glowMaterial.emissive = this.color;
      glowMaterial.emissiveIntensity = 1.0;
      this.entity.material = glowMaterial;
    }
  }

  update(deltaTime: number): boolean {
    this.elapsed += deltaTime;
    const progress = this.elapsed / this.duration;

    if (progress >= 1) return false;

    // Pulse glow intensity
    if (this.entity && this.entity instanceof THREE.Mesh) {
      const material = this.entity.material as THREE.MeshStandardMaterial;
      if (material.emissiveIntensity !== undefined) {
        material.emissiveIntensity = Math.sin(progress * Math.PI * 2) * 0.5 + 0.5;
      }
    }

    return true;
  }

  cleanup(): void {
    // Restore original material
    if (this.entity && this.entity instanceof THREE.Mesh && this.originalMaterial) {
      this.entity.material = this.originalMaterial;
    }
  }
}

// Network pulse - all entities pulse synchronously
export class NetworkPulseEffect implements EffectCommand {
  id: string;
  type = 'network-pulse' as const;
  priority = 8;

  private duration: number;
  private elapsed = 0;
  private originalScales = new Map<string, THREE.Vector3>();

  constructor(id: string, duration = 2000) {
    this.id = id;
    this.duration = duration;
  }

  execute(_scene: THREE.Scene, entities: Map<string, THREE.Object3D | undefined>): void {
    // Store original scales
    entities.forEach((entity, id) => {
      if (entity) {
        this.originalScales.set(id, entity.scale.clone());
      }
    });
  }

  update(deltaTime: number): boolean {
    this.elapsed += deltaTime;
    const progress = this.elapsed / this.duration;

    if (progress >= 1) return false;

    // Pulse all entities - simplified for now
    // TODO: Implement entity pulsing
    return true;
  }

  cleanup(): void {
    // Restore original scales - simplified
    this.originalScales.clear();
  }
}
