<script lang="ts">
  /**
   * Entities Panel - Entity list with live state
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { panelBridge } from '../utils/panelBridge';
  import { xlnEnvironment } from '$lib/stores/xlnStore';

  let selectedEntityId: string | null = null;

  // Listen for selections
  const unsubscribe = panelBridge.on('entity:selected', ({ entityId }) => {
    selectedEntityId = entityId;
  });

  $: entities = $xlnEnvironment?.entities || [];
</script>

<div class="entities-panel">
  <div class="header">
    <h3>🏢 Entities</h3>
    <span>{entities.length} total</span>
  </div>

  <div class="entity-list">
    {#each entities as entity}
      <div
        class="entity-card"
        class:selected={entity.id === selectedEntityId}
        on:click={() => panelBridge.emit('entity:selected', { entityId: entity.id })}
      >
        <h4>{entity.id.slice(0, 10)}...</h4>
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
