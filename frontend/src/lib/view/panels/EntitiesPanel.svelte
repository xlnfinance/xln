<script lang="ts">
  /**
   * Entities Panel - Entity list with live state
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { panelBridge } from '../utils/panelBridge';
  import { shortAddress } from '$lib/utils/format';

  // Receive isolated env as prop (passed from View.svelte)
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]> | null = null;
  export let isolatedTimeIndex: Writable<number> | null = null;

  let selectedEntityId: string | null = null;

  // REMOVED HARDCODED BANK NAMES - they override prepopulate entity names!
  // Entity names now come ONLY from gossip profiles
  const BANK_NAMES: string[] = [];

  const FED_NAMES = new Map([
    ['federal_reserve', 'Federal Reserve'],
    ['ecb', 'European Central Bank'],
    ['boc', 'Bank of China'],
    ['boj', 'Bank of Japan'],
    ['boe', 'Bank of England'],
    ['snb', 'Swiss National Bank'],
    ['rbi', 'Reserve Bank of India'],
    ['cbr', 'Central Bank of Russia'],
    ['bundesbank', 'Bundesbank']
  ]);

  const FED_FLAGS = new Map([
    ['federal_reserve', ''],
    ['ecb', ''],
    ['boc', ''],
    ['boj', ''],
    ['boe', ''],
    ['snb', ''],
    ['rbi', ''],
    ['cbr', ''],
    ['bundesbank', '']
  ]);

  function getEntityName(entityId: string, signerId: string | undefined, gossipName?: string): string {
    // First priority: gossip profile name (from prepopulate demos)
    if (gossipName) return gossipName;

    if (!signerId) return shortAddress(entityId);

    // Check if Fed
    for (const [key, name] of FED_NAMES) {
      if (signerId.toLowerCase().includes(key)) {
        const flag = FED_FLAGS.get(key) || '';
        return flag ? `${flag} ${name}` : name;
      }
    }

    // Bank: hash-based consistent name
    const hash = entityId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return BANK_NAMES[hash % BANK_NAMES.length] || shortAddress(entityId);
  }

  // Listen for selections
  const unsubscribe = panelBridge.on('entity:selected', ({ entityId }) => {
    selectedEntityId = entityId;
  });

  // Time-travel aware: read from history[timeIndex] or live state
  $: entities = (() => {
    let replicas;
    let gossipProfiles;

    // Time travel mode: show historical frame
    if (isolatedTimeIndex && isolatedHistory) {
      const timeIdx = $isolatedTimeIndex;
      const hist = $isolatedHistory;
      if (timeIdx != null && timeIdx >= 0 && hist && hist.length > 0) {
        const idx = Math.min(timeIdx, hist.length - 1);
        const frame = hist[idx];
        replicas = frame?.replicas;
        gossipProfiles = frame?.gossip?.profiles;
      }
    }

    if (!replicas) {
      // Live mode: read from current env
      replicas = $isolatedEnv?.replicas;
      gossipProfiles = $isolatedEnv?.gossip?.getProfiles?.();
    }

    if (replicas) {
      // Extract entityId from replica key (format: "entityId:signerId")
      return Array.from(replicas.entries() as any).map((entry: any) => {
        const replicaKey = entry[0];
        const entityId = replicaKey.split(':')[0] || replicaKey;
        const replica = entry[1];

        // Find gossip profile for this entity
        const profile = gossipProfiles?.find((p: any) => p.entityId === entityId);

        return {
          id: entityId,
          replicaKey: replicaKey,
          signerId: replica?.signerId,
          accounts: replica?.state?.accounts,
          name: profile?.metadata?.name, // Add name from gossip
        };
      });
    }
    return [];
  })();
</script>

<div class="entities-panel">
  <div class="header">
    <h3> Entities</h3>
    <span>{entities.length} total</span>
  </div>

  <div class="entity-list">
    {#each entities as entity}
      <div
        class="entity-card"
        class:selected={entity.id === selectedEntityId}
        on:click={() => panelBridge.emit('entity:selected', { entityId: entity.id })}
      >
        <h4>{getEntityName(entity.id, entity.signerId, entity.name)}</h4>
        <p>Accounts: {entity.accounts?.size || 0}</p>
      </div>
    {/each}
  </div>
</div>

<style>
  .entities-panel {
    width: 100%;
    height: 100%;
    background: #1e1e1e;
    color: #ccc;
    display: flex;
    flex-direction: column;
  }

  .header {
    padding: 12px;
    background: #2d2d30;
    border-bottom: 2px solid #007acc;
    display: flex;
    justify-content: space-between;
  }

  .header h3 {
    margin: 0;
    font-size: 14px;
  }

  .entity-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .entity-card {
    background: #252526;
    border: 1px solid #3e3e3e;
    border-left: 3px solid #007acc;
    padding: 12px;
    margin-bottom: 8px;
    border-radius: 4px;
    cursor: pointer;
  }

  .entity-card:hover {
    background: #2d2d30;
  }

  .entity-card.selected {
    background: #094771;
    border-left-color: #1177bb;
  }

  .entity-card h4 {
    margin: 0 0 6px 0;
    font-size: 13px;
    color: #fff;
    font-family: monospace;
  }

  .entity-card p {
    margin: 0;
    font-size: 12px;
    color: #8b949e;
  }
</style>
