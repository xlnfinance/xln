<script lang="ts">
  import type { AccountMachine, AccountTx, EntityReplica, Tab } from '$lib/types/ui';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { p2pState, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import { settings } from '../../stores/settingsStore';
  import EntityIdentity from '../shared/EntityIdentity.svelte';
  import DeltaTokenSummary from './shared/DeltaTokenSummary.svelte';
  import { resolveEntityName } from '$lib/utils/entityNaming';
  import { getAccountUiStatus, getAccountUiStatusLabel } from '$lib/utils/accountStatus';

  export let account: AccountMachine;
  export let counterpartyId: string;
  export let entityId: string;
  export let replica: EntityReplica | null = null;
  export let tab: Tab | null = null;

  const dispatch = createEventDispatcher();

  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = $xlnEnvironment;

  let expandedTokenIds = new Set<number>();
  let nowMs = Date.now();
  let nowTimer: ReturnType<typeof setInterval> | null = null;
  let liveJHeightTimer: ReturnType<typeof setInterval> | null = null;
  let liveJHeight = 0;
  let activityStatusFilter: 'all' | 'pending' | 'mempool' | 'confirmed' = 'all';
  let activityTypeFilter = 'all';

  type ActivityRow = {
    id: string;
    kind: 'pending' | 'mempool' | 'confirmed';
    frameLabel: string;
    timestamp: number;
    statusLabel: string;
    txs: AccountTx[];
  };

  type ActionParam = {
    label: string;
    value: string;
    tone?: 'default' | 'good' | 'warn' | 'danger';
  };

  $: iAmLeft = entityId < counterpartyId;
  $: mempoolCount = Number(account.mempool?.length || 0);
  $: hasPendingConsensus = Boolean(account.pendingFrame);
  $: hasQueuedMempool = mempoolCount > 0;
  $: activeDispute = account.activeDispute ?? null;
  $: uiStatus = getAccountUiStatus(account);
  $: uiStatusLabel = getAccountUiStatusLabel(uiStatus);
  $: disputeTimeoutBlock = Number(activeDispute?.disputeTimeout ?? 0);
  $: currentJHeight = Math.max(
    Number(account.lastFinalizedJHeight ?? 0),
    Number(replica?.state?.lastFinalizedJHeight ?? 0),
    Number(liveJHeight || 0),
  );
  $: disputeBlocksLeft = activeDispute ? Math.max(0, disputeTimeoutBlock - currentJHeight) : 0;

  $: reconnectCountdown = (() => {
    if (!$p2pState.reconnect) return null;
    const remaining = Math.max(0, Math.ceil(($p2pState.reconnect.nextAt - nowMs) / 1000));
    return { seconds: remaining, attempt: $p2pState.reconnect.attempt };
  })();
  $: relayStatus = $p2pState.connected ? 'connected' : reconnectCountdown ? 'reconnecting' : 'disconnected';

  $: counterpartyName = resolveEntityName(counterpartyId, activeEnv);

  $: tokenDetails = (() => {
    if (!activeXlnFunctions?.deriveDelta) return [];
    return Array.from(account.deltas?.entries() || []).map(([tokenId, delta]) => {
      const derived = activeXlnFunctions.deriveDelta(delta, iAmLeft);
      const peerDerived = activeXlnFunctions.deriveDelta(delta, !iAmLeft);
      const tokenInfo = activeXlnFunctions.getTokenInfo(tokenId) || {
        symbol: `TKN${tokenId}`,
        color: '#999',
        name: `Token ${tokenId}`,
        decimals: 18,
      };
      return {
        tokenId,
        tokenInfo,
        delta,
        derived,
        peerDerived,
        ourCreditLimit: iAmLeft ? delta.leftCreditLimit : delta.rightCreditLimit,
        theirCreditLimit: iAmLeft ? delta.rightCreditLimit : delta.leftCreditLimit,
      };
    });
  })();
  $: hasCommittedFrame = Number(account.currentHeight || 0) > 0;
  $: showTokenDetails = hasCommittedFrame && tokenDetails.length > 0;
  $: currentFrameTxs = Array.isArray(account.currentFrame?.accountTxs) ? account.currentFrame.accountTxs : [];
  $: activityRows = (() => {
    const rows: ActivityRow[] = [];
    if (account.pendingFrame) {
      rows.push({
        id: `pending-${account.pendingFrame.height}`,
        kind: 'pending',
        frameLabel: `Pending Frame #${account.pendingFrame.height}`,
        timestamp: Number(account.pendingFrame.timestamp || 0),
        statusLabel: 'Awaiting Consensus',
        txs: Array.isArray(account.pendingFrame.accountTxs) ? account.pendingFrame.accountTxs : [],
      });
    }
    if (Array.isArray(account.mempool) && account.mempool.length > 0) {
      rows.push({
        id: `mempool-${account.currentHeight}`,
        kind: 'mempool',
        frameLabel: 'Mempool Queue',
        timestamp: Number(account.currentFrame?.timestamp || 0),
        statusLabel: `${account.mempool.length} queued`,
        txs: account.mempool,
      });
    }
    const historicalFrames = Array.isArray(account.frameHistory) ? account.frameHistory.slice(-12).reverse() : [];
    for (const frame of historicalFrames) {
      rows.push({
        id: `confirmed-${frame.height}`,
        kind: 'confirmed',
        frameLabel: `Frame #${frame.height}`,
        timestamp: Number(frame.timestamp || 0),
        statusLabel: 'Confirmed',
        txs: Array.isArray(frame.accountTxs) ? frame.accountTxs : [],
      });
    }
    return rows;
  })();
  $: allActivityTypes = (() => {
    const typeSet = new Set<string>();
    for (const row of activityRows) {
      for (const tx of row.txs) typeSet.add(String(tx?.type || 'unknown'));
    }
    return Array.from(typeSet.values()).sort((a, b) => txTypeLabel(a).localeCompare(txTypeLabel(b)));
  })();
  $: filteredActivityRows = activityRows
    .filter((row) => activityStatusFilter === 'all' || row.kind === activityStatusFilter)
    .map((row) => ({
      ...row,
      filteredTxs: activityTypeFilter === 'all'
        ? row.txs
        : row.txs.filter((tx) => String(tx?.type || 'unknown') === activityTypeFilter),
    }))
    .filter((row) => row.filteredTxs.length > 0);

  function formatTimestamp(ms: number): string {
    return new Date(ms).toLocaleTimeString();
  }

  function txTypeLabel(type: string): string {
    const known: Record<string, string> = {
      request_collateral: 'Request Collateral',
      set_rebalance_policy: 'Set Rebalance Policy',
      request_withdrawal: 'Request Withdrawal',
      approve_withdrawal: 'Approve Withdrawal',
      reserve_to_collateral: 'Reserve to Collateral',
      account_settle: 'Account Settle',
      j_event_claim: 'J Event Claim',
      direct_payment: 'Direct Payment',
      account_payment: 'Account Payment',
      add_delta: 'Add Delta',
      set_credit_limit: 'Set Credit Limit',
    };
    if (known[type]) return known[type];
    return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatKeyLabel(raw: string): string {
    const known: Record<string, string> = {
      offerId: 'Offer',
      tokenId: 'Token',
      giveTokenId: 'Sell Token',
      wantTokenId: 'Buy Token',
      amount: 'Amount',
      giveAmount: 'Sell Amount',
      wantAmount: 'Buy Amount',
      priceTicks: 'Limit Price',
      minFillRatio: 'Min Fill',
      fillRatio: 'Fill',
      cancelRemainder: 'Cancel Remainder',
      requestId: 'Request ID',
      approved: 'Approved',
      counterpartyEntityId: 'Counterparty',
      jHeight: 'J Height',
      blockNumber: 'J Block',
      transactionHash: 'Tx Hash',
      workspaceVersion: 'Workspace',
      onChainNonce: 'Nonce',
      feeTokenId: 'Fee Token',
      feeAmount: 'Fee',
      events: 'Events',
      observedAt: 'Observed',
      revealBeforeHeight: 'Reveal Before',
      hashlock: 'Hashlock',
      lockId: 'Lock ID',
      timelock: 'Timelock',
      policyVersion: 'Policy Version',
      r2cRequestSoftLimit: 'R2C Request Soft Limit',
      hardLimit: 'Hard Limit',
      maxAcceptableFee: 'Max Acceptable Fee',
    };
    if (known[raw]) return known[raw];
    return raw.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }

  function toBigIntSafe(value: unknown): bigint | null {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
    return null;
  }

  function toNumberSafe(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
    return null;
  }

  function toTokenIdSafe(value: unknown): number | null {
    const num = toNumberSafe(value);
    if (num === null || !Number.isFinite(num) || num <= 0) return null;
    return Math.floor(num);
  }

  function tokenLabel(tokenId: number): string {
    const tokenInfo = activeXlnFunctions?.getTokenInfo?.(tokenId);
    return tokenInfo?.symbol ? `${tokenInfo.symbol} (#${tokenId})` : `Token #${tokenId}`;
  }

  function entityLabel(entityRaw: unknown): string {
    const entity = String(entityRaw || '');
    if (!entity) return '-';
    const resolvedName = resolveEntityName(entity, activeEnv);
    const short = entity.length > 18 ? `${entity.slice(0, 10)}...${entity.slice(-4)}` : entity;
    if (resolvedName && resolvedName.toLowerCase() !== entity.toLowerCase()) return `${resolvedName} (${short})`;
    return short;
  }

  function fillRatioToPercent(ratioRaw: unknown): string {
    const ratio = toNumberSafe(ratioRaw);
    if (ratio === null) return '-';
    const clamped = Math.max(0, Math.min(65535, ratio));
    return `${((clamped / 65535) * 100).toFixed(2)}%`;
  }

  function tokenIdForAmountKey(data: Record<string, unknown>, key: string): number | null {
    if (key === 'giveAmount') return toTokenIdSafe(data.giveTokenId);
    if (key === 'wantAmount') return toTokenIdSafe(data.wantTokenId);
    if (key === 'feeAmount') return toTokenIdSafe(data.feeTokenId) ?? toTokenIdSafe(data.tokenId);
    return toTokenIdSafe(data.tokenId);
  }

  function formatDataValue(key: string, value: unknown, data: Record<string, unknown>): ActionParam {
    const label = formatKeyLabel(key);
    if (key === 'counterpartyEntityId') {
      return { label, value: entityLabel(value) };
    }
    if (key === 'transactionHash') {
      const hash = String(value || '');
      return { label, value: hash.length > 18 ? `${hash.slice(0, 12)}...${hash.slice(-6)}` : hash || '-' };
    }
    if (key === 'offerId' || key === 'requestId' || key === 'lockId') {
      return { label, value: String(value || '-') };
    }
    if (key === 'events' && Array.isArray(value)) {
      const preview = value.slice(0, 2).map((ev) => String((ev as { type?: unknown })?.type || 'event')).join(', ');
      const suffix = value.length > 2 ? ', ...' : '';
      return { label, value: `${value.length} (${preview}${suffix})` };
    }
    if (key.endsWith('TokenId') || key === 'tokenId' || key === 'feeTokenId') {
      const tokenId = toTokenIdSafe(value);
      return { label, value: tokenId ? tokenLabel(tokenId) : '-' };
    }
    if (key === 'minFillRatio' || key === 'fillRatio') {
      return { label, value: fillRatioToPercent(value) };
    }
    if (key === 'priceTicks') {
      const ticks = toBigIntSafe(value);
      if (ticks === null) return { label, value: String(value || '-') };
      const whole = ticks / 10_000n;
      const frac = (ticks % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
      return { label, value: frac ? `${whole}.${frac}` : whole.toString() };
    }
    if (key === 'approved' || key === 'cancelRemainder') {
      const boolVal = Boolean(value);
      return { label, value: boolVal ? 'Yes' : 'No', tone: boolVal ? 'good' : 'warn' };
    }
    const big = toBigIntSafe(value);
    if (big !== null) {
      const tokenId = tokenIdForAmountKey(data, key);
      if (tokenId) return { label, value: formatTokenAmountSafe(tokenId, big) };
      return { label, value: big.toString() };
    }
    if (Array.isArray(value)) return { label, value: `${value.length} item(s)` };
    if (value && typeof value === 'object') return { label, value: `${Object.keys(value as Record<string, unknown>).length} field(s)` };
    return { label, value: String(value ?? '-') };
  }

  function buildActionParams(tx: AccountTx): ActionParam[] {
    const data = (tx?.data && typeof tx.data === 'object') ? (tx.data as Record<string, unknown>) : {};
    const orderedKeys = [
      'offerId',
      'counterpartyEntityId',
      'tokenId',
      'giveTokenId',
      'wantTokenId',
      'amount',
      'giveAmount',
      'wantAmount',
      'priceTicks',
      'minFillRatio',
      'fillRatio',
      'cancelRemainder',
      'requestId',
      'approved',
      'feeTokenId',
      'feeAmount',
      'r2cRequestSoftLimit',
      'hardLimit',
      'maxAcceptableFee',
      'workspaceVersion',
      'jHeight',
      'events',
      'blockNumber',
      'transactionHash',
      'onChainNonce',
    ];
    const keys = Object.keys(data);
    const seen = new Set<string>();
    const out: ActionParam[] = [];
    for (const key of orderedKeys) {
      if (!(key in data)) continue;
      seen.add(key);
      out.push(formatDataValue(key, data[key], data));
    }
    for (const key of keys) {
      if (seen.has(key)) continue;
      out.push(formatDataValue(key, data[key], data));
    }
    return out;
  }

  function txKindTone(type: string): 'neutral' | 'good' | 'warn' | 'danger' {
    if (type === 'swap_resolve' || type === 'approve_withdrawal' || type === 'account_settle') return 'good';
    if (type === 'swap_cancel_request' || type === 'request_withdrawal' || type === 'request_collateral') return 'warn';
    if (type === 'reopen_disputed') return 'danger';
    return 'neutral';
  }

  function toggleTokenDetails(tokenId: number): void {
    const next = new Set(expandedTokenIds);
    if (next.has(tokenId)) next.delete(tokenId);
    else next.add(tokenId);
    expandedTokenIds = next;
  }

  function formatTokenAmountSafe(tokenId: number, value: bigint): string {
    return activeXlnFunctions?.formatTokenAmount
      ? activeXlnFunctions.formatTokenAmount(tokenId, value)
      : value.toString();
  }

  function handleBackToEntity(): void {
    dispatch('back');
  }

  function openAccountWorkspace(): void {
    dispatch('goToOpenAccounts');
  }

  function handleFaucet(tokenId: number): void {
    dispatch('faucet', { counterpartyId, tokenId });
  }

  async function refreshLiveJHeight(): Promise<void> {
    if (!activeDispute) return;
    const jReplicas = activeEnv?.jReplicas;
    if (!(jReplicas instanceof Map) || jReplicas.size === 0) return;
    const activeJKey = activeEnv?.activeJurisdiction;
    const activeJReplica = activeJKey ? jReplicas.get(activeJKey) : null;
    const anyJReplica = activeJReplica ?? Array.from(jReplicas.values())[0];
    const provider = anyJReplica?.jadapter?.provider;
    if (!provider || typeof provider.getBlockNumber !== 'function') return;
    try {
      const blockNumber = Number(await provider.getBlockNumber());
      if (Number.isFinite(blockNumber)) liveJHeight = blockNumber;
    } catch {}
  }

  $: if (activeDispute) {
    void refreshLiveJHeight();
  }

  onMount(() => {
    nowTimer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    liveJHeightTimer = setInterval(() => {
      if (!activeDispute) return;
      void refreshLiveJHeight();
    }, 1000);
    void refreshLiveJHeight();
  });

  onDestroy(() => {
    if (nowTimer) clearInterval(nowTimer);
    if (liveJHeightTimer) clearInterval(liveJHeightTimer);
  });
</script>

<div class="account-panel">
  <div class="panel-header">
    <div class="header-row-top">
      <button class="back-button" on:click={handleBackToEntity}>←</button>

      <div class="header-identity">
        <EntityIdentity
          entityId={counterpartyId}
          name={counterpartyName}
          showAddress={true}
          compact={false}
        />
      </div>

      <div class="relay-status">
        <span class="conn-dot {relayStatus}"></span>
        {#if reconnectCountdown}
          <span class="reconnect-label">reconnect {reconnectCountdown.seconds}s</span>
        {/if}
      </div>
    </div>

    <div class="header-row-bottom">
      <span class="frame-badge">Frame #{account.currentFrame?.height ?? account.currentHeight ?? 0}</span>
      <span class="jheight-badge">J#{currentJHeight}</span>
      <span class="status-badge {uiStatus}">
        {#if uiStatus === 'disputed'}
          {uiStatusLabel} · {disputeBlocksLeft} block{disputeBlocksLeft === 1 ? '' : 's'} left
        {:else if uiStatus === 'sent'}
          {uiStatusLabel}{hasQueuedMempool ? ` · ${mempoolCount}` : ''}
        {:else}
          {uiStatusLabel}
        {/if}
      </span>
      {#if account.hankoSignature}
        <span class="trust-indicator verified" title="Cryptographically verified account state">🔒</span>
      {:else}
        <span class="trust-indicator pending" title="Awaiting cryptographic verification">⏳</span>
      {/if}
    </div>
  </div>

  <div class="panel-content">
    {#if showTokenDetails}
      {#each tokenDetails as td (td.tokenId)}
        {@const outTotal = td.derived.outOwnCredit + td.derived.outCollateral + td.derived.outPeerCredit}
        {@const inTotal = td.derived.inOwnCredit + td.derived.inCollateral + td.derived.inPeerCredit}
        {@const isExpanded = expandedTokenIds.has(td.tokenId)}
        <div class="delta-card">
          <DeltaTokenSummary
            barLayout={$settings.barLayout ?? 'center'}
            symbol={td.tokenInfo.symbol}
            name={td.tokenInfo.name || ''}
            outAmount={activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outCapacity) || '0'}
            inAmount={activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inCapacity) || '0'}
            derived={td.derived}
            decimals={Number(td.tokenInfo.decimals ?? 18)}
            barHeight={12}
          >
            <svelte:fragment slot="actions">
              <button class="delta-expand" on:click={() => toggleTokenDetails(td.tokenId)}>
                {isExpanded ? 'Hide' : 'Details'}
              </button>
              <button class="delta-faucet" on:click={() => handleFaucet(td.tokenId)}>Faucet</button>
            </svelte:fragment>
          </DeltaTokenSummary>

          {#if isExpanded}
            <div class="delta-details">
              <div class="detail-grid-three detail-head">
                <span class="detail-header">Parameter</span>
                <span class="detail-header">You</span>
                <span class="detail-header">Peer</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Delta</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.derived.delta)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.delta)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Out capacity</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.derived.outCapacity)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.outCapacity)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">In capacity</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.derived.inCapacity)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.inCapacity)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Out own credit (grey)</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.derived.outOwnCredit)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.outOwnCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Out collateral (green)</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.derived.outCollateral)}</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.peerDerived.outCollateral)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Out peer credit (red)</span>
                <span class="detail-value-cell debt">{formatTokenAmountSafe(td.tokenId, td.derived.outPeerCredit)}</span>
                <span class="detail-value-cell debt">{formatTokenAmountSafe(td.tokenId, td.peerDerived.outPeerCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">In own credit (red)</span>
                <span class="detail-value-cell debt">{formatTokenAmountSafe(td.tokenId, td.derived.inOwnCredit)}</span>
                <span class="detail-value-cell debt">{formatTokenAmountSafe(td.tokenId, td.peerDerived.inOwnCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">In collateral (green)</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.derived.inCollateral)}</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.peerDerived.inCollateral)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">In peer credit (grey)</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.derived.inPeerCredit)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.inPeerCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Bar OUT total</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, outTotal)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.outOwnCredit + td.peerDerived.outCollateral + td.peerDerived.outPeerCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Bar IN total</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, inTotal)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.inOwnCredit + td.peerDerived.inCollateral + td.peerDerived.inPeerCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Raw collateral</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.delta.collateral)}</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.delta.collateral)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Credit limit</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.ourCreditLimit)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.theirCreditLimit)}</span>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    {:else}
      <div class="empty-token-state">
        {#if hasCommittedFrame}
          No active token deltas in this account.
        {:else}
          Account is opening. Deltas will appear after first committed frame.
        {/if}
      </div>
    {/if}

    <div class="proof-card">
      <div class="proof-header">
        <span>Frame #{account.currentFrame.height}</span>
        <span>{formatTimestamp(account.currentFrame.timestamp)}</span>
        {#if account.currentFrame.stateHash}
          <code title={account.currentFrame.stateHash}>{account.currentFrame.stateHash.slice(0, 16)}...</code>
          <span class="proof-ok">✓</span>
        {/if}
        {#if hasPendingConsensus}
          <span class="proof-pending">Consensus pending</span>
        {:else}
          <span class="proof-ok">Confirmed</span>
        {/if}
        {#if hasQueuedMempool}
          <span class="proof-pending">Mempool: {mempoolCount} op{mempoolCount === 1 ? '' : 's'}</span>
        {/if}
      </div>
      {#if currentFrameTxs.length > 0}
        <div class="tx-cards">
          {#each currentFrameTxs as tx, txIndex (`latest-${txIndex}-${tx.type}`)}
            <article class="tx-action-card">
              <div class="tx-action-head">
                <span class="tx-type tone-{txKindTone(tx.type)}">{txTypeLabel(tx.type)}</span>
                <span class="tx-idx">#{txIndex + 1}</span>
              </div>
              <div class="tx-params">
                {#each buildActionParams(tx) as param (`${param.label}-${param.value}`)}
                  <div class="tx-param">
                    <span class="tx-param-label">{param.label}</span>
                    <span class="tx-param-value tone-{param.tone || 'default'}">{param.value}</span>
                  </div>
                {/each}
              </div>
            </article>
          {/each}
        </div>
      {:else}
        <div class="frame-empty">No account txs in current frame.</div>
      {/if}
    </div>

    <div class="action-card management-card">
      <h4>Dispute</h4>
      {#if activeDispute}
        <p class="dispute-status">
          Dispute active: {disputeBlocksLeft} block{disputeBlocksLeft === 1 ? '' : 's'} left (until J#{disputeTimeoutBlock}).
        </p>
      {:else if account.status === 'disputed'}
        <p class="dispute-status queued">
          Dispute queued. Use `Accounts -> Settle -> Dispute`, then Sign & Broadcast.
        </p>
      {:else}
        <p class="dispute-status idle">No active dispute.</p>
      {/if}
      {#if account.status === 'disputed'}
        <div class="management-buttons">
          <button class="action-button open" on:click={openAccountWorkspace}>Open Accounts Workspace</button>
        </div>
      {/if}
    </div>

    <div class="section">
      <h3>Activity</h3>
      <div class="activity-filters">
        <label>
          Status
          <select bind:value={activityStatusFilter}>
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="mempool">Mempool</option>
            <option value="confirmed">Confirmed</option>
          </select>
        </label>
        <label>
          Action
          <select bind:value={activityTypeFilter}>
            <option value="all">All</option>
            {#each allActivityTypes as type}
              <option value={type}>{txTypeLabel(type)}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="frame-history">
        {#if filteredActivityRows.length > 0}
          {#each filteredActivityRows as row (row.id)}
            <div class="frame-item {row.kind}">
              <div class="frame-header">
                <span class="frame-id">{row.frameLabel}</span>
                <span class="frame-status {row.kind}">{row.statusLabel}</span>
                <span class="frame-timestamp">{formatTimestamp(row.timestamp)}</span>
              </div>
              <div class="tx-cards">
                {#each row.filteredTxs as tx, txIndex (`${row.id}-${txIndex}-${tx.type}`)}
                  <article class="tx-action-card">
                    <div class="tx-action-head">
                      <span class="tx-type tone-{txKindTone(tx.type)}">{txTypeLabel(tx.type)}</span>
                      <span class="tx-idx">#{txIndex + 1}</span>
                    </div>
                    <div class="tx-params">
                      {#each buildActionParams(tx) as param (`${param.label}-${param.value}`)}
                        <div class="tx-param">
                          <span class="tx-param-label">{param.label}</span>
                          <span class="tx-param-value tone-{param.tone || 'default'}">{param.value}</span>
                        </div>
                      {/each}
                    </div>
                  </article>
                {/each}
              </div>
            </div>
          {/each}
        {:else}
          <div class="no-frames">No account activity yet.</div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .account-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #0c0a09;
  }

  .panel-header {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid #292524;
    background: linear-gradient(180deg, #1c1917 0%, #151310 100%);
  }

  .header-row-top {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px 8px;
  }

  .header-row-bottom {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 10px;
    padding-left: 52px;
  }

  .back-button {
    padding: 6px 10px;
    background: transparent;
    border: 1px solid #3f3f46;
    color: #a1a1aa;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    flex-shrink: 0;
  }

  .back-button:hover {
    background: #27272a;
    border-color: #52525b;
    color: #fbbf24;
  }

  .header-identity {
    flex: 1;
    min-width: 0;
  }

  .relay-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .conn-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .conn-dot.connected {
    background: #4ade80;
    box-shadow: 0 0 4px rgba(74, 222, 128, 0.5);
  }

  .conn-dot.reconnecting {
    background: #fbbf24;
  }

  .conn-dot.disconnected {
    background: #57534e;
  }

  .reconnect-label {
    font-size: 0.65em;
    color: #fbbf24;
    font-family: monospace;
  }

  .frame-badge,
  .jheight-badge {
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 0.75em;
    font-family: 'JetBrains Mono', monospace;
  }

  .frame-badge {
    background: #18181b;
    border: 1px solid #27272a;
    color: #a1a1aa;
  }

  .jheight-badge {
    background: #18181b;
    border: 1px solid #292524;
    color: #d6d3d1;
  }

  .status-badge {
    font-size: 0.72em;
    padding: 3px 10px;
    border-radius: 6px;
    font-weight: 500;
    text-transform: uppercase;
  }

  .status-badge.ready {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.1);
    border: 1px solid rgba(74, 222, 128, 0.15);
  }

  .status-badge.sent {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.15);
  }

  .status-badge.disputed {
    color: #fb7185;
    background: rgba(244, 63, 94, 0.12);
    border: 1px solid rgba(244, 63, 94, 0.3);
  }

  .status-badge.finalized_disputed {
    color: #fca5a5;
    background: rgba(153, 27, 27, 0.24);
    border: 1px solid rgba(248, 113, 113, 0.32);
  }

  .trust-indicator {
    font-size: 0.85em;
  }

  .trust-indicator.verified {
    color: #4ade80;
  }

  .trust-indicator.pending {
    color: #a8a29e;
  }

  .panel-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .delta-card,
  .proof-card,
  .action-card,
  .frame-item {
    background: #18181b;
    border: 1px solid #292524;
    border-radius: 10px;
    padding: 12px;
  }

  .empty-token-state {
    background: #18181b;
    border: 1px solid #292524;
    border-radius: 10px;
    padding: 14px 12px;
    color: #9ca3af;
    font-size: 12px;
    font-style: italic;
  }

  .delta-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .delta-token {
    font-weight: 700;
    color: #f3f4f6;
  }

  .delta-brief {
    flex: 1;
    color: #a1a1aa;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .delta-expand,
  .delta-faucet {
    border: 1px solid #3f3f46;
    background: transparent;
    color: #d1d5db;
    border-radius: 8px;
    padding: 4px 8px;
    cursor: pointer;
  }

  .delta-details {
    margin-top: 10px;
    border-top: 1px solid #292524;
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .detail-grid-three {
    display: grid;
    grid-template-columns: minmax(130px, 1fr) minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
    align-items: center;
  }

  .detail-head {
    color: #9ca3af;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .detail-label-cell,
  .detail-value-cell {
    font-size: 12px;
    color: #d1d5db;
    font-family: 'JetBrains Mono', monospace;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-label-cell {
    color: #9ca3af;
    font-family: inherit;
  }

  .detail-value-cell.coll {
    color: #34d399;
  }

  .proof-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #9ca3af;
    flex-wrap: wrap;
  }

  .proof-header code {
    font-family: 'JetBrains Mono', monospace;
    color: #d1d5db;
  }

  .proof-ok {
    color: #34d399;
  }

  .proof-pending {
    color: #f59e0b;
  }

  .tx-cards {
    margin-top: 8px;
    display: grid;
    gap: 8px;
  }

  .tx-action-card {
    background: rgba(24, 24, 27, 0.85);
    border: 1px solid #34302c;
    border-radius: 10px;
    padding: 10px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
  }

  .tx-action-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .tx-type {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    border: 1px solid #3f3f46;
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #e7e5e4;
  }

  .tx-type.tone-neutral {
    border-color: #44403c;
    color: #e7e5e4;
    background: rgba(68, 64, 60, 0.2);
  }

  .tx-type.tone-good {
    border-color: rgba(16, 185, 129, 0.4);
    color: #86efac;
    background: rgba(16, 185, 129, 0.12);
  }

  .tx-type.tone-warn {
    border-color: rgba(245, 158, 11, 0.45);
    color: #fbbf24;
    background: rgba(245, 158, 11, 0.13);
  }

  .tx-type.tone-danger {
    border-color: rgba(244, 63, 94, 0.5);
    color: #fda4af;
    background: rgba(244, 63, 94, 0.16);
  }

  .tx-idx {
    color: #78716c;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
  }

  .tx-params {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 8px;
  }

  .tx-param {
    border: 1px solid #312d2a;
    border-radius: 8px;
    padding: 6px 8px;
    background: rgba(12, 10, 9, 0.65);
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .tx-param-label {
    color: #9ca3af;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    line-height: 1;
  }

  .tx-param-value {
    color: #e7e5e4;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tx-param-value.tone-good {
    color: #86efac;
  }

  .tx-param-value.tone-warn {
    color: #fbbf24;
  }

  .tx-param-value.tone-danger {
    color: #fda4af;
  }

  .management-card h4 {
    margin: 0 0 6px;
    color: #f3f4f6;
    font-size: 13px;
  }

  .dispute-status {
    margin: 0;
    font-size: 12px;
    color: #fda4af;
  }

  .dispute-status.queued {
    color: #fb7185;
  }

  .dispute-status.idle {
    color: #9ca3af;
  }

  .management-buttons {
    margin-top: 10px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .action-button {
    border-radius: 8px;
    padding: 8px 12px;
    border: 1px solid #3f3f46;
    background: #18181b;
    color: #f3f4f6;
    cursor: pointer;
  }

  .action-button.settle {
    border-color: #f59e0b;
    color: #fbbf24;
  }

  .action-button.open {
    border-color: #52525b;
    color: #d6d3d1;
  }

  .section h3 {
    margin: 4px 0 8px;
    color: #9ca3af;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .activity-filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    margin-bottom: 10px;
  }

  .activity-filters label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: #a8a29e;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .activity-filters select {
    border: 1px solid #3f3f46;
    border-radius: 8px;
    background: #111113;
    color: #e7e5e4;
    font-size: 12px;
    padding: 7px 8px;
  }

  .activity-filters select:focus-visible {
    outline: 1px solid rgba(251, 191, 36, 0.7);
    outline-offset: 1px;
  }

  .frame-history {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .frame-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
  }

  .frame-status.pending {
    color: #f59e0b;
  }

  .frame-status.mempool {
    color: #f97316;
  }

  .frame-status.historical {
    color: #34d399;
  }

  .frame-status.confirmed {
    color: #34d399;
  }

  .frame-id,
  .frame-timestamp {
    color: #9ca3af;
  }

  .frame-empty {
    margin-top: 8px;
    color: #6b7280;
    font-size: 11px;
  }

  .no-frames {
    border: 1px dashed #3f3f46;
    color: #78716c;
    border-radius: 8px;
    padding: 10px;
    text-align: center;
    font-size: 12px;
  }

  @media (max-width: 768px) {
    .header-row-bottom {
      padding-left: 16px;
      flex-wrap: wrap;
    }

    .delta-card-header {
      flex-wrap: wrap;
    }

    .detail-grid-three {
      grid-template-columns: 1fr;
      gap: 2px;
      padding: 4px 0;
    }

    .detail-head {
      display: none;
    }

    .tx-params {
      grid-template-columns: 1fr;
    }
  }
</style>
