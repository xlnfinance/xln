<script lang="ts">
  import type { EntityReplica } from '$lib/types/ui';
  
  export let replica: EntityReplica | null;
</script>

<div class="consensus-state">
  {#if replica}
    <div class="consensus-item">
      <span class="consensus-label">Status:</span>
      <span class="consensus-value consensus-status-unlocked">🔓 Unlocked</span>
    </div>
    <div class="consensus-item">
      <span class="consensus-label">Role:</span>
      <span class="consensus-value">👁️ Validator</span>
    </div>
    <div class="consensus-item">
      <span class="consensus-label">Frame Height:</span>
      <span class="consensus-value">{replica.state?.height || 0}</span>
    </div>
    <div class="consensus-item">
      <span class="consensus-label">J-Block:</span>
      <span class="consensus-value consensus-jblock">🔭 {replica.state?.lastFinalizedJHeight || 0}</span>
    </div>
    <div class="consensus-item">
      <span class="consensus-label">Messages:</span>
      <span class="consensus-value">{replica.state?.messages?.length || 0}</span>
    </div>
    <div class="consensus-item">
      <span class="consensus-label">Proposals:</span>
      <span class="consensus-value">{replica.state?.proposals?.size || 0}</span>
    </div>
  {:else}
    <div class="empty-state">- select entity to view consensus state</div>
  {/if}
</div>

<style>
  .consensus-state {
    padding: 12px;
    font-size: 0.85em;
  }

  .consensus-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px solid #3e3e3e;
  }

  .consensus-item:last-child {
    border-bottom: none;
  }

  .consensus-label {
    color: #9d9d9d;
  }

  .consensus-value {
    color: #d4d4d4;
    font-weight: 500;
  }


  .consensus-status-unlocked {
    color: #4ade80;
  }

  .consensus-jblock {
    color: #007acc;
    font-family: 'Monaco', 'Menlo', monospace;
  }

  .empty-state {
    text-align: center;
    color: #666;
    font-style: italic;
    padding: 20px;
    font-size: 0.9em;
  }
</style>
