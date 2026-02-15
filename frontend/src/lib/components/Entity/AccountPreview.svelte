<script lang="ts">
  import type { AccountMachine, Delta } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import { xlnFunctions } from '../../stores/xlnStore';
  import { settings } from '../../stores/settingsStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { getBarColors } from '$lib/utils/bar-colors';
  import { p2pState } from '../../stores/xlnStore';
  import EntityIdentity from '../shared/EntityIdentity.svelte';

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

  $: counterpartyName = getEntityName(counterpartyId);

  // P2P connection indicator for counterparty
  function getCounterpartyRuntimeId(id: string): string | null {
    const envData = entityEnv?.env ? (entityEnv.env as any) : null;
    if (envData?.gossip) {
      const profiles = typeof envData.gossip.getProfiles === 'function' ? envData.gossip.getProfiles() : (envData.gossip.profiles || []);
      const profile = profiles.find((p: any) => p.entityId === id);
      if (profile?.runtimeId) return profile.runtimeId;
    }
    return null;
  }

  $: counterpartyRuntimeId = getCounterpartyRuntimeId(counterpartyId);

  // Connection state: unknown (no runtimeId), disconnected, queued, connected
  $: connState = (() => {
    if (!counterpartyRuntimeId) return 'unknown';
    if (!$p2pState.connected) return 'disconnected';
    const peerQueued = $p2pState.queue.perTarget[counterpartyRuntimeId.toLowerCase()] ?? 0;
    if (peerQueued > 0) return 'queued';
    return 'connected';
  })();

  // Validate xlnFunctions availability - fail fast if not ready

  // Calculate total utilization across all tokens
  $: utilization = calculateUtilization();

  function calculateUtilization(): number {
    if (!account.deltas || account.deltas.size === 0) return 0;
    const isLeftEntity = entityId < counterpartyId;
    let totalCap = 0n;
    let freeCap = 0n;
    for (const [, delta] of account.deltas.entries()) {
      const derived = activeXlnFunctions!.deriveDelta(delta, isLeftEntity);
      totalCap += derived.totalCapacity;
      freeCap += derived.outCapacity + derived.inCapacity;
    }
    if (totalCap <= 0n) return 0;
    return Number(((totalCap - freeCap) * 100n) / totalCap);
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
        totalCapacity: 0n,
        outSettleHoldPct: 0,
        inSettleHoldPct: 0,
        outHtlcHoldPct: 0,
        inHtlcHoldPct: 0,
      };
    }

    const isLeftEntity = entityId < counterpartyId;
    const derived = activeXlnFunctions.deriveDelta(delta, isLeftEntity);
    const tokenInfo = activeXlnFunctions.getTokenInfo(tokenId);

    // Hold % relative to collateral segment, clamped to 0..100
    const clampPct = (hold: bigint, total: bigint) =>
      total > 0n ? Math.min(100, Math.max(0, Number((hold * 100n) / total))) : 0;

    const outSettleHoldPct = clampPct(derived.outSettleHold, derived.outCollateral);
    const inSettleHoldPct = clampPct(derived.inSettleHold, derived.inCollateral);
    const outHtlcHoldPct = clampPct(derived.outHtlcHold, derived.outCollateral);
    const inHtlcHoldPct = clampPct(derived.inHtlcHold, derived.inCollateral);

    return { tokenId, tokenInfo, delta, derived, outSettleHoldPct, inSettleHoldPct, outHtlcHoldPct, inHtlcHoldPct };
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
      <EntityIdentity entityId={counterpartyId} name={counterpartyName} size={28} clickable={false} compact={false} copyable={false} showAddress={true} />
    </div>
    <div class="account-status">
      <span class="conn-dot {connState}" title="{connState === 'connected' ? 'Relay connected' : connState === 'queued' ? 'Messages queued' : connState === 'disconnected' ? 'Relay disconnected' : 'Unknown peer'}"></span>
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
    {#if tokenDeltas.length === 0}
      <div class="no-deltas">No deltas yet</div>
    {/if}
    {#each tokenDeltas as td (td.tokenId)}
      {@const colors = getBarColors($settings.barColorMode, td.tokenInfo?.color || '#888888')}
      <div class="token-row" style="--bar-credit: {colors.credit}; --bar-collateral: {colors.collateral}; --bar-debt: {colors.debt}">
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
          <!-- LEFT (OUT): outOwnCredit -> outCollateral -> outPeerCredit -->
          <div class="bar-section left-side">
            {#if td.derived.outOwnCredit > 0n}
              <div
                class="bar-segment unused-credit"
                style="width: {Number((td.derived.outOwnCredit * 100n) / td.derived.totalCapacity)}%"
                title="YOUR credit line (your risk — peer can take this): {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outOwnCredit)}"
              ></div>
            {/if}
            {#if td.derived.outCollateral > 0n}
              <div
                class="bar-segment collateral"
                style="width: {Number((td.derived.outCollateral * 100n) / td.derived.totalCapacity)}%"
                title="Collateral: {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outCollateral)}{td.outSettleHoldPct > 0 ? ` (${td.outSettleHoldPct}% held for settlement)` : ''}"
              >
                {#if td.outSettleHoldPct > 0}
                  <div class="settle-hold-stripe out" style="width: {td.outSettleHoldPct}%"></div>
                {/if}
                {#if td.outHtlcHoldPct > 0}
                  <div class="htlc-hold-stripe out" style="width: {td.outHtlcHoldPct}%"></div>
                {/if}
              </div>
            {/if}
            {#if td.derived.outPeerCredit > 0n}
              <div
                class="bar-segment used-credit"
                style="width: {Number((td.derived.outPeerCredit * 100n) / td.derived.totalCapacity)}%"
                title="Peer OWES you (debt — their credit used): {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outPeerCredit)}"
              ></div>
            {/if}
          </div>

          <!-- Visual separator / zero-point marker -->
          <div class="bar-separator" class:zero-point={td.derived.collateral === 0n}
               title={td.derived.collateral === 0n ? 'No collateral — pure credit channel' : 'Delta position'}>
            {td.derived.collateral === 0n ? '0' : '|'}
          </div>

          <!-- RIGHT (IN): inOwnCredit -> inCollateral -> inPeerCredit -->
          <div class="bar-section right-side">
            {#if td.derived.inOwnCredit > 0n}
              <div
                class="bar-segment used-credit"
                style="width: {Number((td.derived.inOwnCredit * 100n) / td.derived.totalCapacity)}%"
                title="You OWE peer (debt — your credit used): {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inOwnCredit)}"
              ></div>
            {/if}
            {#if td.derived.inCollateral > 0n}
              <div
                class="bar-segment collateral"
                style="width: {Number((td.derived.inCollateral * 100n) / td.derived.totalCapacity)}%"
                title="Collateral: {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inCollateral)}{td.inSettleHoldPct > 0 ? ` (${td.inSettleHoldPct}% held for settlement)` : ''}"
              >
                {#if td.inSettleHoldPct > 0}
                  <div class="settle-hold-stripe in" style="width: {td.inSettleHoldPct}%"></div>
                {/if}
                {#if td.inHtlcHoldPct > 0}
                  <div class="htlc-hold-stripe in" style="width: {td.inHtlcHoldPct}%"></div>
                {/if}
              </div>
            {/if}
            {#if td.derived.inPeerCredit > 0n}
              <div
                class="bar-segment unused-credit"
                style="width: {Number((td.derived.inPeerCredit * 100n) / td.derived.totalCapacity)}%"
                title="PEER's credit line (their risk — you can take this): {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived.inPeerCredit)}"
              ></div>
            {/if}
          </div>
        </div>
        <div class="capacity-labels">
          <span class="capacity-out">
            OUT {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived?.outCapacity || 0n)}
          </span>
          <span class="capacity-in">
            IN {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived?.inCapacity || 0n)}
          </span>
        </div>
        <div class="capacity-breakdown">
          <div class="breakdown-side">
            {#if td.derived.outPeerCredit > 0n}
              <span class="breakdown-item debt">owed {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived.outPeerCredit)}</span>
            {/if}
            {#if td.derived.outCollateral > 0n}
              <span class="breakdown-item coll">coll {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived.outCollateral)}</span>
            {/if}
            {#if td.derived.outOwnCredit > 0n}
              <span class="breakdown-item credit">credit {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived.outOwnCredit)}</span>
            {/if}
          </div>
          <div class="breakdown-side right">
            {#if td.derived.inPeerCredit > 0n}
              <span class="breakdown-item credit">peer credit {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived.inPeerCredit)}</span>
            {/if}
            {#if td.derived.inCollateral > 0n}
              <span class="breakdown-item coll">coll {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived.inCollateral)}</span>
            {/if}
            {#if td.derived.inOwnCredit > 0n}
              <span class="breakdown-item debt">debt {activeXlnFunctions!.formatTokenAmount(td.tokenId, td.derived.inOwnCredit)}</span>
            {/if}
          </div>
        </div>
        {#if account.settlementWorkspace}
          <div class="settle-badge-row">
            <span class="settle-badge {account.settlementWorkspace.status}">
              Settlement: {account.settlementWorkspace.status.replace(/_/g, ' ')}
            </span>
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .account-preview {
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    padding: 14px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .account-preview:hover {
    background: #292524;
    border-color: #44403c;
    transform: translateX(2px);
  }

  .account-preview.selected {
    background: #292524;
    border-color: #fbbf24;
    border-left: 3px solid #fbbf24;
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

  .account-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .conn-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .conn-dot.connected {
    background: #4ade80;
    box-shadow: 0 0 4px rgba(74, 222, 128, 0.5);
  }

  .conn-dot.queued {
    background: #fbbf24;
    animation: conn-pulse 2s infinite;
  }

  .conn-dot.disconnected {
    background: #57534e;
  }

  .conn-dot.unknown {
    background: transparent;
    border: 1px solid #57534e;
  }

  @keyframes conn-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
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
    border: 1px solid rgba(74, 222, 128, 0.15);
  }

  .status-badge.pending {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.15);
  }

  .no-deltas {
    font-size: 0.8em;
    color: #666;
    font-style: italic;
    padding: 4px 0;
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
    background: #0c0a09;
    border-radius: 3px;
    overflow: hidden;
    border: 1px solid #292524;
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

  .bar-separator.zero-point {
    width: 6px;
    background: rgba(16, 185, 129, 0.3);
    color: #10b981;
    font-size: 0.6em;
    font-weight: 700;
  }

  .bar-segment {
    height: 100%;
    position: relative;
    transition: width 0.3s ease;
  }

  /* Unused credit - credit line exposure (dimmed via element opacity, not color alpha) */
  .bar-segment.unused-credit {
    background: var(--bar-credit, #eab308);
    opacity: 0.5;
  }

  /* Collateral - on-chain backed (color from barColorMode) */
  .bar-segment.collateral {
    background: var(--bar-collateral, #10b981);
  }

  /* Used credit - active debt (color from barColorMode) */
  .bar-segment.used-credit {
    background: var(--bar-debt, #ef4444);
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

  .capacity-breakdown {
    display: flex;
    justify-content: space-between;
    font-size: 0.6em;
    font-family: 'JetBrains Mono', monospace;
    padding: 0 0 2px;
  }

  .breakdown-side {
    display: flex;
    gap: 6px;
  }

  .breakdown-side.right {
    justify-content: flex-end;
  }

  .breakdown-item {
    opacity: 0.7;
  }

  .breakdown-item.debt {
    color: var(--bar-debt, #ef4444);
  }

  .breakdown-item.coll {
    color: var(--bar-collateral, #10b981);
  }

  .breakdown-item.credit {
    color: var(--bar-credit, #eab308);
  }

  /* Settlement hold stripe overlay */
  .settle-hold-stripe {
    position: absolute;
    top: 0;
    bottom: 0;
    background: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 2px,
      rgba(255, 255, 255, 0.15) 2px,
      rgba(255, 255, 255, 0.15) 4px
    );
    pointer-events: none;
  }

  .settle-hold-stripe.out {
    right: 0;
  }

  .settle-hold-stripe.in {
    left: 0;
  }

  /* HTLC hold stripe — horizontal dashes (distinct from diagonal settlement) */
  .htlc-hold-stripe {
    position: absolute;
    top: 0;
    bottom: 0;
    background: repeating-linear-gradient(
      90deg,
      transparent,
      transparent 3px,
      rgba(251, 191, 36, 0.25) 3px,
      rgba(251, 191, 36, 0.25) 5px
    );
    pointer-events: none;
  }

  .htlc-hold-stripe.out {
    right: 0;
  }

  .htlc-hold-stripe.in {
    left: 0;
  }

  /* Settlement status badge */
  .settle-badge-row {
    padding: 2px 0 0;
  }

  .settle-badge {
    font-size: 0.6em;
    padding: 2px 6px;
    border-radius: 2px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
  }

  .settle-badge.draft {
    color: #a8a29e;
    background: rgba(168, 162, 158, 0.1);
    border: 1px solid rgba(168, 162, 158, 0.15);
  }

  .settle-badge.awaiting_counterparty {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.15);
  }

  .settle-badge.ready_to_submit {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.1);
    border: 1px solid rgba(74, 222, 128, 0.15);
  }

  .settle-badge.submitted {
    color: #60a5fa;
    background: rgba(96, 165, 250, 0.1);
    border: 1px solid rgba(96, 165, 250, 0.15);
  }
</style>
