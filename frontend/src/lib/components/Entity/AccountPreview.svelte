<script lang="ts">
  import type { AccountMachine, DerivedDelta } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import { xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import { settings } from '$lib/stores/settingsStore';
  import { p2pState } from '../../stores/xlnStore';
  import EntityIdentity from '../shared/EntityIdentity.svelte';
  import DeltaTokenSummary from './shared/DeltaTokenSummary.svelte';
  import { getGossipProfile, resolveEntityName } from '$lib/utils/entityNaming';
  import { getAccountUiStatus, getAccountUiStatusLabel } from '$lib/utils/accountStatus';

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

  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = $xlnEnvironment;

  function getProfile(id: string): ReturnType<typeof getGossipProfile> {
    return getGossipProfile(id, activeEnv);
  }

  $: counterpartyProfile = getProfile(counterpartyId);
  $: counterpartyName = resolveEntityName(counterpartyId, activeEnv);

  $: isHub = (() => {
    const profile = counterpartyProfile;
    if (!profile) return false;
    return !!(profile.metadata?.isHub === true ||
      (Array.isArray(profile.capabilities) && profile.capabilities.includes('hub')));
  })();

  // P2P connection state
  $: connState = (() => {
    const profile = counterpartyProfile;
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
               outHold: 0n, inHold: 0n, tokenCount: 0, primaryTokenId: 1, primarySymbol: '?',
               uncollateralized: 0n, totalCollateral: 0n, totalDebt: 0n };
    }

    const isLeft = entityId < counterpartyId;
    let outCap = 0n, inCap = 0n;
    let outCredit = 0n, outColl = 0n, outDebt = 0n;
    let inCredit = 0n, inColl = 0n, inDebt = 0n;
    let outHold = 0n, inHold = 0n;
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
      outHold += (typeof d.outTotalHold === 'bigint' ? d.outTotalHold : 0n);
      inHold += (typeof d.inTotalHold === 'bigint' ? d.inTotalHold : 0n);
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
             inCredit, inColl, inDebt, outTotal, inTotal, outHold, inHold,
             tokenCount: account.deltas.size, primaryTokenId, primarySymbol,
             uncollateralized, totalCollateral, totalDebt };
  })();

  $: primaryTokenInfo = activeXlnFunctions?.getTokenInfo?.(agg.primaryTokenId) || {
    symbol: String(agg.primarySymbol || '?'),
    name: String(agg.primarySymbol || 'Token'),
    decimals: 18,
  };
  $: aggDerived = {
    outOwnCredit: agg.outCredit,
    outCollateral: agg.outColl,
    outPeerCredit: agg.outDebt,
    inOwnCredit: agg.inDebt,
    inCollateral: agg.inColl,
    inPeerCredit: agg.inCredit,
    outTotalHold: agg.outHold,
    inTotalHold: agg.inHold,
  };
  $: accountDeltaViewMode = $settings.accountDeltaViewMode ?? 'per-token';
  $: tokenSummaries = (() => {
    if (!account.deltas || account.deltas.size === 0 || !activeXlnFunctions) return [];
    const isLeft = entityId < counterpartyId;
    const rows: Array<{
      tokenId: number;
      symbol: string;
      name: string;
      decimals: number;
      derived: DerivedDelta;
      outAmount: string;
      inAmount: string;
      outTotal: bigint;
      inTotal: bigint;
    }> = [];
    for (const [tokenId, delta] of account.deltas.entries()) {
      const derived = activeXlnFunctions.deriveDelta(delta, isLeft);
      const info = activeXlnFunctions.getTokenInfo(tokenId) || {
        symbol: `T${tokenId}`,
        name: `Token ${tokenId}`,
        decimals: 18,
      };
      const outTotal = derived.outOwnCredit + derived.outCollateral + derived.outPeerCredit;
      const inTotal = derived.inOwnCredit + derived.inCollateral + derived.inPeerCredit;
      rows.push({
        tokenId,
        symbol: String(info.symbol || `T${tokenId}`),
        name: String(info.name || ''),
        decimals: Number(info.decimals ?? 18),
        derived,
        outAmount: activeXlnFunctions.formatTokenAmount(tokenId, derived.outCapacity),
        inAmount: activeXlnFunctions.formatTokenAmount(tokenId, derived.inCapacity),
        outTotal,
        inTotal,
      });
    }
    return rows.sort((a, b) => {
      const aScore = a.outTotal + a.inTotal;
      const bScore = b.outTotal + b.inTotal;
      if (aScore === bScore) return a.tokenId - b.tokenId;
      return aScore > bScore ? -1 : 1;
    });
  })();
  $: hasAnyDeltas = tokenSummaries.length > 0;
  $: hasCommittedFrame = Number(account.currentHeight || 0) > 0;
  $: showDeltaRows = hasCommittedFrame && hasAnyDeltas;

  $: uiStatus = getAccountUiStatus(account);
  $: isPending = uiStatus === 'sent';
  $: hasActiveDispute = uiStatus === 'disputed';
  $: isFinalizedDisputed = uiStatus === 'finalized_disputed';
  $: statusLabel = getAccountUiStatusLabel(uiStatus);
  $: disputeTimeoutBlock = Number(account.activeDispute?.disputeTimeout || 0);
  $: disputeBlocksLeft = hasActiveDispute
    ? Math.max(0, disputeTimeoutBlock - Number(account.lastFinalizedJHeight || 0))
    : 0;
  $: canFaucet =
    !isPending &&
    Number(account.currentHeight || 0) > 0 &&
    agg.inTotal > 0n &&
    !hasActiveDispute &&
    !isFinalizedDisputed;

  // Pending prepaid requests (actual request_collateral state)
  $: pendingRequested = (() => {
    const map = account.requestedRebalance;
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
    const ws = account.settlementWorkspace;
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

  $: workspace = account.settlementWorkspace;
  $: iAmLeft = entityId < counterpartyId;
  $: disputeStartedByLeft = Boolean(account.activeDispute?.startedByLeft);
  $: disputeRole = hasActiveDispute ? (disputeStartedByLeft === iAmLeft ? 'starter' : 'counterparty') : '';
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
    const hasPendingBatch = account.settlementWorkspace?.status === 'submitted';
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
      <span
        class="badge"
        class:ready={uiStatus === 'ready'}
        class:sent={uiStatus === 'sent'}
        class:disputed={uiStatus === 'disputed'}
        class:finalized_disputed={uiStatus === 'finalized_disputed'}
      >
        {statusLabel}
      </span>
      <span class="j-sync" title="Last finalized bilateral J-event height">
        J#{account.lastFinalizedJHeight ?? 0}
      </span>
      {#if hasActiveDispute}
        <span class="dispute-counter" title={`Until J#${disputeTimeoutBlock}`}>
          ⚠ {disputeBlocksLeft} block{disputeBlocksLeft === 1 ? '' : 's'} left · {disputeRole}
        </span>
      {/if}
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
  {#if showDeltaRows}
    {#if accountDeltaViewMode === 'aggregated'}
      <DeltaTokenSummary
        compact={true}
        symbol={primaryTokenInfo.symbol}
        name={primaryTokenInfo.name}
        outAmount={activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.outCap) || '0'}
        inAmount={activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.inCap) || '0'}
        derived={aggDerived}
        decimals={Number(primaryTokenInfo.decimals ?? 18)}
        barHeight={9}
      />
    {:else}
      <div class="token-delta-list">
        {#each tokenSummaries as td (td.tokenId)}
          <DeltaTokenSummary
            compact={true}
            symbol={td.symbol}
            name={td.name}
            outAmount={td.outAmount}
            inAmount={td.inAmount}
            derived={td.derived}
            decimals={td.decimals}
            barHeight={9}
          />
        {/each}
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
    <div class="empty">{hasCommittedFrame ? 'No capacity' : 'Awaiting first frame'}</div>
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
    gap: 8px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .conn-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .conn-dot.connected { background: #4ade80; box-shadow: 0 0 4px rgba(74, 222, 128, 0.4); }
  .conn-dot.queued { background: #fbbf24; animation: pulse 2s infinite; box-shadow: 0 0 4px rgba(251, 191, 36, 0.4); }
  .conn-dot.disconnected { background: #3f3f46; }
  .conn-dot.unknown { background: transparent; border: 1px solid #3f3f46; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    font-size: 10px;
    padding: 0 10px;
    border-radius: 5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    line-height: 1;
  }
  .badge.ready { color: #4ade80; background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.12); }
  .badge.sent { color: #fbbf24; background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.12); }
  .badge.disputed { color: #fecdd3; background: rgba(244,63,94,0.2); border: 1px solid rgba(244,63,94,0.35); }
  .badge.finalized_disputed { color: #fca5a5; background: rgba(153, 27, 27, 0.26); border: 1px solid rgba(248, 113, 113, 0.38); }

  .locks-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .token-delta-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
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
    color: #d6d3d1;
    background: rgba(113, 113, 122, 0.16);
    border-color: rgba(113, 113, 122, 0.28);
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
    color: #d6d3d1;
    background: #18181b;
    border: 1px solid #292524;
    padding: 0 9px;
    border-radius: 4px;
    line-height: 1;
  }

  .dispute-counter {
    display: inline-flex;
    align-items: center;
    height: 24px;
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
    color: #fda4af;
    background: rgba(127, 29, 29, 0.35);
    border: 1px solid rgba(251, 113, 133, 0.35);
    padding: 0 9px;
    border-radius: 4px;
    line-height: 1;
    white-space: nowrap;
  }

  .btn-faucet {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    font-size: 10px;
    padding: 0 10px;
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
    border-color: #fbbf24;
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.08);
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
    color: #0c0a09;
  }
  .token-icon-small.usdc {
    background: #52525b;
    color: #fff;
  }
  .token-icon-small.usdt {
    background: #26a17b;
    color: #fff;
  }
  .token-icon-small.weth {
    background: #71717a;
    color: #fff;
  }
  .token-icon-small.other {
    background: #a1a1aa;
    color: #0c0a09;
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
  .half.in .seg.credit, .side.in .seg.credit { background: rgba(161, 161, 170, 0.65); }
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
  .settle.submitted { color:#fbbf24; background:rgba(251,191,36,0.08); border-color: rgba(251,191,36,0.12); }

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
