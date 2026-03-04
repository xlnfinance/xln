<script lang="ts">
  import DeltaCapacityBar from './DeltaCapacityBar.svelte';

  type DeltaParts = {
    outOwnCredit: bigint;
    outCollateral: bigint;
    outPeerCredit: bigint;
    inOwnCredit: bigint;
    inCollateral: bigint;
    inPeerCredit: bigint;
    outTotalHold?: bigint;
    inTotalHold?: bigint;
  };

  export let symbol: string;
  export let name: string = '';
  export let outAmount: string;
  export let inAmount: string;
  export let derived: DeltaParts;
  export let decimals: number = 18;
  export let barHeight: number = 9;
  export let compact: boolean = false;
  export let barLayout: 'center' | 'sides' = 'center';
  export let pendingOutDebtMode: 'none' | 'pending' | 'settling' = 'none';

  function iconForSymbol(rawSymbol: string): { text: string; cls: string } {
    const s = String(rawSymbol || '').toUpperCase();
    if (s === 'USDC') return { text: '$', cls: 'usdc' };
    if (s === 'USDT') return { text: '$', cls: 'usdt' };
    if (s === 'WETH' || s === 'ETH') return { text: 'E', cls: 'weth' };
    return { text: s.slice(0, 1) || 'T', cls: 'other' };
  }

  $: icon = iconForSymbol(symbol);

  function normalizeAmount(raw: string): string {
    return String(raw || '').replace(/\s+/g, ' ').trim();
  }

  function stripTrailingSymbol(rawAmount: string, rawSymbol: string): string {
    const amount = normalizeAmount(rawAmount);
    const symbolText = String(rawSymbol || '').trim();
    if (!amount || !symbolText) return amount;
    const escaped = symbolText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return amount.replace(new RegExp(`\\s+${escaped}\\s*$`, 'i'), '').trim();
  }

  $: outAmountDisplay = normalizeAmount(outAmount);
  $: inAmountDisplay = normalizeAmount(inAmount);
  $: outAmountCompact = stripTrailingSymbol(outAmountDisplay, symbol);
  $: inAmountCompact = stripTrailingSymbol(inAmountDisplay, symbol);
  $: compactName = name || symbol;
</script>

<div class="delta-summary" class:compact>
  <div class="summary-head" class:compact-head={compact}>
    {#if compact}
      <div class="token-meta compact-meta">
        <span class="token-icon {icon.cls}">{icon.text}</span>
        <div class="token-text">
          <span class="token-symbol">{symbol}</span>
          <span class="token-name">{compactName}</span>
        </div>
      </div>
      <div class="compact-metric compact-out" aria-label="Outbound capacity">
        <span class="metric-label">Outbound</span>
        <span class="compact-out-value">{outAmountCompact}</span>
      </div>
      <div class="compact-metric compact-in" aria-label="Inbound capacity">
        <span class="metric-label">Inbound</span>
        <span class="compact-in-value">{inAmountCompact}</span>
      </div>
    {:else}
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
          <span class="cap-value">{outAmountDisplay}</span>
        </span>
        <span class="cap in">
          <span class="cap-label">Inbound</span>
          <span class="cap-value">{inAmountDisplay}</span>
        </span>
      </div>
    {/if}

    {#if $$slots.actions}
      <div class="actions">
        <slot name="actions" />
      </div>
    {/if}
  </div>

  <DeltaCapacityBar
    {derived}
    {decimals}
    layout={barLayout}
    {pendingOutDebtMode}
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
    min-height: 28px;
  }

  .compact-head {
    grid-template-columns: max-content max-content minmax(0, 1fr) max-content auto;
    align-items: center;
    gap: 14px;
  }

  .delta-summary.compact .token-meta.compact-meta {
    min-width: 0;
    flex: 0 0 auto;
    gap: 10px;
  }

  .delta-summary.compact .token-symbol {
    font-size: clamp(22px, 1.2vw, 25px);
    line-height: 1;
    letter-spacing: -0.025em;
  }

  .delta-summary.compact .token-name {
    font-size: 13px;
    color: #9ca3af;
    line-height: 1.05;
  }

  .delta-summary.compact .token-icon {
    width: 28px;
    height: 28px;
    font-size: 13px;
  }

  .compact-metric {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    font-family: 'JetBrains Mono', monospace;
    color: #d1d5db;
    white-space: nowrap;
  }

  .metric-label {
    font-size: 10px;
    letter-spacing: 0.07em;
    line-height: 1;
    text-transform: uppercase;
    color: #9ca3af;
    font-weight: 700;
  }

  .compact-out-value {
    font-size: clamp(18px, 1.1vw, 22px);
    line-height: 1;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: #f3f4f6;
    font-variant-numeric: tabular-nums;
  }

  .compact-in {
    align-items: flex-end;
    justify-self: end;
    text-align: right;
    padding-left: 12px;
    min-width: 120px;
    border-left: 1px solid rgba(148, 163, 184, 0.35);
  }

  .compact-in-value {
    font-size: clamp(18px, 1.1vw, 22px);
    line-height: 1;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: #e5e7eb;
    font-variant-numeric: tabular-nums;
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

    .compact-head {
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 8px 10px;
    }

    .delta-summary.compact .compact-meta {
      grid-column: 1;
    }

    .delta-summary.compact .compact-out {
      grid-column: 2;
    }

    .delta-summary.compact .compact-in {
      grid-column: 3;
      min-width: 0;
      padding-left: 10px;
    }

    .delta-summary.compact .actions {
      grid-column: 1 / -1;
      justify-self: start;
    }
  }

  @media (max-width: 760px) {
    .compact-head {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
    }

    .delta-summary.compact .compact-meta {
      grid-column: 1 / -1;
    }

    .delta-summary.compact .compact-out {
      grid-column: 1;
    }

    .delta-summary.compact .compact-in {
      grid-column: 2;
      justify-self: end;
      text-align: right;
      align-items: flex-end;
      padding-left: 8px;
      min-width: 0;
    }

    .compact-out-value,
    .compact-in-value {
      font-size: 19px;
    }
  }
</style>
