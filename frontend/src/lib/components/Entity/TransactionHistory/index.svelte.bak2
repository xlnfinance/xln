<script lang="ts">
  import type { EntityReplica, Tab, Snapshot } from '../../../types';
  import { getServerFrames } from '../../../utils/serverFrameProcessor';
  import FrameItem from './FrameItem.svelte';

  export let replica: EntityReplica | null;
  export let tab: Tab;
  export let serverHistory: Snapshot[] = [];
  export let currentTimeIndex: number | undefined = undefined;


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

  // REMOVED: Auto-focus functionality to prevent unwanted scrolling/focus jumps
  // Users can manually scroll to see frames they're interested in
  // Auto-scrolling was causing disruptive UX during time machine navigation
</script>

<div class="scrollable-component transaction-history">
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
