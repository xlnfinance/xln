<script lang="ts">
  import type { EntityReplica, Tab } from '../../types';

  export let replica: EntityReplica | null;
  export let tab: Tab;
</script>

<div class="scrollable-component">
  {#if replica && replica.state?.messages?.length > 0}
    {#each replica.state.messages as message, index}
      <div class="chat-message">
        <div class="chat-meta">Message #{index + 1} • {replica.signerId}</div>
        <div class="chat-content">{message}</div>
      </div>
    {/each}
  {:else}
    <div class="empty-state">- no messages</div>
  {/if}
</div>

<style>
  .scrollable-component {
    height: 25vh;
    overflow-y: auto;
    padding: 8px;
  }

  .scrollable-component::-webkit-scrollbar {
    width: 6px;
  }

  .scrollable-component::-webkit-scrollbar-track {
    background: #1e1e1e;
  }

  .scrollable-component::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 3px;
  }

  .empty-state {
    text-align: center;
    color: #666;
    font-style: italic;
    padding: 20px;
    font-size: 0.9em;
  }

  .chat-message {
    background: #2d2d2d;
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 6px;
    border-left: 3px solid #007acc;
  }

  .chat-meta {
    font-size: 0.75em;
    color: #9d9d9d;
    margin-bottom: 4px;
  }

  .chat-content {
    color: #d4d4d4;
    font-size: 0.85em;
  }
</style>
