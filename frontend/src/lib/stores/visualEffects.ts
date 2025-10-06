/**
 * Visual Effects Store - Centralized effect queue management
 *
 * Hybrid Store + Command Pattern for immersive 3D effects
 * - GPU shaders for performance (1000+ entities)
 * - Spatial hashing for efficient neighbor queries
 * - Clean separation between effect logic and UI
 */

import { writable, derived } from 'svelte/store';
import type * as THREE from 'three';

// Effect Command Pattern - each effect is self-contained
export interface EffectCommand {
  id: string;
  type: 'ripple' | 'lightning' | 'glow' | 'shake' | 'pulse' | 'network-pulse';
  priority: number; // 0-10, higher = processed first
  execute(scene: THREE.Scene, entities: Map<string, THREE.Object3D | undefined>): void;
  update(deltaTime: number): boolean; // returns false when complete
  cleanup(): void;
}

// Effect queue state
export interface EffectQueueState {
  active: Map<string, EffectCommand>;
  pending: EffectCommand[];
  completed: string[];
  stats: {
    totalExecuted: number;
    activeCount: number;
    droppedFrames: number;
  };
}

// Initial state
const initialState: EffectQueueState = {
  active: new Map(),
  pending: [],
  completed: [],
  stats: {
    totalExecuted: 0,
    activeCount: 0,
    droppedFrames: 0
  }
};

// Main effect queue store
export const effectQueue = writable<EffectQueueState>(initialState);

// Derived stores for convenience
export const activeEffectCount = derived(
  effectQueue,
  $queue => $queue.active.size
);

export const pendingEffectCount = derived(
  effectQueue,
  $queue => $queue.pending.length
);

// Effect queue operations
export const effectOperations = {
  // Add effect to queue
  enqueue(effect: EffectCommand) {
    effectQueue.update(queue => {
      queue.pending.push(effect);
      // Sort by priority (high to low)
      queue.pending.sort((a, b) => b.priority - a.priority);
      return queue;
    });
  },

  // Batch add multiple effects
  enqueueBatch(effects: EffectCommand[]) {
    effectQueue.update(queue => {
      queue.pending.push(...effects);
      queue.pending.sort((a, b) => b.priority - a.priority);
      return queue;
    });
  },

  // Process effect queue (called from animation loop)
  process(
    scene: THREE.Scene,
    entities: Map<string, THREE.Object3D | undefined>,
    deltaTime: number,
    maxConcurrent = 10
  ) {
    effectQueue.update(queue => {
      // Move pending to active (respect max concurrent limit)
      while (queue.pending.length > 0 && queue.active.size < maxConcurrent) {
        const effect = queue.pending.shift()!;
        try {
          effect.execute(scene, entities);
          queue.active.set(effect.id, effect);
          queue.stats.totalExecuted++;
        } catch (error) {
          console.error('❌ Effect execution failed:', effect.type, error);
          queue.stats.droppedFrames++;
        }
      }

      // Update active effects
      const toRemove: string[] = [];
      queue.active.forEach((effect, id) => {
        try {
          const shouldContinue = effect.update(deltaTime);
          if (!shouldContinue) {
            effect.cleanup();
            toRemove.push(id);
            queue.completed.push(id);
          }
        } catch (error) {
          console.error('❌ Effect update failed:', effect.type, error);
          effect.cleanup();
          toRemove.push(id);
          queue.stats.droppedFrames++;
        }
      });

      // Remove completed effects
      toRemove.forEach(id => queue.active.delete(id));
      queue.stats.activeCount = queue.active.size;

      // Clean completed list periodically (keep last 50)
      if (queue.completed.length > 100) {
        queue.completed = queue.completed.slice(-50);
      }

      return queue;
    });
  },

  // Clear all effects
  clear() {
    effectQueue.update(queue => {
      // Cleanup all active effects
      queue.active.forEach(effect => effect.cleanup());
      return initialState;
    });
  },

  // Cancel specific effect by ID
  cancel(effectId: string) {
    effectQueue.update(queue => {
      const effect = queue.active.get(effectId);
      if (effect) {
        effect.cleanup();
        queue.active.delete(effectId);
      }
      // Also remove from pending if exists
      queue.pending = queue.pending.filter(e => e.id !== effectId);
      return queue;
    });
  },

  // Cancel all effects of a specific type
  cancelType(type: EffectCommand['type']) {
    effectQueue.update(queue => {
      // Cancel active
      Array.from(queue.active.values())
        .filter(e => e.type === type)
        .forEach(e => {
          e.cleanup();
          queue.active.delete(e.id);
        });

      // Remove from pending
      queue.pending = queue.pending.filter(e => e.type !== type);
      return queue;
    });
  }
};
