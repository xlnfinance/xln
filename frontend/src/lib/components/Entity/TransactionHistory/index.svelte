<script lang="ts">
  import { afterUpdate } from 'svelte';
  import type { EntityReplica, Tab, Snapshot } from '../../../types';
  import { getServerFrames } from '../../../utils/serverFrameProcessor';
  import FrameItem from './FrameItem.svelte';

  export let replica: EntityReplica | null;
  export let tab: Tab;
  export let serverHistory: Snapshot[] = [];
  export let currentTimeIndex: number | undefined = undefined;

  let containerElement: HTMLDivElement;

  // Debug reactive statements
  $: {
    console.log(`📊 [TransactionHistory] Props updated:`, {
      serverHistoryLength: serverHistory?.length || 0,
      replicaExists: !!replica,
      replicaDetails: replica ? { signerId: replica.signerId, entityId: replica.entityId } : null,
      currentTimeIndex,
      tabId: tab?.id,
    });
  }

  $: serverFrames = getServerFrames(serverHistory, replica);

  $: {
    console.log(`📊 [TransactionHistory] Server frames computed:`, {
      totalFrames: serverFrames.length,
      framesWithActivity: serverFrames.filter((f) => f.hasActivity).length,
      frameIndexes: serverFrames.map((f) => f.frameIndex),
    });
  }

  $: activeFrameCount = serverFrames.filter((f) => f.hasActivity).length;

  // Auto-focus current server frame when currentTimeIndex changes
  function autoFocusCurrentFrame() {
    if (typeof currentTimeIndex !== 'undefined' && currentTimeIndex >= 0 && containerElement) {
      setTimeout(() => {
        const currentFrameElement = containerElement.querySelector(`[data-frame="${currentTimeIndex}"]`);
        if (currentFrameElement) {
          currentFrameElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          console.log(`🎯 Auto-focused frame ${currentTimeIndex}`);
        }
      }, 100);
    }
  }

  // Watch for currentTimeIndex changes
  $: if (currentTimeIndex !== undefined && containerElement) {
    autoFocusCurrentFrame();
  }
</script>

<div class="scrollable-component transaction-history" bind:this={containerElement}>
  {#if serverFrames.length > 0}
    <div class="history-summary">
      Found {activeFrameCount} frames with activity out of {serverFrames.length} total
    </div>
    {#each serverFrames.slice().reverse() as frame (frame.frameIndex)}
      {@const isCurrentFrame = currentTimeIndex !== undefined && frame.frameIndex === currentTimeIndex}
      <FrameItem {frame} {isCurrentFrame} />
    {/each}
  {:else}
    <div class="empty-state">- no server history available</div>
  {/if}
</div>

<style>
  .scrollable-component {
    height: 50vh;
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

  .history-summary {
    font-size: 0.75em;
    color: #9d9d9d;
    margin-bottom: 8px;
    padding: 4px 8px;
    background: #1e1e1e;
    border-radius: 4px;
  }

  .empty-state {
    text-align: center;
    color: #666;
    font-style: italic;
    padding: 20px;
    font-size: 0.9em;
  }
</style>
