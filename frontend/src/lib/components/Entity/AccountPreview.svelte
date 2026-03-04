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
      tokenRebalanceState: TokenRebalanceState;
      tokenRebalanceLabel: string;
      pendingOutDebtMode: 'none' | 'pending' | 'settling';
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
      const tokenRequested = pendingRequestedByToken.get(tokenId) || 0n;
      const tokenC2R = pendingC2RByToken.get(tokenId) || 0n;
      let tokenRebalanceState: TokenRebalanceState = 'none';
      let tokenRebalanceAmount = 0n;
      if (tokenRequested > 0n) {
        tokenRebalanceState = hasPendingBatch ? 'settling' : 'pending';
        tokenRebalanceAmount = tokenRequested;
      } else if (tokenC2R > 0n) {
        tokenRebalanceState = hasPendingBatch ? 'settling' : 'pending';
        tokenRebalanceAmount = tokenC2R;
      } else if (derived.outCollateral > 0n && derived.outPeerCredit === 0n) {
        tokenRebalanceState = 'secured';
      } else if (derived.outCollateral > 0n && derived.outPeerCredit > 0n) {
        tokenRebalanceState = 'partial';
      }
      const tokenRebalanceLabel = (() => {
        if (tokenRebalanceState === 'pending') {
          if (tokenRequested > 0n) return `Awaiting collateral ${activeXlnFunctions.formatTokenAmount(tokenId, tokenRebalanceAmount)}`;
          return `Awaiting withdrawal ${activeXlnFunctions.formatTokenAmount(tokenId, tokenRebalanceAmount)}`;
        }
        if (tokenRebalanceState === 'settling') {
          if (tokenRequested > 0n) return `Collateral settling ${activeXlnFunctions.formatTokenAmount(tokenId, tokenRebalanceAmount)}`;
          return `Withdrawal settling ${activeXlnFunctions.formatTokenAmount(tokenId, tokenRebalanceAmount)}`;
        }
        if (tokenRebalanceState === 'secured') return 'Secured';
        if (tokenRebalanceState === 'partial') return 'Partially secured';
        return '';
      })();
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
        tokenRebalanceState,
        tokenRebalanceLabel,
        pendingOutDebtMode: tokenRebalanceState === 'settling'
          ? 'settling'
          : tokenRebalanceState === 'pending'
            ? 'pending'
            : 'none',
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

  type TokenRebalanceState = 'none' | 'pending' | 'settling' | 'secured' | 'partial';

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
    if (status === 'ready_to_submit') return 'Ready to submit';
    if (status === 'submitted') return 'Submitted on-chain';
    if (status === 'draft') return 'Draft';
    return status.replace(/_/g, ' ');
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
        barLayout={$settings.barLayout ?? 'center'}
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
            barLayout={$settings.barLayout ?? 'center'}
            symbol={td.symbol}
            name={td.name}
            outAmount={td.outAmount}
            inAmount={td.inAmount}
            derived={td.derived}
            decimals={td.decimals}
            barHeight={9}
            pendingOutDebtMode={td.pendingOutDebtMode}
          >
            <svelte:fragment slot="actions">
              {#if td.tokenRebalanceState !== 'none'}
                <span class="delta-rb {td.tokenRebalanceState}">{td.tokenRebalanceLabel}</span>
              {/if}
            </svelte:fragment>
          </DeltaTokenSummary>
        {/each}
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

  /* ── Misc ──────────────────────────────────────── */
  .empty { font-size:0.65em; color:#52525b; padding:4px 0; font-style: italic; }

  .delta-rb {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    border: 1px solid #3f3f46;
    background: rgba(24, 24, 27, 0.8);
    color: #d6d3d1;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 3px 8px;
    white-space: nowrap;
  }
  .delta-rb.pending {
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.45);
    background: rgba(251, 191, 36, 0.12);
  }
  .delta-rb.settling {
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.45);
    background: rgba(245, 158, 11, 0.11);
  }
  .delta-rb.secured {
    color: #4ade80;
    border-color: rgba(74, 222, 128, 0.4);
    background: rgba(16, 185, 129, 0.1);
  }
  .delta-rb.partial {
    color: #34d399;
    border-color: rgba(52, 211, 153, 0.4);
    background: rgba(52, 211, 153, 0.1);
  }

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
