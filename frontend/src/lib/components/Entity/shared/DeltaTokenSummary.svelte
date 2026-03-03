<script lang="ts">
  import DeltaCapacityBar from './DeltaCapacityBar.svelte';

  type DeltaParts = {
    outOwnCredit: bigint;
    outCollateral: bigint;
    outPeerCredit: bigint;
    inOwnCredit: bigint;
    inCollateral: bigint;
    inPeerCredit: bigint;
  };

  export let symbol: string;
  export let name: string = '';
  export let outAmount: string;
  export let inAmount: string;
  export let derived: DeltaParts;
  export let decimals: number = 18;
  export let barHeight: number = 9;
  export let compact: boolean = false;

  function iconForSymbol(rawSymbol: string): { text: string; cls: string } {
    const s = String(rawSymbol || '').toUpperCase();
    if (s === 'USDC') return { text: '$', cls: 'usdc' };
    if (s === 'USDT') return { text: '$', cls: 'usdt' };
    if (s === 'WETH' || s === 'ETH') return { text: 'E', cls: 'weth' };
    return { text: s.slice(0, 1) || 'T', cls: 'other' };
  }

  $: icon = iconForSymbol(symbol);
</script>

<div class="delta-summary" class:compact>
  <div class="summary-head">
    <div class="token-meta">
      <span class="token-icon {icon.cls}">{icon.text}</span>
      <div class="token-text">
        <span class="token-symbol">{symbol}</span>
        {#if name}
          <span class="token-name">{name}</span>
        {/if}
      </div>
    </div>

    <div class="caps">
      <span class="cap out">
        <span class="cap-label">Outbound</span>
        <span class="cap-value">{outAmount}</span>
      </span>
      <span class="cap in">
        <span class="cap-label">Inbound</span>
        <span class="cap-value">{inAmount}</span>
      </span>
    </div>

    {#if $$slots.actions}
      <div class="actions">
        <slot name="actions" />
      </div>
    {/if}
  </div>

  <DeltaCapacityBar
    {derived}
    {decimals}
    heightPx={barHeight}
  />
</div>

<style>
  .delta-summary {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .summary-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 10px;
    min-height: 28px;
  }

  .token-meta {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .token-icon {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    flex: 0 0 auto;
  }

  .token-icon.usdc {
    background: #2563eb;
    color: #e6f0ff;
  }

  .token-icon.usdt {
    background: #0f9f6e;
    color: #eafff6;
  }

  .token-icon.weth {
    background: #6d28d9;
    color: #f2e8ff;
  }

  .token-icon.other {
    background: #4b5563;
    color: #f3f4f6;
  }

  .token-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .token-symbol {
    color: #f3f4f6;
    font-size: 26px;
    line-height: 1;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .token-name {
    color: #9ca3af;
    font-size: 12px;
    line-height: 1.1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .caps {
    display: inline-flex;
    align-items: stretch;
    gap: 14px;
    font-family: 'JetBrains Mono', monospace;
    white-space: nowrap;
  }

  .cap {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    min-width: 0;
  }

  .cap.out {
    color: #f3f4f6;
    align-items: flex-start;
  }

  .cap.in {
    color: #d1d5db;
    align-items: flex-end;
  }

  .cap-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9ca3af;
    font-weight: 700;
    line-height: 1;
  }

  .cap-value {
    font-size: 30px;
    line-height: 1;
    font-weight: 700;
    letter-spacing: -0.045em;
  }

  .actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    justify-self: end;
  }

  .delta-summary.compact .summary-head {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .delta-summary.compact .token-symbol {
    font-size: 20px;
  }

  .delta-summary.compact .token-name {
    font-size: 11px;
  }

  .delta-summary.compact .token-icon {
    width: 18px;
    height: 18px;
    font-size: 10px;
  }

  .delta-summary.compact .caps {
    gap: 10px;
  }

  .delta-summary.compact .cap-label {
    font-size: 9px;
  }

  .delta-summary.compact .cap-value {
    font-size: 22px;
  }

  @media (max-width: 1100px) {
    .summary-head {
      grid-template-columns: 1fr;
      align-items: start;
      gap: 8px;
    }

    .actions {
      justify-self: start;
    }
  }
</style>
