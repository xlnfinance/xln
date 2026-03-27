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
  import { amountToUsdMicros } from '$lib/utils/assetPricing';
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
  export let activeFlows: Array<{
    id: string;
    direction: 'incoming' | 'outgoing';
    tokenId: number;
    amount: bigint;
    title: string;
    subtitle: string;
  }> = [];
  export let activeFlowOverflowCount = 0;

  const dispatch = createEventDispatcher();

  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = $xlnEnvironment;

  function getProfile(id: string): ReturnType<typeof getGossipProfile> {
    return getGossipProfile(id, activeEnv);
  }

  function isAccountLeftPerspective(ownerEntityId: string, currentAccount: AccountMachine): boolean {
    const owner = String(ownerEntityId || '').trim().toLowerCase();
    const left = String(currentAccount.leftEntity || '').trim().toLowerCase();
    const right = String(currentAccount.rightEntity || '').trim().toLowerCase();
    if (owner === left) return true;
    if (owner === right) return false;
    throw new Error(`Account perspective mismatch: owner=${ownerEntityId} left=${currentAccount.leftEntity} right=${currentAccount.rightEntity}`);
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
               totalCollateralUsdMicros: 0n, totalDebtUsdMicros: 0n };
    }

    const isLeft = isAccountLeftPerspective(entityId, account);
    let outCap = 0n, inCap = 0n;
    let outCredit = 0n, outColl = 0n, outDebt = 0n;
    let inCredit = 0n, inColl = 0n, inDebt = 0n;
    let outHold = 0n, inHold = 0n;
    let totalCollateralUsdMicros = 0n;
    let totalDebtUsdMicros = 0n;
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
      const symbol = String(info?.symbol || `T${tokenId}`);
      const decimals = Number(info?.decimals ?? 18);
      totalCollateralUsdMicros += amountToUsdMicros(d.outCollateral, decimals, symbol);
      totalDebtUsdMicros += amountToUsdMicros(d.outPeerCredit, decimals, symbol);
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

    return { outCap, inCap, outCredit, outColl, outDebt,
             inCredit, inColl, inDebt, outTotal, inTotal, outHold, inHold,
             tokenCount: account.deltas.size, primaryTokenId, primarySymbol,
             totalCollateralUsdMicros, totalDebtUsdMicros };
  })();

  $: coveragePct = (() => {
    const denom = agg.totalCollateralUsdMicros + agg.totalDebtUsdMicros;
    if (denom <= 0n) return null;
    return Number((agg.totalCollateralUsdMicros * 10000n) / denom) / 100;
  })();
  function formatCoverageUsd(usdMicros: bigint): string {
    if (usdMicros <= 0n) return '$0';
    const whole = usdMicros / 1_000_000n;
    const fraction = usdMicros % 1_000_000n;
    if (whole >= 1000n) return `$${whole.toLocaleString('en-US')}`;
    if (whole >= 1n) {
      const cents = fraction / 10_000n;
      return `$${whole.toString()}.${cents.toString().padStart(2, '0')}`;
    }
    const tenThousandths = fraction / 100n;
    return `$0.${tenThousandths.toString().padStart(4, '0')}`;
  }
  $: coverageCollFmt = formatCoverageUsd(agg.totalCollateralUsdMicros);
  $: coverageDenomFmt = formatCoverageUsd(agg.totalCollateralUsdMicros + agg.totalDebtUsdMicros);

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
    const isLeft = isAccountLeftPerspective(entityId, account);
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
      actionLabel?: string;
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
        actionLabel: faucetLabel,
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
  $: liteMode = !!$settings.liteMode;
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
  $: iAmLeft = isAccountLeftPerspective(entityId, account);
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
    if (status === 'submitted') return 'Pending on-chain confirmation';
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

  function handleDispute(e: MouseEvent) {
    e.stopPropagation();
    dispatch('dispute', { counterpartyId });
  }

  function formatFlowAmount(tokenId: number, amount: bigint): string {
    return activeXlnFunctions?.formatTokenAmount
      ? activeXlnFunctions.formatTokenAmount(tokenId, amount)
      : amount.toString();
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
          {#if !liteMode}
            <span class="status-frame">#{accountHeight}</span>
          {/if}
          {#if !liteMode && coveragePct !== null}
            <span class="status-coverage" class:cov-warn={coveragePct < 40} class:cov-caution={coveragePct >= 40 && coveragePct < 75} class:cov-good={coveragePct >= 75}>{coveragePct.toFixed(0)}%</span>
          {/if}
        </button>
        <div class="consensus-popover" role="tooltip">
          <div class="consensus-popover-head">
            {#if uiStatus === 'ready' && connState === 'connected'}
              <span class="popover-dot green"></span> Active — Online
            {:else if uiStatus === 'sent'}
              <span class="popover-dot yellow"></span> Pending — On-chain confirmation
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
          {#if coveragePct !== null}
            <div class="consensus-popover-row" class:coverage-warn={coveragePct < 40} class:coverage-caution={coveragePct >= 40 && coveragePct < 75}>
              <span>Coverage</span>
              <strong>
                <span class="coverage-pct">{coveragePct.toFixed(0)}%</span>
                <span class="coverage-detail">{coverageCollFmt} / {coverageDenomFmt}</span>
              </strong>
            </div>
          {/if}
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
          {#if !hasActiveDispute && !isFinalizedDisputed}
            <button class="popover-dispute-btn" on:click={handleDispute}>
              Dispute Account
            </button>
          {/if}
          <button class="popover-explore-btn" on:click={handleClick}>
            Explore Account →
          </button>
        </div>
      </div>
    </div>
  </div>

  {#if !liteMode && (activeFlows.length > 0 || lockSummary.incomingCount > 0 || lockSummary.outgoingCount > 0)}
    <div class="locks-row">
      {#if activeFlows.length > 0}
        {#each activeFlows as flow (flow.id)}
          <div class="flow-chip" class:incoming={flow.direction === 'incoming'} class:outgoing={flow.direction === 'outgoing'}>
            <div class="flow-chip-head">
              <span class="flow-chip-dir">{flow.direction === 'incoming' ? '←' : '→'}</span>
              <span class="flow-chip-title">{flow.title}</span>
              <strong class="flow-chip-amount">{formatFlowAmount(flow.tokenId, flow.amount)}</strong>
            </div>
            <div class="flow-chip-subtitle">{flow.subtitle}</div>
          </div>
        {/each}
        {#if activeFlowOverflowCount > 0}
          <div class="flow-chip more">
            <div class="flow-chip-head">
              <span class="flow-chip-title">More active flows</span>
              <strong class="flow-chip-amount">+{activeFlowOverflowCount}</strong>
            </div>
            <div class="flow-chip-subtitle">Open account to inspect the rest</div>
          </div>
        {/if}
      {:else}
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
      {/if}
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
        barHeight={6}
        visualScale={aggregateVisualScale}
        showBar={!liteMode}
        actionLabel={liteMode ? '' : faucetLabel}
        actionTokenId={agg.primaryTokenId}
        on:action={() => handleTokenFaucet(agg.primaryTokenId)}
      />
    {:else}
      <DeltaTokenList
        rows={tokenSummaries}
        barLayout={$settings.barLayout ?? 'center'}
        barHeight={6}
        showMetricLabels={false}
        showBars={!liteMode}
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
    --account-preview-bg: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent);
    --account-preview-bg-hover: color-mix(in srgb, var(--theme-surface-hover, var(--theme-card-bg, #1c1c20)) 96%, transparent);
    --account-preview-border: color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 88%, transparent);
    --account-preview-border-strong: color-mix(in srgb, var(--theme-card-hover-border, var(--theme-border, #27272a)) 84%, transparent);
    --account-preview-text: var(--theme-text-primary, #e4e4e7);
    --account-preview-text-secondary: var(--theme-text-secondary, #a1a1aa);
    --account-preview-text-muted: var(--theme-text-muted, #71717a);
    --account-preview-accent: var(--theme-accent, #fbbf24);
    --account-preview-credit: var(--theme-credit, #4ade80);
    --account-preview-debit: var(--theme-debit, #f43f5e);
    background: var(--account-preview-bg);
    border: 1px solid color-mix(in srgb, var(--account-preview-border) 56%, transparent);
    border-radius: 14px;
    padding: 12px 13px 10px;
    transition: all 0.15s ease;
    box-shadow: 0 6px 14px color-mix(in srgb, var(--theme-background, #09090b) 4%, transparent);
    max-width: 100%;
  }
  .account-preview:hover {
    border-color: var(--account-preview-border-strong);
    background: var(--account-preview-bg-hover);
  }
  .account-preview.selected {
    border-color: var(--account-preview-border-strong);
    background: var(--account-preview-bg-hover);
  }

  /* ── Header ───────────────────────────────────── */
  .row-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    gap: 10px;
  }
  .entity-col { min-width: 0; flex: 1; }
  .entity-col :global(.entity-identity) {
    gap: 10px;
  }
  .entity-col :global(.name) {
    font-size: 16px;
    font-weight: 700;
    color: var(--account-preview-text);
    line-height: 1.15;
  }
  .entity-col :global(.address) {
    font-size: 12px;
    color: var(--account-preview-text-secondary);
    line-height: 1.15;
  }

  .meta-line {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--account-preview-text-muted);
  }
  .meta-status { text-transform: uppercase; font-weight: 600; letter-spacing: 0.03em; }
  .meta-status.ready { color: var(--account-preview-credit); }
  .meta-status.sent { color: var(--account-preview-accent); }
  .meta-status.disputed { color: var(--account-preview-debit); }
  .meta-sep { color: color-mix(in srgb, var(--account-preview-text-muted) 62%, transparent); }
  .meta-frame { color: color-mix(in srgb, var(--account-preview-text-muted) 80%, transparent); }
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
  .status-indicator:hover { background: color-mix(in srgb, var(--theme-surface-hover, var(--theme-card-bg, #1c1c20)) 88%, transparent); }

  .status-dot-inner {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-indicator.green .status-dot-inner { background: var(--account-preview-credit); box-shadow: 0 0 6px color-mix(in srgb, var(--account-preview-credit) 50%, transparent); }
  .status-indicator.amber .status-dot-inner { background: var(--account-preview-accent); box-shadow: 0 0 6px color-mix(in srgb, var(--account-preview-accent) 50%, transparent); animation: pulse 2s infinite; }
  .status-indicator.orange .status-dot-inner { background: color-mix(in srgb, var(--account-preview-accent) 74%, #f97316); box-shadow: 0 0 6px color-mix(in srgb, var(--account-preview-accent) 34%, transparent); }
  .status-indicator.red .status-dot-inner { background: var(--account-preview-debit); box-shadow: 0 0 6px color-mix(in srgb, var(--account-preview-debit) 50%, transparent); animation: pulse 1.5s infinite; }
  .status-indicator.gray .status-dot-inner { background: color-mix(in srgb, var(--account-preview-text-muted) 58%, transparent); }

  .status-frame {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: color-mix(in srgb, var(--account-preview-text-muted) 80%, transparent);
    font-weight: 600;
  }
  .status-indicator.green .status-frame { color: color-mix(in srgb, var(--account-preview-credit) 76%, white 24%); }
  .status-indicator.amber .status-frame { color: color-mix(in srgb, var(--account-preview-accent) 76%, white 24%); }
  .status-indicator.red .status-frame { color: color-mix(in srgb, var(--account-preview-debit) 68%, white 32%); }

  .status-coverage {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    margin-left: 2px;
  }
  .status-coverage.cov-good { color: var(--account-preview-credit); background: color-mix(in srgb, var(--account-preview-credit) 12%, transparent); }
  .status-coverage.cov-caution { color: var(--account-preview-accent); background: color-mix(in srgb, var(--account-preview-accent) 12%, transparent); }
  .status-coverage.cov-warn { color: color-mix(in srgb, var(--account-preview-debit) 72%, white 28%); background: color-mix(in srgb, var(--account-preview-debit) 15%, transparent); }

  .popover-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  }
  .popover-dot.green { background: var(--account-preview-credit); }
  .popover-dot.yellow { background: var(--account-preview-accent); }
  .popover-dot.red { background: var(--account-preview-debit); }
  .popover-dot.gray { background: color-mix(in srgb, var(--account-preview-text-muted) 58%, transparent); }

  .consensus-popover {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    min-width: 0;
    width: min(320px, calc(100vw - 24px));
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--account-preview-border) 90%, transparent);
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 100%, transparent);
    box-shadow: 0 18px 48px color-mix(in srgb, var(--theme-background, #09090b) 32%, transparent);
    display: none;
    z-index: 12;
    backdrop-filter: blur(10px);
  }

  .status-dot-wrap:hover .consensus-popover,
  .status-dot-wrap:focus-within .consensus-popover {
    display: block;
  }

  .consensus-popover-head {
    color: var(--account-preview-text);
    font-size: 12px;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .consensus-popover-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    color: var(--account-preview-text-secondary);
    font-size: 11px;
    line-height: 1.35;
    padding: 3px 0;
  }

  .consensus-popover-row strong {
    color: var(--account-preview-text);
    font-weight: 600;
    text-align: right;
  }

  .consensus-popover-row.dispute strong {
    color: color-mix(in srgb, var(--account-preview-debit) 48%, white 52%);
  }

  .consensus-popover-row.dim {
    opacity: 0.6;
  }

  .consensus-popover-row.dim strong.mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
  }

  .consensus-popover-row.pending strong {
    color: var(--account-preview-accent);
  }

  .consensus-popover-section {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: color-mix(in srgb, var(--account-preview-text-muted) 80%, transparent);
    margin-top: 8px;
    margin-bottom: 2px;
    padding-top: 6px;
    border-top: 1px solid color-mix(in srgb, var(--account-preview-border) 88%, transparent);
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
    border: 1px solid color-mix(in srgb, var(--account-preview-border) 86%, transparent);
    background: color-mix(in srgb, var(--account-preview-accent) 8%, transparent);
    color: var(--account-preview-accent);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.03em;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: center;
  }

  .popover-explore-btn:hover {
    border-color: color-mix(in srgb, var(--account-preview-accent) 70%, transparent);
    background: color-mix(in srgb, var(--account-preview-accent) 16%, transparent);
  }

  .coverage-pct {
    color: var(--account-preview-credit);
    font-weight: 700;
    margin-right: 4px;
  }
  .consensus-popover-row.coverage-caution .coverage-pct { color: var(--account-preview-accent); }
  .consensus-popover-row.coverage-warn .coverage-pct { color: var(--account-preview-debit); }
  .coverage-detail {
    color: color-mix(in srgb, var(--account-preview-text-muted) 80%, transparent);
    font-size: 9px;
    font-weight: 400;
    font-family: 'JetBrains Mono', monospace;
  }

  .status-dot-wrap .consensus-popover .popover-dispute-btn {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 9px 0;
    border-radius: 8px;
    border: 2px solid color-mix(in srgb, var(--account-preview-debit) 78%, transparent);
    background: color-mix(in srgb, var(--account-preview-debit) 84%, transparent);
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.01em;
    text-transform: none;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: center;
    box-shadow: 0 0 12px rgba(220, 38, 38, 0.4);
  }
  .status-dot-wrap .consensus-popover .popover-dispute-btn:hover {
    background: color-mix(in srgb, var(--account-preview-debit) 92%, black 8%);
    border-color: color-mix(in srgb, var(--account-preview-debit) 92%, black 8%);
    box-shadow: 0 0 18px color-mix(in srgb, var(--account-preview-debit) 44%, transparent);
  }

  .locks-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 8px;
    margin-bottom: 8px;
  }

  .flow-chip {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 7px 9px;
    border-radius: 9px;
    border: 1px solid color-mix(in srgb, var(--account-preview-border) 56%, transparent);
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 62%, transparent);
    min-width: 0;
  }

  .flow-chip.incoming {
    border-color: color-mix(in srgb, var(--account-preview-credit) 30%, transparent);
    background: color-mix(in srgb, var(--account-preview-credit) 12%, transparent);
  }

  .flow-chip.outgoing {
    border-color: color-mix(in srgb, var(--account-preview-debit) 24%, transparent);
    background: color-mix(in srgb, var(--account-preview-debit) 10%, transparent);
  }

  .flow-chip.more {
    border-style: dashed;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 92%, transparent);
  }

  .flow-chip-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  .flow-chip-dir {
    font-family: 'JetBrains Mono','SF Mono','Monaco','Menlo',monospace;
    font-size: 11px;
    color: var(--account-preview-accent);
    flex-shrink: 0;
  }

  .flow-chip-title {
    font-size: 11px;
    font-weight: 700;
    color: var(--account-preview-text);
    min-width: 0;
  }

  .flow-chip-amount {
    margin-left: auto;
    font-size: 11px;
    color: var(--account-preview-accent);
    white-space: nowrap;
  }

  .flow-chip-subtitle {
    font-size: 10px;
    color: var(--account-preview-text-secondary);
    line-height: 1.35;
    word-break: break-word;
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
    color: var(--account-preview-text-secondary);
    background: color-mix(in srgb, var(--account-preview-text-muted) 16%, transparent);
    border-color: color-mix(in srgb, var(--account-preview-text-muted) 28%, transparent);
  }

  .lock-badge.outgoing {
    color: color-mix(in srgb, var(--account-preview-debit) 72%, white 28%);
    background: color-mix(in srgb, var(--account-preview-debit) 10%, transparent);
    border-color: color-mix(in srgb, var(--account-preview-debit) 24%, transparent);
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
  .empty { font-size:0.65em; color:color-mix(in srgb, var(--account-preview-text-muted) 80%, transparent); padding:4px 0; font-style: italic; }

  .settle {
    display: inline-block;
    margin-top: 6px;
    font-size: 0.55em;
    padding: 3px 8px;
    border-radius: 5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    color: var(--account-preview-text-muted);
    background: color-mix(in srgb, var(--account-preview-text-muted) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--account-preview-text-muted) 14%, transparent);
  }
  .settle.awaiting_counterparty { color:var(--account-preview-accent); background:color-mix(in srgb, var(--account-preview-accent) 10%, transparent); border-color: color-mix(in srgb, var(--account-preview-accent) 16%, transparent); }
  .settle.ready_to_submit { color:var(--account-preview-credit); background:color-mix(in srgb, var(--account-preview-credit) 10%, transparent); border-color: color-mix(in srgb, var(--account-preview-credit) 16%, transparent); }
  .settle.submitted { color:var(--account-preview-accent); background:color-mix(in srgb, var(--account-preview-accent) 10%, transparent); border-color: color-mix(in srgb, var(--account-preview-accent) 16%, transparent); }

  .settle-row {
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .btn-sign-settle {
    background: color-mix(in srgb, var(--account-preview-accent) 18%, transparent);
    color: var(--account-preview-accent);
    border: 1px solid color-mix(in srgb, var(--account-preview-accent) 35%, transparent);
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
    background: color-mix(in srgb, var(--account-preview-accent) 26%, transparent);
    border-color: color-mix(in srgb, var(--account-preview-accent) 55%, transparent);
  }

  @media (max-width: 720px) {
    .account-preview {
      padding: 10px;
      border-radius: 12px;
    }

    .row-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
      gap: 8px 10px;
      margin-bottom: 6px;
    }

    .entity-col :global(.entity-identity) {
      gap: 8px;
    }

    .entity-col :global(.name) {
      font-size: 14px;
    }

    .entity-col :global(.address) {
      font-size: 10px;
    }

    .status-col {
      width: auto;
      justify-content: flex-end;
      gap: 4px;
      align-self: start;
    }

    .status-indicator {
      padding: 1px 0;
    }

    .consensus-popover {
      left: auto;
      right: 0;
      width: min(320px, calc(100vw - 32px));
    }

    .locks-row {
      grid-template-columns: 1fr;
      gap: 6px;
    }

    .flow-chip-head {
      flex-wrap: wrap;
      gap: 4px 6px;
    }

    .flow-chip-amount {
      margin-left: 0;
    }

    .settle-row {
      flex-wrap: wrap;
      justify-content: space-between;
    }

    .account-preview :global(.delta-summary.compact) {
      gap: 5px;
    }

    .account-preview :global(.delta-summary.compact .summary-head) {
      gap: 8px;
    }

    .account-preview :global(.delta-summary.compact .token-symbol) {
      font-size: 12px;
    }

    .account-preview :global(.delta-summary.compact .token-name) {
      font-size: 10px;
    }

    .account-preview :global(.delta-summary.compact .compact-out-value),
    .account-preview :global(.delta-summary.compact .compact-in-value) {
      font-size: 10px;
    }

    .account-preview :global(.summary-action-inline) {
      font-size: 7px;
      padding: 1px 4px;
      margin-left: 6px;
      align-self: center;
    }

    .account-preview :global(.delta-capacity-bar) {
      margin-top: 1px;
    }
  }

  @media (max-width: 520px) {
    .account-preview {
      padding: 9px;
    }

    .row-header {
      gap: 6px 8px;
    }

    .entity-col :global(.entity-identity) {
      gap: 7px;
    }

    .entity-col :global(.avatar) {
      width: 24px;
      height: 24px;
    }

    .status-frame {
      font-size: 9px;
    }

    .status-coverage {
      font-size: 8px;
      padding: 1px 3px;
    }

    .account-preview :global(.delta-summary.compact .summary-head) {
      grid-template-columns: minmax(0, 1fr);
      gap: 6px;
    }

    .account-preview :global(.delta-summary.compact .token-meta) {
      min-width: 0;
    }

    .account-preview :global(.delta-summary.compact .compact-metrics-wide) {
      width: 100%;
    }

    .account-preview :global(.delta-summary.compact .compact-in-value .inbound-label) {
      letter-spacing: 0.06em;
    }
  }
</style>
