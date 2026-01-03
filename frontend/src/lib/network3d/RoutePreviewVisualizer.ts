/**
 * RoutePreviewVisualizer - Shows lightning preview of selected payment route
 *
 * When user selects a route, shows animated lightning:
 * Source → Hop1 → Hop2 → ... → Destination
 */

import * as THREE from 'three';

export class RoutePreviewVisualizer {
  private scene: THREE.Scene;
  private previewLines: THREE.Line[] = [];
  private previewGlows: THREE.Mesh[] = [];
  private animationProgress = 0;
  private animating = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Show route preview with animated lightning
   */
  showRoute(route: string[], entityMeshMap: Map<string, THREE.Object3D | undefined>) {
    // Clear previous preview
    this.clear();

    if (route.length < 2) return;

    // Create lightning segments for each hop
    for (let i = 0; i < route.length - 1; i++) {
      const fromId = route[i];
      const toId = route[i + 1];

      if (!fromId || !toId) continue;

      const fromMesh = entityMeshMap.get(fromId);
      const toMesh = entityMeshMap.get(toId);

      if (!fromMesh || !toMesh) continue;

      // Create lightning between hops
      const lightning = this.createLightningSegment(
        fromMesh.position,
        toMesh.position,
        0x00ffaa // Cyan-green preview color
      );
      this.previewLines.push(...lightning);

      // Create glow at each hop
      const glow = this.createHopGlow(toMesh.position, 0x00ffaa);
      this.previewGlows.push(glow);
    }

    // Start animation
    this.animationProgress = 0;
    this.animating = true;
  }

  /**
   * Create jagged lightning segment
   */
  private createLightningSegment(
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: number
  ): THREE.Line[] {
    const lines: THREE.Line[] = [];
    const points: THREE.Vector3[] = [from.clone()];

    // Create jagged path (6 segments for preview)
    const segments = 6;
    for (let i = 1; i < segments; i++) {
      const t = i / segments;
      const jitter = 0.5; // Less jitter for preview (cleaner look)
      const jitterX = (Math.random() - 0.5) * jitter;
      const jitterY = (Math.random() - 0.5) * jitter;
      const jitterZ = (Math.random() - 0.5) * jitter;

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
      opacity: 0, // Start invisible
      transparent: true,
      linewidth: 3
    });

    const line = new THREE.Line(geometry, material);
    this.scene.add(line);
    lines.push(line);

    return lines;
  }

  /**
   * Create glow at hop location
   */
  private createHopGlow(position: THREE.Vector3, color: number): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(1.5, 16, 16);
    const material = new THREE.MeshLambertMaterial({
      color,
      transparent: true,
      opacity: 0, // Start invisible
      emissive: color,
      emissiveIntensity: 4
    });

    const glow = new THREE.Mesh(geometry, material);
    glow.position.copy(position);
    this.scene.add(glow);

    return glow;
  }

  /**
   * Update animation (call in animation loop)
   */
  update(deltaTime: number) {
    if (!this.animating) return;

    // Pulse animation (0 → 1 → 0)
    this.animationProgress += deltaTime * 0.003; // Slow pulse

    // Sine wave for smooth pulsing
    const pulse = Math.sin(this.animationProgress) * 0.5 + 0.5; // 0 to 1

    // Update lightning opacity
    this.previewLines.forEach(line => {
      if (line.material instanceof THREE.Material) {
        (line.material as any).opacity = pulse * 0.8;
      }
    });

    // Update glow opacity
    this.previewGlows.forEach(glow => {
      if (glow.material instanceof THREE.Material) {
        (glow.material as any).opacity = pulse * 0.6;
      }
    });
  }

  /**
   * Clear route preview
   */
  clear() {
    // Remove lightning
    this.previewLines.forEach(line => {
      this.scene.remove(line);
      line.geometry.dispose();
      if (line.material instanceof THREE.Material) {
        line.material.dispose();
      }
    });
    this.previewLines = [];

    // Remove glows
    this.previewGlows.forEach(glow => {
      this.scene.remove(glow);
      glow.geometry.dispose();
      if (glow.material instanceof THREE.Material) {
        glow.material.dispose();
      }
    });
    this.previewGlows = [];

    this.animating = false;
    this.animationProgress = 0;
  }
}
