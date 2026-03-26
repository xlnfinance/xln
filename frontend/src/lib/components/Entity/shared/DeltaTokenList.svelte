<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import DeltaTokenSummary from './DeltaTokenSummary.svelte';
  import type { DeltaParts, DeltaVisualScale } from './delta-types';

  type DeltaListRow = {
    tokenId: number;
    symbol: string;
    name: string;
    outAmount: string;
    inAmount: string;
    derived: DeltaParts;
    decimals: number;
    pendingOutDebtMode?: 'none' | 'pending' | 'settling';
    visualScale?: DeltaVisualScale | null;
    actionLabel?: string;
    actionDisabled?: boolean;
  };

  export let rows: DeltaListRow[] = [];
  export let barLayout: 'center' | 'sides' = 'center';
  export let barHeight = 10;
  export let showMetricLabels = false;
  export let showHeader = true;
  export let mode: 'plain' | 'sheet' = 'plain';

  const dispatch = createEventDispatcher<{ action: { tokenId: number } }>();
</script>

<div class="delta-token-list" class:sheet={mode === 'sheet'} class:plain={mode === 'plain'}>
  {#if showHeader && rows.length > 0}
    <div class="delta-list-header">
      <span class="delta-list-header-spacer"></span>
      <span class="delta-list-header-out">Out</span>
      <span class="delta-list-header-sep"></span>
      <span class="delta-list-header-in">In</span>
    </div>
  {/if}

  {#each rows as row (row.tokenId)}
    <div class="delta-row">
      <DeltaTokenSummary
        compact={true}
        {barLayout}
        symbol={row.symbol}
        name={row.name}
        outAmount={row.outAmount}
        inAmount={row.inAmount}
        derived={row.derived}
        decimals={row.decimals}
        barHeight={barHeight}
        pendingOutDebtMode={row.pendingOutDebtMode || 'none'}
        visualScale={row.visualScale ?? null}
        {showMetricLabels}
        actionLabel={row.actionLabel || ''}
        actionTokenId={row.tokenId}
        actionDisabled={row.actionDisabled || false}
        on:action={() => dispatch('action', { tokenId: row.tokenId })}
      />
    </div>
  {/each}
</div>

<style>
  .delta-token-list {
    --delta-col-w: clamp(136px, 14vw, 192px);
    --delta-sep-w: 12px;
    display: flex;
    flex-direction: column;
  }

  .delta-token-list.plain {
    gap: 6px;
  }

  .delta-token-list.sheet {
    background: #18181b;
    border: 1px solid #292524;
    border-radius: 10px;
    overflow: hidden;
    padding: 8px 0 0;
  }

  .delta-list-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--delta-col-w) var(--delta-sep-w) var(--delta-col-w);
    align-items: center;
    gap: 12px;
    margin-bottom: 2px;
    padding: 0 12px;
  }

  .delta-list-header-out,
  .delta-list-header-in {
    color: #9ca3af;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 700;
    font-family: 'JetBrains Mono', 'IBM Plex Mono', monospace;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum' 1;
  }

  .delta-list-header-sep {
    width: 1px;
    height: 14px;
    background: linear-gradient(
      180deg,
      rgba(148, 163, 184, 0.05) 0%,
      rgba(148, 163, 184, 0.35) 50%,
      rgba(148, 163, 184, 0.05) 100%
    );
  }

  .delta-row {
    padding: 0;
  }

  .delta-token-list.sheet .delta-row {
    padding: 10px 12px;
    border-top: 1px solid rgba(63, 63, 70, 0.32);
  }

  .delta-token-list.sheet .delta-row :global(.delta-summary.compact) {
    gap: 6px;
  }

  .delta-token-list.sheet .delta-row :global(.delta-summary.compact .summary-head) {
    min-height: 30px;
    align-items: center;
  }

  @media (max-width: 900px) {
    .delta-list-header {
      display: none;
    }

    .delta-token-list.sheet {
      padding-top: 0;
    }

    .delta-token-list.sheet .delta-row {
      padding: 10px;
    }
  }

  @media (max-width: 640px) {
    .delta-token-list.plain {
      gap: 4px;
    }

    .delta-token-list.sheet .delta-row {
      padding: 8px;
    }
  }
</style>
