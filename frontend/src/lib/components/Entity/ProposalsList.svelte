<script lang="ts">
  import type { EntityReplica, Tab } from '../../types';
  
  export let replica: EntityReplica | null;
  export let tab: Tab;
</script>

<div class="scrollable-component">
  {#if replica && replica.state?.proposals?.size > 0}
    {#each Array.from(replica.state.proposals.entries()) as [propId, proposal]}
      <div class="proposal-item">
        <div class="proposal-title">{proposal.action?.data?.message || 'Unknown proposal'}</div>
        <div class="proposal-meta">
          <span>By: {proposal.proposer || 'Unknown'}</span>
        </div>
      </div>
    {/each}
  {:else}
    <div class="empty-state">- no proposals</div>
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

  .proposal-item {
    background: #2d2d2d;
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 6px;
    border-left: 3px solid #7c3aed;
  }

  .proposal-title {
    font-weight: 500;
    color: #d4d4d4;
    margin-bottom: 4px;
    font-size: 0.85em;
  }

  .proposal-meta {
    font-size: 0.75em;
    color: #9d9d9d;
    display: flex;
    justify-content: space-between;
  }
</style>
