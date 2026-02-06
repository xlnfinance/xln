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

  // CRITICAL FIX: Use xlnFunctions from context (like AccountPanel.svelte:12-16)
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;

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
      const derived = activeXlnFunctions!.deriveDelta(delta, isLeftEntity);
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

  // Bilateral consensus state (for visual effects)
  $: bilateralState = (() => {
    if (!activeXlnFunctions?.classifyBilateralState || !activeXlnFunctions?.getAccountBarVisual) {
      return null;
    }

    const isLeftEntity = entityId < counterpartyId;

    // Get peer account to check their height
    const envData = entityEnv?.env ? (entityEnv.env as any) : null;
    const peerReplica = envData?.eReplicas
      ? Array.from(envData.eReplicas.values()).find((r: any) => r.entityId === counterpartyId) as any
      : null;
    const peerAccount = peerReplica?.state?.accounts?.get(entityId);
    const peerHeight = peerAccount?.currentFrame?.height ?? 0;

    const myState = activeXlnFunctions.classifyBilateralState(account, peerHeight, isLeftEntity);
    const peerState = activeXlnFunctions.classifyBilateralState(peerAccount, account.currentFrame?.height ?? 0, !isLeftEntity);

    return activeXlnFunctions.getAccountBarVisual(
      isLeftEntity ? myState : peerState,
      isLeftEntity ? peerState : myState
    );
  })();

  // Get all token deltas for rendering
  $: tokenDeltas = Array.from(account.deltas?.entries() || [] as [number, Delta][]).map(([tokenId, delta]: [number, Delta]) => {
    if (!activeXlnFunctions) {
      console.error(`❌ [AccountPreview] activeXlnFunctions NULL for account ${entityId.slice(-4)}↔${counterpartyId.slice(-4)} - SHOWING ZEROS!`);
      console.error(`   contextXlnFunctions:`, contextXlnFunctions ? 'exists' : 'NULL');
      console.error(`   $xlnFunctions:`, $xlnFunctions ? 'exists' : 'NULL');
      return {
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
    }

    const isLeftEntity = entityId < counterpartyId;
    const derived = activeXlnFunctions.deriveDelta(delta, isLeftEntity);
    const tokenInfo = activeXlnFunctions.getTokenInfo(tokenId);

    // DEBUG: Log all accounts to trace offdelta issue
    console.log(`📊 AccountPreview ${entityId.slice(-4)}↔${counterpartyId.slice(-4)} token${tokenId}:`, {
      ondelta: delta.ondelta?.toString(),
      offdelta: delta.offdelta?.toString(),
      collateral: delta.collateral?.toString(),
      totalDelta: (delta.ondelta + delta.offdelta).toString(),
      isLeftEntity,
      'derived.outCollateral': derived.outCollateral?.toString(),
      'derived.inCollateral': derived.inCollateral?.toString(),
      'derived.outCapacity': derived.outCapacity?.toString(),
      'derived.inCapacity': derived.inCapacity?.toString(),
    });

    // deriveDelta is single source of truth - use derived.* directly everywhere
    return { tokenId, tokenInfo, delta, derived };
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
      <span class="our-entity">{ourName || entityId}</span>
      <span class="separator">←→</span>
      <span class="counterparty-name">{counterpartyName || counterpartyId}</span>
    </div>
    <div class="account-status">
      {#if account.mempool.length > 0 || (account as any).pendingFrame}
        <span class="status-badge pending">
          {#if (account as any).pendingFrame}
            Awaiting Consensus
          {:else}
            {account.mempool.length} pending
          {/if}
        </span>
      {:else}
        <span class="status-badge synced">Synced</span>
      {/if}
    </div>
  </div>

  <div class="delta-bars">
    {#each tokenDeltas as td (td.tokenId)}
      <div class="token-row">
        <span class="token-label" style="color: {td.tokenInfo.color}">
          {td.tokenInfo.symbol}
        </span>
        <div class="delta-bar"
             class:glow-yellow={bilateralState?.glowColor === 'yellow'}
             class:glow-blue={bilateralState?.glowColor === 'blue'}
             class:glow-red={bilateralState?.glowColor === 'red'}
             class:glow-left={bilateralState?.glowSide === 'left'}
             class:glow-right={bilateralState?.glowSide === 'right'}
             class:glow-both={bilateralState?.glowSide === 'both'}
             style="--glow-intensity: {bilateralState?.glowIntensity ?? 0}">
          <!-- 7-REGION MODEL: OUT side | IN side -->
          <!-- LEFT (OUT): outOwnCredit → outCollateral → outPeerCredit -->
          <div class="bar-section left-side">
            {#if td.derived.outOwnCredit > 0n}
              <div
                class="bar-segment unused-credit"
                style="width: {Number((td.derived.outOwnCredit * 100n) / td.derived.totalCapacity)}%"
                title="Credit we can use: {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outOwnCredit)}"
              ></div>
            {/if}
            {#if td.derived.outCollateral > 0n}
              <div
                class="bar-segment collateral"
                style="width: {Number((td.derived.outCollateral * 100n) / td.derived.totalCapacity)}%"
                title="Our collateral: {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outCollateral)}"
              ></div>
            {/if}
            {#if td.derived.outPeerCredit > 0n}
              <div
                class="bar-segment used-credit"
                style="width: {Number((td.derived.outPeerCredit * 100n) / td.derived.totalCapacity)}%"
                title="Peer debt (using our credit): {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outPeerCredit)}"
              ></div>
            {/if}
          </div>

          <!-- Visual separator -->
          <div class="bar-separator">|</div>

          <!-- RIGHT (IN): inOwnCredit → inCollateral → inPeerCredit -->
          <div class="bar-section right-side">
            {#if td.derived.inOwnCredit > 0n}
              <div
                class="bar-segment used-credit"
                style="width: {Number((td.derived.inOwnCredit * 100n) / td.derived.totalCapacity)}%"
                title="Our debt (using our credit): {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inOwnCredit)}"
              ></div>
            {/if}
            {#if td.derived.inCollateral > 0n}
              <div
                class="bar-segment collateral"
                style="width: {Number((td.derived.inCollateral * 100n) / td.derived.totalCapacity)}%"
                title="Peer collateral: {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inCollateral)}"
              ></div>
            {/if}
            {#if td.derived.inPeerCredit > 0n}
              <div
                class="bar-segment unused-credit"
                style="width: {Number((td.derived.inPeerCredit * 100n) / td.derived.totalCapacity)}%"
                title="Credit peer can use: {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived.inPeerCredit)}"
              ></div>
            {/if}
          </div>
        </div>
        <div class="capacity-labels">
          <span class="capacity-out" title="Available to send (outCapacity)">
            OUT {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived?.outCapacity || 0n)}
          </span>
          <span class="capacity-in" title="Available to receive (inCapacity)">
            IN {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived?.inCapacity || 0n)}
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
    position: relative;
  }

  /* Bilateral consensus state glows - subtle from entity side */
  .delta-bar.glow-left.glow-yellow::before,
  .delta-bar.glow-right.glow-yellow::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 30%;
    pointer-events: none;
    background: linear-gradient(to right, rgba(255, 255, 0, calc(var(--glow-intensity, 0.3) * 0.4)), transparent);
    animation: pulse 2s ease-in-out infinite;
  }

  .delta-bar.glow-right.glow-yellow::after {
    right: 0;
    background: linear-gradient(to left, rgba(255, 255, 0, calc(var(--glow-intensity, 0.3) * 0.4)), transparent);
  }

  .delta-bar.glow-left.glow-yellow::before {
    left: 0;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
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
