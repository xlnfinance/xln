/**
 * AccountActivityVisualizer - Lightning effects showing account consensus flow
 *
 * Visualizes 3-phase network progression per server frame:
 * 1. Incoming: Lightning from account midpoints → entity (receiving messages)
 * 2. Processing: Powerful glow around entity (it's active)
 * 3. Outgoing: Lightning from entity → account midpoints (sending messages)
 */

import * as THREE from 'three';

interface AccountActivity {
  entityId: string;
  incoming: Array<{ fromEntityId: string; toEntityId: string }>;
  outgoing: Array<{ fromEntityId: string; toEntityId: string }>;
}

interface LightningEffect {
  lines: THREE.Line[];
  glow: THREE.Mesh | null;
  entityId: string;
  startTime: number;
  duration: number;
}

export class AccountActivityVisualizer {
  private scene: THREE.Scene;
  private activeEffects = new Map<string, LightningEffect>();
  private frameDuration = 100; // ms per frame

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Process server frame and create lightning effects
   */
  processFrame(
    runtimeFrame: any,
    entityMeshMap: Map<string, THREE.Object3D | undefined>
  ) {
    // Clear previous frame effects
    this.clearAll();

    // Extract account activity from server frame
    const activities = this.extractAccountActivity(runtimeFrame);

    // Create effects for each active entity
    const now = Date.now();
    activities.forEach(activity => {
      const entityObj = entityMeshMap.get(activity.entityId);
      if (!entityObj || !(entityObj instanceof THREE.Mesh)) return;
      const entityMesh = entityObj as THREE.Mesh;

      const effect: LightningEffect = {
        lines: [],
        glow: null,
        entityId: activity.entityId,
        startTime: now,
        duration: this.frameDuration
      };

      // Phase 1: Incoming lightning (account midpoint → entity)
      activity.incoming.forEach(accountInput => {
        const { fromEntityId, toEntityId } = accountInput;
        const midpoint = this.getAccountMidpoint(fromEntityId, toEntityId, entityMeshMap);
        if (midpoint) {
          const lightning = this.createLightning(midpoint, entityMesh.position, 0x00ffff, 0.6);
          effect.lines.push(...lightning);
        }
      });

      // Phase 2: Entity glow (powerful processing indicator)
      effect.glow = this.createEntityGlow(entityMesh.position, 0xffaa00, 8);

      // Phase 3: Outgoing lightning (entity → account midpoint)
      activity.outgoing.forEach(accountInput => {
        const { fromEntityId, toEntityId } = accountInput;
        const midpoint = this.getAccountMidpoint(fromEntityId, toEntityId, entityMeshMap);
        if (midpoint) {
          const lightning = this.createLightning(entityMesh.position, midpoint, 0xff6600, 0.6);
          effect.lines.push(...lightning);
        }
      });

      this.activeEffects.set(activity.entityId, effect);
    });
  }

  /**
   * Extract account activity from RuntimeFrame
   */
  private extractAccountActivity(runtimeFrame: any): AccountActivity[] {
    const activityMap = new Map<string, AccountActivity>();

    if (!runtimeFrame?.entityInputs) return [];

    for (const entityInput of runtimeFrame.entityInputs) {
      const { entityTxs } = entityInput;
      if (!entityTxs) continue;

      for (const entityTx of entityTxs) {
        if (entityTx.type === 'accountInput') {
          const accountInput = entityTx.data;
          const { fromEntityId, toEntityId } = accountInput;

          // Track incoming for recipient
          if (!activityMap.has(toEntityId)) {
            activityMap.set(toEntityId, { entityId: toEntityId, incoming: [], outgoing: [] });
          }
          activityMap.get(toEntityId)!.incoming.push(accountInput);

          // Track outgoing for sender
          if (!activityMap.has(fromEntityId)) {
            activityMap.set(fromEntityId, { entityId: fromEntityId, incoming: [], outgoing: [] });
          }
          activityMap.get(fromEntityId)!.outgoing.push(accountInput);
        }
      }
    }

    return Array.from(activityMap.values());
  }

  /**
   * Get geometric midpoint of account (connection between two entities)
   */
  private getAccountMidpoint(
    entityA: string,
    entityB: string,
    entityMeshMap: Map<string, THREE.Object3D | undefined>
  ): THREE.Vector3 | null {
    const objA = entityMeshMap.get(entityA);
    const objB = entityMeshMap.get(entityB);

    if (!objA || !objB) return null;

    return new THREE.Vector3()
      .addVectors(objA.position, objB.position)
      .multiplyScalar(0.5);
  }

  /**
   * Create jagged lightning between two points
   */
  private createLightning(
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: number,
    opacity: number
  ): THREE.Line[] {
    const lines: THREE.Line[] = [];
    const points: THREE.Vector3[] = [from.clone()];

    // Create jagged path (8 segments for chaos)
    const segments = 8;
    for (let i = 1; i < segments; i++) {
      const t = i / segments;
      const jitterScale = 0.8;
      const jitterX = (Math.random() - 0.5) * jitterScale;
      const jitterY = (Math.random() - 0.5) * jitterScale;
      const jitterZ = (Math.random() - 0.5) * jitterScale;

      const point = new THREE.Vector3(
        from.x + (to.x - from.x) * t + jitterX,
        from.y + (to.y - from.y) * t + jitterY,
        from.z + (to.z - from.z) * t + jitterZ
      );
      points.push(point);
    }
    points.push(to.clone());

    // Create line
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color,
      opacity,
      transparent: true,
      linewidth: 2
    });

    const line = new THREE.Line(geometry, material);
    this.scene.add(line);
    lines.push(line);

    return lines;
  }

  /**
   * Create powerful glow around entity
   */
  private createEntityGlow(
    position: THREE.Vector3,
    color: number,
    intensity: number
  ): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(3, 16, 16);
    const material = new THREE.MeshLambertMaterial({
      color,
      transparent: true,
      opacity: 0.4,
      emissive: color,
      emissiveIntensity: intensity
    });

    const glow = new THREE.Mesh(geometry, material);
    glow.position.copy(position);
    this.scene.add(glow);

    return glow;
  }

  /**
   * Update effects (fade out over frame duration)
   */
  update(_deltaTime: number) {
    const now = Date.now();

    this.activeEffects.forEach((effect, entityId) => {
      const elapsed = now - effect.startTime;
      const progress = Math.min(elapsed / effect.duration, 1);

      // Fade out over duration
      const opacity = 1 - progress;

      // Update lightning opacity
      effect.lines.forEach(line => {
        if (line.material instanceof THREE.Material) {
          (line.material as any).opacity = opacity * 0.6;
        }
      });

      // Update glow opacity with pulse
      if (effect.glow) {
        const pulse = Math.sin(elapsed * 0.01) * 0.2 + 0.8;
        (effect.glow.material as any).opacity = opacity * 0.4 * pulse;
      }

      // Remove when done
      if (progress >= 1) {
        this.removeEffect(entityId);
      }
    });
  }

  /**
   * Remove specific effect
   */
  private removeEffect(entityId: string) {
    const effect = this.activeEffects.get(entityId);
    if (!effect) return;

    // Dispose lightning
    effect.lines.forEach(line => {
      this.scene.remove(line);
      line.geometry.dispose();
      if (line.material instanceof THREE.Material) {
        line.material.dispose();
      }
    });

    // Dispose glow
    if (effect.glow) {
      this.scene.remove(effect.glow);
      effect.glow.geometry.dispose();
      if (effect.glow.material instanceof THREE.Material) {
        effect.glow.material.dispose();
      }
    }

    this.activeEffects.delete(entityId);
  }

  /**
   * Clear all effects
   */
  clearAll() {
    this.activeEffects.forEach((_, entityId) => {
      this.removeEffect(entityId);
    });
  }

  /**
   * Set frame duration
   */
  setFrameDuration(ms: number) {
    this.frameDuration = ms;
  }
}
