<script lang="ts">
  import type { AccountMachine, DerivedDelta } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import { xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import { settings } from '$lib/stores/settingsStore';
  import { p2pState } from '../../stores/xlnStore';
  import EntityIdentity from '../shared/EntityIdentity.svelte';
  import DeltaTokenList from './shared/DeltaTokenList.svelte';
  import DeltaTokenSummary from './shared/DeltaTokenSummary.svelte';
  import { buildTokenVisualScale, sumVisualScales } from './shared/delta-visual';
  import { getGossipProfile, resolveEntityName } from '$lib/utils/entityNaming';
  import { getAccountUiStatus, getAccountUiStatusLabel } from '$lib/utils/accountStatus';

  export let account: AccountMachine;
  export let counterpartyId: string;
  export let entityId: string;
  export let isSelected: boolean = false;
  export let entityHeight: number = 0;
  export let runtimeHeight: number = 0;
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
    return profile.metadata.isHub === true;
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
    let bestPrimaryOut = -1n;
    let bestPrimaryIn = -1n;

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
      if (
        info?.symbol &&
        (d.outCapacity > bestPrimaryOut || (d.outCapacity === bestPrimaryOut && d.inCapacity > bestPrimaryIn))
      ) {
        bestPrimaryOut = d.outCapacity;
        bestPrimaryIn = d.inCapacity;
        primaryTokenId = tokenId;
        primarySymbol = info.symbol;
      }
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
    outCapacity: agg.outCap,
    inCapacity: agg.inCap,
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
      pendingOutDebtMode: 'none' | 'pending' | 'settling';
      visualScale: ReturnType<typeof buildTokenVisualScale>;
    }> = [];
    for (const [tokenId, delta] of account.deltas.entries()) {
      const derived = activeXlnFunctions.deriveDelta(delta, isLeft);
      const info = activeXlnFunctions.getTokenInfo(tokenId) || {
        symbol: `T${tokenId}`,
        name: `Token ${tokenId}`,
        decimals: 18,
      };
      const outTotal = derived.outCapacity;
      const inTotal = derived.inCapacity;
      const tokenRequested = pendingRequestedByToken.get(tokenId) || 0n;
      const tokenC2R = pendingC2RByToken.get(tokenId) || 0n;
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
        pendingOutDebtMode: (tokenRequested > 0n || tokenC2R > 0n)
          ? (hasPendingBatch ? 'settling' : 'pending')
          : 'none',
        visualScale: buildTokenVisualScale(String(info.symbol || ''), Number(info.decimals ?? 18), derived),
        actionLabel: 'Faucet',
      });
    }
    return rows.sort((a, b) => {
      const aScore = a.outTotal + a.inTotal;
      const bScore = b.outTotal + b.inTotal;
      if (aScore === bScore) {
        if (a.derived.outCapacity === b.derived.outCapacity) return a.tokenId - b.tokenId;
        return a.derived.outCapacity > b.derived.outCapacity ? -1 : 1;
      }
      return aScore > bScore ? -1 : 1;
    });
  })();
  $: aggregateVisualScale = sumVisualScales(tokenSummaries.map((row) => row.visualScale));
  $: hasAnyDeltas = tokenSummaries.length > 0;
  $: hasCommittedFrame = Number(account.currentFrame?.height ?? account.currentHeight ?? 0) > 0;
  $: showDeltaRows = hasCommittedFrame && hasAnyDeltas;

  $: isDevnet = (() => {
    if (!activeEnv?.jReplicas) return false;
    for (const [, jr] of activeEnv.jReplicas) {
      if (jr?.chainId === 31337) return true;
    }
    return false;
  })();
  $: faucetLabel = isDevnet ? 'Faucet' : '';
  $: uiStatus = getAccountUiStatus(account);
  $: isPending = uiStatus === 'sent';
  $: hasActiveDispute = uiStatus === 'disputed';
  $: isFinalizedDisputed = uiStatus === 'finalized_disputed';
  $: statusLabel = getAccountUiStatusLabel(uiStatus);
  $: accountHeight = Number(account.currentFrame?.height ?? account.currentHeight ?? 0);
  $: jFinalizedHeight = Number(account.lastFinalizedJHeight ?? 0);
  $: pendingLeftJClaim = Array.isArray(account.leftJObservations)
    && account.leftJObservations.some(obs => Number(obs?.jHeight ?? 0) > jFinalizedHeight);
  $: pendingRightJClaim = Array.isArray(account.rightJObservations)
    && account.rightJObservations.some(obs => Number(obs?.jHeight ?? 0) > jFinalizedHeight);
  $: jPendingSideSuffix = `${pendingLeftJClaim ? '+L' : ''}${pendingRightJClaim ? '+R' : ''}`;
  $: disputeTimeoutBlock = Number(account.activeDispute?.disputeTimeout || 0);
  $: disputeBlocksLeft = hasActiveDispute
    ? Math.max(0, disputeTimeoutBlock - Number(account.lastFinalizedJHeight || 0))
    : 0;
  $: compactConsensusLabel = `${statusLabel} · A#${accountHeight} · J#${jFinalizedHeight}${jPendingSideSuffix}`;
  $: consensusUpdatedAt = Number(account.currentFrame?.timestamp ?? account.pendingFrame?.timestamp ?? 0);
  function formatDetailTimestamp(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return 'n/a';
    return new Date(ms).toLocaleString();
  }
  function toBigIntSafe(value: unknown): bigint | null {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
    return null;
  }

  function toTokenIdSafe(value: unknown): number | null {
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
    return Math.floor(asNumber);
  }

  $: pendingRequestedByToken = (() => {
    const out = new Map<number, bigint>();
    const map = account.requestedRebalance;
    if (!(map instanceof Map)) return out;
    for (const [rawTokenId, rawAmount] of map.entries()) {
      const tokenId = toTokenIdSafe(rawTokenId);
      const amount = toBigIntSafe(rawAmount);
      if (!tokenId || amount === null || amount <= 0n) continue;
      out.set(tokenId, (out.get(tokenId) || 0n) + amount);
    }
    return out;
  })();

  $: pendingC2RByToken = (() => {
    const out = new Map<number, bigint>();
    const ws = account.settlementWorkspace;
    if (!ws || !Array.isArray(ws.ops)) return out;
    for (const op of ws.ops) {
      if (op?.type !== 'c2r') continue;
      const tokenId = toTokenIdSafe(op?.tokenId);
      const amount = toBigIntSafe(op?.amount);
      if (!tokenId || amount === null || amount <= 0n) continue;
      out.set(tokenId, (out.get(tokenId) || 0n) + amount);
    }
    return out;
  })();
  $: hasPendingBatch = account.settlementWorkspace?.status === 'submitted';

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
    if (status === 'ready_to_submit') return 'Counterparty signed';
    if (status === 'submitted') return 'Submitted on-chain';
    if (status === 'draft') return 'Draft';
    return status.replace(/_/g, ' ');
  })();

  function handleClick() {
    dispatch('select', { accountId: counterpartyId });
  }

  function handleFaucet(e: MouseEvent) {
    e.stopPropagation();
    dispatch('faucet', { counterpartyId, tokenId: agg.primaryTokenId });
  }

  function handleTokenFaucet(tokenId: number): void {
    dispatch('faucet', { counterpartyId, tokenId });
  }

  function handleSettleApprove(e: MouseEvent) {
    e.stopPropagation();
    dispatch('settleApprove', { counterpartyId });
  }
</script>

<div
  class="account-preview"
  class:selected={isSelected}
  data-counterparty-id={counterpartyId}
  data-owner-entity-id={entityId}
>
  <!-- Row 1: Entity name + status dot -->
  <div class="row-header">
    <div class="entity-col">
      <EntityIdentity entityId={counterpartyId} name={counterpartyName} size={30} clickable={false} compact={false} copyable={false} showAddress={false} />
    </div>
    <div class="status-col">
      <div class="status-dot-wrap">
        <button
          class="status-indicator"
          class:green={uiStatus === 'ready' && connState === 'connected'}
          class:amber={uiStatus === 'sent'}
          class:orange={connState === 'disconnected' || connState === 'queued'}
          class:red={uiStatus === 'disputed' || uiStatus === 'finalized_disputed'}
          class:gray={uiStatus !== 'ready' && uiStatus !== 'sent' && uiStatus !== 'disputed' && uiStatus !== 'finalized_disputed' && connState !== 'disconnected' && connState !== 'queued'}
          type="button"
          title="Account status"
        >
          <span class="status-dot-inner"></span>
          <span class="status-frame">#{accountHeight}</span>
        </button>
        <div class="consensus-popover" role="tooltip">
          <div class="consensus-popover-head">
            {#if uiStatus === 'ready' && connState === 'connected'}
              <span class="popover-dot green"></span> Active — Online
            {:else if uiStatus === 'sent'}
              <span class="popover-dot yellow"></span> Pending — Awaiting ACK
            {:else if connState === 'disconnected' || connState === 'queued'}
              <span class="popover-dot yellow"></span> Active — Offline
            {:else if uiStatus === 'disputed' || uiStatus === 'finalized_disputed'}
              <span class="popover-dot red"></span> Dispute Active
            {:else}
              <span class="popover-dot gray"></span> Inactive
            {/if}
          </div>
          <div class="consensus-popover-row">
            <span>Counterparty</span>
            <strong>{counterpartyName}</strong>
          </div>
          <div class="consensus-popover-row dim">
            <span>ID</span>
            <strong class="mono">{counterpartyId.slice(0, 10)}...{counterpartyId.slice(-6)}</strong>
          </div>
          <div class="consensus-popover-section">Channel</div>
          <div class="consensus-popover-row">
            <span>Account</span>
            <strong>#{accountHeight}</strong>
          </div>
          {#if account.pendingFrame}
            <div class="consensus-popover-row pending">
              <span>Pending</span>
              <strong>#{account.pendingFrame.height}</strong>
            </div>
          {/if}
          <div class="consensus-popover-row">
            <span>Jurisdiction</span>
            <strong>#{jFinalizedHeight}{jPendingSideSuffix}</strong>
          </div>
          <div class="consensus-popover-row">
            <span>Updated</span>
            <strong>{formatDetailTimestamp(consensusUpdatedAt)}</strong>
          </div>
          <div class="consensus-popover-section">General</div>
          <div class="consensus-popover-row">
            <span>Entity</span>
            <strong>#{entityHeight}</strong>
          </div>
          <div class="consensus-popover-row">
            <span>Runtime</span>
            <strong>#{runtimeHeight}</strong>
          </div>
          {#if hasActiveDispute}
            <div class="consensus-popover-row dispute">
              <span>Dispute</span>
              <strong>{disputeBlocksLeft} block{disputeBlocksLeft === 1 ? '' : 's'} left · {disputeRole}</strong>
            </div>
          {/if}
          <button class="popover-explore-btn" on:click={handleClick}>
            Explore Account →
          </button>
        </div>
      </div>
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
        barLayout={$settings.barLayout ?? 'center'}
        symbol={primaryTokenInfo.symbol}
        name={primaryTokenInfo.name}
        outAmount={activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.outCap) || '0'}
        inAmount={activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.inCap) || '0'}
        derived={aggDerived}
        decimals={Number(primaryTokenInfo.decimals ?? 18)}
        barHeight={4}
        visualScale={aggregateVisualScale}
        actionLabel="Faucet"
        actionTokenId={agg.primaryTokenId}
        on:action={() => handleTokenFaucet(agg.primaryTokenId)}
      />
    {:else}
      <DeltaTokenList
        rows={tokenSummaries}
        barLayout={$settings.barLayout ?? 'center'}
        barHeight={4}
        showMetricLabels={false}
        showHeader={false}
        mode="plain"
        on:action={(event) => handleTokenFaucet(event.detail.tokenId)}
      />
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
    --delta-col-w: clamp(136px, 14vw, 192px);
    --delta-sep-w: 12px;
    background: #18181b;
    border: 1px solid #27272a;
    border-left: none;
    border-radius: 12px;
    padding: 14px 16px 12px;
    transition: all 0.15s ease;
  }
  /* Status indicated by dot only — no border coloring */
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
  .entity-col :global(.entity-identity) {
    gap: 12px;
  }
  .entity-col :global(.name) {
    font-size: 18px;
    font-weight: 700;
    color: #f3f4f6;
    line-height: 1.15;
  }
  .entity-col :global(.address) {
    font-size: 12px;
    color: #94a3b8;
    line-height: 1.15;
  }

  .meta-line {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: #71717a;
  }
  .meta-status { text-transform: uppercase; font-weight: 600; letter-spacing: 0.03em; }
  .meta-status.ready { color: #4ade80; }
  .meta-status.sent { color: #fbbf24; }
  .meta-status.disputed { color: #f43f5e; }
  .meta-sep { color: #3f3f46; }
  .meta-frame { color: #52525b; }
  .status-col {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    flex-wrap: wrap;
    row-gap: 6px;
  }

  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  .status-dot-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .status-indicator {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: none;
    padding: 2px 4px;
    cursor: pointer;
    border-radius: 6px;
    transition: background 0.15s ease;
  }
  .status-indicator:hover { background: rgba(255,255,255,0.05); }

  .status-dot-inner {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-indicator.green .status-dot-inner { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.5); }
  .status-indicator.amber .status-dot-inner { background: #fbbf24; box-shadow: 0 0 6px rgba(251, 191, 36, 0.5); animation: pulse 2s infinite; }
  .status-indicator.orange .status-dot-inner { background: #f97316; box-shadow: 0 0 6px rgba(249, 115, 22, 0.4); }
  .status-indicator.red .status-dot-inner { background: #f43f5e; box-shadow: 0 0 6px rgba(244, 63, 94, 0.5); animation: pulse 1.5s infinite; }
  .status-indicator.gray .status-dot-inner { background: #3f3f46; }

  .status-frame {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #52525b;
    font-weight: 600;
  }
  .status-indicator.green .status-frame { color: #6ee7b7; }
  .status-indicator.amber .status-frame { color: #fcd34d; }
  .status-indicator.red .status-frame { color: #fda4af; }

  .popover-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  }
  .popover-dot.green { background: #4ade80; }
  .popover-dot.yellow { background: #fbbf24; }
  .popover-dot.red { background: #f43f5e; }
  .popover-dot.gray { background: #3f3f46; }

  .consensus-popover {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    min-width: 260px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid #2f2f35;
    background: rgba(12, 12, 16, 0.97);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.34);
    display: none;
    z-index: 12;
    backdrop-filter: blur(10px);
  }

  .status-dot-wrap:hover .consensus-popover,
  .status-dot-wrap:focus-within .consensus-popover {
    display: block;
  }

  .consensus-popover-head {
    color: #f5f5f4;
    font-size: 12px;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .consensus-popover-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    color: #a8a29e;
    font-size: 11px;
    line-height: 1.35;
    padding: 3px 0;
  }

  .consensus-popover-row strong {
    color: #f3f4f6;
    font-weight: 600;
    text-align: right;
  }

  .consensus-popover-row.dispute strong {
    color: #fecdd3;
  }

  .consensus-popover-row.dim {
    opacity: 0.6;
  }

  .consensus-popover-row.dim strong.mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
  }

  .consensus-popover-row.pending strong {
    color: #fbbf24;
  }

  .consensus-popover-section {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #52525b;
    margin-top: 8px;
    margin-bottom: 2px;
    padding-top: 6px;
    border-top: 1px solid #27272a;
  }
  .consensus-popover-section:first-child {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
  }

  .popover-explore-btn {
    display: block;
    width: 100%;
    margin-top: 10px;
    padding: 8px 0;
    border-radius: 8px;
    border: 1px solid #3f3f46;
    background: rgba(251, 191, 36, 0.06);
    color: #fbbf24;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.03em;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: center;
  }

  .popover-explore-btn:hover {
    border-color: #fbbf24;
    background: rgba(251, 191, 36, 0.14);
  }

  .locks-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
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

  /* ── Misc ──────────────────────────────────────── */
  .empty { font-size:0.65em; color:#52525b; padding:4px 0; font-style: italic; }

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
