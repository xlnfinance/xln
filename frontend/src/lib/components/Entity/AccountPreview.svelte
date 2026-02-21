<script lang="ts">
  import type { AccountMachine } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import { xlnFunctions } from '../../stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { settings } from '../../stores/settingsStore';
  import { p2pState } from '../../stores/xlnStore';
  import EntityIdentity from '../shared/EntityIdentity.svelte';

  export let account: AccountMachine;
  export let counterpartyId: string;
  export let entityId: string;
  export let isSelected: boolean = false;
  export let lockSummary: {
    incomingCount: number;
    incomingAmount: bigint;
    outgoingCount: number;
    outgoingAmount: bigint;
  } = {
    incomingCount: 0,
    incomingAmount: 0n,
    outgoingCount: 0,
    outgoingAmount: 0n,
  };

  const dispatch = createEventDispatcher();

  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;

  // Gossip helpers
  function getGossipProfiles(): any[] {
    const envData = entityEnv?.env ? (entityEnv.env as any) : null;
    if (!envData?.gossip) return [];
    return typeof envData.gossip.getProfiles === 'function'
      ? envData.gossip.getProfiles()
      : (envData.gossip.profiles || []);
  }

  function getProfile(id: string): any {
    return getGossipProfiles().find((p: any) =>
      String(p?.entityId || '').toLowerCase() === String(id).toLowerCase()
    );
  }

  $: counterpartyName = getProfile(counterpartyId)?.metadata?.name || '';

  $: isHub = (() => {
    const profile = getProfile(counterpartyId);
    if (!profile) return false;
    return !!(profile.metadata?.isHub === true ||
      (Array.isArray(profile.capabilities) && profile.capabilities.includes('hub')));
  })();

  // P2P connection state
  $: connState = (() => {
    const profile = getProfile(counterpartyId);
    const runtimeId = profile?.runtimeId;
    if (!runtimeId) return 'unknown';
    if (!$p2pState.connected) return 'disconnected';
    const peerQueued = $p2pState.queue.perTarget[runtimeId.toLowerCase()] ?? 0;
    return peerQueued > 0 ? 'queued' : 'connected';
  })();

  // Aggregate across all deltas
  $: agg = (() => {
    if (!account.deltas || account.deltas.size === 0 || !activeXlnFunctions) {
      return { outCap: 0n, inCap: 0n, outCredit: 0n, outColl: 0n, outDebt: 0n,
               inCredit: 0n, inColl: 0n, inDebt: 0n, outTotal: 0n, inTotal: 0n,
               tokenCount: 0, primaryTokenId: 1, primarySymbol: '?',
               uncollateralized: 0n, totalCollateral: 0n, totalDebt: 0n };
    }

    const isLeft = entityId < counterpartyId;
    let outCap = 0n, inCap = 0n;
    let outCredit = 0n, outColl = 0n, outDebt = 0n;
    let inCredit = 0n, inColl = 0n, inDebt = 0n;
    let primaryTokenId = 1;
    let primarySymbol = '?';

    for (const [tokenId, delta] of account.deltas.entries()) {
      const d = activeXlnFunctions.deriveDelta(delta, isLeft);
      outCap += d.outCapacity;
      inCap += d.inCapacity;
      outCredit += d.outOwnCredit;
      outColl += d.outCollateral;
      outDebt += d.outPeerCredit;
      inDebt += d.inOwnCredit;
      inColl += d.inCollateral;
      inCredit += d.inPeerCredit;
      const info = activeXlnFunctions.getTokenInfo(tokenId);
      if (info?.symbol) { primaryTokenId = tokenId; primarySymbol = info.symbol; }
    }

    const outTotal = outCredit + outColl + outDebt;
    const inTotal = inDebt + inColl + inCredit;

    // Compute rebalance risk strictly from derived perspective fields.
    // Do not recalculate from raw ondelta/offdelta here.
    let totalDebt = 0n;
    let totalCollateral = 0n;
    for (const [, delta] of account.deltas.entries()) {
      const d = activeXlnFunctions.deriveDelta(delta, isLeft);
      totalDebt += d.outPeerCredit;
      totalCollateral += d.outCollateral;
    }
    const uncollateralized = totalDebt > totalCollateral ? totalDebt - totalCollateral : 0n;

    return { outCap, inCap, outCredit, outColl, outDebt,
             inCredit, inColl, inDebt, outTotal, inTotal,
             tokenCount: account.deltas.size, primaryTokenId, primarySymbol,
             uncollateralized, totalCollateral, totalDebt };
  })();

  $: halfMax = agg.outTotal > agg.inTotal ? agg.outTotal : agg.inTotal;
  $: pctOf = (v: bigint, base: bigint) => base > 0n ? Number((v * 10000n) / base) / 100 : 0;
  $: tokenSymbol = String(agg.primarySymbol || '').toUpperCase();
  $: tokenIconText = tokenSymbol === 'USDC' || tokenSymbol === 'USDT' ? '$' : tokenSymbol === 'WETH' || tokenSymbol === 'ETH' ? 'E' : (tokenSymbol.slice(0, 1) || 'T');
  $: tokenIconClass = tokenSymbol === 'USDC'
    ? 'usdc'
    : tokenSymbol === 'USDT'
      ? 'usdt'
      : tokenSymbol === 'WETH' || tokenSymbol === 'ETH'
        ? 'weth'
        : 'other';

  // Normalize BigInt to safe Number for CSS flex values (avoids MAX_SAFE_INTEGER overflow)
  $: toFlex = (v: bigint) => {
    const n = Number(v / (10n ** 14n));
    return n > 0 ? n : (v > 0n ? 1 : 0);
  };

  // Absolute bar width: proportional to totalCapacity relative to portfolioScale
  $: barWidthPct = (() => {
    const scale = BigInt($settings.portfolioScale || 5000) * (10n ** 18n);
    const total = agg.outTotal + agg.inTotal;
    if (scale === 0n || total === 0n) return 100;
    return Math.min(100, Math.max(5, Number(total * 100n / scale)));
  })();

  $: isPending = account.mempool.length > 0 || (account as any).pendingFrame;
  $: canFaucet =
    !isPending &&
    Number(account.currentHeight || 0) > 0 &&
    agg.inTotal > 0n &&
    String((account as any).status || 'active') !== 'disputed';

  // Pending prepaid requests (actual request_collateral state)
  $: pendingRequested = (() => {
    const map = (account as any).requestedRebalance;
    if (!map || typeof map.values !== 'function') return 0n;
    let total = 0n;
    for (const amount of map.values()) {
      try {
        const n = typeof amount === 'bigint' ? amount : BigInt(amount);
        if (n > 0n) total += n;
      } catch {
        // ignore malformed value
      }
    }
    return total;
  })();

  $: pendingC2R = (() => {
    const ws = (account as any).settlementWorkspace;
    if (!ws || !Array.isArray(ws.ops)) return { active: false, submitted: false, amount: 0n };
    let amount = 0n;
    let hasC2R = false;
    for (const op of ws.ops) {
      if (op?.type !== 'c2r') continue;
      hasC2R = true;
      try {
        const n = typeof op.amount === 'bigint' ? op.amount : BigInt(op.amount ?? 0);
        if (n > 0n) amount += n;
      } catch {
        // ignore malformed op
      }
    }
    if (!hasC2R) return { active: false, submitted: false, amount: 0n };
    const submitted = ws.status === 'submitted';
    return { active: true, submitted, amount };
  })();

  $: workspace = (account as any).settlementWorkspace;
  $: iAmLeft = entityId < counterpartyId;
  $: iAmProposer = workspace ? workspace.lastModifiedByLeft === iAmLeft : false;
  $: myHanko = workspace ? (iAmLeft ? workspace.leftHanko : workspace.rightHanko) : null;
  $: canQuickApproveSettle = !!(workspace && workspace.status === 'awaiting_counterparty' && !iAmProposer && !myHanko);
  $: settleStatusLabel = (() => {
    if (!workspace) return '';
    const status = String(workspace.status || '');
    if (status === 'awaiting_counterparty') {
      if (canQuickApproveSettle) return 'Awaiting your signature';
      if (iAmProposer) return 'Awaiting counterparty signature';
      return 'Awaiting signature';
    }
    if (status === 'ready_to_submit') return 'Ready to submit';
    if (status === 'submitted') return 'Submitted on-chain';
    if (status === 'draft') return 'Draft';
    return status.replace(/_/g, ' ');
  })();

  // Rebalance state: show pending only when there is an actual prepaid request.
  $: rebalanceState = (() => {
    const hasPendingBatch = !!(account as any).jBatchState?.sentBatch;
    const hasPendingRequest = pendingRequested > 0n;

    if (hasPendingRequest) {
      if (hasPendingBatch) return 'settling'; // On-chain tx in flight
      return 'pending'; // request_collateral exists and fee was prepaid
    }
    if (pendingC2R.active) {
      if (pendingC2R.submitted || hasPendingBatch) return 'settling'; // C→R on-chain tx in flight
      return 'pending'; // awaiting/ready settlement signature path
    }
    if (agg.totalCollateral > 0n && agg.uncollateralized === 0n) {
      return 'secured'; // All green — fully collateralized
    }
    if (agg.totalCollateral > 0n && agg.uncollateralized > 0n) {
      return 'partial'; // Some collateral, but not fully covered
    }
    return 'none'; // Below soft limit, no rebalance needed
  })();

  function handleClick() {
    dispatch('select', { accountId: counterpartyId });
  }

  function handleFaucet(e: MouseEvent) {
    e.stopPropagation();
    if (!canFaucet) return;
    dispatch('faucet', { counterpartyId, tokenId: agg.primaryTokenId });
  }

  function handleSettleApprove(e: MouseEvent) {
    e.stopPropagation();
    dispatch('settleApprove', { counterpartyId });
  }
</script>

<div
  class="account-preview"
  class:selected={isSelected}
  on:click={handleClick}
  on:keydown={(e) => e.key === 'Enter' && handleClick()}
  role="button"
  tabindex="0"
>
  <!-- Row 1: Entity + status -->
  <div class="row-header">
    <div class="entity-col">
      <EntityIdentity entityId={counterpartyId} name={counterpartyName} size={22} clickable={false} compact={false} copyable={false} showAddress={true} />
    </div>
    <div class="status-col">
      <span class="conn-dot {connState}"></span>
      <span class="badge" class:synced={!isPending} class:pending={isPending}>
        {isPending ? 'Pending' : 'Synced'}
      </span>
      <span class="j-sync" title="Last finalized bilateral J-event height">
        J#{account.lastFinalizedJHeight ?? 0}
      </span>
      <button
        class="btn-faucet"
        on:click={handleFaucet}
        disabled={!canFaucet}
        title={canFaucet ? 'Request offchain faucet payment' : 'Account not ready for faucet yet'}
      >
        Faucet
      </button>
    </div>
  </div>

  {#if lockSummary.incomingCount > 0 || lockSummary.outgoingCount > 0}
    <div class="locks-row">
      <div class="lock-badge incoming" class:empty={lockSummary.incomingCount === 0}>
        {#if lockSummary.incomingCount > 0}
          <span class="lock-dir">←</span>
          <span class="lock-count">{lockSummary.incomingCount} lock{lockSummary.incomingCount !== 1 ? 's' : ''}</span>
          <span class="lock-amount">{activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, lockSummary.incomingAmount)}</span>
        {:else}
          <span>← 0 locks</span>
        {/if}
      </div>
      <div class="lock-badge outgoing" class:empty={lockSummary.outgoingCount === 0}>
        {#if lockSummary.outgoingCount > 0}
          <span class="lock-dir">→</span>
          <span class="lock-count">{lockSummary.outgoingCount} lock{lockSummary.outgoingCount !== 1 ? 's' : ''}</span>
          <span class="lock-amount">{activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, lockSummary.outgoingAmount)}</span>
        {:else}
          <span>→ 0 locks</span>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Row 2: Aggregate bar -->
  {#if agg.outTotal > 0n || agg.inTotal > 0n}
    <div class="row-bar">
      <span class="cap-label">
        {#if $settings.showTokenIcons}
          <span class="token-icon-small {tokenIconClass}">{tokenIconText}</span>
        {/if}
        OUT {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.outCap) || '0'}
      </span>
      <span class="cap-label">
        {#if $settings.showTokenIcons}
          <span class="token-icon-small {tokenIconClass}">{tokenIconText}</span>
        {/if}
        IN {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.inCap) || '0'}
      </span>
    </div>

    {#if $settings.barLayout === 'center'}
      <div class="bar center" style="width:{barWidthPct}%" class:rebalance-pending={rebalanceState === 'pending'} class:rebalance-active={rebalanceState === 'settling'} class:rebalance-secured={rebalanceState === 'secured'}>
        <div class="half out">
          {#if agg.outCredit > 0n}<div class="seg credit" style="width:{pctOf(agg.outCredit, halfMax)}%" title="Available: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.outCredit) || '?'}"></div>{/if}
          {#if agg.outColl > 0n}<div class="seg coll" class:striped={pendingC2R.active && !pendingC2R.submitted} class:pulsing={pendingC2R.submitted} style="width:{pctOf(agg.outColl, halfMax)}%" title="Secured: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.outColl) || '?'}"></div>{/if}
          {#if agg.outDebt > 0n}<div class="seg debt" class:striped={rebalanceState === 'pending'} class:pulsing={rebalanceState === 'settling'} style="width:{pctOf(agg.outDebt, halfMax)}%" title="Unsecured: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.outDebt) || '?'}"></div>{/if}
        </div>
        <div class="mid"></div>
        <div class="half in">
          {#if agg.inDebt > 0n}<div class="seg debt" class:striped={rebalanceState === 'pending'} class:pulsing={rebalanceState === 'settling'} style="width:{pctOf(agg.inDebt, halfMax)}%" title="Unsecured: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.inDebt) || '?'}"></div>{/if}
          {#if agg.inColl > 0n}<div class="seg coll" class:striped={pendingC2R.active && !pendingC2R.submitted} class:pulsing={pendingC2R.submitted} style="width:{pctOf(agg.inColl, halfMax)}%" title="Secured: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.inColl) || '?'}"></div>{/if}
          {#if agg.inCredit > 0n}<div class="seg credit" style="width:{pctOf(agg.inCredit, halfMax)}%" title="Available: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.inCredit) || '?'}"></div>{/if}
        </div>
      </div>
    {:else}
      <div class="bar sides" style="width:{barWidthPct}%" class:rebalance-pending={rebalanceState === 'pending'} class:rebalance-active={rebalanceState === 'settling'} class:rebalance-secured={rebalanceState === 'secured'}>
        <div class="side out" style="flex:{toFlex(agg.outTotal || 1n)}">
          {#if agg.outCredit > 0n}<div class="seg credit" style="flex:{toFlex(agg.outCredit)}" title="Available: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.outCredit) || '?'}"></div>{/if}
          {#if agg.outColl > 0n}<div class="seg coll" class:striped={pendingC2R.active && !pendingC2R.submitted} class:pulsing={pendingC2R.submitted} style="flex:{toFlex(agg.outColl)}" title="Secured: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.outColl) || '?'}"></div>{/if}
          {#if agg.outDebt > 0n}<div class="seg debt" class:striped={rebalanceState === 'pending'} class:pulsing={rebalanceState === 'settling'} style="flex:{toFlex(agg.outDebt)}" title="Unsecured: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.outDebt) || '?'}"></div>{/if}
        </div>
        <div class="gap"></div>
        <div class="side in" style="flex:{toFlex(agg.inTotal || 1n)}">
          {#if agg.inDebt > 0n}<div class="seg debt" class:striped={rebalanceState === 'pending'} class:pulsing={rebalanceState === 'settling'} style="flex:{toFlex(agg.inDebt)}" title="Unsecured: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.inDebt) || '?'}"></div>{/if}
          {#if agg.inColl > 0n}<div class="seg coll" class:striped={pendingC2R.active && !pendingC2R.submitted} class:pulsing={pendingC2R.submitted} style="flex:{toFlex(agg.inColl)}" title="Secured: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.inColl) || '?'}"></div>{/if}
          {#if agg.inCredit > 0n}<div class="seg credit" style="flex:{toFlex(agg.inCredit)}" title="Available: {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.inCredit) || '?'}"></div>{/if}
        </div>
      </div>
    {/if}

    <!-- Rebalance status indicator -->
    {#if rebalanceState !== 'none'}
      <div class="rebalance-indicator {rebalanceState}">
        {#if rebalanceState === 'pending'}
          <span class="rb-dot pending-dot"></span>
          {#if pendingRequested > 0n}
            <span>Awaiting collateral ({activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, pendingRequested) || '?'} requested)</span>
          {:else if pendingC2R.active}
            {#if canQuickApproveSettle}
              <span>Awaiting your withdrawal signature ({activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, pendingC2R.amount) || '?'} pending)</span>
            {:else}
              <span>Awaiting withdrawal signature ({activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, pendingC2R.amount) || '?'} pending)</span>
            {/if}
          {:else}
            <span>Rebalance pending</span>
          {/if}
        {:else if rebalanceState === 'settling'}
          <span class="rb-dot settling-dot"></span>
          {#if pendingRequested > 0n}
            <span>On-chain collateral settlement</span>
          {:else if pendingC2R.active}
            <span>On-chain collateral withdrawal</span>
          {:else}
            <span>On-chain settlement</span>
          {/if}
        {:else if rebalanceState === 'secured'}
          <span class="rb-dot secured-dot"></span>
          <span>Secured</span>
        {:else if rebalanceState === 'partial'}
          <span class="rb-dot partial-dot"></span>
          <span>Partially secured</span>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="empty">No capacity</div>
  {/if}

  {#if workspace}
    <div class="settle-row">
      <span class="settle {workspace.status}">
        {settleStatusLabel}
      </span>
      {#if canQuickApproveSettle}
        <button class="btn-sign-settle" on:click={handleSettleApprove}>Sign</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .account-preview {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 10px;
    padding: 12px 14px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .account-preview:hover {
    border-color: #3f3f46;
    background: #1c1c20;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }
  .account-preview.selected {
    border-color: #fbbf24;
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.04) 0%, transparent 100%);
  }

  /* ── Header ───────────────────────────────────── */
  .row-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    gap: 10px;
  }
  .entity-col { min-width: 0; flex: 1; }
  .status-col {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-shrink: 0;
  }

  .conn-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .conn-dot.connected { background: #4ade80; box-shadow: 0 0 4px rgba(74, 222, 128, 0.4); }
  .conn-dot.queued { background: #fbbf24; animation: pulse 2s infinite; box-shadow: 0 0 4px rgba(251, 191, 36, 0.4); }
  .conn-dot.disconnected { background: #3f3f46; }
  .conn-dot.unknown { background: transparent; border: 1px solid #3f3f46; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  .badge {
    font-size: 0.6em;
    padding: 3px 8px;
    border-radius: 5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .badge.synced { color: #4ade80; background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.12); }
  .badge.pending { color: #fbbf24; background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.12); }

  .locks-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .lock-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.56em;
    padding: 3px 7px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-family: 'JetBrains Mono','SF Mono','Monaco','Menlo',monospace;
    letter-spacing: 0.01em;
    min-width: 0;
  }

  .lock-badge.incoming {
    color: #67e8f9;
    background: rgba(34, 211, 238, 0.12);
    border-color: rgba(34, 211, 238, 0.25);
  }

  .lock-badge.outgoing {
    color: #fda4af;
    background: rgba(244, 63, 94, 0.1);
    border-color: rgba(244, 63, 94, 0.22);
  }

  .lock-badge.empty {
    opacity: 0.45;
  }

  .lock-dir {
    font-weight: 700;
  }

  .lock-count {
    white-space: nowrap;
  }

  .lock-amount {
    font-weight: 600;
    white-space: nowrap;
  }

  .j-sync {
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
    color: #93c5fd;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
  }

  .btn-faucet {
    font-size: 0.6em;
    padding: 3px 10px;
    border-radius: 5px;
    border: 1px solid #3f3f46;
    background: transparent;
    color: #71717a;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    transition: all 0.15s;
  }
  .btn-faucet:hover {
    border-color: #0ea5e9;
    color: #0ea5e9;
    background: rgba(14, 165, 233, 0.05);
  }
  .btn-faucet:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    border-color: #3f3f46;
    color: #71717a;
    background: transparent;
  }

  /* ── Bar labels ───────────────────────────────── */
  .row-bar {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-family: 'JetBrains Mono','SF Mono','Monaco','Menlo',monospace;
    font-size: 0.65em;
    letter-spacing: 0.02em;
    margin-bottom: 4px;
  }
  .cap-label { color: #a1a1aa; font-weight: 500; }
  .token-icon-small {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    font-size: 0.62rem;
    font-weight: 700;
    margin-right: 5px;
    vertical-align: middle;
    color: #0f172a;
  }
  .token-icon-small.usdc {
    background: #2775ca;
    color: #fff;
  }
  .token-icon-small.usdt {
    background: #26a17b;
    color: #fff;
  }
  .token-icon-small.weth {
    background: #627eea;
    color: #fff;
  }
  .token-icon-small.other {
    background: #a1a1aa;
    color: #111827;
  }

  /* ── Bar core ─────────────────────────────────── */
  .bar {
    display: flex;
    align-items: stretch;
    height: 8px;
    background: #27272a;
    border-radius: 4px;
    overflow: hidden;
  }
  .seg { min-width: 2px; transition: width 0.3s ease, flex 0.3s ease; position: relative; overflow: hidden; }
  .seg.credit { background: #a1a1aa; }
  .half.in .seg.credit, .side.in .seg.credit { background: rgba(34, 211, 238, 0.5); }
  .seg.coll { background: linear-gradient(180deg, #34d399, #10b981); }
  .seg.debt { background: linear-gradient(180deg, #fb7185, #f43f5e); }

  /* Striped = awaiting rebalance (over soft limit, hub hasn't collateralized yet) */
  .seg.debt.striped {
    background: repeating-linear-gradient(
      -45deg,
      #f43f5e 0px,
      #f43f5e 3px,
      #fbbf24 3px,
      #fbbf24 6px
    );
    background-size: 8.5px 8.5px;
    animation: stripe-scroll 0.8s linear infinite;
  }

  /* Pulsing = deposit/settlement in progress */
  .seg.debt.pulsing {
    background: linear-gradient(180deg, #fbbf24, #f59e0b);
    animation: rebalance-pulse 1s ease-in-out infinite;
  }

  @keyframes stripe-scroll {
    0% { background-position: 0 0; }
    100% { background-position: 8.5px 8.5px; }
  }

  @keyframes rebalance-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* Secured bar glow */
  .bar.rebalance-secured {
    box-shadow: 0 0 8px rgba(16, 185, 129, 0.3);
  }

  /* Pending bar subtle glow */
  .bar.rebalance-pending {
    box-shadow: 0 0 6px rgba(251, 191, 36, 0.2);
  }

  .bar.rebalance-active {
    box-shadow: 0 0 8px rgba(251, 191, 36, 0.3);
  }

  /* Center mode */
  .bar.center { flex-direction: row; }
  .half { flex:1; display:flex; align-items:stretch; overflow:hidden; }
  .half.out { justify-content: flex-end; }
  .half.in { justify-content: flex-start; }
  .mid { width:2px; background:#52525b; flex-shrink:0; border-radius:1px; }

  /* Sides mode */
  .bar.sides { gap:3px; background:transparent; }
  .side { display:flex; align-items:stretch; height:8px; background:#27272a; border-radius:4px; overflow:hidden; }
  .side.out { justify-content: flex-end; }
  .side.in { justify-content: flex-start; }
  .gap { width:2px; flex-shrink:0; }

  /* ── Misc ──────────────────────────────────────── */
  .empty { font-size:0.65em; color:#52525b; padding:4px 0; font-style: italic; }

  /* ── Rebalance indicator ───────────────────────── */
  .rebalance-indicator {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 0.55em;
    padding: 3px 0;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .rebalance-indicator.pending { color: #fbbf24; }
  .rebalance-indicator.quoted { color: #fb923c; }
  .rebalance-indicator.depositing { color: #f59e0b; }
  .rebalance-indicator.settling { color: #a78bfa; }
  .rebalance-indicator.secured { color: #4ade80; }
  .rebalance-indicator.partial { color: #34d399; }

  .rb-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .pending-dot { background: #fbbf24; animation: rebalance-pulse 1.5s ease-in-out infinite; }
  .quoted-dot { background: #fb923c; animation: rebalance-pulse 1s ease-in-out infinite; }
  .depositing-dot { background: #f59e0b; animation: rebalance-pulse 0.6s ease-in-out infinite; }
  .settling-dot { background: #a78bfa; animation: rebalance-pulse 0.4s ease-in-out infinite; }
  .secured-dot { background: #4ade80; box-shadow: 0 0 4px rgba(74, 222, 128, 0.5); }
  .partial-dot { background: #34d399; }

  .settle {
    display: inline-block;
    margin-top: 6px;
    font-size: 0.55em;
    padding: 3px 8px;
    border-radius: 5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    color: #71717a;
    background: rgba(113,113,122,0.08);
    border: 1px solid rgba(113,113,122,0.1);
  }
  .settle.awaiting_counterparty { color:#fbbf24; background:rgba(251,191,36,0.08); border-color: rgba(251,191,36,0.12); }
  .settle.ready_to_submit { color:#4ade80; background:rgba(74,222,128,0.08); border-color: rgba(74,222,128,0.12); }
  .settle.submitted { color:#60a5fa; background:rgba(96,165,250,0.08); border-color: rgba(96,165,250,0.12); }

  .settle-row {
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .btn-sign-settle {
    background: rgba(251, 191, 36, 0.18);
    color: #fbbf24;
    border: 1px solid rgba(251, 191, 36, 0.35);
    border-radius: 7px;
    font-size: 0.72em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 4px 9px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-sign-settle:hover {
    background: rgba(251, 191, 36, 0.26);
    border-color: rgba(251, 191, 36, 0.55);
  }
</style>
