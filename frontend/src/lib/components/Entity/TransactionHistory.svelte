<script lang="ts">
  import type { EntityReplica, Tab } from '../../types';

  export let replica: EntityReplica | null;
  export let tab: Tab;
</script>

<div class="transaction-history">
  {#if replica}
    <div class="history-list">
      {#each replica.state.messages as message, i (i)}
        <div class="history-item">
          <div class="item-icon">
            {#if message.type === 'chat'}
              <span>💬</span>
            {:else if message.type === 'proposal'}
              <span>🗳️</span>
            {:else}
              <span>⚙️</span>
            {/if}
          </div>
          <div class="item-details">
            <div class="item-header">
              <span class="item-type">{message.type}</span>
              <span class="item-timestamp">{new Date(message.timestamp).toLocaleTimeString()}</span>
            </div>
            <div class="item-content">
              {#if message.type === 'chat'}
                <p><strong>{message.data.from}:</strong> {message.data.message}</p>
              {:else if message.type === 'proposal'}
                <p>Proposal to "{message.data.action.data.message}"</p>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <p class="no-history">No history available.</p>
  {/if}
</div>

<style>
  .transaction-history {
    padding: 10px;
  }
  .no-history {
    color: #9d9d9d;
    text-align: center;
    padding: 20px;
  }
  .history-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .history-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px;
    background: #333;
    border-radius: 4px;
  }
  .item-icon {
    font-size: 1.2em;
  }
  .item-details {
    flex: 1;
  }
  .item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }
  .item-type {
    font-weight: bold;
    font-size: 0.9em;
    text-transform: capitalize;
  }
  .item-timestamp {
    font-size: 0.8em;
    color: #9d9d9d;
  }
  .item-content {
    font-size: 0.9em;
  }
</style>
