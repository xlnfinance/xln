<script lang="ts">
  import type { RuntimeFrame } from '$lib/types/ui';
  import { formatTimestamp } from '../../../utils/runtimeFrameProcessor';
  // Simplified without complex rendering - no more TransactionItem needed

  export let frame: RuntimeFrame;
  export let isCurrentFrame: boolean = false;
</script>

<div
  class="frame-item"
  class:current-frame={isCurrentFrame}
  class:has-activity={frame.hasActivity}
  class:no-activity={!frame.hasActivity}
  data-frame={frame.frameIndex}
>
  <div class="frame-header">
    <span class="frame-index-title">Runtime Frame {frame.frameIndex}</span>
    <span class="frame-time">{formatTimestamp(frame.timestamp)}</span>
    <span class="activity-badge">{frame.hasActivity ? '🟢' : '⚪'}</span>
  </div>

  {#if frame.hasActivity}
    <div class="frame-content">
      <div class="banking-transactions">
        {#each frame.imports as imp}
          <div class="simple-transaction">
            <span class="tx-type">Import</span>
            <span class="tx-details">
              {#if imp.type === 'importReplica'}
                Entity {imp.entityId}
              {:else}
                {imp.type}
              {/if}
            </span>
          </div>
        {/each}

        {#each frame.inputs as input}
          <div class="simple-transaction">
            <span class="tx-type">Input</span>
            <span class="tx-details">{input.entityTxs?.length || 0} transactions</span>
          </div>
        {/each}

        {#each frame.outputs as output}
          <div class="simple-transaction">
            <span class="tx-type">Output</span>
            <span class="tx-details">{output.entityTxs?.length || 0} transactions</span>
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <div class="frame-inactive">No activity from this replica in this frame</div>
  {/if}
</div>

<style>
  .frame-item {
    background: #2d2d2d;
    border-radius: 4px;
    margin-bottom: 8px;
    border-left: 3px solid #404040;
  }

  .frame-item.current-frame {
    border-left-color: #fbbf24;
    box-shadow: 0 0 0 1px #fbbf24;
  }

  .frame-item.has-activity {
    border-left-color: #10b981;
  }

  .frame-item.no-activity {
    opacity: 0.6;
  }

  .frame-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid #404040;
    font-size: 0.8em;
    color: #d4d4d4;
    font-weight: 500;
  }

  .frame-time {
    color: #9d9d9d;
    font-size: 0.9em;
  }

  .activity-badge {
    font-size: 0.8em;
  }

  .frame-content {
    padding: 8px;
  }

  .frame-inactive {
    padding: 12px;
    color: #666;
    font-style: italic;
    font-size: 0.8em;
    text-align: center;
  }

  .banking-transactions {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .simple-transaction {
    display: flex;
    justify-content: space-between;
    padding: 6px 8px;
    background: #3a3a3a;
    border-radius: 3px;
    font-size: 0.8em;
  }

  .tx-type {
    color: #10b981;
    font-weight: 500;
  }

  .tx-details {
    color: #d4d4d4;
  }
</style>
