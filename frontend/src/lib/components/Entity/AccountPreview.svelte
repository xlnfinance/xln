<script lang="ts">
  import type { AccountMachine, Delta } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import { xlnFunctions } from '../../stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';

  export let account: AccountMachine;
  export let counterpartyId: string;
  export let entityId: string;
  export let isSelected: boolean = false;

  const dispatch = createEventDispatcher();

  // Get entity names from gossip
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;

  function getEntityName(id: string): string {
    const envData = entityEnv?.env ? (entityEnv.env as any) : null;
    if (envData?.gossip) {
      const profiles = typeof envData.gossip.getProfiles === 'function' ? envData.gossip.getProfiles() : (envData.gossip.profiles || []);
      const profile = profiles.find((p: any) => p.entityId === id);
      if (profile?.metadata?.name) return profile.metadata.name;
    }
    return '';
  }

  $: ourName = getEntityName(entityId);
  $: counterpartyName = getEntityName(counterpartyId);

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
    if (!$xlnFunctions) return {
      tokenId,
      delta,
      derived: null,
      tokenInfo: null,
      theirUnusedCredit: 0n,
      ourCollateralLocked: 0n,
      theirUsedCredit: 0n,
      ourUnusedCredit: 0n,
      theirCollateralLocked: 0n,
      ourUsedCredit: 0n,
      peerDebtToUs: 0n,
      totalCapacity: 0n
    };

    const isLeftEntity = entityId < counterpartyId;
    const derived = $xlnFunctions.deriveDelta(delta, isLeftEntity);
    const tokenInfo = $xlnFunctions.getTokenInfo(tokenId);

    // Based on deriveDelta logic:
    // inOwnCredit = credit we're using from them (moves from their credit to us)
    // outPeerCredit = credit they're using from us (moves from our credit to them)
    // inCollateral/outCollateral = collateral split based on delta position

    // HYBRID MODEL: Use deriveDelta outputs directly (no manual calculations)

    // Left side (OUT): What WE can send
    const theirUnusedCredit = derived.inPeerCredit; // Their credit we CAN use (available)
    const ourCollateralLocked = derived.inCollateral; // Our collateral
    const theirUsedCredit = derived.peerCreditUsed; // Credit we USED from peer

    // Right side (IN): What THEY can send
    const ourUnusedCredit = derived.outOwnCredit; // Our credit they CAN use
    const theirCollateralLocked = derived.outCollateral; // Their collateral
    const ourUsedCredit = derived.ownCreditUsed; // Credit they USED from us
    const peerDebtToUs = derived.peerCreditUsed; // What we owe peer

    const totalCapacity = derived.totalCapacity;

    // Visual bar sums (what's actually shown on each side)
    const leftVisualSum = theirUnusedCredit + ourCollateralLocked;  // Unused credit + our collateral
    const rightVisualSum = theirCollateralLocked + peerDebtToUs;    // Their collateral + used credit

    return {
      tokenId,
      tokenInfo,
      theirUnusedCredit,
      ourCollateralLocked,
      theirUsedCredit,
      ourUnusedCredit,
      theirCollateralLocked,
      ourUsedCredit,
      peerDebtToUs,
      totalCapacity,
      leftVisualSum,   // OUT label = sum of LEFT bars
      rightVisualSum,  // IN label = sum of RIGHT bars
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
      <span class="our-entity">{ourName || `#${$xlnFunctions!.getEntityShortId(entityId)}`}</span>
      <span class="separator">←→</span>
      <span class="counterparty-name">{counterpartyName || `#${$xlnFunctions!.getEntityShortId(counterpartyId)}`}</span>
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
          <!-- HYBRID MODEL: Unused on borrower, Used on lender -->

          <!-- Left side: OUR PERSPECTIVE (what we can use) -->
          <div class="bar-section left-side">
            {#if td.theirUnusedCredit > 0n}
              <div
                class="bar-segment unused-credit"
                style="width: {Number((td.theirUnusedCredit * 100n) / td.totalCapacity)}%"
                title="Credit FROM peer we CAN use: {$xlnFunctions?.formatTokenAmount(td.tokenId, td.theirUnusedCredit) || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })()}"
              ></div>
            {/if}
            {#if td.ourCollateralLocked > 0n}
              <div
                class="bar-segment collateral"
                style="width: {Number((td.ourCollateralLocked * 100n) / td.totalCapacity)}%"
                title="Our collateral: {$xlnFunctions?.formatTokenAmount(td.tokenId, td.ourCollateralLocked) || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })()}"
              ></div>
            {/if}
          </div>

          <!-- Visual separator -->
          <div class="bar-separator">|</div>

          <!-- Right side: THEIR PERSPECTIVE (what they deployed/we owe) -->
          <div class="bar-section right-side">
            {#if td.theirCollateralLocked > 0n}
              <div
                class="bar-segment collateral"
                style="width: {Number((td.theirCollateralLocked * 100n) / td.totalCapacity)}%"
                title="Peer collateral: {$xlnFunctions?.formatTokenAmount(td.tokenId, td.theirCollateralLocked) || (() => { throw new Error('FINTECH-SAFETY: Missing required data'); })()}"
              ></div>
            {/if}
            {#if td.peerDebtToUs > 0n}
              <div
                class="bar-segment used-credit"
                style="width: {Number((td.peerDebtToUs * 100n) / td.totalCapacity)}%"
                title="USED credit (we owe peer): {$xlnFunctions!.formatTokenAmount(td.tokenId, td.peerDebtToUs)}"
              ></div>
            {/if}
          </div>
        </div>
        <div class="capacity-labels">
          <span class="capacity-out" title="Sum of left side bars">
            OUT {$xlnFunctions!.formatTokenAmount(td.tokenId, td.leftVisualSum)}
          </span>
          <span class="capacity-in" title="Sum of right side bars">
            IN {$xlnFunctions!.formatTokenAmount(td.tokenId, td.rightVisualSum)}
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

  .our-entity {
    color: rgba(255, 255, 255, 0.5);
    font-weight: 400;
    font-size: 0.9em;
  }

  .separator {
    color: rgba(255, 255, 255, 0.3);
    font-weight: 300;
    font-size: 0.85em;
  }

  .counterparty-name {
    font-weight: 600;
    color: #4fd18b;
    font-size: 0.95em;
    text-decoration: underline;
    text-decoration-color: rgba(79, 209, 139, 0.3);
    text-underline-offset: 3px;
  }

  .our-entity {
    color: rgba(255, 255, 255, 0.5);
    font-weight: 400;
    font-size: 0.9em;
  }

  .separator {
    color: rgba(255, 255, 255, 0.3);
    font-weight: 300;
    font-size: 0.85em;
  }

  .counterparty-name {
    font-weight: 600;
    color: #4fd18b;
    font-size: 0.95em;
    text-decoration: underline;
    text-decoration-color: rgba(79, 209, 139, 0.3);
    text-underline-offset: 3px;
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

  /* Unused credit - Red (credit = potential liability) */
  .bar-segment.unused-credit {
    background: #ef4444;
    opacity: 0.7;
  }

  /* Collateral - Green (safe, backed) */
  .bar-segment.collateral {
    background: #10b981;
  }

  /* Used credit - Dark Red (actual debt) */
  .bar-segment.used-credit {
    background: #dc2626;
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

  .capacity-used {
    color: #ef4444;
    font-weight: 600;
  }

  .capacity-owed {
    color: #f59e0b;
    font-weight: 600;
  }

  .capacity-in {
    color: #10b981;
  }
</style>