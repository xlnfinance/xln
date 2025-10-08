<script lang="ts">
  import type { AccountMachine, Delta } from '$lib/types/ui';
  // Functions now accessed through $xlnEnvironment.xln from server.ts
  // Entity functions now accessed through xlnFunctions from server.js
  import { createEventDispatcher } from 'svelte';
  import { xlnFunctions } from '../../stores/xlnStore';

  export let account: AccountMachine;
  export let counterpartyId: string;
  export let entityId: string;
  export let isSelected: boolean = false;

  const dispatch = createEventDispatcher();

  // Validate xlnFunctions availability - fail fast if not ready

  // Calculate total utilization across all tokens
  $: utilization = calculateUtilization();

  function calculateUtilization(): number {
    if (!account.deltas || account.deltas.size === 0) return 0;
    // XLN is always ready - no guards needed

    let totalCapacity = 0n;
    let totalUsed = 0n;

    // Determine if current entity is left in the relationship
    const isLeftEntity = entityId < counterpartyId;

    for (const [, delta] of account.deltas.entries()) {
      const derived = $xlnFunctions!.deriveDelta(delta, isLeftEntity);
      totalCapacity += derived.outCapacity + derived.inCapacity;

      // Used = credit they spent + our collateral locked
      const theirUsedCredit = delta.rightCreditLimit > 0n ?
        delta.rightCreditLimit - (derived.outCapacity - delta.collateral) : 0n;
      totalUsed += theirUsedCredit + delta.collateral;
    }

    return totalCapacity > 0n ? Number((totalUsed * 100n) / totalCapacity) : 0;
  }

  function handleClick() {
    dispatch('select', { accountId: counterpartyId });
  }

  // Get all token deltas for rendering
  $: tokenDeltas = Array.from(account.deltas?.entries() || [] as [number, Delta][]).map(([tokenId, delta]: [number, Delta]) => {
    if (!$xlnFunctions) return { tokenId, delta, derived: null, tokenInfo: null };

    const isLeftEntity = entityId < counterpartyId;
    const derived = $xlnFunctions.deriveDelta(delta, isLeftEntity);
    const tokenInfo = $xlnFunctions.getTokenInfo(tokenId);

    // Based on deriveDelta logic:
    // inOwnCredit = credit we're using from them (moves from their credit to us)
    // outPeerCredit = credit they're using from us (moves from our credit to them)
    // inCollateral/outCollateral = collateral split based on delta position

    // Left side bars (incoming capacity):
    const theirUnusedCredit = derived.inPeerCredit; // Pink - their credit we haven't used
    const ourCollateralLocked = derived.inCollateral; // Green - our collateral on this side
    const theirUsedCredit = derived.inOwnCredit; // Orange - their credit we are using

    // Right side bars (outgoing capacity):
    const ourUnusedCredit = derived.outOwnCredit; // Pink - our credit they haven't used
    const theirCollateralLocked = derived.outCollateral; // Green - their collateral usage
    const ourUsedCredit = derived.outPeerCredit; // Orange - our credit they are using

    // Total for percentage calculations
    const totalCapacity = derived.totalCapacity;

    return {
      tokenId,
      tokenInfo,
      theirUnusedCredit,
      ourCollateralLocked,
      theirUsedCredit,
      ourUnusedCredit,
      theirCollateralLocked,
      ourUsedCredit,
      totalCapacity,
      derived
    };
  });
</script>

<!-- XLN always ready - no conditional needed -->
<div
  class="account-preview"
  class:selected={isSelected}
  on:click={handleClick}
  on:keydown={(e) => e.key === 'Enter' && handleClick()}
  role="button"
  tabindex="0"
>
  <div class="account-header">
    <div class="entity-info">
      <span class="entity-name">Entity #{$xlnFunctions!.getEntityShortId(counterpartyId)}</span>
    </div>
    <div class="account-status">
      {#if account.mempool.length > 0 || (account as any).pendingFrame || (account as any).sentTransitions > 0}
        <span class="status-badge pending">
          {#if (account as any).pendingFrame}
            Awaiting Consensus
          {:else if account.mempool.length > 0}
            {account.mempool.length} pending
          {:else}
            {(account as any).sentTransitions} in flight
          {/if}
        </span>
      {:else}
        <span class="status-badge synced">Synced</span>
      {/if}
    </div>
  </div>

  <div class="utilization-indicator">
    <div class="utilization-bar">
      <div class="utilization-fill" style="width: {utilization}%"></div>
    </div>
    <span class="utilization-text">{utilization}% utilized</span>
  </div>

  <div class="delta-bars">
    {#each tokenDeltas as td (td.tokenId)}
      <div class="token-row">
        <span class="token-label" style="color: {td.tokenInfo.color}">
          {td.tokenInfo.symbol}
        </span>
        <div class="delta-bar">
          <!-- Left side: Outbound capacity (what we can send) -->
          <div class="bar-section left-side">
            {#if td.ourUnusedCredit > 0n}
              <div
                class="bar-segment unused-credit"
                style="width: {Number((td.ourUnusedCredit * 100n) / td.totalCapacity)}%"
                title="Our unused credit: {$xlnFunctions?.formatTokenAmount(td.tokenId, td.ourUnusedCredit) || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })()}"
              ></div>
            {/if}
            {#if td.theirCollateralLocked > 0n}
              <div
                class="bar-segment collateral"
                style="width: {Number((td.theirCollateralLocked * 100n) / td.totalCapacity)}%"
                title="Their collateral: {$xlnFunctions?.formatTokenAmount(td.tokenId, td.theirCollateralLocked) || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })()}"
              ></div>
            {/if}
            {#if td.ourUsedCredit > 0n}
              <div
                class="bar-segment used-credit"
                style="width: {Number((td.ourUsedCredit * 100n) / td.totalCapacity)}%"
                title="Credit they're using: {$xlnFunctions?.formatTokenAmount(td.tokenId, td.ourUsedCredit) || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })()}"
              ></div>
            {/if}
          </div>

          <!-- Visual separator -->
          <div class="bar-separator">|</div>

          <!-- Right side: Inbound capacity (what we can receive) -->
          <div class="bar-section right-side">
            {#if td.theirUnusedCredit > 0n}
              <div
                class="bar-segment unused-credit"
                style="width: {Number((td.theirUnusedCredit * 100n) / td.totalCapacity)}%"
                title="Their unused credit: {$xlnFunctions?.formatTokenAmount(td.tokenId, td.theirUnusedCredit) || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })()}"
              ></div>
            {/if}
            {#if td.ourCollateralLocked > 0n}
              <div
                class="bar-segment collateral"
                style="width: {Number((td.ourCollateralLocked * 100n) / td.totalCapacity)}%"
                title="Our collateral: {$xlnFunctions?.formatTokenAmount(td.tokenId, td.ourCollateralLocked) || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })()}"
              ></div>
            {/if}
            {#if td.theirUsedCredit > 0n}
              <div
                class="bar-segment used-credit"
                style="width: {Number((td.theirUsedCredit * 100n) / td.totalCapacity)}%"
                title="Credit we're using: {$xlnFunctions!.formatTokenAmount(td.tokenId, td.theirUsedCredit)}"
              ></div>
            {/if}
          </div>
        </div>
        <div class="capacity-labels">
          <span class="capacity-out" title="Can send">
            OUT {$xlnFunctions!.formatTokenAmount(td.tokenId, td.derived.outCapacity)}
          </span>
          <span class="capacity-in" title="Can receive">
            IN {$xlnFunctions!.formatTokenAmount(td.tokenId, td.derived.inCapacity)}
          </span>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .account-preview {
    background: #1a1a1a;
    border: 1px solid #2d2d2d;
    border-radius: 4px;
    padding: 16px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }



  .account-preview:hover {
    background: #222;
    border-color: #3e3e3e;
    transform: translateX(2px);
  }

  .account-preview.selected {
    background: #252525;
    border-color: #0084ff;
    border-left: 3px solid #0084ff;
  }

  .account-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .entity-info {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .entity-name {
    font-weight: 500;
    color: #e1e1e1;
    font-size: 0.95em;
    letter-spacing: 0.02em;
  }

  .account-status {
    display: flex;
    align-items: center;
  }

  .status-badge {
    font-size: 0.7em;
    padding: 3px 8px;
    border-radius: 2px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
  }

  .status-badge.synced {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.1);
    border: 1px solid rgba(74, 222, 128, 0.2);
  }

  .status-badge.pending {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.2);
  }

  .utilization-indicator {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 12px 0;
  }

  .utilization-bar {
    flex: 1;
    height: 3px;
    background: #0d0d0d;
    border-radius: 1px;
    overflow: hidden;
  }

  .utilization-fill {
    height: 100%;
    background: linear-gradient(90deg, #0084ff, #00d4ff);
    transition: width 0.3s ease;
  }

  .utilization-text {
    font-size: 0.7em;
    color: #999;
    min-width: 60px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .delta-bars {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .token-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .token-label {
    font-size: 0.75em;
    font-weight: 600;
    margin-bottom: 2px;
  }

  .delta-bar {
    display: flex;
    align-items: center;
    height: 20px;
    background: #0d0d0d;
    border-radius: 2px;
    overflow: hidden;
    border: 1px solid #1a1a1a;
  }

  .bar-section {
    display: flex;
    height: 100%;
  }

  .bar-section.left-side {
    flex: 1;
    justify-content: flex-end;
  }

  .bar-section.right-side {
    flex: 1;
    justify-content: flex-start;
  }

  .bar-separator {
    width: 2px;
    background: #3e3e3e;
    margin: 0 1px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #666;
    font-size: 0.8em;
  }

  .bar-segment {
    height: 100%;
    position: relative;
    transition: width 0.3s ease;
  }

  /* Unused credit - Blue */
  .bar-segment.unused-credit {
    background: #3b82f6;
  }

  /* Collateral - Green */
  .bar-segment.collateral {
    background: #10b981;
  }

  /* Used credit - Orange */
  .bar-segment.used-credit {
    background: #f59e0b;
  }

  .bar-segment:hover {
    opacity: 1;
    filter: brightness(1.2);
  }

  .capacity-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.65em;
    color: #666;
    font-family: 'SF Mono', 'Monaco', monospace;
    padding: 4px 0 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .capacity-out {
    color: #3b82f6;
  }

  .capacity-in {
    color: #10b981;
  }
</style>