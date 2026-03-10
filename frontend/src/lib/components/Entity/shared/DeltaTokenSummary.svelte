<script lang="ts">
  import DeltaCapacityBar from './DeltaCapacityBar.svelte';
  import type { DeltaParts, DeltaVisualScale } from './delta-types';
  import { buildTokenVisualScale } from './delta-visual';

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
  export let showMetricLabels: boolean = true;
  export let visualScale: DeltaVisualScale | null = null;

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
  $: resolvedVisualScale = visualScale ?? buildTokenVisualScale(symbol, decimals, derived);
  $: outUsdHint = formatUsdHint(resolvedVisualScale?.outCapacityUsd ?? 0);
  $: inUsdHint = formatUsdHint(resolvedVisualScale?.inCapacityUsd ?? 0);

  function formatUsdHint(valueUsd: number): string {
    if (!Number.isFinite(valueUsd) || valueUsd <= 0) return '';
    if (valueUsd >= 1000) return `~$${Math.round(valueUsd).toLocaleString('en-US')}`;
    if (valueUsd >= 1) return `~$${valueUsd.toFixed(0)}`;
    return `~$${valueUsd.toFixed(2)}`;
  }
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
        {#if showMetricLabels}<span class="metric-label">Outbound</span>{/if}
        <span class="compact-out-value">
          <span>{outAmountCompact}</span>
          {#if outUsdHint}<span class="usd-hint">{outUsdHint}</span>{/if}
        </span>
      </div>
      <span class="metric-divider" aria-hidden="true"></span>
      <div class="compact-metric compact-in" aria-label="Inbound capacity">
        {#if showMetricLabels}<span class="metric-label">Inbound</span>{/if}
        <span class="compact-in-value">
          <span>{inAmountCompact}</span>
          {#if inUsdHint}<span class="usd-hint">{inUsdHint}</span>{/if}
        </span>
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
          <span class="cap-value">
            <span>{outAmountDisplay}</span>
            {#if outUsdHint}<span class="usd-hint">{outUsdHint}</span>{/if}
          </span>
        </span>
        <span class="cap in">
          <span class="cap-label">Inbound</span>
          <span class="cap-value">
            <span>{inAmountDisplay}</span>
            {#if inUsdHint}<span class="usd-hint">{inUsdHint}</span>{/if}
          </span>
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
    layout={barLayout}
    {pendingOutDebtMode}
    heightPx={barHeight}
    visualScale={resolvedVisualScale}
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
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
  }

  .usd-hint {
    color: #94a3b8;
    font-size: 0.48em;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  .actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    justify-self: end;
  }

  .delta-summary.compact .summary-head {
    min-height: 34px;
  }

  .compact-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .delta-summary.compact .token-meta.compact-meta {
    min-width: 180px;
    flex: 1 1 auto;
    gap: 9px;
  }

  .delta-summary.compact .token-symbol {
    font-size: clamp(17px, 1vw, 19px);
    line-height: 1;
    letter-spacing: -0.018em;
  }

  .delta-summary.compact .token-name {
    font-size: 11px;
    color: #9ca3af;
    line-height: 1.05;
  }

  .delta-summary.compact .token-icon {
    width: 18px;
    height: 18px;
    font-size: 10px;
  }

  .compact-metric {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    color: #d1d5db;
    white-space: nowrap;
    min-width: 0;
    font-family: 'JetBrains Mono', 'IBM Plex Mono', monospace;
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum' 1;
    text-align: right;
  }

  .compact-out {
    margin-left: auto;
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
    font-size: clamp(15px, 0.9vw, 17px);
    line-height: 1;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: #f3f4f6;
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum' 1;
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }

  .metric-divider {
    width: 1px;
    height: 22px;
    background: linear-gradient(
      180deg,
      rgba(148, 163, 184, 0.05) 0%,
      rgba(148, 163, 184, 0.34) 50%,
      rgba(148, 163, 184, 0.05) 100%
    );
    border-radius: 999px;
    flex: 0 0 1px;
  }

  .compact-in {
    flex: 0 0 auto;
  }

  .delta-summary.compact .actions {
    flex: 0 0 auto;
    margin-left: 4px;
    margin-top: 0;
    align-self: center;
    white-space: nowrap;
  }

  .compact-in-value {
    font-size: clamp(15px, 0.9vw, 17px);
    line-height: 1;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: #e5e7eb;
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum' 1;
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
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
      display: flex;
      align-items: center;
      gap: 8px;
    }
  }

  @media (max-width: 760px) {
    .compact-head {
      flex-wrap: wrap;
      align-items: flex-start;
    }

    .delta-summary.compact .compact-meta {
      min-width: 0;
      flex: 1 1 100%;
    }

    .delta-summary.compact .compact-out {
      margin-left: 0;
      min-width: 0;
      text-align: left;
      align-items: flex-start;
    }

    .delta-summary.compact .metric-divider {
      display: none;
    }

    .delta-summary.compact .compact-in {
      margin-left: auto;
      text-align: right;
      align-items: flex-end;
      min-width: 0;
    }

    .delta-summary.compact .actions {
      margin-left: auto;
      margin-top: 4px;
    }

    .compact-out-value,
    .compact-in-value {
      font-size: 19px;
    }
  }
</style>
