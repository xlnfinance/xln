<script lang="ts">
  import { effectOperations, activeEffectCount, pendingEffectCount } from '../../stores/visualEffects';
  import { RippleEffect, GlowEffect, NetworkPulseEffect, SpatialHash } from '../../vr/EffectsManager';
  import { replicas } from '../../stores/xlnStore';
  import * as THREE from 'three';

  // Props - injected from NetworkTopology
  export let scene: THREE.Scene | null = null;
  export let entityMeshes: Map<string, THREE.Object3D | undefined> = new Map();
  export let spatialHash: SpatialHash | null = null;

  interface DemoEffect {
    name: string;
    description: string;
    intensity: 'small' | 'medium' | 'large';
    trigger: () => void;
    icon: string;
    color: string;
  }

  // Demo effect definitions
  const demoEffects: DemoEffect[] = [
    {
      name: 'Ripple (Small)',
      description: 'Single entity pulse - 10 gas',
      intensity: 'small',
      icon: '〰️',
      color: '#00ccff',
      trigger: () => triggerRipple(10n)
    },
    {
      name: 'Ripple (Medium)',
      description: 'Settlement wave - 500 gas',
      intensity: 'medium',
      icon: '🌊',
      color: '#00aaff',
      trigger: () => triggerRipple(500n)
    },
    {
      name: 'Ripple (Large)',
      description: 'Batch processing - 1000 gas',
      intensity: 'large',
      icon: '💥',
      color: '#0088ff',
      trigger: () => triggerRipple(1000n)
    },
    {
      name: 'Entity Glow (Blue)',
      description: 'Activity highlight',
      intensity: 'small',
      icon: '✨',
      color: '#00ccff',
      trigger: () => triggerGlow(new THREE.Color(0x00ccff))
    },
    {
      name: 'Entity Glow (Orange)',
      description: 'Warning highlight',
      intensity: 'medium',
      icon: '⚠️',
      color: '#ff8800',
      trigger: () => triggerGlow(new THREE.Color(0xff8800))
    },
    {
      name: 'Entity Glow (Red)',
      description: 'Error highlight',
      intensity: 'large',
      icon: '🚨',
      color: '#ff0000',
      trigger: () => triggerGlow(new THREE.Color(0xff0000))
    },
    {
      name: 'Network Pulse',
      description: 'All entities synchronize',
      intensity: 'large',
      icon: '🌐',
      color: '#00ff88',
      trigger: () => triggerNetworkPulse()
    },
    {
      name: 'Random Multi-Ripple',
      description: '5 random ripples',
      intensity: 'large',
      icon: '🎲',
      color: '#ff00ff',
      trigger: () => triggerRandomMultiRipple()
    }
  ];

  // Helper: Get random visible entity
  function getRandomEntity(): { id: string; position: THREE.Vector3 } | null {
    if (!$replicas || $replicas.size === 0) return null;

    const replicaKeys = Array.from($replicas.keys()) as string[];
    const randomKey = replicaKeys[Math.floor(Math.random() * replicaKeys.length)];
    if (!randomKey) return null;

    const parts = randomKey.split(':');
    const entityId = parts[0];
    if (!entityId) return null;

    const mesh = entityMeshes.get(entityId);
    if (!mesh) return null;

    return {
      id: entityId,
      position: mesh.position.clone()
    };
  }

  // Trigger ripple effect
  function triggerRipple(gasUsed: bigint) {
    if (!scene || !spatialHash) {
      console.error('❌ Scene or spatialHash not ready');
      return;
    }

    const entity = getRandomEntity();
    if (!entity) {
      console.error('❌ No entities available');
      return;
    }

    console.log(`🌊 Triggering ripple: gas=${gasUsed}, entity=${entity.id}`);

    const ripple = new RippleEffect(
      `demo-ripple-${Date.now()}`,
      entity.position,
      gasUsed,
      entity.id,
      spatialHash
    );

    effectOperations.enqueue(ripple);
  }

  // Trigger glow effect
  function triggerGlow(color: THREE.Color) {
    const entity = getRandomEntity();
    if (!entity) {
      console.error('❌ No entities available');
      return;
    }

    console.log(`✨ Triggering glow: color=${color.getHexString()}, entity=${entity.id}`);

    const glow = new GlowEffect(
      `demo-glow-${Date.now()}`,
      entity.id,
      color,
      2000 // 2 second duration
    );

    effectOperations.enqueue(glow);
  }

  // Trigger network pulse
  function triggerNetworkPulse() {
    console.log('🌐 Triggering network pulse');

    const pulse = new NetworkPulseEffect(
      `demo-pulse-${Date.now()}`,
      3000 // 3 second duration
    );

    effectOperations.enqueue(pulse);
  }

  // Trigger multiple random ripples
  function triggerRandomMultiRipple() {
    if (!spatialHash) return;

    const count = 5;
    const effects: RippleEffect[] = [];

    for (let i = 0; i < count; i++) {
      const entity = getRandomEntity();
      if (!entity) continue;

      const gasUsed = BigInt(Math.floor(Math.random() * 900) + 100); // 100-1000 gas

      const ripple = new RippleEffect(
        `demo-multi-${Date.now()}-${i}`,
        entity.position,
        gasUsed,
        entity.id,
        spatialHash
      );

      effects.push(ripple);

      // Delay between ripples for cascading effect
      setTimeout(() => {
        const effectToQueue = effects[i];
        if (effectToQueue) {
          effectOperations.enqueue(effectToQueue);
        }
      }, i * 200);
    }

    console.log(`🎲 Triggered ${count} random ripples`);
  }

  // Clear all effects
  function clearAllEffects() {
    effectOperations.clear();
    console.log('🧹 Cleared all effects');
  }
</script>

<div class="visual-demo-panel">
  <div class="panel-header">
    <h3>🎨 Visual Effect Demos</h3>
    <div class="stats">
      <span class="stat">Active: {$activeEffectCount}</span>
      <span class="stat">Pending: {$pendingEffectCount}</span>
    </div>
  </div>

  <div class="effect-grid">
    {#each demoEffects as effect}
      <button
        class="effect-button"
        class:disabled={!scene || entityMeshes.size === 0}
        style="--effect-color: {effect.color}"
        on:click={effect.trigger}
        disabled={!scene || entityMeshes.size === 0}
      >
        <span class="icon">{effect.icon}</span>
        <span class="name">{effect.name}</span>
        <span class="description">{effect.description}</span>
      </button>
    {/each}
  </div>

  <div class="controls">
    <button
      class="clear-button"
      on:click={clearAllEffects}
      disabled={$activeEffectCount === 0 && $pendingEffectCount === 0}
    >
      🧹 Clear All Effects
    </button>
  </div>

  <div class="info">
    <p class="hint">
      💡 <strong>Shake Gesture:</strong> In VR, rapidly shake an entity 3 times to trigger automatic rebalancing
    </p>
    <p class="hint">
      💡 <strong>J-Events:</strong> On-chain settlements automatically trigger ripples (gas-weighted intensity)
    </p>
  </div>
</div>

<style>
  .visual-demo-panel {
    background: var(--theme-glass-bg, rgba(30, 30, 30, 0.9));
    border: 1px solid var(--theme-glass-border, rgba(255, 255, 255, 0.1));
    border-radius: 12px;
    padding: 16px;
    max-width: 400px;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--theme-border, rgba(255, 255, 255, 0.1));
  }

  .panel-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--theme-text-primary, #e8e8e8);
  }

  .stats {
    display: flex;
    gap: 12px;
    font-size: 11px;
    font-family: 'SF Mono', 'Monaco', monospace;
  }

  .stat {
    color: var(--theme-text-secondary, #9d9d9d);
  }

  .effect-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    margin-bottom: 16px;
  }

  .effect-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px 8px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid var(--effect-color);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: var(--theme-text-primary, #e8e8e8);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .effect-button:hover:not(:disabled) {
    background: var(--effect-color);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .effect-button:active:not(:disabled) {
    transform: translateY(0);
  }

  .effect-button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .effect-button .icon {
    font-size: 24px;
    line-height: 1;
  }

  .effect-button .name {
    font-size: 12px;
    font-weight: 600;
    text-align: center;
  }

  .effect-button .description {
    font-size: 10px;
    color: var(--theme-text-secondary, #9d9d9d);
    text-align: center;
  }

  .controls {
    margin-bottom: 16px;
  }

  .clear-button {
    width: 100%;
    padding: 10px;
    background: rgba(255, 68, 68, 0.2);
    border: 1px solid rgba(255, 68, 68, 0.5);
    border-radius: 8px;
    color: var(--theme-text-primary, #e8e8e8);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .clear-button:hover:not(:disabled) {
    background: rgba(255, 68, 68, 0.4);
    transform: translateY(-1px);
  }

  .clear-button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .info {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .hint {
    font-size: 11px;
    color: var(--theme-text-secondary, #9d9d9d);
    margin: 0;
    line-height: 1.4;
  }

  .hint strong {
    color: var(--theme-accent, #00d9ff);
  }
</style>
