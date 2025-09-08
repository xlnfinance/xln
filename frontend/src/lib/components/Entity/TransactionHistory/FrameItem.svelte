<script lang="ts">
  import type { ServerFrame } from '../../../types';
  import { formatTimestamp } from '../../../utils/serverFrameProcessor';
  import { renderBankingInput, renderBankingOutput, renderBankingImport } from '../../../utils/transactionRenderers';
  import TransactionItem from './TransactionItem.svelte';

  export let frame: ServerFrame;
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
    <span class="frame-index-title">Server Frame {frame.frameIndex}</span>
    <span class="frame-time">{formatTimestamp(frame.timestamp)}</span>
    <span class="activity-badge">{frame.hasActivity ? '🟢' : '⚪'}</span>
  </div>

  {#if frame.hasActivity}
    <div class="frame-content">
      <div class="banking-transactions">
        {#each frame.imports as imp}
          <TransactionItem transaction={renderBankingImport(imp)} />
        {/each}

        {#each frame.inputs as input}
          <TransactionItem transaction={renderBankingInput(input)} />
        {/each}

        {#each frame.outputs as output}
          <TransactionItem transaction={renderBankingOutput(output)} />
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
</style>
