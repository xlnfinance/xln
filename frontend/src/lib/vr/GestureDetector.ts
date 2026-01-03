/**
 * Gesture Detector - VR motion pattern recognition
 *
 * Detects shake gestures for triggering rebalance operations
 * Uses rolling window with velocity tracking for smooth detection
 */

import * as THREE from 'three';

export type GestureType = 'shake-rebalance' | 'double-tap' | 'hold';

export interface GestureEvent {
  type: GestureType;
  entityId: string;
  position: THREE.Vector3;
  timestamp: number;
}

interface VelocitySample {
  position: THREE.Vector3;
  timestamp: number;
}

export class ShakeDetector {
  private velocityBuffer: VelocitySample[] = [];
  private lastShakeTime = 0;
  private shakeCount = 0;
  private entityId: string;

  // Tunable parameters
  private readonly VELOCITY_THRESHOLD = 50; // units/sec
  private readonly SHAKE_WINDOW = 2000; // ms - time window for 3 shakes
  private readonly REQUIRED_SHAKES = 3;
  private readonly BUFFER_DURATION = 500; // ms - rolling window size

  constructor(entityId: string) {
    this.entityId = entityId;
  }

  /**
   * Update detector with new position sample
   * @returns Gesture event if shake detected, null otherwise
   */
  update(position: THREE.Vector3, timestamp: number): GestureEvent | null {
    // Add to circular buffer
    this.velocityBuffer.push({
      position: position.clone(),
      timestamp
    });

    // Keep only last 500ms of data
    const cutoff = timestamp - this.BUFFER_DURATION;
    this.velocityBuffer = this.velocityBuffer.filter(s => s.timestamp > cutoff);

    if (this.velocityBuffer.length < 3) return null;

    // Calculate instantaneous velocity
    const n = this.velocityBuffer.length;
    const latest = this.velocityBuffer[n - 1]!;
    const previous = this.velocityBuffer[n - 2]!;
    const dt = (latest.timestamp - previous.timestamp) / 1000; // to seconds

    if (dt === 0) return null;

    const displacement = latest.position.clone().sub(previous.position);
    const velocity = displacement.length() / dt;

    // Detect direction reversal (key indicator of shake)
    if (velocity > this.VELOCITY_THRESHOLD && this.detectDirectionReversal()) {
      const now = timestamp;

      // Reset if too much time passed since last shake
      if (now - this.lastShakeTime > this.SHAKE_WINDOW) {
        this.shakeCount = 0;
      }

      this.shakeCount++;
      this.lastShakeTime = now;

      console.log(`🤝 Shake detected: ${this.shakeCount}/${this.REQUIRED_SHAKES} (velocity: ${velocity.toFixed(1)} u/s)`);

      // Trigger rebalance after 3 shakes
      if (this.shakeCount >= this.REQUIRED_SHAKES) {
        this.shakeCount = 0;
        console.log('✅ SHAKE GESTURE COMPLETE - Triggering rebalance!');

        return {
          type: 'shake-rebalance',
          entityId: this.entityId,
          position: latest.position.clone(),
          timestamp: now
        };
      }
    }

    return null;
  }

  /**
   * Detect if motion direction reversed (sign of shaking)
   */
  private detectDirectionReversal(): boolean {
    if (this.velocityBuffer.length < 3) return false;

    const n = this.velocityBuffer.length;

    // Get last 3 samples
    const p1 = this.velocityBuffer[n - 3]!.position;
    const p2 = this.velocityBuffer[n - 2]!.position;
    const p3 = this.velocityBuffer[n - 1]!.position;

    // Calculate velocity vectors
    const v1 = p2.clone().sub(p1);
    const v2 = p3.clone().sub(p2);

    // Dot product < 0 means direction reversed
    const dotProduct = v1.dot(v2);

    // Also check if velocities are significant enough
    const v1Mag = v1.length();
    const v2Mag = v2.length();

    return dotProduct < 0 && v1Mag > 5 && v2Mag > 5;
  }

  /**
   * Reset detector state
   */
  reset() {
    this.velocityBuffer = [];
    this.shakeCount = 0;
    this.lastShakeTime = 0;
  }

  /**
   * Get current shake progress (0-1)
   */
  getProgress(): number {
    const timeSinceLastShake = Date.now() - this.lastShakeTime;
    if (timeSinceLastShake > this.SHAKE_WINDOW) {
      return 0;
    }
    return this.shakeCount / this.REQUIRED_SHAKES;
  }
}

/**
 * Gesture Manager - Tracks gestures for multiple entities
 */
export class GestureManager {
  private detectors = new Map<string, ShakeDetector>();
  private callbacks = new Set<(event: GestureEvent) => void>();

  /**
   * Register gesture callback
   */
  on(callback: (event: GestureEvent) => void) {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback); // Return unsubscribe function
  }

  /**
   * Update entity position (detects gestures automatically)
   */
  updateEntity(entityId: string, position: THREE.Vector3, timestamp = Date.now()) {
    // Get or create detector for this entity
    if (!this.detectors.has(entityId)) {
      this.detectors.set(entityId, new ShakeDetector(entityId));
    }

    const detector = this.detectors.get(entityId)!;
    const gesture = detector.update(position, timestamp);

    if (gesture) {
      // Notify all callbacks
      this.callbacks.forEach(cb => cb(gesture));
    }
  }

  /**
   * Get shake progress for visual feedback
   */
  getShakeProgress(entityId: string): number {
    return this.detectors.get(entityId)?.getProgress() || 0;
  }

  /**
   * Reset specific entity's detector
   */
  resetEntity(entityId: string) {
    this.detectors.get(entityId)?.reset();
  }

  /**
   * Clear all detectors
   */
  clear() {
    this.detectors.clear();
    this.callbacks.clear();
  }
}
