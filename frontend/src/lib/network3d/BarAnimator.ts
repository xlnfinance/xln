/**
 * BarAnimator - Handles smooth transitions for capacity bar heights
 *
 * Manages lerping between previous and current bar values for fluid animations
 */

import * as THREE from 'three';

interface BarState {
  currentHeight: number;
  targetHeight: number;
  mesh: THREE.Mesh;
}

export class BarAnimator {
  private bars = new Map<string, BarState>();
  private lerpSpeed = 5.0; // Higher = faster transitions

  /**
   * Register a bar for animation
   */
  registerBar(key: string, mesh: THREE.Mesh, initialHeight: number) {
    this.bars.set(key, {
      currentHeight: initialHeight,
      targetHeight: initialHeight,
      mesh
    });

    // Store initial scale
    mesh.userData['baseHeight'] = initialHeight;
    mesh.scale.y = 1.0;
  }

  /**
   * Update target height for a bar
   */
  setTargetHeight(key: string, targetHeight: number) {
    const bar = this.bars.get(key);
    if (bar) {
      bar.targetHeight = targetHeight;
    }
  }

  /**
   * Update all bar animations (call this in animation loop)
   */
  update(deltaTime: number) {
    this.bars.forEach((bar) => {
      const { currentHeight, targetHeight, mesh } = bar;

      // Lerp current towards target
      const newHeight = currentHeight + (targetHeight - currentHeight) * this.lerpSpeed * deltaTime;
      bar.currentHeight = newHeight;

      // Update mesh scale
      const baseHeight = mesh.userData['baseHeight'] as number || 1;
      if (baseHeight > 0) {
        mesh.scale.y = newHeight / baseHeight;

        // Adjust position to keep bar anchored at bottom
        // (since scaling from center, we need to move it up/down by half the difference)
        const positionOffset = (newHeight - baseHeight) / 2;
        const originalY = mesh.userData['originalY'] as number || 0;
        mesh.position.y = originalY + positionOffset;
      }
    });
  }

  /**
   * Clear all registered bars
   */
  clear() {
    this.bars.clear();
  }

  /**
   * Set lerp speed (higher = faster transitions)
   */
  setLerpSpeed(speed: number) {
    this.lerpSpeed = speed;
  }
}
