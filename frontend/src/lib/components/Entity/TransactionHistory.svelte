<script lang="ts">
  import type { EntityReplica, Tab } from '../../types';
  
  export let replica: EntityReplica | null;
  export let tab: Tab;
</script>

<div class="entity-history-container">
  {#if replica}
    <div class="frame-item">
      <div class="frame-header">
        <span>Server Frame 0</span>
        <span class="frame-time">{new Date().toLocaleTimeString()}</span>
        <span class="activity-badge">🟢</span>
      </div>
      <div class="frame-inactive">Transaction history will be populated here</div>
    </div>
  {:else}
    <div class="empty-state">- no frame history</div>
  {/if}
</div>

<style>
  .entity-history-container {
    height: 40vh;
    overflow-y: auto;
    padding: 0;
  }

  .frame-item {
    border-bottom: 1px solid #3e3e3e;
    padding: 12px;
    margin-bottom: 0;
  }

  .frame-item:last-child {
    border-bottom: none;
  }

  .frame-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    font-size: 0.9em;
    font-weight: 500;
    color: #007acc;
  }

  .frame-time {
    font-size: 0.8em;
    color: #9d9d9d;
  }

  .frame-inactive {
    color: #666;
    font-style: italic;
    font-size: 0.8em;
    padding: 8px 12px;
    text-align: center;
    border-left: 2px solid #555;
  }

  .activity-badge {
    font-size: 0.8em;
    margin-left: 8px;
  }

  .empty-state {
    text-align: center;
    color: #666;
    font-style: italic;
    padding: 20px;
    font-size: 0.9em;
  }
</style>
